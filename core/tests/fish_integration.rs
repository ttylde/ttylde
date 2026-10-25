//! The fish script, run by a real fish in a home of its own.
//!
//! Skipped where there is no fish on the PATH.
#![cfg(unix)]

mod common;

use std::{
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver},
    time::Duration,
};

use common::{home, nonce, scripts, Shell};
use portable_pty::CommandBuilder;
use ttylde_core::{
    session::{EventHandler, Session, SessionEvent},
    shell,
    theme::Theme,
};

const PROMPT: &str = "\x1b]133;A";

fn find_fish() -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join("fish"))
        .find(|path| path.is_file())
}

/// A fish started as Ttylde starts it, with its config in `home`.
fn fish(home: &Path) -> Option<Shell> {
    Some(Shell::start(command(home, nonce())?))
}

fn command(home: &Path, nonce: &str) -> Option<CommandBuilder> {
    let fish = find_fish()?;
    let mut cmd = CommandBuilder::new(&fish);
    cmd.arg("-l");
    cmd.cwd(home);
    cmd.env("HOME", home);
    cmd.env("XDG_CONFIG_HOME", home.join(".config"));
    cmd.env("XDG_DATA_HOME", home.join(".local/share"));
    cmd.env("TERM", "xterm-256color");
    cmd.env_remove("XDG_DATA_DIRS");
    shell::integrate(&mut cmd, &fish, &scripts(), nonce);
    Some(cmd)
}

// A command comes with its text and the nonce, its end with the status.
#[test]
fn commands_are_marked_with_their_text_and_status() {
    let home = home("fish-commands", &[]);
    let Some(fish) = fish(&home) else { return };
    fish.type_after(PROMPT, 1, "echo caffè; false");
    let text = fish.wait_for("\x1b]133;D;", 1);

    let start = format!(
        "cmdline_url=echo%20caff%C3%A8%3B%20false;nonce={}\x07",
        nonce()
    );
    assert!(text.contains(&start), "{text:?}");
    assert!(text.contains("\x1b]133;D;1"), "{text:?}");
}

// The user's config.fish loads as always.
#[test]
fn the_config_of_the_user_loads() {
    let home = home(
        "fish-config",
        &[(".config/fish/config.fish", "echo read:config.fish\n")],
    );
    let Some(fish) = fish(&home) else { return };
    let text = fish.wait_for(PROMPT, 1);

    assert!(text.contains("read:config.fish"), "{text:?}");
}

// What the shell runs sees neither the nonce nor Ttylde's data folder.
#[test]
fn commands_do_not_inherit_the_setup() {
    let home = home("fish-inherit", &[]);
    let Some(fish) = fish(&home) else { return };
    fish.type_after(
        PROMPT,
        1,
        "sh -c 'echo \"seen:${TTYLDE_NONCE-none}:${TTYLDE_FISH_DATA_DIR-none}:$XDG_DATA_DIRS\"'",
    );
    let text = fish.wait_for("seen:", 2);

    assert!(
        text.contains("seen:none:none:/usr/local/share:/usr/share"),
        "{text:?}"
    );
}

/// A session of fish as the app opens it, and its command events.
fn session(home: &Path) -> Option<(Session, Receiver<SessionEvent>)> {
    let cmd = command(home, &shell::nonce())?;
    let (tx, rx) = mpsc::channel();
    let on_event: EventHandler = Box::new(move |event| {
        let _ = tx.send(event);
    });
    let session = Session::spawn(cmd, 80, 24, Theme::default(), 100, on_event).unwrap();
    Some((session, rx))
}

/// The command events up to the first one `until` accepts.
fn commands_until(
    rx: &Receiver<SessionEvent>,
    until: impl Fn(&SessionEvent) -> bool,
) -> Vec<SessionEvent> {
    let mut seen = Vec::new();
    loop {
        let event = rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|_| panic!("timed out; seen: {seen:?}"));
        let done = until(&event);
        if matches!(
            event,
            SessionEvent::Prompt
                | SessionEvent::CommandStart(_)
                | SessionEvent::CommandRunning(_)
                | SessionEvent::CommandEnd(_)
        ) {
            seen.push(event);
        }
        if done {
            return seen;
        }
    }
}

// fish 4 marks the start of the command itself, before the script adds
// one with the text: the session sees the start, then its text, and one
// end, from fish.
#[test]
fn the_marks_of_fish_and_of_the_script_make_one_command() {
    let home = home("fish-session", &[]);
    let Some((mut session, rx)) = session(&home) else {
        return;
    };
    commands_until(&rx, |e| *e == SessionEvent::Prompt);
    session.write(b"sleep 1; false\r").unwrap();

    let seen = commands_until(&rx, |e| matches!(e, SessionEvent::CommandEnd(_)));
    assert_eq!(
        seen,
        [
            SessionEvent::CommandStart(None),
            SessionEvent::CommandStart(Some("sleep 1; false".into())),
            SessionEvent::CommandRunning("sleep 1; false".into()),
            SessionEvent::CommandEnd(Some(1)),
        ]
    );
}
