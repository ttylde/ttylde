//! The zsh script, run by a real zsh in a home of its own: the user's files
//! load as without Ttylde, and the sequences come out.
//!
//! Skipped where there is no zsh.
#![cfg(unix)]

mod common;

use std::{
    fs,
    path::Path,
    sync::mpsc::{self, Receiver},
    time::Duration,
};

use common::{home, scripts, Shell, NONCE};
use portable_pty::CommandBuilder;
use ttylde_core::{
    session::{EventHandler, Session, SessionEvent},
    shell,
    theme::Theme,
};

const ZSH: &str = "/bin/zsh";
const PROMPT_END: &str = "\x1b]133;B\x07";

/// A zsh started as Ttylde starts it, with `zdotdir` as the user's ZDOTDIR.
fn zsh(home: &Path, zdotdir: Option<&Path>) -> Option<Shell> {
    if !Path::new(ZSH).exists() {
        return None;
    }
    let mut cmd = CommandBuilder::new(ZSH);
    cmd.arg("-l");
    cmd.cwd(home);
    cmd.env("HOME", home);
    cmd.env("TERM", "xterm-256color");
    match zdotdir {
        Some(dir) => cmd.env("ZDOTDIR", dir),
        None => cmd.env_remove("ZDOTDIR"),
    }
    shell::integrate(&mut cmd, Path::new(ZSH), &scripts(), NONCE);
    Some(Shell::start(cmd))
}

/// Startup files that say they were read, and what ZDOTDIR was then.
fn startup_files() -> Vec<(String, String)> {
    ["zshenv", "zprofile", "zshrc", "zlogin"]
        .into_iter()
        .map(|name| {
            let text = format!("echo \"read:{name}:${{ZDOTDIR-unset}}:\"\n");
            (format!(".{name}"), text)
        })
        .collect()
}

// The user's four files load, in zsh's order, with ZDOTDIR as it was.
#[test]
fn the_files_of_the_user_load_in_order() {
    let files = startup_files();
    let files: Vec<(&str, &str)> = files.iter().map(|(p, t)| (&p[..], &t[..])).collect();
    let home = home("zsh-order", &files);
    let Some(zsh) = zsh(&home, None) else { return };
    let text = zsh.wait_for("\x1b]133;A\x07", 1);

    let read: Vec<&str> = text
        .match_indices("read:")
        .map(|(i, _)| text[i..].split(':').nth(1).unwrap())
        .collect();
    assert_eq!(read, ["zshenv", "zprofile", "zshrc", "zlogin"]);
    assert!(text.contains("read:zshrc:unset:"), "{text:?}");
}

// A ZDOTDIR of the user's is where zsh finds the files, and stays set.
#[test]
fn a_zdotdir_of_the_user_is_put_back() {
    let home = home("zsh-zdotdir", &[]);
    let dir = home.join(".config/zsh");
    fs::create_dir_all(&dir).unwrap();
    for (path, text) in startup_files() {
        fs::write(dir.join(path), text).unwrap();
    }
    let Some(zsh) = zsh(&home, Some(&dir)) else {
        return;
    };
    let text = zsh.wait_for("\x1b]133;A\x07", 1);

    let expected = format!("read:zshrc:{}:", dir.display());
    assert!(text.contains(&expected), "{text:?}");
    assert!(text.contains("read:zlogin:"), "{text:?}");
}

// A command comes with its text and the nonce, its end with the status.
#[test]
fn commands_are_marked_with_their_text_and_status() {
    let home = home("zsh-commands", &[(".zshrc", "PS1='%# '\n")]);
    let Some(zsh) = zsh(&home, None) else { return };
    zsh.type_after(PROMPT_END, 1, "echo caffè; false");
    let text = zsh.wait_for("\x1b]133;D;", 1);

    let start = format!("\x1b]133;C;cmdline_url=echo%20caff%C3%A8%3B%20false;nonce={NONCE}\x07");
    assert!(text.contains(&start), "{text:?}");
    assert!(text.contains("\x1b]133;D;1\x07"), "{text:?}");
}

// A prompt with no command run has no end of command.
#[test]
fn an_empty_line_is_no_command() {
    let home = home("zsh-empty", &[(".zshrc", "PS1='%# '\n")]);
    let Some(zsh) = zsh(&home, None) else { return };
    zsh.type_after(PROMPT_END, 1, "");
    zsh.type_after(PROMPT_END, 2, "true");
    let text = zsh.wait_for("\x1b]133;D;0\x07", 1);

    assert_eq!(text.matches("\x1b]133;C;").count(), 1, "{text:?}");
    assert_eq!(text.matches("\x1b]133;D;").count(), 1, "{text:?}");
}

