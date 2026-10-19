//! Ttylde core.
//!
//! All the terminal logic lives here. This crate must not depend on any
//! UI toolkit.
pub mod command;
pub mod config;
pub mod cwd;
pub mod emulator;
pub mod error;
pub mod favorites;
pub mod frame;
pub mod git;
pub mod history;
pub mod input;
pub mod pty;
pub mod session;
pub mod shell;
pub mod state;
pub mod theme;
