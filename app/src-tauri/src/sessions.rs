//! The bridge between core sessions and the webview.
//!
//! Every command is thin: it converts the arguments coming from JavaScript
//! and forwards them to the core. Events go back to the webview through a
//! `Channel`.

use std::collections::HashMap;
use std::sync::Mutex;

use portable_pty::CommandBuilder;
use tauri::ipc::Channel;
use tauri::State;
use ttylde_core::emulator::{SelectionKind, SelectionSide};
use ttylde_core::input::{Key, Mods};
use ttylde_core::session::{Session, SessionEvent};
use ttylde_core::theme::Theme;

const NO_SUCH_SESSION: &str = "no such session";

/// Registry of open sessions, shared by the commands.
#[derive(Default)]
pub struct Sessions {
    next_id: Mutex<u32>,
    open: Mutex<HashMap<u32, Session>>,
}

impl Sessions {
    fn allocate_id(&self) -> u32 {
        let mut next = self.next_id.lock().unwrap();
        let id = *next;
        *next += 1;
        id
    }
}

#[tauri::command]
pub fn session_open(
    state: State<'_, Sessions>,
    cols: u16,
    rows: u16,
    on_event: Channel<SessionEvent>,
) -> Result<u32, String> {
    // The user's shell, launched as a login shell like Terminal.app does.
    let mut cmd = CommandBuilder::new_default_prog();
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Ttylde");

    let session = Session::spawn(
        cmd,
        cols,
        rows,
        Theme::default(),
        10_000,
        // If the webview is gone the send fails: nothing to do about it.
        Box::new(move |event| {
            let _ = on_event.send(event);
        }),
    )
    .map_err(|e| e.to_string())?;

    let id = state.allocate_id();
    state.open.lock().unwrap().insert(id, session);
    Ok(id)
}

#[tauri::command]
pub fn session_write(state: State<'_, Sessions>, id: u32, text: String) -> Result<(), String> {
    let mut open = state.open.lock().unwrap();
    let session = open.get_mut(&id).ok_or(NO_SUCH_SESSION)?;
    session.write(text.as_bytes()).map_err(|e| e.to_string())
}

/// A special key or a combination: the core does the encoding.
/// Returns `false` if the key means nothing to the terminal.
#[tauri::command]
pub fn session_key(
    state: State<'_, Sessions>,
    id: u32,
    key: Key,
    mods: Mods,
) -> Result<bool, String> {
    let mut open = state.open.lock().unwrap();
    let session = open.get_mut(&id).ok_or(NO_SUCH_SESSION)?;
    session.key(key, mods).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_paste(state: State<'_, Sessions>, id: u32, text: String) -> Result<(), String> {
    let mut open = state.open.lock().unwrap();
    let session = open.get_mut(&id).ok_or(NO_SUCH_SESSION)?;
    session.paste(&text).map_err(|e| e.to_string())
}

/// Mouse wheel: positive rows go up (back into the history). The core decides
/// whether to move the view or, on the alternate screen, send arrow keys.
#[tauri::command]
pub fn session_scroll(state: State<'_, Sessions>, id: u32, delta: i32) -> Result<(), String> {
    let mut open = state.open.lock().unwrap();
    let session = open.get_mut(&id).ok_or(NO_SUCH_SESSION)?;
    session.scroll(delta).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_resize(
    state: State<'_, Sessions>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut open = state.open.lock().unwrap();
    let session = open.get_mut(&id).ok_or(NO_SUCH_SESSION)?;
    session.resize(cols, rows).map_err(|e| e.to_string())
}

/// Start of a mouse selection. `row`/`col` are screen coordinates; `side`
/// says which half of the cell the click landed in.
#[tauri::command]
pub fn session_select_start(
    state: State<'_, Sessions>,
    id: u32,
    row: u16,
    col: u16,
    side: SelectionSide,
    kind: SelectionKind,
) -> Result<(), String> {
    let open = state.open.lock().unwrap();
    let session = open.get(&id).ok_or(NO_SUCH_SESSION)?;
    session.select_start(row, col, side, kind);
    Ok(())
}

#[tauri::command]
pub fn session_select_update(
    state: State<'_, Sessions>,
    id: u32,
    row: u16,
    col: u16,
    side: SelectionSide,
) -> Result<(), String> {
    let open = state.open.lock().unwrap();
    let session = open.get(&id).ok_or(NO_SUCH_SESSION)?;
    session.select_update(row, col, side);
    Ok(())
}

#[tauri::command]
pub fn session_select_clear(state: State<'_, Sessions>, id: u32) -> Result<(), String> {
    let open = state.open.lock().unwrap();
    let session = open.get(&id).ok_or(NO_SUCH_SESSION)?;
    session.select_clear();
    Ok(())
}

/// The selected text, ready for the clipboard. `None` without a selection.
#[tauri::command]
pub fn session_selection_text(
    state: State<'_, Sessions>,
    id: u32,
) -> Result<Option<String>, String> {
    let open = state.open.lock().unwrap();
    let session = open.get(&id).ok_or(NO_SUCH_SESSION)?;
    Ok(session.selection_text())
}

/// Removes the session from the registry: its `Drop` kills the shell.
#[tauri::command]
pub fn session_close(state: State<'_, Sessions>, id: u32) {
    state.open.lock().unwrap().remove(&id);
}
