//! The bash script, run by a real bash in a home of its own: the user's
//! files load as without Ttylde, and the sequences come out.
//!
//! The bash of the system: 3.2 on macOS. Skipped where there is none.
#![cfg(unix)]

mod common;

use std::{
    path::Path,
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

const BASH: &str = "/bin/bash";
const PROMPT_END: &str = "\x1b]133;B\x07";
const PROMPT: &str = "\x1b]133;A\x07";

/// A bash set up as Ttylde starts it: a login shell, in `home`.
fn command(home: &Path, nonce: &str) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(BASH);
    cmd.arg("-l");
    cmd.cwd(home);
    cmd.env("HOME", home);
    cmd.env("TERM", "xterm-256color");
    cmd.env("BASH_SILENCE_DEPRECATION_WARNING", "1");
    shell::integrate(&mut cmd, Path::new(BASH), &scripts(), nonce);
    cmd
}

fn bash(home: &Path) -> Option<Shell> {
    Path::new(BASH)
        .exists()
        .then(|| Shell::start(command(home, nonce())))
}

/// A .bash_profile with a plain prompt, and more lines.
fn profile(more: &str) -> String {
    format!("PS1='$ '\n{more}")
}

/// The names the files that say they were read printed, in order.
fn read(text: &str) -> Vec<&str> {
    text.match_indices("read:")
        .map(|(i, _)| text[i..].split(':').nth(1).unwrap())
        .collect()
}

// Of the three files of a login bash, the first one there loads, alone.
#[test]
fn the_first_login_file_loads() {
    let files = [".bash_profile", ".bash_login", ".profile"];
    for (first, name) in files.iter().enumerate() {
        let texts: Vec<(String, String)> = files[first..]
            .iter()
            .map(|f| (f.to_string(), format!("echo read:{f}:\n")))
            .collect();
        let texts: Vec<(&str, &str)> = texts.iter().map(|(p, t)| (&p[..], &t[..])).collect();
        let home = home(&format!("bash-login-{first}"), &texts);
        let Some(bash) = bash(&home) else { return };
        let text = bash.wait_for(PROMPT, 1);
        assert_eq!(read(&text), [*name], "{text:?}");
    }
}

// .bashrc is not read by a login bash: only if the profile reads it.
#[test]
fn the_bashrc_loads_only_from_the_profile() {
    let rc = "echo read:bashrc:\n";
    let home = home("bash-rc", &[(".bashrc", rc)]);
    let Some(bash) = bash(&home) else { return };
    let text = bash.wait_for(PROMPT, 1);
    assert!(read(&text).is_empty(), "{text:?}");

    let profile = ". ~/.bashrc\necho read:bash_profile:\n";
    let home = common::home(
        "bash-rc-sourced",
        &[(".bashrc", rc), (".bash_profile", profile)],
    );
    let Some(bash) = self::bash(&home) else {
        return;
    };
    let text = bash.wait_for(PROMPT, 1);
    assert_eq!(read(&text), ["bashrc", "bash_profile"], "{text:?}");
}

// /etc/profile comes first: on macOS it builds PATH with path_helper.
#[cfg(target_os = "macos")]
#[test]
fn the_system_profile_loads_first() {
    let home = home(
        "bash-etc",
        &[(".bash_profile", "echo \"read:profile:$PATH:\"\n")],
    );
    let mut cmd = command(&home, nonce());
    cmd.env("PATH", "/nowhere");
    let bash = Shell::start(cmd);
    let text = bash.wait_for(PROMPT, 1);
    assert!(text.contains("/usr/bin"), "{text:?}");
}

// A command comes with its text and the nonce, its end with the status.
#[test]
fn commands_are_marked_with_their_text_and_status() {
    let home = home("bash-commands", &[(".bash_profile", &profile(""))]);
    let Some(bash) = bash(&home) else { return };
    bash.type_after(PROMPT_END, 1, "echo caffè | cat; false");
    let text = bash.wait_for("\x1b]133;D;", 1);

    let start = format!(
        "\x1b]133;C;cmdline_url=echo%20caff%C3%A8%20%7C%20cat%3B%20false;nonce={}\x07",
        nonce()
    );
    assert!(text.contains(&start), "{text:?}");
    assert_eq!(text.matches("\x1b]133;C").count(), 1, "{text:?}");
    assert!(text.contains("\x1b]133;D;1\x07"), "{text:?}");
}

