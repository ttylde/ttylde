//! The git repository a folder belongs to: its branch, and whether it has
//! changes to commit.
//!
//! The branch is read from the files of the repository. The changes are
//! asked to `git`, which is the one that knows how to compare the folder
//! with the index. A `Watcher` does both away from the thread that reads
//! the terminal.

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;

/// Sent to the frontend as it is.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    /// The branch, or the start of the commit when `HEAD` is on none.
    pub branch: String,
    /// How many files have changes to commit, files never added included.
    pub changes: u32,
}

/// How many characters of a commit stand for it.
const SHORT_COMMIT: usize = 7;

/// A repository found on disk.
struct Repository {
    /// The folder the files are in.
    root: PathBuf,
    /// Where git keeps its own: `.git`, or where a worktree points.
    git_dir: PathBuf,
}

/// The state of the repository `folder` is in. `None` if it is in none.
pub fn status(folder: &Path) -> Option<Status> {
    let repository = find(folder)?;
    let head = fs::read_to_string(repository.git_dir.join("HEAD")).ok()?;

    Some(Status {
        branch: parse_head(&head)?,
        changes: changes(&repository.root),
    })
}

/// Walks up from `folder` to the first one that holds a `.git`.
fn find(folder: &Path) -> Option<Repository> {
    folder.ancestors().find_map(|root| {
        let dot_git = root.join(".git");
        if dot_git.is_dir() {
            return Some(Repository {
                root: root.to_path_buf(),
                git_dir: dot_git,
            });
        }

        // In a worktree or a submodule `.git` is a file that says where
        // the real one is.
        let text = fs::read_to_string(&dot_git).ok()?;
        Some(Repository {
            root: root.to_path_buf(),
            git_dir: root.join(parse_git_file(&text)?),
        })
    })
}

/// The path in a `.git` file: `gitdir: <path>`, relative to the file or not.
fn parse_git_file(text: &str) -> Option<&Path> {
    let path = text.strip_prefix("gitdir:")?.trim();
    (!path.is_empty()).then(|| Path::new(path))
}

/// The branch `HEAD` is on, or the short form of the commit it holds.
fn parse_head(text: &str) -> Option<String> {
    let text = text.trim();
    if let Some(reference) = text.strip_prefix("ref:") {
        let reference = reference.trim();
        let branch = reference.strip_prefix("refs/heads/").unwrap_or(reference);
        return (!branch.is_empty()).then(|| branch.to_string());
    }

    let is_commit = text.len() >= SHORT_COMMIT && text.bytes().all(|b| b.is_ascii_hexdigit());
    is_commit.then(|| text[..SHORT_COMMIT].to_string())
}

/// Asks git how many files of `root` have changes: one line each in the
/// short status. Without git, or if it fails, the answer is none: a mark
/// that is wrong is worse than one that is missing.
fn changes(root: &Path) -> u32 {
    Command::new("git")
        // Looking must not take the lock a command of the user is waiting for.
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map_or(0, |output| {
            let lines = output.stdout.split(|&b| b == b'\n');
            let files = lines.filter(|line| !line.is_empty()).count();
            u32::try_from(files).unwrap_or(u32::MAX)
        })
}

/// Shortest time between two looks at the repository.
const PAUSE: Duration = Duration::from_secs(1);
/// A slow look is followed by a pause this many times as long: a big
/// repository is asked less often.
const SLOWDOWN: u32 = 10;

/// What the session and the thread of the watcher share.
#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    wake: Condvar,
}

#[derive(Default)]
struct State {
    folder: Option<PathBuf>,
    /// Something happened since the last look.
    stale: bool,
    /// The folder changed: the next look does not wait for the pause.
    moved: bool,
    closed: bool,
}

/// Follows the repository of one session on a thread of its own, so that
/// a slow `git status` never holds the terminal back.
///
/// Nothing says when a repository changes: the watcher looks again when
/// the terminal has shown something, which is when a command may have
/// changed it.
pub struct Watcher(Arc<Shared>);

impl Watcher {
    /// `on_change` is called with every new state; `None`: no repository.
    pub fn spawn(on_change: impl Fn(Option<Status>) + Send + 'static) -> Watcher {
        Watcher::spawn_with(PAUSE, on_change)
    }