// What the shell runs sees neither the nonce nor Ttylde's ZDOTDIR.
#[test]
fn commands_do_not_inherit_the_setup() {
    let home = home("zsh-inherit", &[(".zshrc", "PS1='%# '\n")]);
    let Some(zsh) = zsh(&home, None) else { return };
    zsh.type_after(
        PROMPT_END,
        1,
        "sh -c 'echo \"seen:${TTYLDE_NONCE-none}:${ZDOTDIR-none}:${TTYLDE_ZDOTDIR-none}\"'",
    );
    let text = zsh.wait_for("seen:", 2);

    assert!(text.contains("seen:none:none:none"), "{text:?}");
}

// Themes set PS1 in a precmd hook of their own, added in .zshrc: from the
// second prompt on, the prompt mark comes last and the end mark is in the
// prompt. At the first one the theme's hook still runs after ours, which
// are installed only then, as kitty and Ghostty do.
#[test]
fn hooks_of_a_theme_do_not_hide_the_marks() {
    let zshrc = "theme() { PS1='themed%# '; print -n THEME_RAN }\nprecmd_functions+=(theme)\n";
    let home = home("zsh-theme", &[(".zshrc", zshrc)]);
    let Some(zsh) = zsh(&home, None) else { return };
    zsh.type_after("THEME_RAN", 1, "true");
    let text = zsh.wait_for("themed% \x1b]133;B\x07", 1);

    let second = &text[text.find("\x1b]133;D;0\x07").unwrap()..];
    let theme = second.find("THEME_RAN").unwrap();
    let prompt = second.find("\x1b]133;A\x07").unwrap();
    assert!(theme < prompt, "{second:?}");
}

// Sourced by hand from .zshrc as well, the script loads once.
#[test]
fn the_script_loads_once() {
    let script = scripts().join("zsh/ttylde-integration.zsh");
    let zshrc = format!("PS1='%# '\nsource {}\n", script.display());
    let home = home("zsh-once", &[(".zshrc", &zshrc)]);
    let Some(zsh) = zsh(&home, None) else { return };
    zsh.type_after(PROMPT_END, 1, "true");
    let text = zsh.wait_for("\x1b]133;D;0\x07", 1);

    assert_eq!(text.matches("\x1b]133;C;").count(), 1, "{text:?}");
}

// The folder is announced at every prompt.
#[test]
fn the_folder_is_announced() {
    let home = home(
        "zsh-folder",
        &[(".zshrc", "PS1='%# '\n"), ("my dir/.keep", "")],
    );
    let Some(zsh) = zsh(&home, None) else { return };
    zsh.type_after(PROMPT_END, 1, "cd 'my dir'");
    let text = zsh.wait_for("\x1b]133;A\x07", 2);

    let path = format!("{}/my%20dir\x07", home.display());
    assert!(text.contains("\x1b]7;file://"), "{text:?}");
    assert!(text.contains(&path), "{text:?}");
}

/// A session of zsh as the app opens it, and its events.
fn session(home: &Path) -> Option<(Session, Receiver<SessionEvent>)> {
    if !Path::new(ZSH).exists() {
        return None;
    }
    let mut cmd = CommandBuilder::new(ZSH);
    cmd.arg("-l");
    cmd.cwd(home);
    cmd.env("HOME", home);
    cmd.env("TERM", "xterm-256color");
    cmd.env_remove("ZDOTDIR");
    shell::integrate(&mut cmd, Path::new(ZSH), &scripts(), &shell::nonce());

    let (tx, rx) = mpsc::channel();
    let on_event: EventHandler = Box::new(move |event| {
        let _ = tx.send(event);
    });
    let session = Session::spawn(cmd, 80, 24, Theme::default(), 100, on_event).unwrap();
    Some((session, rx))
}

/// The command events up to the first one `until` accepts, the frames left out.
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

