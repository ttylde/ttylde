//! Key-to-bytes translation for the shell.
//!
//! The frontend sends raw events (which key, which modifiers); here we decide
//! which bytes to write to the PTY. The rules follow xterm, the de facto
//! standard programs expect with `TERM=xterm-256color`.
use serde::Deserialize;

/// A pressed key. `Char` is only used for Ctrl or Alt combinations: plain
/// text arrives ready-made from the system (IME, dead keys, Option).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum Key {
    Enter,
    Tab,
    Backspace,
    Escape,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Insert,
    Delete,
    F(u8),
    Char(char),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub struct Mods {
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub ctrl: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
    WheelUp,
    WheelDown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum MouseAction {
    Press,
    Release,
    Move,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct MouseEvent {
    pub action: MouseAction,
    /// `None` only for a `Move` with no button held.
    pub button: Option<MouseButton>,
    pub row: u16,
    pub col: u16,
    #[serde(default)]
    pub mods: Mods,
}

/// Which mouse events the program asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MouseTracking {
    #[default]
    Off,
    Click,
    Drag,
    Motion,
}

impl Mods {
    /// The modifier parameter of xterm sequences: 1 plus the bits
    /// Shift (1), Alt (2), Ctrl (4). It is 1 without modifiers.
    fn xterm_param(self) -> u8 {
        1 + (self.shift as u8) + ((self.alt as u8) << 1) + ((self.ctrl as u8) << 2)
    }

    fn any(self) -> bool {
        self.shift || self.alt || self.ctrl
    }
}

/// The emulator state that affects encoding.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InputMode {
    /// Arrows and Home/End as `ESC O x` instead of `ESC [ x` (DECCKM).
    pub app_cursor: bool,
    /// The program wants pasted text wrapped in `ESC [200~` and `ESC [201~`.
    pub bracketed_paste: bool,
    pub alt_screen: bool,
    pub alternate_scroll: bool,
    pub mouse: MouseTracking,
    pub sgr_mouse: bool,
    /// The program wants `ESC [ I` and `ESC [ O` when the focus changes.
    pub focus_events: bool,
}

const ESC: u8 = 0x1b;

/// Encodes a key. `None` if the combination means nothing to the terminal:
/// the caller leaves it to the system.
pub fn encode_key(key: Key, mods: Mods, mode: InputMode) -> Option<Vec<u8>> {
    let bytes = match key {
        // Shift+Enter is "new line without sending": the bytes of Alt+Enter,
        // which programs already read that way.
        Key::Enter if mods.shift => b"\x1b\r".to_vec(),
        Key::Enter => with_alt_prefix(mods, vec![b'\r']),
        Key::Tab if mods.shift => b"\x1b[Z".to_vec(),
        Key::Tab => vec![b'\t'],
        Key::Backspace => with_alt_prefix(mods, vec![if mods.ctrl { 0x08 } else { 0x7f }]),
        Key::Escape => with_alt_prefix(mods, vec![ESC]),

        Key::Up => cursor_key(b'A', mods, mode),
        Key::Down => cursor_key(b'B', mods, mode),
        Key::Right => cursor_key(b'C', mods, mode),
        Key::Left => cursor_key(b'D', mods, mode),
        Key::Home => cursor_key(b'H', mods, mode),
        Key::End => cursor_key(b'F', mods, mode),

        Key::Insert => tilde_key(2, mods),
        Key::Delete => tilde_key(3, mods),
        Key::PageUp => tilde_key(5, mods),
        Key::PageDown => tilde_key(6, mods),

        Key::F(n @ 1..=4) => {
            let final_byte = b'P' + (n - 1);
            if mods.any() {
                format!("\x1b[1;{}{}", mods.xterm_param(), final_byte as char).into_bytes()
            } else {
                vec![ESC, b'O', final_byte]
            }
        }
        Key::F(n @ 5..=12) => {
            let code = [15, 17, 18, 19, 20, 21, 23, 24][(n - 5) as usize];
            tilde_key(code, mods)
        }
        Key::F(_) => return None,

        Key::Char(c) if mods.ctrl => with_alt_prefix(mods, vec![control_byte(c)?]),
        Key::Char(c) => {
            let mut buf = [0u8; 4];
            with_alt_prefix(mods, c.encode_utf8(&mut buf).as_bytes().to_vec())
        }
    };

    Some(bytes)
}

