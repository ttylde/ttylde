// Avoids the console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod saved;
mod sessions;

use std::path::PathBuf;

use sessions::Sessions;
use tauri::Manager;
use ttylde_core::config::{self, Config};

/// Which config file to read. A debug build, the one `tauri dev` runs, reads
/// its own `config-dev.toml` when there is one, and the one of the installed
/// app otherwise: options being tried go there, and the installed app, which
/// does not know them yet, never sees them.
fn config_path() -> Option<PathBuf> {
    let path = config::default_path()?;
    Some(if cfg!(debug_assertions) {
        dev_config(path)
    } else {
        path
    })
}

// `config-dev.toml` next to `path`, if it is there.
fn dev_config(path: PathBuf) -> PathBuf {
    let dev = path.with_file_name("config-dev.toml");
    if dev.is_file() {
        dev
    } else {
        path
    }
}

fn main() {
    let config = config_path()
        .map(|path| Config::load(&path))
        .unwrap_or_else(|| Ok(Config::default()))
        .unwrap_or_else(|e| {
            eprintln!("ttylde: {e}");
            Config::default()
        });

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
            app.manage(Sessions::new(scripts));
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
            sessions::session_select_clear,
            sessions::session_selection_text,
            sessions::session_close,
            sessions::session_focus,
            sessions::restore_runs_by_itself,
            saved::state_load,
            saved::state_save,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Ttylde");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dev_config_is_read_only_when_it_is_there() {
        let folder = std::env::temp_dir().join(format!("ttylde-config-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("config.toml");
        let dev = folder.join("config-dev.toml");
        let _ = std::fs::remove_file(&dev);

        assert_eq!(dev_config(path.clone()), path);
        std::fs::write(&dev, "").unwrap();
        assert_eq!(dev_config(path), dev);
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
