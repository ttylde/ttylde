use std::{fmt, io};

/// Core errors. An enum rather than `Box<dyn Error>` so callers can tell
/// the cases apart without parsing the message.
#[derive(Debug)]
pub enum Error {
    /// Opening, spawning or resizing the PTY failed.
    Pty(anyhow::Error),
    /// Reading from or writing to the PTY failed.
    Io(io::Error),
    /// The config file is not valid; the message says where.
    Config(String),
    /// The state file is not one the app wrote; the message says why.
    State(String),
    /// The history database could not be opened, read or written.
    History(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Pty(e) => write!(f, "pty: {e}"),
            Error::Io(e) => write!(f, "io: {e}"),
            Error::Config(s) => write!(f, "config: {s}"),
            Error::State(s) => write!(f, "state: {s}"),
            Error::History(s) => write!(f, "history: {s}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Pty(e) => Some(e.as_ref()),
            Error::Io(e) => Some(e),
            Error::Config(_) | Error::State(_) | Error::History(_) => None,
        }
    }
}

impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        Error::Pty(e)
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::History(e.to_string())
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e)
    }
}