/// Encodes a mouse event. `None` if the program did not ask for it, or
/// the position does not fit the format in use.
pub fn encode_mouse(event: MouseEvent, mode: InputMode) -> Option<Vec<u8>> {
    let wanted = match mode.mouse {
        MouseTracking::Off => false,
        MouseTracking::Click => event.action != MouseAction::Move,
        MouseTracking::Drag => event.action != MouseAction::Move || event.button.is_some(),
        MouseTracking::Motion => true,
    };

    if !wanted {
        return None;
    }

    let is_wheel = matches!(
        event.button,
        Some(MouseButton::WheelUp | MouseButton::WheelDown)
    );
    if is_wheel && event.action != MouseAction::Press {
        return None;
    }

    let mut code: u8 = match event.button {
        Some(MouseButton::Left) => 0,
        Some(MouseButton::Middle) => 1,
        Some(MouseButton::Right) => 2,
        Some(MouseButton::WheelUp) => 64,
        Some(MouseButton::WheelDown) => 65,
        None => 3,
    };

    if event.action == MouseAction::Move {
        code += 32;
    }
    if event.mods.shift {
        code += 4;
    }
    if event.mods.alt {
        code += 8;
    }
    if event.mods.ctrl {
        code += 16;
    }

    let col = event.col + 1;
    let row = event.row + 1;

    if mode.sgr_mouse {
        // SGR
        let end = if event.action == MouseAction::Release {
            'm'
        } else {
            'M'
        };

        Some(format!("\x1b[<{code};{col};{row}{end}").into_bytes())
    } else {
        // X10
        if event.action == MouseAction::Release {
            code |= 3;
        }
        if col > 223 || row > 223 {
            return None;
        }

        Some(vec![
            ESC,
            b'[',
            b'M',
            code + 32,
            col as u8 + 32,
            row as u8 + 32,
        ])
    }
}

/// Arrows and Home/End: `ESC [ x`, or `ESC O x` in application mode;
/// with modifiers always `ESC [ 1 ; m x`.
fn cursor_key(final_byte: u8, mods: Mods, mode: InputMode) -> Vec<u8> {
    if mods.any() {
        format!("\x1b[1;{}{}", mods.xterm_param(), final_byte as char).into_bytes()
    } else if mode.app_cursor {
        vec![ESC, b'O', final_byte]
    } else {
        vec![ESC, b'[', final_byte]
    }
}

/// Keys of the form `ESC [ n ~`, with modifiers `ESC [ n ; m ~`.
fn tilde_key(code: u8, mods: Mods) -> Vec<u8> {
    if mods.any() {
        format!("\x1b[{code};{}~", mods.xterm_param()).into_bytes()
    } else {
        format!("\x1b[{code}~").into_bytes()
    }
}

/// Alt before a key adds an ESC: xterm's "meta" convention.
fn with_alt_prefix(mods: Mods, mut bytes: Vec<u8>) -> Vec<u8> {
    if mods.alt {
        bytes.insert(0, ESC);
    }
    bytes
}

/// Ctrl plus a character yields a control byte (0x00–0x1f, or 0x7f).
fn control_byte(c: char) -> Option<u8> {
    Some(match c.to_ascii_lowercase() {
        'a'..='z' => c.to_ascii_lowercase() as u8 - b'a' + 1,
        '@' | ' ' | '2' => 0x00,
        '[' | '3' => 0x1b,
        '\\' | '4' => 0x1c,
        ']' | '5' => 0x1d,
        '^' | '6' => 0x1e,
        '_' | '7' | '-' => 0x1f,
        '?' | '8' => 0x7f,
        _ => return None,
    })
}

/// Prepares pasted text: with bracketed paste the program receives it wrapped
/// in markers and knows not to run it line by line; otherwise newlines become
/// Enter, as if typed.
pub fn encode_paste(text: &str, mode: InputMode) -> Vec<u8> {
    if mode.bracketed_paste {
        let mut bytes = b"\x1b[200~".to_vec();
        // An ESC inside the text could end the paste early.
        bytes.extend(text.bytes().filter(|&b| b != ESC));
        bytes.extend_from_slice(b"\x1b[201~");
        bytes
    } else {
        text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
    }
}