    fn spawn_with(pause: Duration, on_change: impl Fn(Option<Status>) + Send + 'static) -> Watcher {
        let shared = Arc::new(Shared::default());
        let for_thread = Arc::clone(&shared);

        thread::spawn(move || {
            // A session starts outside any repository, as far as it knows.
            let mut last: Option<Status> = None;
            while let Some(folder) = for_thread.next_folder() {
                let started = Instant::now();
                let found = status(&folder);
                if found != last {
                    last.clone_from(&found);
                    on_change(found);
                }

                for_thread.rest(pause.max(started.elapsed() * SLOWDOWN));
            }
        });

        Watcher(shared)
    }

    /// The session moved to another folder.
    pub fn set_folder(&self, folder: PathBuf) {
        let mut state = self.0.state.lock().unwrap();
        state.folder = Some(folder);
        state.stale = true;
        state.moved = true;
        self.0.wake.notify_one();
    }

    /// The terminal showed something: the repository may have changed.
    pub fn poke(&self) {
        let mut state = self.0.state.lock().unwrap();
        if !state.stale {
            state.stale = true;
            self.0.wake.notify_one();
        }
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().closed = true;
        self.0.wake.notify_one();
    }
}

impl Shared {
    /// Waits until there is a folder to look at. `None`: the watcher is closed.
    fn next_folder(&self) -> Option<PathBuf> {
        let mut state = self
            .wake
            .wait_while(self.state.lock().unwrap(), |state| {
                !state.closed && !(state.stale && state.folder.is_some())
            })
            .unwrap();
        if state.closed {
            return None;
        }

        state.stale = false;
        state.moved = false;
        state.folder.clone()
    }

