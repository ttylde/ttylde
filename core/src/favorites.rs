//! The saved commands: a name and a command, for one space or for every
//! one. Which of them a tab has in its header, and in what order, is the
//! tab's own: it is kept with the tab, in the state. The palette lists them.
//!
//! The app writes this file and reads it back, in the order they are shown;
//! it is short and readable, to carry to another machine. It lives next to
//! the state, readable by its owner only: commands can say a lot.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    state::write_private,
};

/// Every saved command, in the order they were saved.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Favorites {
    #[serde(rename = "favorite")]
    pub favorites: Vec<Favorite>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Favorite {
    /// What the tabs name it by in the state. `0` in a file written by hand:
    /// `load` gives it one.
    #[serde(default)]
    pub id: u32,
    pub name: String,
    pub command: String,
    /// The id of the space it is for; `None`: every space, and the tabs
    /// that are in none.
    #[serde(default)]
    pub space: Option<u32>,
}

/// Reads the file at `path`. A missing file is no saved command; one that
/// is there but cannot be read is `Error::State`. A command without an id,
/// or with one another has, gets a new one.
pub fn load(path: &Path) -> Result<Favorites> {
    let mut favorites: Favorites = match fs::read_to_string(path) {
        Ok(text) => toml::from_str(&text).map_err(|e| Error::State(e.to_string()))?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Favorites::default()),
        Err(e) => return Err(e.into()),
    };
    let mut next = favorites.favorites.iter().map(|f| f.id).max().unwrap_or(0);
    let mut seen = std::collections::HashSet::new();
    for favorite in &mut favorites.favorites {
        if favorite.id == 0 || !seen.insert(favorite.id) {
            next += 1;
            favorite.id = next;
            seen.insert(next);
        }
    }
    Ok(favorites)
}

/// Writes `favorites` to `path`, whole: see `state::write_private`.
pub fn save(favorites: &Favorites, path: &Path) -> Result<()> {
    let text = toml::to_string(favorites).map_err(|e| Error::State(e.to_string()))?;
    write_private(path, &text)?;
    Ok(())
}

/// Where the saved commands live: next to the state.
pub fn default_path() -> Option<PathBuf> {
    Some(crate::state::default_path()?.with_file_name("favorites.toml"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let folder =
            std::env::temp_dir().join(format!("ttylde-favorites-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        folder.join("favorites.toml")
    }

    fn sample() -> Favorites {
        Favorites {
            favorites: vec![
                Favorite {
                    id: 1,
                    name: "Dev".into(),
                    command: "pnpm dev".into(),
                    space: Some(3),
                },
                Favorite {
                    id: 2,
                    name: "Pull".into(),
                    command: "git pull --rebase".into(),
                    space: None,
                },
            ],
        }
    }

    #[test]
    fn what_is_saved_is_read_back_in_order() {
        let path = temp_path("round");
        save(&sample(), &path).unwrap();
        assert_eq!(load(&path).unwrap(), sample());
    }

    #[test]
    fn no_file_is_no_saved_command() {
        assert_eq!(load(&temp_path("missing")).unwrap(), Favorites::default());
    }

    #[test]
    fn a_broken_file_is_an_error() {
        let path = temp_path("broken");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "[[favorite]]\nname = 1").unwrap();
        assert!(matches!(load(&path), Err(Error::State(_))));
    }

    // Written by hand: no space is every space, and the ids are given.
    #[test]
    fn short_entries_are_for_every_space_and_get_ids() {
        let path = temp_path("short");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text = "[[favorite]]\nid = 4\nname = \"Up\"\ncommand = \"up\"\n\n\
                    [[favorite]]\nname = \"Down\"\ncommand = \"down\"\n\n\
                    [[favorite]]\nid = 4\nname = \"Logs\"\ncommand = \"logs\"\n";
        fs::write(&path, text).unwrap();
        let favorites = load(&path).unwrap().favorites;
        assert_eq!(favorites[0].space, None);
        let ids: Vec<u32> = favorites.iter().map(|f| f.id).collect();
        assert_eq!(ids, [4, 5, 6]);
    }

    #[cfg(unix)]
    #[test]
    fn only_its_owner_can_read_it() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_path("private");
        save(&sample(), &path).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
