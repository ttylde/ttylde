# ~ Ttylde

[![CI](https://github.com/ttylde/ttylde/actions/workflows/ci.yml/badge.svg)](https://github.com/ttylde/ttylde/actions/workflows/ci.yml)

A terminal emulator for macOS, built around one idea: the terminal should adapt to you, not the other way around. Ttylde is an attempt to put user experience first and build everything else around that.

> !! Early development. It opens a shell, you can type, scroll back and copy text. That's it for now.

VT parsing and the grid are provided by [`alacritty_terminal`](https://crates.io/crates/alacritty_terminal), wrapped behind Ttylde's own interface.

## Running it

Requirements: Rust (stable), Node.js, [pnpm](https://pnpm.io).

```sh
cd app
pnpm install
pnpm tauri dev
```

Tests:

```sh
cargo test --workspace   # core
cd app && pnpm test      # frontend
```

## License

[MIT](LICENSE) © 2026 Alessio Farinelli
