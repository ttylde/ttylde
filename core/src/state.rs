//! What the app was showing when it closed: the spaces and their tabs, and
//! the tabs pinned outside of them, so that the next start can bring them
//! back.
//!
//! The app writes this file and reads it back; the user does not edit it.
//! It lives apart from the config file, under `$XDG_STATE_HOME`.

use std::{
    env,
    ffi::OsString,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Every space, open or closed, the one that was shown, and the pinned tabs.
///
/// Fields a file does not have take their default: a file written by an
/// older version still reads.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    /// Id of the space that was shown; `None` if none was.
    pub shown: Option<u32>,
    /// When the app wrote it, in milliseconds since 1970: for a space still
    /// open then, the time it was last seen.
    pub saved_at: Option<u64>,
    pub spaces: Vec<Space>,
    /// Tabs that belong to no space and are seen from every one: they start
    /// again as soon as the app does.
    pub pinned: Vec<Tab>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Space {
    pub id: u32,
    pub name: String,
    pub color: String,
    /// Where its new tabs start, as the user typed it: `~` is the home.
    pub folder: String,
    /// `None`: the shell of the system.
    #[serde(default)]
    pub shell: Option<String>,
    /// When it was closed, in milliseconds since 1970; `None`: it is open.
    #[serde(default)]
    pub closed_at: Option<u64>,
    /// Position of the tab that was shown among `tabs`.
    #[serde(default)]
    pub shown: usize,
    #[serde(default)]
    pub tabs: Vec<Tab>,
    /// Its groups of panes: one tree each, whose leaves are positions in
    /// `tabs`. A tab in none is on its own.
    #[serde(default)]
    pub layouts: Vec<Layout>,
}

/// How a group of panes divides its room: a tab, or two halves.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Layout {
    /// The position of the tab among those of the space.
    Pane(usize),
    /// `a` takes `ratio` of the room, `b` the rest.
    Split {
        split: Direction,
        ratio: f64,
        a: Box<Layout>,
        b: Box<Layout>,
    },
}

/// A row puts its halves side by side; a column, one over the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Row,
    Column,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tab {
    /// The name the user gave it; `None`: it takes the one of its folder.
    #[serde(default)]
    pub name: Option<String>,
    pub color: String,
    pub icon: String,
    /// The folder it was in; `None` if it never said.
    #[serde(default)]
    pub cwd: Option<String>,
    /// The last command it ran, if its shell has the integration.
    #[serde(default)]
    pub command: Option<String>,
    /// The command still running in it when it closed: resuming offers to
    /// start it again.
    #[serde(default)]
    pub restart: Option<String>,
    /// The ids of the saved commands it has in its header, in their order.
    #[serde(default)]
    pub favorites: Vec<u32>,
}

/// Reads the file at `path`. A missing file is not an error: it means
/// nothing was saved yet, and gives an empty state. A file that is there
/// but is not a state is `Error::State`.
pub fn load(path: &Path) -> Result<State> {
    match fs::read_to_string(path) {
        Ok(text) => toml::from_str(&text).map_err(|e| Error::State(e.to_string())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(State::default()),
        Err(e) => Err(e.into()),
    }
}

/// Writes `state` to `path`: see `write_private`.
pub fn save(state: &State, path: &Path) -> Result<()> {
    let text = toml::to_string(state).map_err(|e| Error::State(e.to_string()))?;
    write_private(path, &text)?;
    Ok(())
}

/// Writes `text` to `path`, making its folder if needed, readable by its
/// owner only. The text goes to a temporary file next to it first, then
/// takes the place of the old one: a crash halfway leaves the old file whole.
pub(crate) fn write_private(path: &Path, text: &str) -> io::Result<()> {
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder)?;
    }
    // Next to the file, not in `/tmp`: a rename within one folder is atomic.
    let temporary = with_suffix(path, ".tmp");
    private_file(&temporary)?.write_all(text.as_bytes())?;
    fs::rename(&temporary, path)
}

// A file only its owner can read: the state has the commands the user ran.
fn private_file(path: &Path) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Moves a file that could not be read out of the way, to `<name>.broken`,
/// so that the next save does not write over what is left of it.
pub fn set_aside(path: &Path) -> io::Result<()> {
    fs::rename(path, with_suffix(path, ".broken"))
}

// `path` with `suffix` after its whole name: `state.toml.tmp`.
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Where the state file lives: under `$XDG_STATE_HOME`, or `~/.local/state`.
pub fn default_path() -> Option<PathBuf> {
    path_from(env::var_os("XDG_STATE_HOME"), env::var_os("HOME"))
}

