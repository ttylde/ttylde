//! The spaces and tabs the app was showing, and the saved commands, kept
//! across restarts: the webview hands them over after every change and asks
//! for them at start.

use ttylde_core::error::Error;
use ttylde_core::favorites::{self, Favorites};
use ttylde_core::state::{self, State};

use crate::places;

/// What was saved last time. Nothing saved, or nowhere to save it, is an
/// empty state; so is a file that cannot be read, which is set aside first
/// so that the next save does not write over it.
#[tauri::command]
pub async fn state_load() -> State {
    let Some(path) = places::state() else {
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
    let path = places::state().ok_or("no home folder to save the state in")?;
    state::save(&state, &path).map_err(|e| e.to_string())
}

/// The saved commands. None, or a file that cannot be read, which is set
/// aside as the state is, is an empty list.
#[tauri::command]
pub async fn favorites_load() -> Favorites {
    let Some(path) = places::favorites() else {
        return Favorites::default();
    };
    match favorites::load(&path) {
        Ok(saved) => saved,
        Err(e) => {
            eprintln!("ttylde: {e}");
            if matches!(e, Error::State(_)) {
                if let Err(e) = state::set_aside(&path) {
                    eprintln!("ttylde: cannot set the saved commands aside: {e}");
                }
            }
            Favorites::default()
        }
    }
}

/// Writes the saved commands, whole, in the order they are shown.
#[tauri::command]
pub async fn favorites_save(favorites: Favorites) -> Result<(), String> {
    let path = places::favorites().ok_or("no home folder to save the commands in")?;
    favorites::save(&favorites, &path).map_err(|e| e.to_string())
}
