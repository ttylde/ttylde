use std::{
    io::{self, Read, Write},
    sync::{Arc, Mutex},
};

use portable_pty::{native_pty_system, Child, CommandBuilder, ExitStatus, MasterPty, PtySize};

use crate::error::Result;

#[derive(Clone)]
pub struct PtyWriter(Arc<Mutex<Box<dyn Write + Send>>>);

impl PtyWriter {
    pub fn write(&self, bytes: &[u8]) -> io::Result<()> {
        let mut writer = self.0.lock().unwrap();
        writer.write_all(bytes)?;
        writer.flush()
    }
}

/// Asks the terminal which process is using it.
#[derive(Clone)]
pub struct PtyProbe(Arc<Mutex<Box<dyn MasterPty + Send>>>);

impl PtyProbe {
    /// The process in the foreground of the terminal, if the system tells.
    #[cfg(unix)]
    pub fn foreground_pid(&self) -> Option<u32> {
        self.0
            .lock()
            .unwrap()
            .process_group_leader()
            .and_then(|pid| u32::try_from(pid).ok())
    }
    #[cfg(not(unix))]
    pub fn foreground_pid(&self) -> Option<u32> {
        None
    }
}

pub struct Pty {
    master: PtyProbe,
    child: Box<dyn Child + Send + Sync>,
    writer: PtyWriter,
}

impl Pty {
    pub fn spawn(cmd: CommandBuilder, cols: u16, rows: u16) -> Result<Self> {
        let pair = native_pty_system().openpty(PtySize {
            rows,
            cols,
            pixel_height: 0,
            pixel_width: 0,
        })?;

        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);
        let writer = pair.master.take_writer()?;

        Ok(Pty {
            child,
            writer: PtyWriter(Arc::new(Mutex::new(writer))),
            master: PtyProbe(Arc::new(Mutex::new(pair.master))),
        })
    }

    pub fn writer(&self) -> PtyWriter {
        self.writer.clone()
    }

    /// The process the PTY was started with.
    pub fn pid(&self) -> Option<u32> {
        self.child.process_id()
    }

    pub fn probe(&self) -> PtyProbe {
        self.master.clone()
    }

    pub fn reader(&self) -> Result<Box<dyn Read + Send>> {
        Ok(self.master.0.lock().unwrap().try_clone_reader()?)
    }

    pub fn write(&self, bytes: &[u8]) -> io::Result<()> {
        self.writer.write(bytes)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        Ok(self.master.0.lock().unwrap().resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?)
    }

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait()
    }

    pub fn kill(&mut self) -> io::Result<()> {
        self.child.kill()
    }
}

#[cfg(test)]
mod tests {

    use super::*;

    #[test]
    fn run_echo_command() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("read IN; echo \"got $IN\"");

        let mut pty = Pty::spawn(cmd, 80, 24).unwrap();
        let mut reader = pty.reader().unwrap();
        pty.write(b"Dhkasd987\n").unwrap();

        let mut output: Vec<u8> = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let out = reader.read(&mut buf);
            match out {
                Ok(0) => break,
                Ok(n) => output.extend_from_slice(&buf[..n]),
                Err(_) => break,
            }
        }

        pty.wait().unwrap();
        let str_out = String::from_utf8_lossy(&output);
        assert!(str_out.contains("got Dhkasd987"));
    }

    // A clone of the writer reaches the shell from another thread.
    #[test]
    fn cloned_writer_writes_from_another_thread() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("read IN; echo \"got $IN\"");

        let mut pty = Pty::spawn(cmd, 80, 24).unwrap();
        let mut reader = pty.reader().unwrap();
        let writer = pty.writer();
        std::thread::spawn(move || writer.write(b"ping\n").unwrap())
            .join()
            .unwrap();

        let mut output: Vec<u8> = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let out = reader.read(&mut buf);
            match out {
                Ok(0) => break,
                Ok(n) => output.extend_from_slice(&buf[..n]),
                Err(_) => break,
            }
        }

        pty.wait().unwrap();
        let str_out = String::from_utf8_lossy(&output);
        assert!(str_out.contains("got ping"));
    }

    // At a prompt the process in the foreground is the shell itself.
    #[cfg(unix)]
    #[test]
    fn the_foreground_process_is_the_command() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "read IN"]);
        let mut pty = Pty::spawn(cmd, 80, 24).unwrap();

        let shell = pty.child.process_id();
        assert!(shell.is_some());
        assert_eq!(pty.probe().foreground_pid(), shell);

        pty.kill().unwrap();
        pty.wait().unwrap();
    }
}
