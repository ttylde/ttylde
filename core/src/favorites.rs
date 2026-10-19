//! The saved commands: a name and a command, for one folder or for every
//! folder. The header shows those of the folder of the tab, the palette
//! lists them all.
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

/// Every saved command, in the order of the header and the menu.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Favorites {
    #[serde(rename = "favorite")]
    pub favorites: Vec<Favorite>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Favorite {
    pub name: String,
    pub command: String,
    /// The folder it is for; `None`: every folder.
    #[serde(default)]
    pub folder: Option<String>,
    /// Shown as a chip in the header, not only in the menu.
    #[serde(default)]
    pub pinned: bool,
}

/// Reads the file at `path`. A missing file is no saved command; one that
/// is there but cannot be read is `Error::State`.
pub fn load(path: &Path) -> Result<Favorites> {
    match fs::read_to_string(path) {
        Ok(text) => toml::from_str(&text).map_err(|e| Error::State(e.to_string())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Favorites::default()),
        Err(e) => Err(e.into()),
    }
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
                    name: "Dev".into(),
                    command: "pnpm dev".into(),
                    folder: Some("/Users/me/api".into()),
                    pinned: true,
                },
                Favorite {
                    name: "Pull".into(),
                    command: "git pull --rebase".into(),
                    folder: None,
                    pinned: false,
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

    // Written by hand: the fields left out take their default.
    #[test]
    fn a_short_entry_is_for_every_folder_and_not_pinned() {
        let path = temp_path("short");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            "[[favorite]]\nname = \"Up\"\ncommand = \"docker compose up\"\n",
        )
        .unwrap();
        let favorite = &load(&path).unwrap().favorites[0];
        assert_eq!((favorite.folder.clone(), favorite.pinned), (None, false));
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
