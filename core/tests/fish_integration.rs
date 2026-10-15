//! The fish script, run by a real fish in a home of its own.
//!
//! Skipped where there is no fish on the PATH.
#![cfg(unix)]

mod common;

use std::path::{Path, PathBuf};

use common::{home, scripts, Shell, NONCE};
use portable_pty::CommandBuilder;
use ttylde_core::shell;

const PROMPT: &str = "\x1b]133;A";

fn find_fish() -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join("fish"))
        .find(|path| path.is_file())
}

/// A fish started as Ttylde starts it, with its config in `home`.
fn fish(home: &Path) -> Option<Shell> {
    let fish = find_fish()?;
    let mut cmd = CommandBuilder::new(&fish);
    cmd.arg("-l");
    cmd.cwd(home);
    cmd.env("HOME", home);
    cmd.env("XDG_CONFIG_HOME", home.join(".config"));
    cmd.env("XDG_DATA_HOME", home.join(".local/share"));
    cmd.env("TERM", "xterm-256color");
    cmd.env_remove("XDG_DATA_DIRS");
    shell::integrate(&mut cmd, &fish, &scripts(), NONCE);
    Some(Shell::start(cmd))
}

// A command comes with its text and the nonce, its end with the status.
#[test]
fn commands_are_marked_with_their_text_and_status() {
    let home = home("fish-commands", &[]);
    let Some(fish) = fish(&home) else { return };
    fish.type_after(PROMPT, 1, "echo caffè; false");
    let text = fish.wait_for("\x1b]133;D;", 1);

    let start = format!("cmdline_url=echo%20caff%C3%A8%3B%20false;nonce={NONCE}\x07");
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
