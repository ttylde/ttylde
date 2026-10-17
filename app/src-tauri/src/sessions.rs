//! The bridge between core sessions and the webview.
//!
//! Every command is thin: it converts the arguments coming from JavaScript
//! and forwards them to the core. Events go back to the webview through a
//! `Channel`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use portable_pty::CommandBuilder;
use tauri::ipc::Channel;
use tauri::State;
use ttylde_core::config::{Config, Font};
use ttylde_core::emulator::{SelectionKind, SelectionSide};
use ttylde_core::history::{Command, History, Recorder};
use ttylde_core::input::{Key, Mods, MouseEvent};
use ttylde_core::session::{Session, SessionEvent};
use ttylde_core::shell;

const NO_SUCH_SESSION: &str = "no such session";

/// Registry of open sessions, shared by the commands.
pub struct Sessions {
    next_id: AtomicU32,
    open: Mutex<HashMap<u32, Session>>,
    /// The shell integration scripts the app ships, `None` if the folder of
    /// its resources is not known: the shells then start without them.
    scripts: Option<PathBuf>,
    /// Where the commands that end are kept; `None`: nowhere, it is off or
    /// could not be opened.
    history: Option<Arc<Mutex<History>>>,
    /// What each session is in the middle of, for the history.
    recorders: Mutex<HashMap<u32, Arc<Mutex<Recorder>>>>,
}

impl Sessions {
    pub fn new(scripts: Option<PathBuf>, history: Option<History>) -> Self {
        Sessions {
            next_id: AtomicU32::new(0),
            open: Mutex::new(HashMap::new()),
            scripts,
            history: history.map(|history| Arc::new(Mutex::new(history))),
            recorders: Mutex::new(HashMap::new()),
        }
    }

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
    let program = shell.unwrap_or_else(|| CommandBuilder::new_default_prog().get_shell());
    let mut cmd = CommandBuilder::new(&program);
    cmd.arg("-l");

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
    if let (true, Some(scripts)) = (config.shell_integration, &state.scripts) {
        shell::integrate(&mut cmd, program.as_ref(), scripts, &shell::nonce());
    }

    let recorder = Arc::new(Mutex::new(Recorder::default()));
    let history = state.history.clone();
    let recording = Arc::clone(&recorder);
    let session = Session::spawn(
        cmd,
        cols,
        rows,
        config.theme.clone(),
        10_000,
        Box::new(move |event| {
            if let Some(history) = &history {
                let ended = recording.lock().unwrap().observe(&event, now());
                if let Some(record) = ended {
                    if let Err(e) = history.lock().unwrap().record(&record) {
                        eprintln!("ttylde: {e}");
                    }
                }
            }
            // If the webview is gone the send fails: nothing to do about it.
            let _ = on_event.send(event);
        }),
    )
    .map_err(|e| e.to_string())?;

    let id = state.allocate_id();
    state.open.lock().unwrap().insert(id, session);
    state.recorders.lock().unwrap().insert(id, recorder);
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
    state.recorders.lock().unwrap().remove(&id);
}

/// The tab of the session is now in the space `space`; `None`: pinned, or
/// in no space. The history records it with the commands that end.
#[tauri::command]
pub fn session_set_space(state: State<'_, Sessions>, id: u32, space: Option<u32>) {
    if let Some(recorder) = state.recorders.lock().unwrap().get(&id) {
        recorder.lock().unwrap().set_space(space);
    }
}

/// The commands of the history, one each, for the palette: those of
/// `space` (`None`: of every space), matched against `text` as a fuzzy
/// search does, or the newest first with no text. None with the history off.
#[tauri::command]
pub fn history_commands(
    state: State<'_, Sessions>,
    space: Option<u32>,
    text: String,
    limit: usize,
) -> Result<Vec<Command>, String> {
    let Some(history) = &state.history else {
        return Ok(Vec::new());
    };
    let history = history.lock().unwrap();
    history
        .commands(space, &text, limit)
        .map_err(|e| e.to_string())
}

/// Lets every run of `command` in `space` go from the history.
#[tauri::command]
pub fn history_forget(
    state: State<'_, Sessions>,
    command: String,
    space: Option<u32>,
) -> Result<(), String> {
    let Some(history) = &state.history else {
        return Ok(());
    };
    let history = history.lock().unwrap();
    history
        .forget(&command, space)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Empties the history of `space` (`None`: all of it). Returns how many
/// commands went.
#[tauri::command]
pub fn history_clear(state: State<'_, Sessions>, space: Option<u32>) -> Result<usize, String> {
    let Some(history) = &state.history else {
        return Ok(0);
    };
    let history = history.lock().unwrap();
    history.clear_in(space).map_err(|e| e.to_string())
}

/// How many commands the history of `space` has, one each.
#[tauri::command]
pub fn history_count(state: State<'_, Sessions>, space: Option<u32>) -> Result<usize, String> {
    let Some(history) = &state.history else {
        return Ok(0);
    };
    let history = history.lock().unwrap();
    history.count(space).map_err(|e| e.to_string())
}

// Milliseconds since 1970, as the history keeps time.
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

/// The window gained or lost the focus, or the tab became the visible one.
#[tauri::command]
pub fn session_focus(state: State<'_, Sessions>, id: u32, focused: bool) -> Result<(), String> {
    state
        .with_session(id, |session| session.focus(focused))?
        .map_err(|e| e.to_string())
}

/// Whether a command that was running when its space was closed starts
/// again by itself on resume, as the config file says, or waits for Enter.
#[tauri::command]
pub fn restore_runs_by_itself(config: State<'_, Config>, command: String) -> bool {
    config.restore.runs_by_itself(&command)
}

/// Font family and size from the config file, for the renderer.
#[tauri::command]
pub fn config_font(config: State<'_, Config>) -> Font {
    config.font.clone()
}
