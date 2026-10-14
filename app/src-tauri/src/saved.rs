//! The spaces and tabs the app was showing, kept across restarts: the
//! webview hands them over after every change and asks for them at start.

use ttylde_core::error::Error;
use ttylde_core::state::{self, State};

/// What was saved last time. Nothing saved, or nowhere to save it, is an
/// empty state; so is a file that cannot be read, which is set aside first
/// so that the next save does not write over it.
#[tauri::command]
pub async fn state_load() -> State {
    let Some(path) = state::default_path() else {
        return State::default();
    };
    match state::load(&path) {
        Ok(saved) => saved,
        Err(e) => {
            eprintln!("ttylde: {e}");
            if matches!(e, Error::State(_)) {
                if let Err(e) = state::set_aside(&path) {
                    eprintln!("ttylde: cannot set the state file aside: {e}");
                }
            }
            State::default()
        }
    }
}

/// Writes what the app shows now. Async: it runs off the main thread.
#[tauri::command]
pub async fn state_save(state: State) -> Result<(), String> {
    let path = state::default_path().ok_or("no home folder to save the state in")?;
    state::save(&state, &path).map_err(|e| e.to_string())
}
