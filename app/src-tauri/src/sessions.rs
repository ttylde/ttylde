//! The bridge between core sessions and the webview.
//!
//! Every command is thin: it converts the arguments coming from JavaScript
//! and forwards them to the core. Events go back to the webview through a
//! `Channel`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use portable_pty::CommandBuilder;
use tauri::ipc::Channel;
use tauri::State;
use ttylde_core::config::{Config, Font};
use ttylde_core::emulator::{SelectionKind, SelectionSide};
use ttylde_core::input::{Key, Mods, MouseEvent};
use ttylde_core::session::{Session, SessionEvent};

const NO_SUCH_SESSION: &str = "no such session";

/// Registry of open sessions, shared by the commands.
#[derive(Default)]
pub struct Sessions {
    next_id: AtomicU32,
    open: Mutex<HashMap<u32, Session>>,
}

impl Sessions {
    fn allocate_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    fn with_session<R>(&self, id: u32, f: impl FnOnce(&mut Session) -> R) -> Result<R, String> {
        let mut open = self.open.lock().unwrap();
        let session = open.get_mut(&id).ok_or(NO_SUCH_SESSION)?;
        Ok(f(session))
    }
}

#[tauri::command]
pub fn session_open(
    state: State<'_, Sessions>,
    config: State<'_, Config>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    on_event: Channel<SessionEvent>,
) -> Result<u32, String> {
    // The user's shell, launched as a login shell like Terminal.app does.
    let mut cmd = match shell {
        Some(shell) => {
            let mut cmd = CommandBuilder::new(&shell);
            cmd.arg("-l");
            cmd
        }
        None => CommandBuilder::new_default_prog(),
    };

    let home = std::env::home_dir();
    if let Some(cwd) = cwd {
        if let Some(home) = home {
            let folder = ttylde_core::cwd::expand_home(&cwd, &home);
            if folder.is_dir() {
                cmd.cwd(&folder);
            }
        }
    }

    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Ttylde");

    let session = Session::spawn(
        cmd,
        cols,
        rows,
        config.theme.clone(),
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
    state
        .with_session(id, |session| session.write(text.as_bytes()))?
        .map_err(|e| e.to_string())
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
    state
        .with_session(id, |session| session.key(key, mods))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_paste(state: State<'_, Sessions>, id: u32, text: String) -> Result<(), String> {
    state
        .with_session(id, |session| session.paste(&text))?
        .map_err(|e| e.to_string())
}

/// Mouse wheel: positive rows go up (back into the history). The core decides
/// whether to move the view or, on the alternate screen, send arrow keys.
#[tauri::command]
pub fn session_scroll(state: State<'_, Sessions>, id: u32, delta: i32) -> Result<(), String> {
    state
        .with_session(id, |session| session.scroll(delta))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_resize(
    state: State<'_, Sessions>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .with_session(id, |session| session.resize(cols, rows))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_mouse(
    state: State<'_, Sessions>,
    id: u32,
    event: MouseEvent,
) -> Result<bool, String> {
    state
        .with_session(id, |session| session.mouse(event))?
        .map_err(|e| e.to_string())
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
    state.with_session(id, |session| session.select_start(row, col, side, kind))
}

#[tauri::command]
pub fn session_select_update(
    state: State<'_, Sessions>,
    id: u32,
    row: u16,
    col: u16,
    side: SelectionSide,
) -> Result<(), String> {
    state.with_session(id, |session| session.select_update(row, col, side))
}

#[tauri::command]
pub fn session_select_clear(state: State<'_, Sessions>, id: u32) -> Result<(), String> {
    state.with_session(id, |session| session.select_clear())
}

/// The selected text, ready for the clipboard. `None` without a selection.
#[tauri::command]
pub fn session_selection_text(
    state: State<'_, Sessions>,
    id: u32,
) -> Result<Option<String>, String> {
    state.with_session(id, |session| session.selection_text())
}

/// Removes the session from the registry: its `Drop` kills the shell.
#[tauri::command]
pub fn session_close(state: State<'_, Sessions>, id: u32) {
    state.open.lock().unwrap().remove(&id);
}

/// The window gained or lost the focus, or the tab became the visible one.
#[tauri::command]
pub fn session_focus(state: State<'_, Sessions>, id: u32, focused: bool) -> Result<(), String> {
    state
        .with_session(id, |session| session.focus(focused))?
        .map_err(|e| e.to_string())
}

/// Font family and size from the config file, for the renderer.
#[tauri::command]
pub fn config_font(config: State<'_, Config>) -> Font {
    config.font.clone()
}
