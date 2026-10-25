use portable_pty::CommandBuilder;
use serde::Serialize;
use std::{
    io,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use crate::{
    command::{self, Change},
    cwd::{hostname, of_process, Tracker},
    emulator::{Emulator, EmulatorEvent, SelectionKind, SelectionSide},
    error::Result,
    frame::Frame,
    git::{Status, Watcher},
    input::{encode_focus, encode_key, encode_mouse, encode_paste, Key, Mods, MouseEvent},
    pty::{Pty, PtyProbe},
    shell,
    theme::Theme,
};

/// How long a command has to stay in the foreground to count as running:
/// see `SessionEvent::CommandRunning`.
const RUNNING_AFTER: Duration = Duration::from_millis(500);

/// Serialized as `{ "type": "Frame", "data": {...} }` and `{ "type": "Exit" } and ...`.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum SessionEvent {
    Frame(Frame),
    Title(String),
    TitleReset,
    /// The folder the session works in: sent when it changes.
    Cwd(PathBuf),
    /// The repository of that folder: sent when branch or changes differ.
    /// `None`: the folder is in no repository.
    Git(Option<Status>),
    Bell,
    /// The shell shows a prompt: it is ready for a command. Only from a
    /// shell with the integration (see `shell`), as the three below.
    Prompt,
    /// A command started, or its text arrived after it did. `None`: the
    /// text is not known, or is not to be kept (it starts with a space).
    CommandStart(Option<String>),
    /// The command is still in the foreground a moment after it started:
    /// a process to start again if the session is closed now. What the
    /// system says about the foreground confirms what the output said.
    CommandRunning(String),
    /// The command ended, with its exit status if the shell said it.
    CommandEnd(Option<i32>),
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
        let nonce = cmd
            .get_env(shell::NONCE_VAR)
            .and_then(|nonce| nonce.to_str())
            .map(String::from);
        let pty = Pty::spawn(cmd, cols, rows)?;
        let mut reader = pty.reader()?;
        let writer = pty.writer();
        let probe = pty.probe();
        let shell_pid = pty.pid();
        let mut tracker = Tracker::new(hostname());
        let mut commands = command::Tracker::default();
        // Changes at every start and end: a check of the foreground made for
        // a command that is over by then does not count.
        let generation = Arc::new(AtomicU64::new(0));
        let mut emulator = Emulator::new(cols, rows, theme, history);
        emulator.set_nonce(nonce);
        let emulator = Arc::new(Mutex::new(emulator));

        let shared = Arc::clone(&emulator);
        let on_event = Arc::new(on_event);
        let on_event_for_thread = Arc::clone(&on_event);
        let on_event_for_git = Arc::clone(&on_event);
        // Dropped with the reader thread, which ends with the session.
        let watcher = Watcher::spawn(move |status| on_event_for_git(SessionEvent::Git(status)));

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
                                EmulatorEvent::Location(location) => {
                                    if let Some(folder) = tracker.announce(location) {
                                        watcher.set_folder(folder.clone());
                                        on_event_for_thread(SessionEvent::Cwd(folder));
                                    }
                                }
                                EmulatorEvent::Mark(mark) => {
                                    for change in commands.mark(mark) {
                                        let event = match change {
                                            Change::Prompt => SessionEvent::Prompt,
                                            Change::Started(text) => {
                                                let id =
                                                    generation.fetch_add(1, Ordering::SeqCst) + 1;
                                                if let Some(text) = &text {
                                                    confirm_running(
                                                        text.clone(),
                                                        id,
                                                        Arc::clone(&generation),
                                                        probe.clone(),
                                                        shell_pid,
                                                        Arc::clone(&on_event_for_thread),
                                                    );
                                                }
                                                SessionEvent::CommandStart(text)
                                            }
                                            Change::Ended(status) => {
                                                generation.fetch_add(1, Ordering::SeqCst);
                                                SessionEvent::CommandEnd(status)
                                            }
                                        };
                                        on_event_for_thread(event);
                                    }
                                }
                            }
                        }

                        // A shell that does not announce its folder is
                        // followed through the process in the foreground.
                        if tracker.needs_probe() {
                            let folder = probe.foreground_pid().and_then(of_process);
                            if let Some(folder) = tracker.observe(folder) {
                                watcher.set_folder(folder.clone());
                                on_event_for_thread(SessionEvent::Cwd(folder));
                            }
                        }
                        // A command may have changed branch or files.
                        watcher.poke();

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
        self.emulator.lock().unwrap().resize(cols, rows);

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

    /// Brings the prompt above the first line shown (or below it) to the
    /// top of the view.
    pub fn jump_to_prompt(&self, up: bool) {
        if self.emulator.lock().unwrap().jump_to_prompt(up) {
            self.emit_frame();
        }
    }

    /// The output of the last command run: see `Emulator::last_output`.
    pub fn last_output(&self) -> Option<String> {
        self.emulator.lock().unwrap().last_output()
    }

    /// The last lines of the output of the last command run: see
    /// `Emulator::output_tail`.
    pub fn output_tail(&self, count: usize) -> Vec<String> {
        self.emulator.lock().unwrap().output_tail(count)
    }

    /// Selects the output of the last command run. Returns whether there
    /// was one.
    pub fn select_last_output(&self) -> bool {
        let selected = self.emulator.lock().unwrap().select_last_output();
        if selected {
            self.emit_frame();
        }
        selected
    }

    /// Reports a mouse event to the program, if it asked for it.
    /// Returns `false` if nothing was written.
    pub fn mouse(&mut self, event: MouseEvent) -> io::Result<bool> {
        let mode = self.emulator.lock().unwrap().input_mode();
        match encode_mouse(event, mode) {
            Some(bytes) => self.pty.write(&bytes).map(|_| true),
            None => Ok(false),
        }
    }

    /// Tells the session whether its window has the focus: the cursor
    /// changes shape, and the program is told if it asked to be.
    pub fn focus(&mut self, focused: bool) -> io::Result<()> {
        let mode = {
            let mut emulator = self.emulator.lock().unwrap();
            if !emulator.set_focused(focused) {
                return Ok(());
            }

            emulator.input_mode()
        };

        self.emit_frame();
        if let Some(bytes) = encode_focus(focused, mode) {
            self.pty.write(&bytes)?;
        }
        Ok(())
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

/// Sends `CommandRunning` if, a moment from now, the command `id` is still
/// the last one started and a process other than the shell is in the
/// foreground. A shell builtin, or a command already over, is not one.
fn confirm_running(
    text: String,
    id: u64,
    generation: Arc<AtomicU64>,
    probe: PtyProbe,
    shell_pid: Option<u32>,
    on_event: Arc<EventHandler>,
) {
    std::thread::spawn(move || {
        std::thread::sleep(RUNNING_AFTER);
        if generation.load(Ordering::SeqCst) != id {
            return;
        }
        let foreground = probe.foreground_pid();
        if foreground.is_some() && foreground != shell_pid {
            on_event(SessionEvent::CommandRunning(text));
        }
    });
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
    use crate::frame::CursorShape;
    use crate::input::{MouseAction, MouseButton};

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
        wait_for_frame(&rx, |f| contains_text(std::slice::from_ref(f), "30"));

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
        wait_for_frame(&rx, |f| contains_text(std::slice::from_ref(f), "foo bar"));

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
        wait_for_frame(&rx, |f| contains_text(std::slice::from_ref(f), "foo"));

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
        wait_for_frame(&rx, |f| contains_text(std::slice::from_ref(f), "foo"));

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

    fn left_press() -> MouseEvent {
        MouseEvent {
            action: MouseAction::Press,
            button: Some(MouseButton::Left),
            row: 0,
            col: 0,
            mods: Mods::default(),
        }
    }

    // The shell turns mouse reporting on, which the frame tells the
    // frontend, and prints `ok` only once the nine bytes of the click
    // (`ESC [ < 0 ; 1 ; 1 M`) arrive through the PTY.
    #[test]
    fn mouse_events_reach_a_program_that_asked_for_them() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args([
            "-c",
            r"stty raw -echo; printf '\033[?1000h\033[?1006h'; dd bs=1 count=9 >/dev/null 2>&1; echo ok; read x",
        ]);
        let (mut session, rx) = spawn_with_channel(cmd);

        wait_for_frame(&rx, |f| f.mouse);
        assert!(session.mouse(left_press()).unwrap());
        wait_for_frame(&rx, |f| contains_text(std::slice::from_ref(f), "ok"));
    }

    // Losing the focus is a local change: the frame with the hollow cursor
    // comes from the call, not from the shell.
    #[test]
    fn losing_focus_hollows_the_cursor() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "echo ready; read x"]);
        let (mut session, rx) = spawn_with_channel(cmd);
        wait_for_frame(&rx, |f| contains_text(std::slice::from_ref(f), "ready"));

        let shape = |f: &Frame| f.cursor.as_ref().map(|c| c.shape);
        session.focus(false).unwrap();
        wait_for_frame(&rx, |f| shape(f) == Some(CursorShape::Hollow));
        session.focus(true).unwrap();
        wait_for_frame(&rx, |f| shape(f) == Some(CursorShape::Block));
    }

    // The shell turns focus reporting on and prints `ok` only once the
    // three bytes of the report (`ESC [ O`) arrive through the PTY.
    #[test]
    fn focus_changes_reach_a_program_that_asked_for_them() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args([
            "-c",
            r"stty raw -echo; printf '\033[?1004hready\r\n'; dd bs=1 count=3 >/dev/null 2>&1; echo ok; read x",
        ]);
        let (mut session, rx) = spawn_with_channel(cmd);
        wait_for_frame(&rx, |f| contains_text(std::slice::from_ref(f), "ready"));

        session.focus(false).unwrap();
        wait_for_frame(&rx, |f| contains_text(std::slice::from_ref(f), "ok"));
    }

    // Without a request the mouse belongs to the terminal: nothing is written.
    #[test]
    fn mouse_events_are_dropped_without_a_request() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "read x"]);
        let (mut session, _rx) = spawn_with_channel(cmd);

        assert!(!session.mouse(left_press()).unwrap());
    }

    // With no word from the shell, the folder is the one of its process.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn the_folder_follows_the_shell() {
        // The system reports the real path: `/tmp` may be a link.
        let folder = std::env::temp_dir().canonicalize().unwrap();
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "cd \"$1\" && echo ready && read x", "sh"]);
        cmd.arg(&folder);
        let (_session, rx) = spawn_with_channel(cmd);

        wait_for_event(&rx, SessionEvent::Cwd(folder));
    }

    // OSC 7 is the shell saying where it is: no need to look.
    #[test]
    fn an_announced_folder_arrives_as_an_event() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args([
            "-c",
            r"printf '\033]7;file:///announced/folder\007'; read x",
        ]);
        let (_session, rx) = spawn_with_channel(cmd);

        wait_for_event(&rx, SessionEvent::Cwd("/announced/folder".into()));
    }

    // The marks of a shell with the integration arrive as events; the text
    // of a command only with the nonce the session was started with.
    #[test]
    fn marks_of_the_shell_arrive_as_events() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.env(shell::NONCE_VAR, "n0nce");
        cmd.args([
            "-c",
            r"printf '\033]133;A\007\033]133;C;cmdline_url=make%%20all;nonce=n0nce\007\033]133;D;2\007'; read x",
        ]);
        let (_session, rx) = spawn_with_channel(cmd);

        wait_for_event(&rx, SessionEvent::Prompt);
        wait_for_event(&rx, SessionEvent::CommandStart(Some("make all".into())));
        wait_for_event(&rx, SessionEvent::CommandEnd(Some(2)));
    }

    // Once a command ended, its output can be read back.
    #[test]
    fn the_output_of_the_last_command_of_the_shell() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args([
            "-c",
            r"printf '\033]133;A\007$ \033]133;B\007make\r\n\033]133;C\007oops\r\n\033]133;D;2\007\033]133;A\007$ '; read x",
        ]);
        let (session, rx) = spawn_with_channel(cmd);

        wait_for_event(&rx, SessionEvent::CommandEnd(Some(2)));
        assert_eq!(session.last_output().as_deref(), Some("oops"));
    }

    // Output that forges a mark without the nonce gives no text, and so
    // nothing to start again.
    #[test]
    fn a_forged_mark_has_no_text() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.env(shell::NONCE_VAR, "n0nce");
        cmd.args([
            "-c",
            r"printf '\033]133;C;cmdline_url=rm%%20-rf%%20~;nonce=guess\007'; read x",
        ]);
        let (_session, rx) = spawn_with_channel(cmd);

        wait_for_event(&rx, SessionEvent::CommandStart(None));
    }

    // The branch is the one of the repository the shell is in.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn the_branch_of_the_folder_arrives_as_an_event() {
        let folder = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("ttylde-session-git-{}", std::process::id()));
        std::fs::create_dir_all(folder.join(".git")).unwrap();
        std::fs::write(folder.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();

        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "cd \"$1\" && echo ready && read x", "sh"]);
        cmd.arg(&folder);
        let (_session, rx) = spawn_with_channel(cmd);

        wait_for_event(
            &rx,
            SessionEvent::Git(Some(Status {
                branch: "main".into(),
                dirty: false,
            })),
        );
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
