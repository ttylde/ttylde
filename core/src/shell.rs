//! Shell integration: the shell tells Ttylde what only it knows (where a
//! prompt starts, the text of each command, how it ended) with escape
//! sequences, once a script of Ttylde is loaded into it.
//!
//! The scripts are in `core/shell-integration`; the app ships that folder.
//! `integrate` sets up a command so that the shell loads them without any
//! of the user's files being changed:
//!
//! - zsh: `ZDOTDIR` points to `zsh/`, whose `.zshenv` puts the user's
//!   `ZDOTDIR` back and loads the user's files from there.
//! - fish: the folder goes first in `XDG_DATA_DIRS`, and fish loads
//!   `fish/vendor_conf.d/` by itself; the script takes the folder out again.
//!
//! Any other shell starts as it would without Ttylde.

use std::{
    ffi::{OsStr, OsString},
    path::Path,
};

use portable_pty::CommandBuilder;

/// The secret the scripts put in the sequences that carry a command: see
/// `integrate`.
pub const NONCE_VAR: &str = "TTYLDE_NONCE";

/// What fish reads when `XDG_DATA_DIRS` is not set, as the XDG
/// specification says: keeping it after our folder changes nothing for it.
const DEFAULT_DATA_DIRS: &str = "/usr/local/share:/usr/share";

/// The shells Ttylde has a script for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shell {
    Zsh,
    Fish,
}

impl Shell {
    /// Which shell a program is, from its name: `/bin/zsh`, `zsh`, or `-zsh`
    /// as a login shell names itself. `None` for any other program.
    pub fn of(program: &Path) -> Option<Shell> {
        let name = program.file_name()?.to_str()?;
        match name.strip_prefix('-').unwrap_or(name) {
            "zsh" => Some(Shell::Zsh),
            "fish" => Some(Shell::Fish),
            _ => None,
        }
    }
}

/// Sets up `cmd`, which runs `program`, to load the integration from
/// `scripts`. The nonce goes to every shell, integrated or not: the scripts
/// sourced by hand from a `.zshrc` read it too.
///
/// The nonce is a secret only the shell knows: the scripts take it out of
/// the environment, so the commands they run do not see it. Any program can
/// print an OSC 133 (a `cat` of a crafted file is enough); one that carries
/// the nonce comes from the script.
pub fn integrate(cmd: &mut CommandBuilder, program: &Path, scripts: &Path, nonce: &str) {
    cmd.env(NONCE_VAR, nonce);

    match Shell::of(program) {
        Some(Shell::Zsh) => {
            // An unset ZDOTDIR and an empty one are not the same to zsh.
            match cmd.get_env("ZDOTDIR").map(OsStr::to_owned) {
                Some(user) => cmd.env("TTYLDE_ZDOTDIR", user),
                None => cmd.env_remove("TTYLDE_ZDOTDIR"),
            }
            cmd.env("ZDOTDIR", scripts.join("zsh"));
        }
        Some(Shell::Fish) => {
            let user = cmd
                .get_env("XDG_DATA_DIRS")
                .filter(|dirs| !dirs.is_empty())
                .map(OsStr::to_owned)
                .unwrap_or_else(|| DEFAULT_DATA_DIRS.into());
            let mut dirs = OsString::from(scripts);
            dirs.push(":");
            dirs.push(user);
            cmd.env("XDG_DATA_DIRS", dirs);
            // What the script takes out of XDG_DATA_DIRS once loaded.
            cmd.env("TTYLDE_FISH_DATA_DIR", scripts);
        }
        None => {}
    }
}

