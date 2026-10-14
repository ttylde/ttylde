// Avoids the console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod saved;
mod sessions;

use sessions::Sessions;
use ttylde_core::config::{self, Config};

fn main() {
    let config = config::default_path()
        .map(|path| Config::load(&path))
        .unwrap_or_else(|| Ok(Config::default()))
        .unwrap_or_else(|e| {
            eprintln!("ttylde: {e}");
            Config::default()
        });

    tauri::Builder::default()
        .manage(Sessions::default())
        .manage(config)
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
            sessions::session_select_clear,
            sessions::session_selection_text,
            sessions::session_close,
            sessions::session_focus,
            saved::state_load,
            saved::state_save,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Ttylde");
}