// The prompt mark comes before the prompt, its end after it.
#[test]
fn the_prompt_is_marked() {
    let home = home("bash-prompt", &[(".bash_profile", &profile(""))]);
    let Some(bash) = bash(&home) else { return };
    let text = bash.wait_for(PROMPT_END, 1);
    // bash may turn on the meta key in between.
    let start = text.find(PROMPT).unwrap();
    assert!(text[start..].contains("$ \x1b]133;B\x07"), "{text:?}");
}

// A prompt with no command run has no command.
#[test]
fn an_empty_line_is_no_command() {
    let home = home("bash-empty", &[(".bash_profile", &profile(""))]);
    let Some(bash) = bash(&home) else { return };
    bash.type_after(PROMPT_END, 1, "");
    bash.type_after(PROMPT_END, 2, "true");
    let text = bash.wait_for("\x1b]133;D;0\x07", 1);

    assert_eq!(text.matches("\x1b]133;C").count(), 1, "{text:?}");
    assert_eq!(text.matches("\x1b]133;D;").count(), 1, "{text:?}");
}

// A command over more lines is one command, with all of its text.
#[test]
fn a_command_over_more_lines_is_one() {
    let home = home("bash-lines", &[(".bash_profile", &profile(""))]);
    let Some(bash) = bash(&home) else { return };
    bash.type_after(PROMPT_END, 1, "for i in 1 2");
    bash.type_after("> ", 1, "do echo n$i");
    bash.type_after("> ", 2, "done");
    let text = bash.wait_for("\x1b]133;D;0\x07", 1);

    assert_eq!(text.matches("\x1b]133;C").count(), 1, "{text:?}");
    assert!(
        text.contains("cmdline_url=for%20i%20in%201%202"),
        "{text:?}"
    );
    assert!(text.contains("n2"), "{text:?}");
}

// Ctrl+C on a command ends it with 130; at the prompt, it runs nothing.
#[test]
fn ctrl_c_ends_the_command() {
    let home = home("bash-ctrl-c", &[(".bash_profile", &profile(""))]);
    let Some(bash) = bash(&home) else { return };
    bash.type_after(PROMPT_END, 1, "sleep 10");
    bash.wait_for("\x1b]133;C", 1);
    std::thread::sleep(Duration::from_millis(200));
    bash.pty.write(b"\x03").unwrap();
    bash.wait_for("\x1b]133;D;130\x07", 1);
    bash.wait_for(PROMPT_END, 2);
    bash.pty.write(b"half typed\x03").unwrap();
    bash.type_after(PROMPT_END, 3, "true");
    let text = bash.wait_for("\x1b]133;D;0\x07", 1);

    assert_eq!(text.matches("\x1b]133;C").count(), 2, "{text:?}");
}

// The user's PROMPT_COMMAND runs, and sees the status of the command. That
// one runs in a subshell, out of reach of the trap: it starts late.
#[test]
fn the_prompt_command_of_the_user_runs() {
    let more = "PROMPT_COMMAND='echo \"user:$?:\"'\n";
    let home = home("bash-prompt-command", &[(".bash_profile", &profile(more))]);
    let Some(bash) = bash(&home) else { return };
    bash.type_after(PROMPT_END, 1, "(exit 3)");
    let text = bash.wait_for("user:3:", 1);

    let after = &text[text.find("\x1b]133;D;3\x07").unwrap()..];
    assert!(text.contains("cmdline_url=%28exit%203%29;"), "{text:?}");
    let user = after.find("user:3:").unwrap();
    let prompt = after.find(PROMPT).unwrap();
    assert!(user < prompt, "{after:?}");
}

// The user's DEBUG trap goes on running, before each command.
#[test]
fn the_debug_trap_of_the_user_runs() {
    let more = "trap 'echo \"trap:$BASH_COMMAND:\"' DEBUG\n";
    let home = home("bash-debug", &[(".bash_profile", &profile(more))]);
    let Some(bash) = bash(&home) else { return };
    bash.type_after(PROMPT_END, 1, "echo hi");
    let text = bash.wait_for("trap:echo hi:", 1);

    assert!(text.contains("cmdline_url=echo%20hi;"), "{text:?}");
}

