//! The zsh script, run by a real zsh in a home of its own: the user's files
//! load as without Ttylde, and the sequences come out.
//!
//! Skipped where there is no zsh.
#![cfg(unix)]

mod common;

use std::{fs, path::Path};

use common::{home, scripts, Shell, NONCE};
use portable_pty::CommandBuilder;
use ttylde_core::shell;

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