    /// Waits `pause`, or less if the folder changes or the watcher closes.
    fn rest(&self, pause: Duration) {
        let _ = self
            .wake
            .wait_timeout_while(self.state.lock().unwrap(), pause, |state| {
                !state.closed && !state.moved
            })
            .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicU32, Ordering},
        mpsc,
    };

    use super::*;

    const TIMEOUT: Duration = Duration::from_secs(5);

    /// A folder of its own for one test, removed when the test ends.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let name = format!(
                "ttylde-git-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            );
            // The system reports real paths: `/tmp` may be a link.
            let path = std::env::temp_dir().canonicalize().unwrap().join(name);
            fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }

        fn write(&self, file: &str, text: &str) {
            let path = self.0.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn git(folder: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(folder)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("git is needed to run these tests");
        assert!(status.success(), "git {args:?} failed");
    }

    fn clean(branch: &str) -> Option<Status> {
        Some(Status {
            branch: branch.to_string(),
            changes: 0,
        })
    }

    #[test]
    fn head_on_a_branch() {
        assert_eq!(parse_head("ref: refs/heads/main\n"), Some("main".into()));
    }

    // A branch name can have slashes of its own.
    #[test]
    fn a_branch_keeps_its_slashes() {
        assert_eq!(
            parse_head("ref: refs/heads/feature/tabs\n"),
            Some("feature/tabs".into())
        );
    }

    // Checking out a commit or a tag leaves `HEAD` on no branch.
    #[test]
    fn a_detached_head_is_a_short_commit() {
        assert_eq!(
            parse_head("3bf1efe0c2a94d7e8f1b6a5d4c3b2a1908f7e6d5\n"),
            Some("3bf1efe".into())
        );
    }

    #[test]
    fn a_broken_head_is_no_branch() {
        assert_eq!(parse_head(""), None);
        assert_eq!(parse_head("ref: \n"), None);
        assert_eq!(parse_head("not a commit\n"), None);
        assert_eq!(parse_head("3bf1\n"), None);
    }

    #[test]
    fn git_file_points_to_the_real_folder() {
        assert_eq!(
            parse_git_file("gitdir: /repo/.git/worktrees/fix\n"),
            Some(Path::new("/repo/.git/worktrees/fix"))
        );
        assert_eq!(parse_git_file("gitdir:\n"), None);
        assert_eq!(parse_git_file("something else"), None);
    }

    #[test]
    fn a_folder_outside_any_repository_has_no_status() {
        let dir = TempDir::new();
        assert_eq!(status(&dir.0), None);
    }

    // What git itself would not call a repository still has a branch to show.
    #[test]
    fn the_branch_is_read_from_head() {
        let dir = TempDir::new();
        dir.write(".git/HEAD", "ref: refs/heads/main\n");

        assert_eq!(status(&dir.0), clean("main"));
    }

    #[test]
    fn the_repository_is_found_from_a_folder_inside_it() {
        let dir = TempDir::new();
        dir.write(".git/HEAD", "ref: refs/heads/main\n");
        dir.write("src/deep/file.txt", "");

        assert_eq!(status(&dir.0.join("src/deep")), clean("main"));
    }

    // The nearest repository wins: a submodule is not its parent.
    #[test]
    fn the_nearest_repository_wins() {
        let dir = TempDir::new();
        dir.write(".git/HEAD", "ref: refs/heads/outer\n");
        dir.write("vendor/lib/.git/HEAD", "ref: refs/heads/inner\n");

        assert_eq!(status(&dir.0.join("vendor/lib")), clean("inner"));
        assert_eq!(status(&dir.0.join("vendor")), clean("outer"));
    }

    #[test]
    fn a_git_file_is_followed() {
        let dir = TempDir::new();
        dir.write("real/HEAD", "ref: refs/heads/fix\n");
        dir.write("tree/.git", "gitdir: ../real\n");

        assert_eq!(status(&dir.0.join("tree")), clean("fix"));
    }

    #[test]
    fn new_files_are_changes_to_commit() {
        let dir = TempDir::new();
        git(&dir.0, &["init", "--quiet", "--initial-branch=work"]);
        assert_eq!(status(&dir.0), clean("work"));

        dir.write("new.txt", "hello");
        dir.write("other.txt", "hello");
        assert_eq!(
            status(&dir.0),
            Some(Status {
                branch: "work".into(),
                changes: 2
            })
        );
    }

    /// A watcher that hands its reports over a channel.
    fn watch() -> (Watcher, mpsc::Receiver<Option<Status>>) {
        let (tx, rx) = mpsc::channel();
        let watcher = Watcher::spawn_with(Duration::from_millis(10), move |status| {
            let _ = tx.send(status);
        });
        (watcher, rx)
    }

    #[test]
    fn the_watcher_reports_the_repository_of_the_folder() {
        let dir = TempDir::new();
        dir.write(".git/HEAD", "ref: refs/heads/main\n");
        let (watcher, rx) = watch();

        watcher.set_folder(dir.0.clone());
        assert_eq!(rx.recv_timeout(TIMEOUT).unwrap(), clean("main"));
    }

    // Nothing to say about a folder that is in no repository, like the
    // one the session starts in.
    #[test]
    fn the_watcher_is_silent_outside_a_repository() {
        let dir = TempDir::new();
        let (watcher, rx) = watch();

        watcher.set_folder(dir.0.clone());
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

    // `git switch` changes the branch and not the folder.
    #[test]
    fn a_poke_makes_the_watcher_look_again() {
        let dir = TempDir::new();
        dir.write(".git/HEAD", "ref: refs/heads/main\n");
        let (watcher, rx) = watch();
        watcher.set_folder(dir.0.clone());
        assert_eq!(rx.recv_timeout(TIMEOUT).unwrap(), clean("main"));

        dir.write(".git/HEAD", "ref: refs/heads/other\n");
        // Without a poke the watcher has no reason to look.
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());

        watcher.poke();
        assert_eq!(rx.recv_timeout(TIMEOUT).unwrap(), clean("other"));
    }

    // Looking again at what has not changed is not news.
    #[test]
    fn the_same_state_is_reported_once() {
        let dir = TempDir::new();
        dir.write(".git/HEAD", "ref: refs/heads/main\n");
        let (watcher, rx) = watch();
        watcher.set_folder(dir.0.clone());
        assert_eq!(rx.recv_timeout(TIMEOUT).unwrap(), clean("main"));

        watcher.poke();
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[test]
    fn leaving_the_repository_is_reported() {
        let inside = TempDir::new();
        inside.write(".git/HEAD", "ref: refs/heads/main\n");
        let outside = TempDir::new();
        let (watcher, rx) = watch();
        watcher.set_folder(inside.0.clone());
        assert_eq!(rx.recv_timeout(TIMEOUT).unwrap(), clean("main"));

        watcher.set_folder(outside.0.clone());
        assert_eq!(rx.recv_timeout(TIMEOUT).unwrap(), None);
    }

    // The thread ends with the watcher: the callback is dropped with it.
    #[test]
    fn dropping_the_watcher_stops_its_thread() {
        let (watcher, rx) = watch();
        drop(watcher);

        assert_eq!(
            rx.recv_timeout(TIMEOUT),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
    }
}