/// A new nonce: 16 random bytes, in hex. From the system's random source;
/// if that cannot be read, from the clock and the process id, which still
/// differ from one session to the next.
pub fn nonce() -> String {
    let mut bytes = [0u8; 16];
    if !fill_random(&mut bytes) {
        use std::hash::{BuildHasher, RandomState};
        let time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let state = RandomState::new();
        let high = state.hash_one((time, std::process::id()));
        let low = state.hash_one(high);
        bytes[..8].copy_from_slice(&high.to_le_bytes());
        bytes[8..].copy_from_slice(&low.to_le_bytes());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(unix)]
fn fill_random(bytes: &mut [u8]) -> bool {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(bytes))
        .is_ok()
}
#[cfg(not(unix))]
fn fill_random(_bytes: &mut [u8]) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scripts() -> PathBuf {
        PathBuf::from("/app/shell-integration")
    }

    fn env(cmd: &CommandBuilder, key: &str) -> Option<String> {
        cmd.get_env(key).map(|v| v.to_string_lossy().into_owned())
    }

    #[test]
    fn shells_are_known_by_name() {
        assert_eq!(Shell::of(Path::new("/bin/zsh")), Some(Shell::Zsh));
        assert_eq!(Shell::of(Path::new("zsh")), Some(Shell::Zsh));
        assert_eq!(Shell::of(Path::new("-zsh")), Some(Shell::Zsh));
        assert_eq!(
            Shell::of(Path::new("/opt/homebrew/bin/fish")),
            Some(Shell::Fish)
        );
        assert_eq!(Shell::of(Path::new("/bin/bash")), None);
        assert_eq!(Shell::of(Path::new("/bin/zsh5")), None);
        assert_eq!(Shell::of(Path::new("")), None);
    }

    #[test]
    fn zsh_reads_its_first_file_from_the_scripts() {
        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.env_remove("ZDOTDIR");
        integrate(&mut cmd, Path::new("/bin/zsh"), &scripts(), "n");

        assert_eq!(
            env(&cmd, "ZDOTDIR").as_deref(),
            Some("/app/shell-integration/zsh")
        );
        // Unset before: the script unsets it again.
        assert_eq!(env(&cmd, "TTYLDE_ZDOTDIR"), None);
    }

    #[test]
    fn the_zdotdir_of_the_user_is_kept_for_the_script() {
        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.env("ZDOTDIR", "/Users/me/.config/zsh");
        integrate(&mut cmd, Path::new("/bin/zsh"), &scripts(), "n");

        assert_eq!(
            env(&cmd, "TTYLDE_ZDOTDIR").as_deref(),
            Some("/Users/me/.config/zsh")
        );
    }

    #[test]
    fn fish_finds_the_scripts_first_among_its_data_folders() {
        let mut cmd = CommandBuilder::new("fish");
        cmd.env("XDG_DATA_DIRS", "/opt/share");
        integrate(&mut cmd, Path::new("fish"), &scripts(), "n");

        assert_eq!(
            env(&cmd, "XDG_DATA_DIRS").as_deref(),
            Some("/app/shell-integration:/opt/share")
        );
        assert_eq!(
            env(&cmd, "TTYLDE_FISH_DATA_DIR").as_deref(),
            Some("/app/shell-integration")
        );
    }

    // Unset, fish would read the default folders: they stay after ours.
    #[test]
    fn fish_keeps_the_default_data_folders() {
        let mut cmd = CommandBuilder::new("fish");
        cmd.env_remove("XDG_DATA_DIRS");
        integrate(&mut cmd, Path::new("fish"), &scripts(), "n");

        assert_eq!(
            env(&cmd, "XDG_DATA_DIRS").as_deref(),
            Some("/app/shell-integration:/usr/local/share:/usr/share")
        );
    }

    #[test]
    fn other_shells_only_get_the_nonce() {
        let mut cmd = CommandBuilder::new("/bin/bash");
        cmd.env_remove("ZDOTDIR");
        cmd.env_remove("XDG_DATA_DIRS");
        integrate(&mut cmd, Path::new("/bin/bash"), &scripts(), "secret");

        assert_eq!(env(&cmd, NONCE_VAR).as_deref(), Some("secret"));
        assert_eq!(env(&cmd, "ZDOTDIR"), None);
        assert_eq!(env(&cmd, "XDG_DATA_DIRS"), None);
    }

    #[test]
    fn nonces_differ() {
        let a = nonce();
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(a, nonce());
    }
}