// With `ignorespace`, a command after a space has no text; with
// `ignoredups`, the same command again keeps it.
#[test]
fn commands_out_of_the_history() {
    let more = "HISTCONTROL=ignoreboth\n";
    let home = home("bash-histcontrol", &[(".bash_profile", &profile(more))]);
    let Some(bash) = bash(&home) else { return };
    bash.type_after(PROMPT_END, 1, "echo one");
    bash.type_after(PROMPT_END, 2, "echo one");
    bash.type_after(PROMPT_END, 3, " echo secret");
    bash.type_after(PROMPT_END, 4, "true");
    let text = bash.wait_for("\x1b]133;D;", 4);

    assert_eq!(
        text.matches("cmdline_url=echo%20one;").count(),
        2,
        "{text:?}"
    );
    assert!(!text.contains("secret;nonce"), "{text:?}");
    assert_eq!(text.matches("\x1b]133;C\x07").count(), 1, "{text:?}");
}

// A login shell reads .bash_logout on the way out, and the user's EXIT
// trap still runs.
#[test]
fn the_logout_file_is_read() {
    let more = "trap 'echo user-exit' EXIT\n";
    let home = home(
        "bash-logout",
        &[
            (".bash_profile", &profile(more)),
            (".bash_logout", "echo logout-read\n"),
        ],
    );
    let Some(bash) = bash(&home) else { return };
    bash.type_after(PROMPT_END, 1, "exit");
    let text = bash.wait_for("user-exit", 1);

    let logout = text.find("logout-read").expect("no logout");
    assert!(logout < text.find("user-exit").unwrap(), "{text:?}");
}

// What the shell runs sees none of the setup.
#[test]
fn commands_do_not_inherit_the_setup() {
    let home = home("bash-inherit", &[(".bash_profile", &profile(""))]);
    let Some(bash) = bash(&home) else { return };
    bash.type_after(
        PROMPT_END,
        1,
        "sh -c 'echo \"seen:${TTYLDE_NONCE-none}:${TTYLDE_BASH_INJECT-none}\"'",
    );
    let text = bash.wait_for("seen:", 2);
    assert!(text.contains("seen:none:none"), "{text:?}");
}

// Sourced by hand from the profile as well, the script loads once.
#[test]
fn the_script_loads_once() {
    let script = scripts().join("bash/ttylde-integration.bash");
    let more = format!(". {}\n", script.display());
    let home = home("bash-once", &[(".bash_profile", &profile(&more))]);
    let Some(bash) = bash(&home) else { return };
    bash.type_after(PROMPT_END, 1, "true");
    let text = bash.wait_for("\x1b]133;D;0\x07", 1);
    assert_eq!(text.matches("\x1b]133;C").count(), 1, "{text:?}");
}

// The folder is announced at every prompt.
#[test]
fn the_folder_is_announced() {
    let home = home(
        "bash-folder",
        &[(".bash_profile", &profile("")), ("my dir/.keep", "")],
    );
    let Some(bash) = bash(&home) else { return };
    bash.type_after(PROMPT_END, 1, "cd 'my dir'");
    let text = bash.wait_for(PROMPT, 2);

    let path = format!("{}/my%20dir\x07", home.display());
    assert!(text.contains("\x1b]7;file://"), "{text:?}");
    assert!(text.contains(&path), "{text:?}");
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

// Through the session as the app opens it: a program still in the
// foreground is one to start again, and ends with its status.
#[test]
fn a_long_command_counts_as_running() {
    if !Path::new(BASH).exists() {
        return;
    }
    let home = home("bash-running", &[(".bash_profile", &profile(""))]);
    let (tx, rx) = mpsc::channel();
    let on_event: EventHandler = Box::new(move |event| {
        let _ = tx.send(event);
    });
    let cmd = command(&home, &shell::nonce());
    let mut session = Session::spawn(cmd, 80, 24, Theme::default(), 100, on_event).unwrap();
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
