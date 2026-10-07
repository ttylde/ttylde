//! Key-to-bytes translation for the shell.
//!
//! The frontend sends raw events (which key, which modifiers); here we decide
//! which bytes to write to the PTY. The rules follow xterm, the de facto
//! standard programs expect with `TERM=xterm-256color`.

use serde::Deserialize;

/// A pressed key. `Char` is only used for Ctrl or Alt combinations: plain
/// text arrives ready-made from the system (IME, dead keys, Option).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum Key {
    Enter,
    Tab,
    Backspace,
    Escape,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Insert,
    Delete,
    F(u8),
    Char(char),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub struct Mods {
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub ctrl: bool,
}

impl Mods {
    /// The modifier parameter of xterm sequences: 1 plus the bits
    /// Shift (1), Alt (2), Ctrl (4). It is 1 without modifiers.
    fn xterm_param(self) -> u8 {
        1 + (self.shift as u8) + ((self.alt as u8) << 1) + ((self.ctrl as u8) << 2)
    }

    fn any(self) -> bool {
        self.shift || self.alt || self.ctrl
    }
}

/// The emulator state that affects encoding.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InputMode {
    /// Arrows and Home/End as `ESC O x` instead of `ESC [ x` (DECCKM).
    pub app_cursor: bool,
    /// The program wants pasted text wrapped in `ESC [200~` and `ESC [201~`.
    pub bracketed_paste: bool,
    pub alt_screen: bool,
    pub alternate_scroll: bool,
}

const ESC: u8 = 0x1b;

/// Encodes a key. `None` if the combination means nothing to the terminal:
/// the caller leaves it to the system.
pub fn encode_key(key: Key, mods: Mods, mode: InputMode) -> Option<Vec<u8>> {
    let bytes = match key {
        Key::Enter => with_alt_prefix(mods, vec![b'\r']),
        Key::Tab if mods.shift => b"\x1b[Z".to_vec(),
        Key::Tab => vec![b'\t'],
        Key::Backspace => with_alt_prefix(mods, vec![if mods.ctrl { 0x08 } else { 0x7f }]),
        Key::Escape => with_alt_prefix(mods, vec![ESC]),

        Key::Up => cursor_key(b'A', mods, mode),
        Key::Down => cursor_key(b'B', mods, mode),
        Key::Right => cursor_key(b'C', mods, mode),
        Key::Left => cursor_key(b'D', mods, mode),
        Key::Home => cursor_key(b'H', mods, mode),
        Key::End => cursor_key(b'F', mods, mode),

        Key::Insert => tilde_key(2, mods),
        Key::Delete => tilde_key(3, mods),
        Key::PageUp => tilde_key(5, mods),
        Key::PageDown => tilde_key(6, mods),

        Key::F(n @ 1..=4) => {
            let final_byte = b'P' + (n - 1);
            if mods.any() {
                format!("\x1b[1;{}{}", mods.xterm_param(), final_byte as char).into_bytes()
            } else {
                vec![ESC, b'O', final_byte]
            }
        }
        Key::F(n @ 5..=12) => {
            let code = [15, 17, 18, 19, 20, 21, 23, 24][(n - 5) as usize];
            tilde_key(code, mods)
        }
        Key::F(_) => return None,

        Key::Char(c) if mods.ctrl => with_alt_prefix(mods, vec![control_byte(c)?]),
        Key::Char(c) => {
            let mut buf = [0u8; 4];
            with_alt_prefix(mods, c.encode_utf8(&mut buf).as_bytes().to_vec())
        }
    };
    Some(bytes)
}

/// Arrows and Home/End: `ESC [ x`, or `ESC O x` in application mode;
/// with modifiers always `ESC [ 1 ; m x`.
fn cursor_key(final_byte: u8, mods: Mods, mode: InputMode) -> Vec<u8> {
    if mods.any() {
        format!("\x1b[1;{}{}", mods.xterm_param(), final_byte as char).into_bytes()
    } else if mode.app_cursor {
        vec![ESC, b'O', final_byte]
    } else {
        vec![ESC, b'[', final_byte]
    }
}

/// Keys of the form `ESC [ n ~`, with modifiers `ESC [ n ; m ~`.
fn tilde_key(code: u8, mods: Mods) -> Vec<u8> {
    if mods.any() {
        format!("\x1b[{code};{}~", mods.xterm_param()).into_bytes()
    } else {
        format!("\x1b[{code}~").into_bytes()
    }
}

/// Alt before a key adds an ESC: xterm's "meta" convention.
fn with_alt_prefix(mods: Mods, mut bytes: Vec<u8>) -> Vec<u8> {
    if mods.alt {
        bytes.insert(0, ESC);
    }
    bytes
}

