//! Where the app keeps its files.
//!
//! The installed app follows XDG: the config under `$XDG_CONFIG_HOME`, the
//! state under `$XDG_STATE_HOME`. A debug build, the one `tauri dev` runs,
//! keeps all of them in `.dev/` at the root of the repository, out of git:
//! trying a change touches nothing outside the project, `rm -rf .dev` starts
//! over, and each worktree has its own. The history goes there too. Its
//! config is `.dev/config.toml`,
//! which no one has until they write it: `dev/config.example.toml` is where
//! to start.

use std::path::PathBuf;

/// The config file to read.
pub fn config() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    return Some(dev_folder().join("config.toml"));
    #[cfg(not(debug_assertions))]
    return ttylde_core::config::default_path();
}

/// The history of commands, a SQLite file.
pub fn history() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    return Some(dev_folder().join("history.db"));
    #[cfg(not(debug_assertions))]
    return ttylde_core::history::default_path();
}

/// The state file to read and write.
pub fn state() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    return Some(dev_folder().join("state.toml"));
    #[cfg(not(debug_assertions))]
    return ttylde_core::state::default_path();
}

// `.dev/` in the repository this build was compiled from. Release builds do
// not have the path in them.
#[cfg(debug_assertions)]
fn dev_folder() -> PathBuf {
    let crate_folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    crate_folder
        .ancestors()
        .nth(2)
        .expect("app/src-tauri is two folders under the root")
        .join(".dev")
}
