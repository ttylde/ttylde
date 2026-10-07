//! Ttylde core.
//!
//! All the terminal logic lives here. This crate must not depend on any
//! UI toolkit.
pub mod emulator;
pub mod error;
pub mod frame;
pub mod input;
pub mod pty;
pub mod session;
pub mod theme;
