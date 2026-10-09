use portable_pty::CommandBuilder;
use serde::Serialize;
use std::{
    io,
    sync::{Arc, Mutex},
};

use crate::{
    emulator::{Emulator, EmulatorEvent, SelectionKind, SelectionSide},
    error::Result,
    frame::Frame,
    input::{encode_key, encode_paste, Key, Mods},
    pty::Pty,
    theme::Theme,
};

/// Serialized as `{ "type": "Frame", "data": {...} }` and `{ "type": "Exit" } and ...`.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum SessionEvent {
    Frame(Frame),
    Title(String),
    TitleReset,
    Bell,
    Exit,
}

pub type EventHandler = Box<dyn Fn(SessionEvent) + Send + Sync + 'static>;

pub struct Session {
    pty: Pty,
    emulator: Arc<Mutex<Emulator>>,
    on_event: Arc<EventHandler>,
}

impl Session {
    pub fn spawn(
        cmd: CommandBuilder,
        cols: u16,
        rows: u16,
        theme: Theme,
        history: usize,
        on_event: EventHandler,
    ) -> Result<Self> {
        let pty = Pty::spawn(cmd, cols, rows)?;
        let mut reader = pty.reader()?;
        let writer = pty.writer();
        let emulator = Arc::new(Mutex::new(Emulator::new(
            cols as usize,
            rows as usize,
            theme,
            history,
        )));

        let shared = Arc::clone(&emulator);
        let on_event = Arc::new(on_event);
        let on_event_for_thread = Arc::clone(&on_event);

        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        on_event_for_thread(SessionEvent::Exit);
                        break;
                    }
                    Ok(n) => {
                        let (frame, events) = {
                            let mut emu = shared.lock().unwrap();
                            emu.feed(&buf[..n]);
                            (emu.frame(), emu.take_events())
                        };

                        for event in events {
                            match event {
                                EmulatorEvent::Write(bytes) => {
                                    let _ = writer.write(&bytes);
                                }
                                EmulatorEvent::Title(title) => {
                                    on_event_for_thread(SessionEvent::Title(title))
                                }
                                EmulatorEvent::ResetTitle => {
                                    on_event_for_thread(SessionEvent::TitleReset)
                                }
                                EmulatorEvent::Bell => on_event_for_thread(SessionEvent::Bell),
                            }
                        }

                        if let Some(frame) = frame {
                            on_event_for_thread(SessionEvent::Frame(frame));
                        }
                    }
                }
            }
        });

        Ok(Session {
            pty,
            emulator,
            on_event,
        })
    }

    pub fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        {
            let mut emulator = self.emulator.lock().unwrap();
            emulator.scroll_to_bottom();
            emulator.clear_selection();
        }
        self.pty.write(bytes)
    }

    /// Encodes a key according to the emulator state and writes it to the PTY.
    /// Returns `false` if the key has no encoding.
    pub fn key(&mut self, key: Key, mods: Mods) -> io::Result<bool> {
        let mode = {
            let mut emulator = self.emulator.lock().unwrap();
            emulator.scroll_to_bottom();
            emulator.clear_selection();
            emulator.input_mode()
        };

        match encode_key(key, mods, mode) {
            Some(bytes) => self.pty.write(&bytes).map(|_| true),
            None => Ok(false),
        }
    }

    pub fn paste(&mut self, text: &str) -> io::Result<()> {
        let mode = {
            let mut emulator = self.emulator.lock().unwrap();
            emulator.scroll_to_bottom();
            emulator.clear_selection();
            emulator.input_mode()
        };

        self.pty.write(&encode_paste(text, mode))
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.pty.resize(cols, rows)?;
        self.emulator
            .lock()
            .unwrap()
            .resize(cols as usize, rows as usize);

        Ok(())
    }

    pub fn scroll(&mut self, delta: i32) -> io::Result<()> {
        let mode = {
            let mut emulator = self.emulator.lock().unwrap();
            let mode = emulator.input_mode();
            if !mode.alt_screen {
                emulator.scroll(delta);
            }
            mode
        };

        if mode.alt_screen {
            if mode.alternate_scroll {
                let key = if delta < 0 { Key::Down } else { Key::Up };

                let sequence = encode_key(key, Mods::default(), mode)
                    .expect("arrow keys always have an encoding");
                let bytes = sequence.repeat(delta.unsigned_abs() as usize);
                self.pty.write(&bytes)?;
            }

            return Ok(());
        }

        self.emit_frame();
        Ok(())
    }

    /// Starts a selection at the given cell (screen coordinates).
    pub fn select_start(&self, row: u16, col: u16, side: SelectionSide, kind: SelectionKind) {
        self.emulator
            .lock()
            .unwrap()
            .start_selection(row, col, side, kind);
        self.emit_frame();
    }

    /// Extends the current selection to the given cell.
    pub fn select_update(&self, row: u16, col: u16, side: SelectionSide) {
        self.emulator
            .lock()
            .unwrap()
            .update_selection(row, col, side);
        self.emit_frame();
    }

    pub fn select_clear(&self) {
        self.emulator.lock().unwrap().clear_selection();
        self.emit_frame();
    }

    pub fn selection_text(&self) -> Option<String> {
        self.emulator.lock().unwrap().selection_text()
    }

    /// Sends the callback the frame produced by a local change (scroll,
    /// selection) that the reader thread would never see.
    fn emit_frame(&self) {
        let frame = self.emulator.lock().unwrap().frame();
        if let Some(frame) = frame {
            (self.on_event)(SessionEvent::Frame(frame));
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.pty.kill();
    }
}
#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    const TIMEOUT: Duration = Duration::from_secs(5);

    /// Creates a session that sends its events over a channel.
    fn spawn_with_channel(cmd: CommandBuilder) -> (Session, mpsc::Receiver<SessionEvent>) {
        let (tx, rx) = mpsc::channel();
        let on_event: EventHandler = Box::new(move |event| {
            tx.send(event).unwrap();
        });
        let session = Session::spawn(cmd, 20, 5, Theme::default(), 100, on_event).unwrap();
        (session, rx)
    }

    /// Collects frames until the session exits.
    fn collect_until_exit(rx: &mpsc::Receiver<SessionEvent>) -> Vec<Frame> {
        let mut frames = Vec::new();
        loop {
            match rx
                .recv_timeout(TIMEOUT)
                .expect("no event within the timeout")
            {
                SessionEvent::Frame(frame) => frames.push(frame),
                SessionEvent::Exit => return frames,
                _ => continue,
            }
        }
    }

    /// Waits for the first frame matching `pred`, discarding the others.
    fn wait_for_frame(rx: &mpsc::Receiver<SessionEvent>, pred: impl Fn(&Frame) -> bool) -> Frame {
        loop {
            match rx
                .recv_timeout(TIMEOUT)
                .expect("no event within the timeout")
            {
                SessionEvent::Frame(frame) if pred(&frame) => return frame,
                SessionEvent::Exit => panic!("the session exited before the expected frame"),
                _ => continue,
            }
        }
    }

    /// Waits for the first event equal to `expected`, discarding the others.
    fn wait_for_event(rx: &mpsc::Receiver<SessionEvent>, expected: SessionEvent) {
        loop {
            match rx
                .recv_timeout(TIMEOUT)
                .expect("no event within the timeout")
            {
                event if event == expected => return,
                SessionEvent::Exit => panic!("the session exited before the expected event"),
                _ => continue,
            }
        }
    }

    fn contains_text(frames: &[Frame], needle: &str) -> bool {
        frames
            .iter()
            .flat_map(|f| &f.lines)
            .flat_map(|l| &l.segments)
            .any(|s| s.text.starts_with(needle))
    }

    // Shell output travels through PTY, emulator and frame to the callback.
    #[test]
    fn shell_output_arrives_as_frames() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "echo ping"]);
        let (_session, rx) = spawn_with_channel(cmd);

        let frames = collect_until_exit(&rx);
        assert!(!frames.is_empty());
        assert!(frames[0].full, "the first frame must be full");
        assert!(contains_text(&frames, "ping"));
    }

    // What we write reaches the shell, and its reply comes back.
    #[test]
    fn written_bytes_reach_the_shell() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "read x; echo \"got $x\""]);
        let (mut session, rx) = spawn_with_channel(cmd);

        session.write(b"ping\n").unwrap();

        let frames = collect_until_exit(&rx);
        assert!(contains_text(&frames, "got ping"));
    }

    // Enter reaches the shell as `\r` and ends the read.
    #[test]
    fn keys_are_encoded_and_written() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "read x; echo \"got $x\""]);
        let (mut session, rx) = spawn_with_channel(cmd);

        session.write(b"ok").unwrap();
        assert!(session.key(Key::Enter, Mods::default()).unwrap());

        let frames = collect_until_exit(&rx);
        assert!(contains_text(&frames, "got ok"));
    }

    // After a resize the next frame is full and has the new size.
    #[test]
    fn resize_produces_a_full_frame_with_new_size() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "read x; echo done"]);
        let (mut session, rx) = spawn_with_channel(cmd);

        session.resize(40, 10).unwrap();
        session.write(b"\n").unwrap();

        let frames = collect_until_exit(&rx);
        // partial frames also arrive after the resize (the echo of "done"):
        // one full frame with the new size is enough
        let resized = frames
            .iter()
            .any(|f| f.full && (f.cols, f.rows) == (40, 10));
        assert!(resized);
    }

    // Scrolling produces a full frame right away; writing brings the view back to the bottom.
    #[test]
    fn scrolling_back_and_typing_returns_to_bottom() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "seq 1 30; read x"]);
        let (mut session, rx) = spawn_with_channel(cmd);

        // wait for `seq` to finish: the last printed row is "30"
        wait_for_frame(&rx, |f| contains_text(&[f.clone()], "30"));

        session.scroll(5).unwrap();
        let scrolled = wait_for_frame(&rx, |f| f.offset > 0);
        assert!(scrolled.full);
        assert_eq!(scrolled.offset, 5);

        session.write(b"\n").unwrap();
        let frames = collect_until_exit(&rx);
        assert_eq!(frames.last().expect("a frame after Enter").offset, 0);
    }

    // On the alternate screen the wheel becomes arrow keys for the program.
    #[test]
    fn scrolling_in_alt_screen_sends_arrow_keys() {
        let mut cmd = CommandBuilder::new("sh");
        // enter the alternate screen, read a line and print how many bytes arrived
        cmd.args([
            "-c",
            "printf '\\033[?1049h'; read x; printf '%s' \"$x\" | wc -c | tr -d ' '",
        ]);
        let (mut session, rx) = spawn_with_channel(cmd);

        // wait for the program to be on the alternate screen
        wait_for_frame(&rx, |f| f.full);
        std::thread::sleep(Duration::from_millis(100));

        session.scroll(2).unwrap();
        session.write(b"\n").unwrap();

        let frames = collect_until_exit(&rx);
        // two arrow-ups: `ESC [ A` twice is 6 bytes
        assert!(contains_text(&frames, "6"));
        assert!(frames.iter().all(|f| f.offset == 0));
    }

    // Dropping the session kills the shell: `Exit` arrives.
    #[test]
    fn dropping_the_session_kills_the_shell() {
        let (session, rx) = spawn_with_channel(CommandBuilder::new("sh"));

        drop(session);

        let exited = std::iter::from_fn(|| rx.recv_timeout(TIMEOUT).ok())
            .any(|event| event == SessionEvent::Exit);
        assert!(exited);
    }

    // Selecting produces a frame with the selection background right away, and exposes the text.
    #[test]
    fn selecting_emits_a_frame_and_exposes_the_text() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "echo foo bar; read x"]);
        let (session, rx) = spawn_with_channel(cmd);
        wait_for_frame(&rx, |f| contains_text(&[f.clone()], "foo bar"));

        session.select_start(0, 0, SelectionSide::Left, SelectionKind::Simple);
        session.select_update(0, 2, SelectionSide::Right);

        let selection = Theme::default().selection;
        let frame = wait_for_frame(&rx, |f| {
            f.lines
                .iter()
                .flat_map(|l| &l.segments)
                .any(|s| s.text == "foo" && s.bg == selection)
        });
        assert_eq!(frame.lines[0].row, 0);
        assert_eq!(session.selection_text(), Some("foo".to_string()));
    }

    // Clearing the selection produces a frame and leaves no selected text.
    #[test]
    fn clearing_the_selection_emits_a_frame() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "echo foo; read x"]);
        let (session, rx) = spawn_with_channel(cmd);
        wait_for_frame(&rx, |f| contains_text(&[f.clone()], "foo"));

        session.select_start(0, 0, SelectionSide::Left, SelectionKind::Line);
        wait_for_frame(&rx, |f| f.lines.iter().any(|l| l.row == 0));

        session.select_clear();

        let background = Theme::default().background;
        wait_for_frame(&rx, |f| {
            f.lines
                .iter()
                .any(|l| l.row == 0 && l.segments.iter().all(|s| s.bg == background))
        });
        assert_eq!(session.selection_text(), None);
    }

    // Typing clears the selection, as in every terminal.
    #[test]
    fn typing_clears_the_selection() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "echo foo; read x"]);
        let (mut session, rx) = spawn_with_channel(cmd);
        wait_for_frame(&rx, |f| contains_text(&[f.clone()], "foo"));

        session.select_start(0, 0, SelectionSide::Left, SelectionKind::Line);
        assert!(session.selection_text().is_some());

        session.key(Key::Char('a'), Mods::default()).unwrap();

        assert_eq!(session.selection_text(), None);
    }
    // Title and bell reach the callback as their own events.
    #[test]
    fn title_and_bell_arrive_as_events() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", r"printf '\033]0;ciao\007\007'; read x"]);
        let (_session, rx) = spawn_with_channel(cmd);

        wait_for_event(&rx, SessionEvent::Title("ciao".into()));
        wait_for_event(&rx, SessionEvent::Bell);
    }

    // The shell asks for the cursor position and prints `ok` only once the
    // six bytes of the reply (`ESC [ 1 ; 1 R`) come back through the PTY.
    #[test]
    fn terminal_queries_are_answered_on_the_pty() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args([
            "-c",
            r"stty raw -echo; printf '\033[6n'; dd bs=1 count=6 >/dev/null 2>&1; echo ok; read x",
        ]);
        let (_session, rx) = spawn_with_channel(cmd);

        wait_for_frame(&rx, |f| contains_text(std::slice::from_ref(f), "ok"));
    }
}
