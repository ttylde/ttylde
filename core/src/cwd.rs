//! The folder a session is working in.
//!
//! A shell can announce it with OSC 7: `ESC ] 7 ; file://host/path BEL`,
//! the path percent-encoded. When it does not, the system knows the folder
//! of every process: `of_process` asks it.

use std::path::PathBuf;

/// What an OSC 7 says: a folder, and the machine it is on.
#[derive(Debug, Clone, PartialEq)]
pub struct Location {
    /// Empty when the shell left it out.
    pub host: String,
    pub path: PathBuf,
}

/// Reads the text of an OSC 7, the part after `7;`. `None` if it is not a
/// `file://` URI with an absolute path.
pub fn parse_osc7(uri: &str) -> Option<Location> {
    let stripped = uri.strip_prefix("file://")?;
    let first_slash_i = stripped.find("/")?;
    let (host, path) = stripped.split_at(first_slash_i);

    let path_decoded = percent_decode(path)?;
    Some(Location {
        host: host.to_string(),
        path: PathBuf::from(String::from_utf8(path_decoded).ok()?),
    })
}

fn percent_decode(uri: &str) -> Option<Vec<u8>> {
    let bytes = uri.as_bytes();
    let mut output: Vec<u8> = Vec::new();

    let mut i = 0;
    while i < bytes.len() {
        let char = bytes[i];
        match char {
            b'%' => {
                let slice = bytes.get(i + 1..i + 3)?;
                let hi = (slice[0] as char).to_digit(16)?;
                let lo = (slice[1] as char).to_digit(16)?;
                output.push((hi * 16 + lo) as u8);

                i += 2;
            }
            _ => output.push(char),
        }

        i += 1;
    }

    Some(output)
}

/// The folder the process `pid` is working in, as the system reports it.
/// `None` if there is no such process, or it is not ours to look at.
#[cfg(target_os = "macos")]
pub fn of_process(pid: u32) -> Option<PathBuf> {
    use std::{
        ffi::{CStr, OsStr},
        mem::{size_of, MaybeUninit},
        os::unix::ffi::OsStrExt,
    };

    let mut info = MaybeUninit::<libc::proc_vnodepathinfo>::zeroed();
    let size = size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    // SAFETY: the buffer is `size` bytes long and the call writes no more.
    let written = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size {
        return None;
    }

    // SAFETY: the call filled the whole struct, and any bytes are valid in it.
    let info = unsafe { info.assume_init() };
    // SAFETY: the path is a C string of at most `MAXPATHLEN` bytes, the
    // length of the field, terminator included.
    let path = unsafe { CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr().cast()) };
    if path.is_empty() {
        return None;
    }

    Some(PathBuf::from(OsStr::from_bytes(path.to_bytes())))
}

