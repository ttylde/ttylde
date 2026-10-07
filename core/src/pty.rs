use std::io::{self, Read, Write};

use portable_pty::{native_pty_system, Child, CommandBuilder, ExitStatus, MasterPty, PtySize};

use crate::error::Result;

pub struct Pty {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
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
            writer,
            master: pair.master,
        })
    }

    pub fn reader(&self) -> Result<Box<dyn Read + Send>> {
        Ok(self.master.try_clone_reader()?)
    }

    pub fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        Ok(self.master.resize(PtySize {
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
}
