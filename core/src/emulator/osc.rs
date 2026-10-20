use alacritty_terminal::vte::Perform;

use crate::{
    command::Mark,
    cwd::{parse_osc7, percent_decode, Location},
};

/// What a shell announces with the OSCs the terminal leaves out.
#[derive(Debug, PartialEq)]
pub(super) enum Announcement {
    /// OSC 7: the folder it is in.
    Location(Location),
    /// OSC 133, or VS Code's OSC 633: prompts and commands.
    Mark(Mark),
    /// `133;B`: the prompt ends, what follows is typed. Only where it falls
    /// in the grid matters: see `blocks`.
    Typed,
}

#[derive(Default)]
pub(super) struct OscWatcher {
    announcements: Vec<Announcement>,
    /// The secret of the session's shell: see `shell::integrate`.
    pub(super) nonce: Option<String>,
}

impl OscWatcher {
    pub(super) fn take(&mut self) -> Vec<Announcement> {
        std::mem::take(&mut self.announcements)
    }

    /// How many announcements wait to be taken.
    pub(super) fn len(&self) -> usize {
        self.announcements.len()
    }

    /// The announcements from the `from`th on.
    pub(super) fn since(&self, from: usize) -> &[Announcement] {
        &self.announcements[from..]
    }

    /// The text of a command, if the sequence that carries it also carries
    /// the nonce. Without a nonce to compare, no text is believed.
    fn believe(&self, text: Option<String>, nonce: Option<&[u8]>) -> Option<String> {
        let expected = self.nonce.as_deref().filter(|n| !n.is_empty())?;
        (nonce? == expected.as_bytes()).then_some(text?)
    }

    // `133;A`, `133;C;cmdline_url=…;nonce=…`, `133;D;<status>`; 633 marks
    // the same way, and adds `633;E;<text>;<nonce>`.
    fn mark(&self, kind: &[u8], rest: &[&[u8]], vscode: bool) -> Option<Mark> {
        match kind {
            b"A" => Some(Mark::Prompt),
            b"C" => {
                let mut text = None;
                let mut nonce = None;
                for param in rest {
                    if let Some(url) = param.strip_prefix(b"cmdline_url=") {
                        text = percent_decode(std::str::from_utf8(url).ok()?)
                            .and_then(|bytes| String::from_utf8(bytes).ok());
                    } else if let Some(value) = param.strip_prefix(b"nonce=") {
                        nonce = Some(value);
                    }
                }
                Some(Mark::Start(self.believe(text, nonce)))
            }
            b"D" => {
                let status = rest
                    .first()
                    .and_then(|s| std::str::from_utf8(s).ok())
                    .and_then(|s| s.parse().ok());
                Some(Mark::End(status))
            }
            b"E" if vscode => {
                let text = rest.first().and_then(|t| unescape_vscode(t));
                self.believe(text, rest.get(1).copied()).map(Mark::Text)
            }
            _ => None,
        }
    }
}

impl Perform for OscWatcher {
    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        match params {
            [b"7", uri @ ..] if !uri.is_empty() => {
                // The parser splits at every `;`: one in the path comes back here.
                let uri = uri.join(&b';');
                let Ok(uri) = std::str::from_utf8(&uri) else {
                    return;
                };
                if let Some(location) = parse_osc7(uri) {
                    self.announcements.push(Announcement::Location(location));
                }
            }
            [b"133" | b"633", b"B", ..] => self.announcements.push(Announcement::Typed),
            [code @ (b"133" | b"633"), kind, rest @ ..] => {
                if let Some(mark) = self.mark(kind, rest, *code == b"633") {
                    self.announcements.push(Announcement::Mark(mark));
                }
            }
            _ => {}
        }
    }
}

/// The text of a `633;E`: `\\` is a backslash, `\xAB` the byte 0xAB (VS
/// Code writes `;` and control characters that way).
fn unescape_vscode(text: &[u8]) -> Option<String> {
    let mut bytes = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        match (text[i], text.get(i + 1)) {
            (b'\\', Some(b'\\')) => {
                bytes.push(b'\\');
                i += 2;
            }
            (b'\\', Some(b'x')) => {
                let hex = std::str::from_utf8(text.get(i + 2..i + 4)?).ok()?;
                bytes.push(u8::from_str_radix(hex, 16).ok()?);
                i += 4;
            }
            (byte, _) => {
                bytes.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(bytes).ok()
}