#[cfg(target_os = "linux")]
pub fn of_process(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn of_process(_pid: u32) -> Option<PathBuf> {
    None
}

/// The name of this machine, to tell its folders from those of another.
/// Empty if the system does not say.
#[cfg(unix)]
pub fn hostname() -> String {
    let mut name = [0u8; 256];
    // SAFETY: the call writes at most `name.len()` bytes into the buffer.
    let failed = unsafe { libc::gethostname(name.as_mut_ptr().cast(), name.len()) } != 0;
    if failed {
        return String::new();
    }

    let end = name.iter().position(|&b| b == 0).unwrap_or(name.len());
    String::from_utf8_lossy(&name[..end]).into_owned()
}

#[cfg(not(unix))]
pub fn hostname() -> String {
    String::new()
}

/// Follows the folder of one session, from what the shell announces or,
/// until it does, from what the system says.
pub struct Tracker {
    /// Name of this machine: folders announced from another are not ours.
    host: String,
    folder: Option<PathBuf>,
    /// The shell announces its folder: there is no need to ask the system.
    announced: bool,
}

impl Tracker {
    pub fn new(host: String) -> Self {
        Tracker {
            host,
            folder: None,
            announced: false,
        }
    }

    /// The shell said where it is. Returns the folder if it changed.
    ///
    /// A location on another machine (a shell reached through ssh) is
    /// ignored: its path means nothing here.
    pub fn announce(&mut self, location: Location) -> Option<PathBuf> {
        let host = &location.host;
        let local = host.is_empty()
            || host.eq_ignore_ascii_case("localhost")
            || host.eq_ignore_ascii_case(&self.host);
        if !local {
            return None;
        }

        self.announced = true;
        self.update(location.path)
    }

    /// Whether the system has to be asked: true until the shell announces.
    pub fn needs_probe(&self) -> bool {
        !self.announced
    }

    /// The system said where the foreground process is, or that it does
    /// not know. Returns the folder if it changed.
    pub fn observe(&mut self, folder: Option<PathBuf>) -> Option<PathBuf> {
        if self.announced {
            return None;
        }

        self.update(folder?)
    }

    // Keeps `folder` and returns it, if it is not the one already known.
    fn update(&mut self, folder: PathBuf) -> Option<PathBuf> {
        if self.folder.as_ref() == Some(&folder) {
            return None;
        }

        self.folder = Some(folder.clone());
        Some(folder)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn location(host: &str, path: &str) -> Option<Location> {
        Some(Location {
            host: host.to_string(),
            path: PathBuf::from(path),
        })
    }

    #[test]
    fn host_and_path() {
        assert_eq!(
            parse_osc7("file://mac.local/Users/me/work"),
            location("mac.local", "/Users/me/work")
        );
    }

    // `file:///path` is the form without a host.
    #[test]
    fn the_host_may_be_empty() {
        assert_eq!(parse_osc7("file:///tmp"), location("", "/tmp"));
    }

    #[test]
    fn the_root_is_a_path() {
        assert_eq!(parse_osc7("file://mac.local/"), location("mac.local", "/"));
    }

    // Shells encode what a URI cannot hold: spaces, accents, `%` itself.
    #[test]
    fn percent_escapes_are_decoded() {
        assert_eq!(
            parse_osc7("file:///Users/me/My%20Files"),
            location("", "/Users/me/My Files")
        );
        assert_eq!(parse_osc7("file:///tmp/100%25"), location("", "/tmp/100%"));
    }

    // An accented letter is two bytes, each with its own escape.
    #[test]
    fn escapes_are_bytes_of_utf8() {
        assert_eq!(
            parse_osc7("file:///tmp/caff%C3%A8"),
            location("", "/tmp/caffè")
        );
    }

    #[test]
    fn hex_digits_can_be_lowercase() {
        assert_eq!(parse_osc7("file:///a%2fb%2Fc"), location("", "/a/b/c"));
    }

    // Not every shell encodes: what is already plain stays as it is.
    #[test]
    fn plain_characters_pass_through() {
        assert_eq!(
            parse_osc7("file:///tmp/my files/è"),
            location("", "/tmp/my files/è")
        );
    }

    // The host is not decoded and takes no part of the path.
    #[test]
    fn the_host_ends_at_the_first_slash() {
        assert_eq!(parse_osc7("file://a.b/c/d"), location("a.b", "/c/d"));
    }

    #[test]
    fn only_file_uris() {
        assert_eq!(parse_osc7("/Users/me"), None);
        assert_eq!(parse_osc7("http://host/path"), None);
        assert_eq!(parse_osc7("kitty-shell-cwd://host/path"), None);
        assert_eq!(parse_osc7(""), None);
    }

    // Without a slash after the host there is no path at all.
    #[test]
    fn a_host_alone_is_not_a_location() {
        assert_eq!(parse_osc7("file://mac.local"), None);
        assert_eq!(parse_osc7("file://"), None);
    }

    #[test]
    fn a_broken_escape_is_an_error() {
        assert_eq!(parse_osc7("file:///tmp/%"), None);
        assert_eq!(parse_osc7("file:///tmp/%2"), None);
        assert_eq!(parse_osc7("file:///tmp/%zz"), None);
    }

    // `from_str_radix` alone would take a sign for a digit.
    #[test]
    fn a_sign_is_not_a_hex_digit() {
        assert_eq!(parse_osc7("file:///tmp/%+1"), None);
    }

    // The decoded bytes must be text: `%FF` alone is not UTF-8.
    #[test]
    fn bytes_that_are_not_text_are_an_error() {
        assert_eq!(parse_osc7("file:///tmp/%FF"), None);
    }

    // Our own folder is the one case we know the answer to.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn the_folder_of_this_process() {
        let expected = std::env::current_dir().unwrap();
        assert_eq!(of_process(std::process::id()), Some(expected));
    }

    // A child started in another folder reports that one, not ours.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn the_folder_of_a_child() {
        // The system reports the real path: `/tmp` may be a link.
        let folder = std::env::temp_dir().canonicalize().unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .current_dir(&folder)
            .spawn()
            .unwrap();
        let found = of_process(child.id());
        child.kill().unwrap();
        child.wait().unwrap();

        assert_eq!(found, Some(folder));
    }

    #[test]
    fn a_process_that_does_not_exist_has_no_folder() {
        assert_eq!(of_process(0x7fff_fff0), None);
    }

    #[cfg(unix)]
    #[test]
    fn this_machine_has_a_name() {
        assert!(!hostname().is_empty());
    }

    fn tracker() -> Tracker {
        Tracker::new("mac.local".to_string())
    }

    fn at(host: &str, path: &str) -> Location {
        location(host, path).unwrap()
    }

    fn folder(path: &str) -> Option<PathBuf> {
        Some(PathBuf::from(path))
    }

    #[test]
    fn an_announced_folder_is_reported() {
        let mut tracker = tracker();
        assert_eq!(tracker.announce(at("mac.local", "/a")), folder("/a"));
    }

    // Every prompt announces again: only a change is news.
    #[test]
    fn the_same_folder_is_reported_once() {
        let mut tracker = tracker();
        tracker.announce(at("mac.local", "/a"));

        assert_eq!(tracker.announce(at("mac.local", "/a")), None);
        assert_eq!(tracker.announce(at("mac.local", "/b")), folder("/b"));
    }

    // No host and `localhost` both mean this machine; names ignore case.
    #[test]
    fn this_machine_has_several_names() {
        let mut tracker = tracker();
        assert_eq!(tracker.announce(at("", "/a")), folder("/a"));
        assert_eq!(tracker.announce(at("localhost", "/b")), folder("/b"));
        assert_eq!(tracker.announce(at("MAC.local", "/c")), folder("/c"));
    }

    // Through ssh the remote shell announces folders of its own machine.
    #[test]
    fn a_folder_on_another_machine_is_ignored() {
        let mut tracker = tracker();
        assert_eq!(tracker.announce(at("server", "/srv")), None);
        // It changed nothing: the system is still the one to ask.
        assert!(tracker.needs_probe());
        assert_eq!(tracker.observe(folder("/a")), folder("/a"));
    }

    #[test]
    fn the_system_is_asked_until_the_shell_announces() {
        let mut tracker = tracker();
        assert!(tracker.needs_probe());

        tracker.announce(at("mac.local", "/a"));
        assert!(!tracker.needs_probe());
    }

    #[test]
    fn an_observed_folder_is_reported_when_it_changes() {
        let mut tracker = tracker();
        assert_eq!(tracker.observe(folder("/a")), folder("/a"));
        assert_eq!(tracker.observe(folder("/a")), None);
        assert_eq!(tracker.observe(folder("/b")), folder("/b"));
    }

    // The process may be gone or not ours: the last folder stays.
    #[test]
    fn an_unknown_folder_changes_nothing() {
        let mut tracker = tracker();
        tracker.observe(folder("/a"));

        assert_eq!(tracker.observe(None), None);
        assert_eq!(tracker.observe(folder("/a")), None);
    }

    // What the shell says is more precise than the foreground process.
    #[test]
    fn the_shell_wins_over_the_system() {
        let mut tracker = tracker();
        tracker.announce(at("mac.local", "/a"));

        assert_eq!(tracker.observe(folder("/b")), None);
        assert_eq!(tracker.announce(at("mac.local", "/a")), None);
    }

    // The two sources share one folder: the same one is not news twice.
    #[test]
    fn announcing_the_observed_folder_is_not_news() {
        let mut tracker = tracker();
        tracker.observe(folder("/a"));

        assert_eq!(tracker.announce(at("mac.local", "/a")), None);
        assert!(!tracker.needs_probe());
    }
}