// An empty variable counts as unset, as the XDG specification asks.
fn path_from(xdg: Option<OsString>, home: Option<OsString>) -> Option<PathBuf> {
    let base = match xdg.filter(|dir| !dir.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(home.filter(|dir| !dir.is_empty())?)
            .join(".local")
            .join("state"),
    };

    Some(base.join("ttylde").join("state.toml"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // A folder of its own for each test: they run at the same time.
    fn temp_folder(name: &str) -> PathBuf {
        let folder = env::temp_dir().join(format!("ttylde-state-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    fn sample() -> State {
        State {
            shown: Some(2),
            saved_at: Some(1_790_000_100_000),
            spaces: vec![
                Space {
                    id: 1,
                    name: "Work".to_string(),
                    color: "#2466ff".to_string(),
                    folder: "~/work".to_string(),
                    shell: Some("fish".to_string()),
                    closed_at: Some(1_790_000_000_000),
                    shown: 1,
                    tabs: vec![
                        Tab {
                            name: Some("api".to_string()),
                            color: "#1f9a6a".to_string(),
                            icon: "server".to_string(),
                            cwd: Some("/Users/me/work/api".to_string()),
                            command: Some("npm run dev".to_string()),
                            restart: Some("npm run dev".to_string()),
                            favorites: vec![2, 1],
                        },
                        Tab {
                            name: None,
                            color: "#5f6f68".to_string(),
                            icon: "terminal".to_string(),
                            cwd: None,
                            command: Some("git status".to_string()),
                            restart: None,
                            favorites: vec![],
                        },
                    ],
                    // The core keeps the positions as they are: the app checks them.
                    layouts: vec![Layout::Split {
                        split: Direction::Row,
                        ratio: 0.6,
                        a: Box::new(Layout::Pane(1)),
                        b: Box::new(Layout::Split {
                            split: Direction::Column,
                            ratio: 0.5,
                            a: Box::new(Layout::Pane(0)),
                            b: Box::new(Layout::Pane(2)),
                        }),
                    }],
                },
                Space {
                    id: 2,
                    name: "Space 2".to_string(),
                    color: "#7fb0ff".to_string(),
                    folder: "~".to_string(),
                    shell: None,
                    closed_at: None,
                    shown: 0,
                    tabs: vec![Tab {
                        name: None,
                        color: "#5f6f68".to_string(),
                        icon: "terminal".to_string(),
                        cwd: Some("/tmp".to_string()),
                        command: None,
                        restart: None,
                        favorites: vec![],
                    }],
                    layouts: vec![],
                },
            ],
            pinned: vec![Tab {
                name: Some("notes".to_string()),
                color: "#c2410c".to_string(),
                icon: "book".to_string(),
                cwd: Some("/Users/me/notes".to_string()),
                command: None,
                restart: None,
                favorites: vec![],
            }],
        }
    }

    #[test]
    fn what_is_saved_is_read_back() {
        let path = temp_folder("round").join("state.toml");
        save(&sample(), &path).unwrap();
        assert_eq!(load(&path).unwrap(), sample());
    }

    #[test]
    fn a_missing_file_is_an_empty_state() {
        let path = temp_folder("missing").join("state.toml");
        assert_eq!(load(&path).unwrap(), State::default());
    }

    #[test]
    fn a_broken_file_is_a_state_error() {
        let path = temp_folder("broken").join("state.toml");
        fs::write(&path, "spaces = [[[").unwrap();
        assert!(matches!(load(&path), Err(Error::State(_))));

        // Well-formed TOML, but not a state: a space with no name.
        fs::write(
            &path,
            "[[spaces]]\nid = 1\ncolor = \"#2466ff\"\nfolder = \"~\"",
        )
        .unwrap();
        assert!(matches!(load(&path), Err(Error::State(_))));
    }

    // A path that is there but cannot be read as a file is not "missing".
    #[test]
    fn an_unreadable_path_is_an_io_error() {
        let folder = temp_folder("unreadable");
        assert!(matches!(load(&folder), Err(Error::Io(_))));
    }

    // A file from an older version, without the fields added since.
    #[test]
    fn fields_left_out_take_their_default() {
        let path = temp_folder("older").join("state.toml");
        let text = "[[spaces]]\nid = 1\nname = \"Work\"\ncolor = \"#2466ff\"\nfolder = \"~\"\n";
        fs::write(&path, text).unwrap();

        let state = load(&path).unwrap();
        assert_eq!((state.shown, state.saved_at), (None, None));
        assert!(state.pinned.is_empty());
        let space = &state.spaces[0];
        assert_eq!((space.shell.clone(), space.closed_at), (None, None));
        assert_eq!((space.shown, space.tabs.len()), (0, 0));
        assert!(space.layouts.is_empty());
    }

    // The commands the user ran are in it: only the user reads it.
    #[cfg(unix)]
    #[test]
    fn only_its_owner_can_read_the_file() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_folder("private").join("state.toml");
        save(&sample(), &path).unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn saving_makes_the_folders_it_needs() {
        let path = temp_folder("folders")
            .join("ttylde")
            .join("deep")
            .join("state.toml");
        save(&sample(), &path).unwrap();
        assert!(path.is_file());
    }

    #[test]
    fn saving_again_replaces_the_file_and_leaves_nothing_else() {
        let folder = temp_folder("again");
        let path = folder.join("state.toml");
        save(&sample(), &path).unwrap();
        save(&State::default(), &path).unwrap();

        assert_eq!(load(&path).unwrap(), State::default());
        let names: Vec<_> = fs::read_dir(&folder)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![OsString::from("state.toml")]);
    }

    #[test]
    fn a_file_set_aside_keeps_its_text_under_another_name() {
        let folder = temp_folder("aside");
        let path = folder.join("state.toml");
        fs::write(&path, "broken").unwrap();
        set_aside(&path).unwrap();

        assert!(!path.exists());
        assert_eq!(
            fs::read_to_string(folder.join("state.toml.broken")).unwrap(),
            "broken"
        );
    }

    #[test]
    fn the_path_prefers_xdg_state_home() {
        let path = path_from(Some("/xdg".into()), Some("/home/me".into()));
        assert_eq!(path, Some(PathBuf::from("/xdg/ttylde/state.toml")));
    }

    #[test]
    fn without_xdg_the_path_is_under_the_home() {
        let expected = Some(PathBuf::from("/home/me/.local/state/ttylde/state.toml"));
        assert_eq!(path_from(None, Some("/home/me".into())), expected);
        assert_eq!(
            path_from(Some("".into()), Some("/home/me".into())),
            expected
        );
    }

    #[test]
    fn without_a_home_there_is_no_path() {
        assert_eq!(path_from(None, None), None);
        assert_eq!(path_from(None, Some("".into())), None);
    }
}
