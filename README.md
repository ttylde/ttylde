<p align="center"><img src="app/src-tauri/icons/128x128@2x.png" width="128" height="128" alt="Ttylde icon"></p>

# ~ Ttylde

[![CI](https://github.com/ttylde/ttylde/actions/workflows/ci.yml/badge.svg)](https://github.com/ttylde/ttylde/actions/workflows/ci.yml)

A terminal emulator for macOS, built around one idea: the terminal should adapt to you, not the other way around. Ttylde is an attempt to put user experience first and build everything else around that.

> !! Early development. Version 0.1 is a terminal you can work in all day; what makes Ttylde its own (spaces, history, favorites, panes) is still ahead. There is no packaged app yet: it runs from source.

VT parsing and the grid are provided by [`alacritty_terminal`](https://crates.io/crates/alacritty_terminal), wrapped behind Ttylde's own interface.

## What works today

- **Tabs** in a sidebar, each with its own session. The sidebar collapses to a rail.
- **Scrollback, selection and copy**: drag, double click for a word, triple click for a line.
- **Mouse and focus reporting** for the programs that ask for them (vim, htop, tmux). Hold Shift to select text anyway.
- **Unicode**: wide characters and combining marks, with glyphs from fallback fonts kept inside their cells.
- **A config file** for the font and the theme colors.

| Shortcut | |
|---|---|
| `Cmd+T` | New tab |
| `Cmd+1` … `Cmd+9` | Go to a tab |
| `Ctrl+1` … `Ctrl+9` | Go to a space, reopening it if it is closed |
| `Ctrl+Tab`, `Ctrl+Shift+Tab` | Next and previous open space |
| `Cmd+\` | Collapse or expand the sidebar |
| `Shift+Enter` | New line without sending, in the programs that support it |

## Configuration

Ttylde reads `~/.config/ttylde/config.toml` (or `$XDG_CONFIG_HOME/ttylde/config.toml`) once at startup. Everything in it is optional; a file with a mistake is reported on stderr and ignored.

```toml
[font]
family = "JetBrains Mono"  # the default: it ships with the app
size = 13                  # between 6 and 72

[theme]
base = "dark"              # "light" (the default) or "dark"
# Any of these replaces the color of the base theme:
foreground = "#d8d8d2"
background = "#16161a"
cursor = "#e8e8e2"
selection = "#3a3f58"
# ansi = ["#000000", ...]  # the 16 ANSI colors, all of them or none
```

Spaces and tabs are kept across restarts in `~/.local/state/ttylde/state.toml` (or `$XDG_STATE_HOME/ttylde/state.toml`). The app writes it: it is not meant to be edited. A file it cannot read is moved aside to `state.toml.broken`, and the app starts as on a first run.

## Running it

Requirements: Rust (stable), Node.js, [pnpm](https://pnpm.io).

```sh
cd app
pnpm install
pnpm tauri dev
```

The app icons are generated from `assets/icons/full.png`; after changing it:

```sh
cd app && pnpm icons
```

Tests:

```sh
cargo test --workspace   # core
cd app && pnpm test      # frontend
```

## License

[MIT](LICENSE) © 2026 Alessio Farinelli