// A program still in the foreground is one to start again; it ends with
// the status the shell saw.
#[test]
fn a_long_command_counts_as_running() {
    let home = home("zsh-running", &[(".zshrc", "PS1='%# '\n")]);
    let Some((mut session, rx)) = session(&home) else {
        return;
    };
    commands_until(&rx, |e| *e == SessionEvent::Prompt);
    session.write(b"sleep 2\r").unwrap();

    let seen = commands_until(&rx, |e| matches!(e, SessionEvent::CommandEnd(_)));
    assert_eq!(
        seen,
        [
            SessionEvent::CommandStart(Some("sleep 2".into())),
            SessionEvent::CommandRunning("sleep 2".into()),
            SessionEvent::CommandEnd(Some(0)),
        ]
    );
}

// A command over before the check, or a builtin that keeps the shell in
// the foreground, is not.
#[test]
fn short_commands_and_builtins_are_not_running() {
    let home = home("zsh-builtin", &[(".zshrc", "PS1='%# '\n")]);
    let Some((mut session, rx)) = session(&home) else {
        return;
    };
    commands_until(&rx, |e| *e == SessionEvent::Prompt);
    session.write(b"true\r").unwrap();
    commands_until(&rx, |e| *e == SessionEvent::Prompt);
    session.write(b"read -t 1 x\r").unwrap();

    let seen = commands_until(&rx, |e| *e == SessionEvent::CommandEnd(Some(1)));
    assert!(
        !seen
            .iter()
            .any(|e| matches!(e, SessionEvent::CommandRunning(_))),
        "{seen:?}"
    );
}

// A command typed with a space in front is not kept.
#[test]
fn a_command_after_a_space_has_no_text() {
    let home = home("zsh-space", &[(".zshrc", "PS1='%# '\n")]);
    let Some((mut session, rx)) = session(&home) else {
        return;
    };
    commands_until(&rx, |e| *e == SessionEvent::Prompt);
    session.write(b" sleep 1\r").unwrap();

    let seen = commands_until(&rx, |e| matches!(e, SessionEvent::CommandEnd(_)));
    assert_eq!(
        seen,
        [
            SessionEvent::CommandStart(None),
            SessionEvent::CommandEnd(Some(0))
        ]
    );
}

// Every command that ends, through a real zsh and the session, is an entry
// of the history, with its folder and status; one typed after a space is not.
#[test]
fn commands_end_up_in_the_history() {
    use std::sync::{Arc, Mutex};
    use ttylde_core::{
        config::HistoryConfig,
        history::{Filter, History, Limits, Query, Recorder},
    };

    if !Path::new(ZSH).exists() {
        return;
    }
    let home = home("zsh-history", &[(".zshrc", "PS1='%# '\n")]);
    let config = HistoryConfig::default();
    let history = Arc::new(Mutex::new(
        History::open(
            &home.join("history.db"),
            Filter::new(&config, None),
            Limits::from(&config),
        )
        .unwrap(),
    ));
    let recorder = Arc::new(Mutex::new(Recorder::default()));
    recorder.lock().unwrap().set_space(Some(7));

    let mut cmd = CommandBuilder::new(ZSH);
    cmd.arg("-l");
    cmd.cwd(&home);
    cmd.env("HOME", &home);
    cmd.env("TERM", "xterm-256color");
    cmd.env_remove("ZDOTDIR");
    shell::integrate(&mut cmd, Path::new(ZSH), &scripts(), &shell::nonce());
    let (tx, rx) = mpsc::channel();
    let (store, recording) = (Arc::clone(&history), Arc::clone(&recorder));
    let on_event: EventHandler = Box::new(move |event| {
        if let Some(record) = recording.lock().unwrap().observe(&event, 1) {
            store.lock().unwrap().record(&record).unwrap();
        }
        let _ = tx.send(event);
    });
    let mut session = Session::spawn(cmd, 80, 24, Theme::default(), 100, on_event).unwrap();

    for line in ["echo one", " echo secret", "false"] {
        commands_until(&rx, |e| *e == SessionEvent::Prompt);
        session.write(format!("{line}\r").as_bytes()).unwrap();
        commands_until(&rx, |e| matches!(e, SessionEvent::CommandEnd(_)));
    }

    let query = Query {
        limit: 10,
        ..Query::default()
    };
    let entries = history.lock().unwrap().search(&query).unwrap();
    let seen: Vec<(&str, Option<i32>)> = entries
        .iter()
        .map(|e| (e.command.as_str(), e.exit))
        .collect();
    assert_eq!(seen, [("false", Some(1)), ("echo one", Some(0))]);
    assert_eq!(entries[0].space, Some(7));
    assert_eq!(entries[0].cwd.as_deref(), home.to_str());
}