/// The report of a focus change, for the programs that asked for it.
pub fn encode_focus(focused: bool, mode: InputMode) -> Option<Vec<u8>> {
    mode.focus_events.then(|| {
        if focused {
            b"\x1b[I".to_vec()
        } else {
            b"\x1b[O".to_vec()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Mods = Mods {
        shift: false,
        alt: false,
        ctrl: false,
    };
    const CTRL: Mods = Mods { ctrl: true, ..NONE };
    const ALT: Mods = Mods { alt: true, ..NONE };
    const SHIFT: Mods = Mods {
        shift: true,
        ..NONE
    };
    const APP: InputMode = InputMode {
        app_cursor: true,
        bracketed_paste: false,
        alt_screen: false,
        alternate_scroll: false,
        mouse: MouseTracking::Off,
        sgr_mouse: false,
        focus_events: false,
    };

    fn enc(key: Key, mods: Mods) -> Vec<u8> {
        encode_key(key, mods, InputMode::default()).unwrap()
    }

    #[test]
    fn basic_keys() {
        assert_eq!(enc(Key::Enter, NONE), b"\r");
        assert_eq!(enc(Key::Tab, NONE), b"\t");
        assert_eq!(enc(Key::Tab, SHIFT), b"\x1b[Z");
        assert_eq!(enc(Key::Backspace, NONE), [0x7f]);
        assert_eq!(enc(Key::Backspace, CTRL), [0x08]);
        assert_eq!(enc(Key::Escape, NONE), [0x1b]);
    }

    // Ctrl+letter is the letter minus 64: Ctrl+C interrupts with 0x03.
    #[test]
    fn control_characters() {
        assert_eq!(enc(Key::Char('c'), CTRL), [0x03]);
        assert_eq!(enc(Key::Char('C'), CTRL), [0x03]);
        assert_eq!(enc(Key::Char('a'), CTRL), [0x01]);
        assert_eq!(enc(Key::Char('['), CTRL), [0x1b]);
        assert_eq!(encode_key(Key::Char('é'), CTRL, InputMode::default()), None);
    }

    // Alt prepends an ESC.
    #[test]
    fn alt_prefixes_escape() {
        assert_eq!(enc(Key::Char('b'), ALT), b"\x1bb");
        assert_eq!(enc(Key::Enter, ALT), b"\x1b\r");
    }

    // Shift+Enter must not look like Enter: a program that sends on Enter
    // would send where the user asked for a new line.
    #[test]
    fn shift_enter_is_not_enter() {
        let shift_alt = Mods { alt: true, ..SHIFT };

        assert_eq!(enc(Key::Enter, SHIFT), b"\x1b\r");
        assert_ne!(enc(Key::Enter, SHIFT), enc(Key::Enter, NONE));
        // one ESC, not two: with Alt it is still the same key
        assert_eq!(enc(Key::Enter, shift_alt), b"\x1b\r");
        // the mode of the cursor keys does not touch it
        assert_eq!(encode_key(Key::Enter, SHIFT, APP).unwrap(), b"\x1b\r");
    }

    // Arrows change shape in application cursor mode and with modifiers.
    #[test]
    fn cursor_keys_follow_the_mode() {
        assert_eq!(enc(Key::Up, NONE), b"\x1b[A");
        assert_eq!(encode_key(Key::Up, NONE, APP).unwrap(), b"\x1bOA");
        assert_eq!(enc(Key::Up, SHIFT), b"\x1b[1;2A");
        assert_eq!(enc(Key::Left, CTRL), b"\x1b[1;5D");
        assert_eq!(enc(Key::Home, NONE), b"\x1b[H");
        assert_eq!(encode_key(Key::End, NONE, APP).unwrap(), b"\x1bOF");
    }

    #[test]
    fn tilde_and_function_keys() {
        assert_eq!(enc(Key::Delete, NONE), b"\x1b[3~");
        assert_eq!(enc(Key::PageUp, SHIFT), b"\x1b[5;2~");
        assert_eq!(enc(Key::F(1), NONE), b"\x1bOP");
        assert_eq!(enc(Key::F(1), SHIFT), b"\x1b[1;2P");
        assert_eq!(enc(Key::F(5), NONE), b"\x1b[15~");
        assert_eq!(enc(Key::F(12), NONE), b"\x1b[24~");
        assert_eq!(encode_key(Key::F(13), NONE, InputMode::default()), None);
    }

    #[test]
    fn paste_is_bracketed_only_when_requested() {
        let plain = InputMode::default();
        assert_eq!(encode_paste("a\nb\r\nc", plain), b"a\rb\rc");

        let bracketed = InputMode {
            bracketed_paste: true,
            ..plain
        };
        assert_eq!(encode_paste("a\nb", bracketed), b"\x1b[200~a\nb\x1b[201~");
    }

    // `ESC [ I` in, `ESC [ O` out, and nothing unless the program asked.
    #[test]
    fn focus_is_reported_only_when_requested() {
        let asked = InputMode {
            focus_events: true,
            ..InputMode::default()
        };
        assert_eq!(encode_focus(true, asked).unwrap(), b"\x1b[I");
        assert_eq!(encode_focus(false, asked).unwrap(), b"\x1b[O");
        assert_eq!(encode_focus(true, InputMode::default()), None);
        assert_eq!(encode_focus(false, InputMode::default()), None);
    }

    fn mouse(action: MouseAction, button: Option<MouseButton>, row: u16, col: u16) -> MouseEvent {
        MouseEvent {
            action,
            button,
            row,
            col,
            mods: NONE,
        }
    }

    fn tracking(mouse: MouseTracking, sgr_mouse: bool) -> InputMode {
        InputMode {
            mouse,
            sgr_mouse,
            ..InputMode::default()
        }
    }

    const LEFT: Option<MouseButton> = Some(MouseButton::Left);

    // SGR is text: button, then column and row counted from one. The final
    // letter tells press from release, and the release names its button.
    #[test]
    fn sgr_reports_press_and_release() {
        let mode = tracking(MouseTracking::Click, true);
        let press = mouse(MouseAction::Press, LEFT, 4, 9);
        let release = mouse(MouseAction::Release, Some(MouseButton::Right), 4, 9);
        assert_eq!(encode_mouse(press, mode).unwrap(), b"\x1b[<0;10;5M");
        assert_eq!(encode_mouse(release, mode).unwrap(), b"\x1b[<2;10;5m");
    }

    // X10 is three raw bytes offset by 32, and a release does not say
    // which button went up.
    #[test]
    fn x10_reports_press_and_release() {
        let mode = tracking(MouseTracking::Click, false);
        let press = mouse(MouseAction::Press, Some(MouseButton::Middle), 0, 0);
        let release = mouse(MouseAction::Release, Some(MouseButton::Middle), 0, 0);
        assert_eq!(
            encode_mouse(press, mode).unwrap(),
            [ESC, b'[', b'M', 33, 33, 33]
        );
        assert_eq!(
            encode_mouse(release, mode).unwrap(),
            [ESC, b'[', b'M', 35, 33, 33]
        );
    }

    // One byte per coordinate: past 223 the position cannot be written.
    #[test]
    fn x10_gives_up_on_far_cells() {
        let mode = tracking(MouseTracking::Click, false);
        let edge = mouse(MouseAction::Press, LEFT, 222, 222);
        let beyond = mouse(MouseAction::Press, LEFT, 0, 223);
        assert_eq!(
            encode_mouse(edge, mode).unwrap(),
            [ESC, b'[', b'M', 32, 255, 255]
        );
        assert_eq!(encode_mouse(beyond, mode), None);
        assert!(encode_mouse(beyond, tracking(MouseTracking::Click, true)).is_some());
    }

    // Each tracking level adds events to the one before.
    #[test]
    fn tracking_decides_which_events_pass() {
        let press = mouse(MouseAction::Press, LEFT, 0, 0);
        let drag = mouse(MouseAction::Move, LEFT, 0, 0);
        let hover = mouse(MouseAction::Move, None, 0, 0);
        let passes = |event, level| encode_mouse(event, tracking(level, true)).is_some();

        assert!(!passes(press, MouseTracking::Off));
        assert!(passes(press, MouseTracking::Click));
        assert!(!passes(drag, MouseTracking::Click));
        assert!(passes(drag, MouseTracking::Drag));
        assert!(!passes(hover, MouseTracking::Drag));
        assert!(passes(hover, MouseTracking::Motion));
    }

    // A move adds 32 to the button; without a button it counts as 3.
    #[test]
    fn moves_are_marked_in_the_button_code() {
        let mode = tracking(MouseTracking::Motion, true);
        let drag = mouse(MouseAction::Move, LEFT, 1, 2);
        let hover = mouse(MouseAction::Move, None, 1, 2);
        assert_eq!(encode_mouse(drag, mode).unwrap(), b"\x1b[<32;3;2M");
        assert_eq!(encode_mouse(hover, mode).unwrap(), b"\x1b[<35;3;2M");
    }

    // The wheel is a button that is only ever pressed.
    #[test]
    fn wheel_is_reported_as_a_press() {
        let mode = tracking(MouseTracking::Click, true);
        let up = mouse(MouseAction::Press, Some(MouseButton::WheelUp), 0, 0);
        let down = mouse(MouseAction::Press, Some(MouseButton::WheelDown), 0, 0);
        let release = mouse(MouseAction::Release, Some(MouseButton::WheelUp), 0, 0);
        assert_eq!(encode_mouse(up, mode).unwrap(), b"\x1b[<64;1;1M");
        assert_eq!(encode_mouse(down, mode).unwrap(), b"\x1b[<65;1;1M");
        assert_eq!(encode_mouse(release, mode), None);
    }

    // Shift, Alt and Ctrl add 4, 8 and 16; in X10 they survive a release.
    #[test]
    fn modifiers_are_added_to_the_button_code() {
        let all = Mods {
            shift: true,
            alt: true,
            ctrl: true,
        };
        let press = MouseEvent {
            mods: all,
            ..mouse(MouseAction::Press, LEFT, 0, 0)
        };
        let release = MouseEvent {
            mods: CTRL,
            ..mouse(MouseAction::Release, LEFT, 0, 0)
        };
        let sgr = tracking(MouseTracking::Click, true);
        let x10 = tracking(MouseTracking::Click, false);
        assert_eq!(encode_mouse(press, sgr).unwrap(), b"\x1b[<28;1;1M");
        assert_eq!(
            encode_mouse(release, x10).unwrap(),
            [ESC, b'[', b'M', 3 + 16 + 32, 33, 33]
        );
    }
}
