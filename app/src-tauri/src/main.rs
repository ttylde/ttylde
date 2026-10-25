// Avoids the console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod places;
mod saved;
mod sessions;

use sessions::Sessions;
use tauri::Manager;
use ttylde_core::config::Config;
use ttylde_core::history::{Filter, History, Limits};

fn main() {
    let config = places::config()
        .map(|path| Config::load(&path))
        .unwrap_or_else(|| Ok(Config::default()))
        .unwrap_or_else(|e| {
            eprintln!("ttylde: {e}");
            Config::default()
        });

    let history = open_history(&config);

    tauri::Builder::default()
        .manage(config)
        .setup(|app| {
            // Copied there from core/shell-integration, by `tauri dev` too.
            let scripts = app
                .path()
                .resource_dir()
                .map(|dir| dir.join("shell-integration"))
                .inspect_err(|e| eprintln!("ttylde: no shell integration: {e}"))
                .ok();
            app.manage(Sessions::new(scripts, history));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sessions::config_font,
            sessions::session_open,
            sessions::session_write,
            sessions::session_key,
            sessions::session_mouse,
            sessions::session_paste,
            sessions::session_scroll,
            sessions::session_resize,
            sessions::session_select_start,
            sessions::session_select_update,
            sessions::session_select_scroll,
            sessions::session_select_clear,
            sessions::session_selection_text,
            sessions::session_jump_to_prompt,
            sessions::session_last_output,
            sessions::session_output_tail,
            sessions::session_select_last_output,
            sessions::session_close,
            sessions::session_set_space,
            sessions::history_commands,
            sessions::history_forget,
            sessions::history_clear,
            sessions::history_count,
            sessions::session_focus,
            sessions::restore_runs_by_itself,
            saved::state_load,
            saved::state_save,
            saved::favorites_load,
            saved::favorites_save,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Ttylde");
}

/// The history of commands, as the config file asks. Turned off, or a file
/// that cannot be opened, is none: the app works the same, saving nothing.
fn open_history(config: &Config) -> Option<History> {
    if !config.history.enabled {
        return None;
    }
    let path = places::history()?;
    let home = std::env::home_dir();
    let filter = Filter::new(&config.history, home.as_deref());
    History::open(&path, filter, Limits::from(&config.history))
        .inspect_err(|e| eprintln!("ttylde: {e}"))
        .ok()
}
