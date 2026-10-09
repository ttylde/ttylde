// Avoids the console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sessions;

use sessions::Sessions;

fn main() {
    tauri::Builder::default()
        .manage(Sessions::default())
        .invoke_handler(tauri::generate_handler![
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Ttylde");
}