/// Ctrl plus a character yields a control byte (0x00–0x1f, or 0x7f).
fn control_byte(c: char) -> Option<u8> {
    Some(match c.to_ascii_lowercase() {
        'a'..='z' => c.to_ascii_lowercase() as u8 - b'a' + 1,
        '@' | ' ' | '2' => 0x00,
        '[' | '3' => 0x1b,
        '\\' | '4' => 0x1c,
        ']' | '5' => 0x1d,
        '^' | '6' => 0x1e,
        '_' | '7' | '-' => 0x1f,
        '?' | '8' => 0x7f,
        _ => return None,
    })
}

/// Prepares pasted text: with bracketed paste the program receives it wrapped
/// in markers and knows not to run it line by line; otherwise newlines become
/// Enter, as if typed.
pub fn encode_paste(text: &str, mode: InputMode) -> Vec<u8> {
    if mode.bracketed_paste {
        let mut bytes = b"\x1b[200~".to_vec();
        // An ESC inside the text could end the paste early.
        bytes.extend(text.bytes().filter(|&b| b != ESC));
        bytes.extend_from_slice(b"\x1b[201~");
        bytes
    } else {
        text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Mods = Mods {
        shift: false,
        alt: false,
        ctrl: false,
    };
    const CTRL: Mods = Mods { ctrl: true, ..NONE };
    const ALT: Mods = Mods { alt: true, ..NONE };
    const SHIFT: Mods = Mods {
        shift: true,
        ..NONE
    };
    const APP: InputMode = InputMode {
        app_cursor: true,
        bracketed_paste: false,
        alt_screen: false,
        alternate_scroll: false,
    };

    fn enc(key: Key, mods: Mods) -> Vec<u8> {
        encode_key(key, mods, InputMode::default()).unwrap()
    }

    #[test]
    fn basic_keys() {
        assert_eq!(enc(Key::Enter, NONE), b"\r");
        assert_eq!(enc(Key::Tab, NONE), b"\t");
        assert_eq!(enc(Key::Tab, SHIFT), b"\x1b[Z");
        assert_eq!(enc(Key::Backspace, NONE), [0x7f]);
        assert_eq!(enc(Key::Backspace, CTRL), [0x08]);
        assert_eq!(enc(Key::Escape, NONE), [0x1b]);
    }

    // Ctrl+letter is the letter minus 64: Ctrl+C interrupts with 0x03.
    #[test]
    fn control_characters() {
        assert_eq!(enc(Key::Char('c'), CTRL), [0x03]);
        assert_eq!(enc(Key::Char('C'), CTRL), [0x03]);
        assert_eq!(enc(Key::Char('a'), CTRL), [0x01]);
        assert_eq!(enc(Key::Char('['), CTRL), [0x1b]);
        assert_eq!(encode_key(Key::Char('é'), CTRL, InputMode::default()), None);
    }

    // Alt prepends an ESC.
    #[test]
    fn alt_prefixes_escape() {
        assert_eq!(enc(Key::Char('b'), ALT), b"\x1bb");
        assert_eq!(enc(Key::Enter, ALT), b"\x1b\r");
    }

    // Arrows change shape in application cursor mode and with modifiers.
    #[test]
    fn cursor_keys_follow_the_mode() {
        assert_eq!(enc(Key::Up, NONE), b"\x1b[A");
        assert_eq!(encode_key(Key::Up, NONE, APP).unwrap(), b"\x1bOA");
        assert_eq!(enc(Key::Up, SHIFT), b"\x1b[1;2A");
        assert_eq!(enc(Key::Left, CTRL), b"\x1b[1;5D");
        assert_eq!(enc(Key::Home, NONE), b"\x1b[H");
        assert_eq!(encode_key(Key::End, NONE, APP).unwrap(), b"\x1bOF");
    }

    #[test]
    fn tilde_and_function_keys() {
        assert_eq!(enc(Key::Delete, NONE), b"\x1b[3~");
        assert_eq!(enc(Key::PageUp, SHIFT), b"\x1b[5;2~");
        assert_eq!(enc(Key::F(1), NONE), b"\x1bOP");
        assert_eq!(enc(Key::F(1), SHIFT), b"\x1b[1;2P");
        assert_eq!(enc(Key::F(5), NONE), b"\x1b[15~");
        assert_eq!(enc(Key::F(12), NONE), b"\x1b[24~");
        assert_eq!(encode_key(Key::F(13), NONE, InputMode::default()), None);
    }

    #[test]
    fn paste_is_bracketed_only_when_requested() {
        let plain = InputMode::default();
        assert_eq!(encode_paste("a\nb\r\nc", plain), b"a\rb\rc");

        let bracketed = InputMode {
            bracketed_paste: true,
            ..plain
        };
        assert_eq!(encode_paste("a\nb", bracketed), b"\x1b[200~a\nb\x1b[201~");
    }
}
