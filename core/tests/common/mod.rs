//! What the shell integration tests share: a home of their own, and a
//! shell in a pty whose output they can wait on.

use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use portable_pty::CommandBuilder;
use ttylde_core::pty::Pty;

const TIMEOUT: Duration = Duration::from_secs(10);

pub const NONCE: &str = "0123456789abcdef";

pub fn scripts() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("shell-integration")
}

/// A home of its own for each test, with the given files in it.
pub fn home(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let home = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("ttylde-shell-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    for (path, text) in files {
        let path = home.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    fs::create_dir_all(&home).unwrap();
    home
}

/// A shell in a pty, and everything it printed so far.
pub struct Shell {
    pub pty: Pty,
    output: Arc<Mutex<Vec<u8>>>,
}

impl Shell {
    pub fn start(cmd: CommandBuilder) -> Shell {
        let pty = Pty::spawn(cmd, 80, 24).unwrap();
        let mut reader = pty.reader().unwrap();
        let output = Arc::new(Mutex::new(Vec::new()));
        let shared = Arc::clone(&output);
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                shared.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        });
        Shell { pty, output }
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.output.lock().unwrap()).into_owned()
    }

    /// Waits until `needle` has been printed `count` times in all.
    pub fn wait_for(&self, needle: &str, count: usize) -> String {
        let start = Instant::now();
        loop {
            let text = self.text();
            if text.matches(needle).count() >= count {
                return text;
            }
            assert!(
                start.elapsed() < TIMEOUT,
                "{needle:?} not printed {count} times; output:\n{text:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Types `line` once `ready` has been printed `count` times.
    pub fn type_after(&self, ready: &str, count: usize, line: &str) {
        self.wait_for(ready, count);
        self.pty.write(format!("{line}\r").as_bytes()).unwrap();
    }
}

impl Drop for Shell {
    fn drop(&mut self) {
        let _ = self.pty.kill();
    }
}
