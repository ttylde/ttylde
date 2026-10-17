//! The history of the commands run in Ttylde: one entry for every command
//! that ends, with where it ran and how it ended. The palette searches it.
//!
//! It is Ttylde's own: the history of the shell is not touched. It comes
//! only from the shell integration (see `shell`), and keeps only what the
//! filters let through: no command typed after a space, none with a key or
//! a token in it, none the user excluded.
//!
//! One SQLite file, readable by its owner only. Entries are found by folder,
//! space, time and exit status through indexes, and by text through FTS5.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
};

use nucleo_matcher::{
    pattern::{CaseMatching, Normalization, Pattern},
    Config, Matcher, Utf32Str,
};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::{
    config::{glob, HistoryConfig},
    cwd::expand_home,
    error::Result,
    session::SessionEvent,
};

/// The version of the schema below, kept in `user_version`.
const SCHEMA_VERSION: i32 = 2;

/// Version 2: one row per command, for the palette.
const COMMANDS_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS entries_command ON entries (command, space);";

const SCHEMA: &str = "
CREATE TABLE entries (
    id INTEGER PRIMARY KEY,
    command TEXT NOT NULL,
    cwd TEXT,
    space INTEGER,
    branch TEXT,
    started INTEGER NOT NULL,
    ended INTEGER NOT NULL,
    exit INTEGER
);
CREATE INDEX entries_ended ON entries (ended);
CREATE INDEX entries_cwd ON entries (cwd, ended);
CREATE INDEX entries_space ON entries (space, ended);

-- The text, for searches anywhere in a command: the trigram tokenizer
-- finds any three characters in a row, case aside.
CREATE VIRTUAL TABLE entries_text USING fts5 (
    command, content = 'entries', content_rowid = 'id', tokenize = 'trigram'
);
CREATE TRIGGER entries_added AFTER INSERT ON entries BEGIN
    INSERT INTO entries_text (rowid, command) VALUES (new.id, new.command);
END;
CREATE TRIGGER entries_removed AFTER DELETE ON entries BEGIN
    INSERT INTO entries_text (entries_text, rowid, command)
        VALUES ('delete', old.id, old.command);
END;
";

/// A command that ended, as the history keeps it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Entry {
    pub id: i64,
    pub command: String,
    /// The folder it ran in, if the shell said.
    pub cwd: Option<String>,
    /// The space of its tab; `None` for a pinned tab or one without a space.
    pub space: Option<u32>,
    /// The branch of the folder, if it is in a repository.
    pub branch: Option<String>,
    /// When it started and ended, in milliseconds since 1970.
    pub started: u64,
    pub ended: u64,
    /// Its exit status, if the shell said.
    pub exit: Option<i32>,
}

/// What to record: an `Entry` before it has an id.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Record {
    pub command: String,
    pub cwd: Option<String>,
    pub space: Option<u32>,
    pub branch: Option<String>,
    pub started: u64,
    pub ended: u64,
    pub exit: Option<i32>,
}

/// A command as the palette lists it: its last run, and how many there were.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Command {
    pub last: Entry,
    pub runs: u32,
}

/// What to look for. Every field set narrows the search; the newest come
/// first.
#[derive(Debug, Clone, Default)]
pub struct Query {
    /// Text anywhere in the command, case aside.
    pub text: Option<String>,
    pub cwd: Option<String>,
    pub space: Option<u32>,
    /// Ended at this time or later, in milliseconds since 1970.
    pub since: Option<u64>,
    /// Only those that ended with an exit status other than 0.
    pub failed: bool,
    pub limit: u32,
}

/// Known keys and tokens: a command with one in it is not saved. They are
/// shapes these services give their secrets, so a match is rarely anything
/// else.
static SECRETS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        // AWS access key ids.
        r"\b(AKIA|ASIA)[0-9A-Z]{16}\b",
        // GitHub tokens, classic and fine-grained.
        r"\bgh[pousr]_[A-Za-z0-9]{36,}\b",
        r"\bgithub_pat_[A-Za-z0-9_]{60,}\b",
        // GitLab personal access tokens.
        r"\bglpat-[A-Za-z0-9_-]{20,}\b",
        // Slack tokens and webhooks.
        r"\bxox[abposr]-[A-Za-z0-9-]{10,}",
        r"hooks\.slack\.com/services/[A-Za-z0-9/]+",
        // Stripe secret and restricted keys.
        r"\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b",
        // Google API keys.
        r"\bAIza[0-9A-Za-z_-]{35}\b",
        // OpenAI and Anthropic API keys.
        r"\bsk-(proj-|ant-)?[A-Za-z0-9_-]{32,}",
        // npm and PyPI tokens.
        r"\bnpm_[A-Za-z0-9]{36}\b",
        r"\bpypi-[A-Za-z0-9_-]{50,}",
        // A private key pasted whole.
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    ]
    .iter()
    .map(|pattern| Regex::new(pattern).expect("the secret patterns compile"))
    .collect()
});

/// What the history leaves out: see `HistoryConfig`.
#[derive(Debug, Clone)]
pub struct Filter {
    secrets: bool,
    exclude: Vec<Regex>,
    /// The excluded folders, with the home written out.
    folders: Vec<String>,
}

impl Filter {
    /// The filter `config` asks for; `home` stands for `~` in its folders.
    pub fn new(config: &HistoryConfig, home: Option<&Path>) -> Filter {
        let folders = config
            .exclude_folders
            .iter()
            .map(|folder| match home {
                Some(home) => expand_home(folder, home).to_string_lossy().into_owned(),
                None => folder.clone(),
            })
            .map(|folder| folder.trim_end_matches('/').to_string())
            .collect();
        Filter {
            secrets: config.secrets_filter,
            // Checked when the config was read: they compile.
            exclude: config
                .exclude
                .iter()
                .filter_map(|pattern| Regex::new(pattern).ok())
                .collect(),
            folders,
        }
    }

    /// Whether a command, run in `cwd`, is one to keep.
    pub fn keeps(&self, command: &str, cwd: Option<&str>) -> bool {
        if command.trim().is_empty() || command.starts_with(' ') {
            return false;
        }
        if self.secrets && SECRETS.iter().any(|secret| secret.is_match(command)) {
            return false;
        }
        if self.exclude.iter().any(|pattern| pattern.is_match(command)) {
            return false;
        }
        let Some(cwd) = cwd else { return true };
        // A folder excludes itself and everything under it.
        !self
            .folders
            .iter()
            .any(|folder| glob(folder, cwd) || glob(&format!("{folder}/*"), cwd))
    }
}

/// How much the history keeps.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Limits {
    pub max_entries: u32,
    /// In milliseconds; `None`: entries do not go for their age.
    pub max_age: Option<u64>,
}

impl From<&HistoryConfig> for Limits {
    fn from(config: &HistoryConfig) -> Limits {
        Limits {
            max_entries: config.max_entries,
            max_age: config.max_age,
        }
    }
}

pub struct History {
    connection: Connection,
    filter: Filter,
    limits: Limits,
}

impl History {
    /// Opens the history at `path`, making it if it is not there.
    pub fn open(path: &Path, filter: Filter, limits: Limits) -> Result<History> {
        if let Some(folder) = path.parent() {
            fs::create_dir_all(folder)?;
        }
        private(path)?;
        let connection = Connection::open(path)?;
        // One write per command: the journal of WAL is enough, and quicker.
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        migrate(&connection)?;
        Ok(History {
            connection,
            filter,
            limits,
        })
    }

    /// Keeps `record` if the filter lets it through, then lets the oldest
    /// entries go past the limits. Returns its id; `None` if it was left out.
    pub fn record(&self, record: &Record) -> Result<Option<i64>> {
        if !self.filter.keeps(&record.command, record.cwd.as_deref()) {
            return Ok(None);
        }
        self.connection.execute(
            "INSERT INTO entries (command, cwd, space, branch, started, ended, exit)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                record.command,
                record.cwd,
                record.space,
                record.branch,
                time(record.started),
                time(record.ended),
                record.exit,
            ],
        )?;
        let id = self.connection.last_insert_rowid();
        self.prune(record.ended)?;
        Ok(Some(id))
    }

    // Past `max_entries` the oldest go; with `max_age`, those older than it.
    fn prune(&self, now: u64) -> Result<()> {
        let last_kept: Option<i64> = self
            .connection
            .query_row(
                "SELECT id FROM entries ORDER BY id DESC LIMIT 1 OFFSET ?1",
                [self.limits.max_entries - 1],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = last_kept {
            self.connection
                .execute("DELETE FROM entries WHERE id < ?1", [id])?;
        }
        if let Some(age) = self.limits.max_age {
            self.connection.execute(
                "DELETE FROM entries WHERE ended < ?1",
                [time(now.saturating_sub(age))],
            )?;
        }
        Ok(())
    }

    /// The entries `query` asks for, the newest first.
    pub fn search(&self, query: &Query) -> Result<Vec<Entry>> {
        let mut conditions: Vec<String> = Vec::new();
        let mut values: Vec<rusqlite::types::Value> = Vec::new();

        if let Some(text) = query.text.as_deref().filter(|t| !t.is_empty()) {
            // Trigrams need three characters; fewer are looked for one by one.
            if text.chars().count() >= 3 {
                conditions.push(
                    "id IN (SELECT rowid FROM entries_text WHERE entries_text MATCH ?)".into(),
                );
                values.push(format!("\"{}\"", text.replace('"', "\"\"")).into());
            } else {
                conditions.push("command LIKE ? ESCAPE '\\'".into());
                values.push(format!("%{}%", escape_like(text)).into());
            }
        }
        if let Some(cwd) = &query.cwd {
            conditions.push("cwd = ?".into());
            values.push(cwd.clone().into());
        }
        if let Some(space) = query.space {
            conditions.push("space = ?".into());
            values.push(i64::from(space).into());
        }
        if let Some(since) = query.since {
            conditions.push("ended >= ?".into());
            values.push(time(since).into());
        }
        if query.failed {
            conditions.push("exit IS NOT NULL AND exit != 0".into());
        }

        let mut sql = String::from(
            "SELECT id, command, cwd, space, branch, started, ended, exit FROM entries",
        );
        if !conditions.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&conditions.join(" AND "));
        }
        sql.push_str(" ORDER BY ended DESC, id DESC LIMIT ?");
        values.push(i64::from(query.limit).into());

        let mut statement = self.connection.prepare(&sql)?;
        let entries = statement
            .query_map(rusqlite::params_from_iter(values), read_entry)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(entries)
    }

    /// Lets the entry `id` go.
    pub fn delete(&self, id: i64) -> Result<()> {
        self.connection
            .execute("DELETE FROM entries WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Lets every entry go.
    pub fn clear(&self) -> Result<()> {
        self.connection.execute("DELETE FROM entries", [])?;
        Ok(())
    }

    /// The commands run in `space` (`None`: in any), one each, the one run
    /// last first. With `text`, those it matches as a fuzzy search does,
    /// the best match first: `gco` finds `git checkout`.
    pub fn commands(&self, space: Option<u32>, text: &str, limit: usize) -> Result<Vec<Command>> {
        // The last run of each, newest first: the ids grow with time.
        let mut statement = self.connection.prepare(
            "SELECT command, MAX(id), COUNT(*) FROM entries
             WHERE ?1 IS NULL OR space = ?1
             GROUP BY command ORDER BY MAX(id) DESC",
        )?;
        let rows = statement
            .query_map([space], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, u32>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let text = text.trim();
        let chosen: Vec<(i64, u32)> = if text.is_empty() {
            rows.into_iter()
                .take(limit)
                .map(|(_, id, runs)| (id, runs))
                .collect()
        } else {
            let pattern = Pattern::parse(text, CaseMatching::Smart, Normalization::Smart);
            let mut matcher = Matcher::new(Config::DEFAULT);
            let mut buffer = Vec::new();
            let mut scored: Vec<(u32, i64, u32)> = rows
                .into_iter()
                .filter_map(|(command, id, runs)| {
                    let haystack = Utf32Str::new(&command, &mut buffer);
                    let score = pattern.score(haystack, &mut matcher)?;
                    Some((score, id, runs))
                })
                .collect();
            // The best match first; among equals, the one run last.
            scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
            scored
                .into_iter()
                .take(limit)
                .map(|(_, id, runs)| (id, runs))
                .collect()
        };

        let mut entry = self.connection.prepare(
            "SELECT id, command, cwd, space, branch, started, ended, exit FROM entries WHERE id = ?1",
        )?;
        chosen
            .into_iter()
            .map(|(id, runs)| {
                let last = entry.query_row([id], read_entry)?;
                Ok(Command { last, runs })
            })
            .collect()
    }

    /// Lets every run of `command` in `space` (`None`: in any) go. Returns
    /// how many went.
    pub fn forget(&self, command: &str, space: Option<u32>) -> Result<usize> {
        let gone = self.connection.execute(
            "DELETE FROM entries WHERE command = ?1 AND (?2 IS NULL OR space = ?2)",
            params![command, space],
        )?;
        Ok(gone)
    }

    /// Lets every entry of `space` (`None`: of any) go. Returns how many
    /// commands went, as the palette counts them: one each.
    pub fn clear_in(&self, space: Option<u32>) -> Result<usize> {
        let commands = self.count(space)?;
        self.connection.execute(
            "DELETE FROM entries WHERE ?1 IS NULL OR space = ?1",
            [space],
        )?;
        Ok(commands)
    }

    /// How many commands `space` (`None`: any) has, one each.
    pub fn count(&self, space: Option<u32>) -> Result<usize> {
        let count: i64 = self.connection.query_row(
            "SELECT COUNT(DISTINCT command) FROM entries WHERE ?1 IS NULL OR space = ?1",
            [space],
            |row| row.get(0),
        )?;
        Ok(usize::try_from(count).unwrap_or(0))
    }
}

fn read_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    Ok(Entry {
        id: row.get(0)?,
        command: row.get(1)?,
        cwd: row.get(2)?,
        space: row.get(3)?,
        branch: row.get(4)?,
        started: u64::try_from(row.get::<_, i64>(5)?).unwrap_or(0),
        ended: u64::try_from(row.get::<_, i64>(6)?).unwrap_or(0),
        exit: row.get(7)?,
    })
}

/// Follows the events of one session and turns each command that ends into
/// a `Record`: the folder and the branch are the last ones the session
/// told, the space the one its tab is in.
#[derive(Debug, Default)]
pub struct Recorder {
    space: Option<u32>,
    cwd: Option<String>,
    branch: Option<String>,
    /// The command running: when it started, and its text once known.
    running: Option<(u64, Option<String>)>,
}

impl Recorder {
    /// The tab of the session moved to `space`; `None`: a pinned tab, or
    /// one without a space.
    pub fn set_space(&mut self, space: Option<u32>) {
        self.space = space;
    }

    /// Takes in `event`, seen at `now`; a command that ended is returned to
    /// be recorded. One whose text is not known is not: a shell that did
    /// not say it, or a command typed after a space.
    pub fn observe(&mut self, event: &SessionEvent, now: u64) -> Option<Record> {
        match event {
            SessionEvent::Cwd(folder) => self.cwd = Some(folder.to_string_lossy().into_owned()),
            SessionEvent::Git(status) => self.branch = status.as_ref().map(|s| s.branch.clone()),
            SessionEvent::CommandStart(text) => match &mut self.running {
                // A second start brings the text of the first.
                Some((_, known)) => {
                    if known.is_none() {
                        known.clone_from(text);
                    }
                }
                None => self.running = Some((now, text.clone())),
            },
            SessionEvent::CommandEnd(exit) => {
                let (started, text) = self.running.take()?;
                return Some(Record {
                    command: text?,
                    cwd: self.cwd.clone(),
                    space: self.space,
                    branch: self.branch.clone(),
                    started,
                    ended: now,
                    exit: *exit,
                });
            }
            SessionEvent::Exit => self.running = None,
            _ => {}
        }
        None
    }
}

/// Where the history lives: next to the state, under `$XDG_STATE_HOME`.
pub fn default_path() -> Option<PathBuf> {
    Some(crate::state::default_path()?.with_file_name("history.db"))
}

// Makes the schema, or brings an older one up to date.
fn migrate(connection: &Connection) -> Result<()> {
    let version: i32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version < 1 {
        connection.execute_batch(SCHEMA)?;
    }
    if version < 2 {
        connection.execute_batch(COMMANDS_INDEX)?;
    }
    connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

// The file, only its owner can read: it has every command the user ran.
// SQLite gives its journal files the same permissions.
fn private(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

// SQLite keeps integers signed: milliseconds since 1970 fit for a while.
fn time(ms: u64) -> i64 {
    i64::try_from(ms).unwrap_or(i64::MAX)
}

// `%`, `_` and the escape itself, taken as they are by LIKE.
fn escape_like(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    // A folder of its own for each test: they run at the same time.
    fn temp_path(name: &str) -> PathBuf {
        let folder =
            std::env::temp_dir().join(format!("ttylde-history-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        folder.join("history.db")
    }

    fn open(name: &str, config: HistoryConfig) -> History {
        let filter = Filter::new(&config, Some(Path::new("/Users/me")));
        History::open(&temp_path(name), filter, Limits::from(&config)).unwrap()
    }

    fn record(command: &str, ended: u64) -> Record {
        Record {
            command: command.into(),
            cwd: Some("/Users/me/work".into()),
            space: Some(1),
            branch: Some("main".into()),
            started: ended.saturating_sub(10),
            ended,
            exit: Some(0),
        }
    }

    fn commands(entries: &[Entry]) -> Vec<&str> {
        entries.iter().map(|e| e.command.as_str()).collect()
    }

    fn all(limit: u32) -> Query {
        Query {
            limit,
            ..Query::default()
        }
    }

    #[test]
    fn a_command_that_ends_is_a_record_with_where_it_ran() {
        let mut recorder = Recorder::default();
        recorder.set_space(Some(4));
        recorder.observe(&SessionEvent::Cwd("/Users/me/api".into()), 1);
        recorder.observe(
            &SessionEvent::Git(Some(crate::git::Status {
                branch: "fix".into(),
                dirty: false,
            })),
            2,
        );
        assert_eq!(
            recorder.observe(&SessionEvent::CommandStart(Some("make".into())), 10),
            None
        );
        let record = recorder
            .observe(&SessionEvent::CommandEnd(Some(2)), 25)
            .unwrap();
        assert_eq!(
            record,
            Record {
                command: "make".into(),
                cwd: Some("/Users/me/api".into()),
                space: Some(4),
                branch: Some("fix".into()),
                started: 10,
                ended: 25,
                exit: Some(2),
            }
        );
        // One end, one record.
        assert_eq!(
            recorder.observe(&SessionEvent::CommandEnd(Some(0)), 30),
            None
        );
    }

    // fish marks the start itself, then the script adds the text.
    #[test]
    fn the_text_can_come_with_a_second_start() {
        let mut recorder = Recorder::default();
        recorder.observe(&SessionEvent::CommandStart(None), 10);
        recorder.observe(&SessionEvent::CommandStart(Some("ls".into())), 11);
        let record = recorder
            .observe(&SessionEvent::CommandEnd(Some(0)), 20)
            .unwrap();
        assert_eq!((record.command.as_str(), record.started), ("ls", 10));
    }

    // A shell that did not say the text, or a command after a space.
    #[test]
    fn a_command_without_its_text_is_not_recorded() {
        let mut recorder = Recorder::default();
        recorder.observe(&SessionEvent::CommandStart(None), 10);
        assert_eq!(
            recorder.observe(&SessionEvent::CommandEnd(Some(0)), 20),
            None
        );
    }

    #[test]
    fn what_is_recorded_is_found_back_newest_first() {
        let history = open("round", HistoryConfig::default());
        history.record(&record("ls", 100)).unwrap();
        history.record(&record("cargo test", 200)).unwrap();

        let entries = history.search(&all(10)).unwrap();
        assert_eq!(commands(&entries), ["cargo test", "ls"]);
        let entry = &entries[0];
        assert_eq!(entry.cwd.as_deref(), Some("/Users/me/work"));
        assert_eq!(
            (entry.space, entry.branch.as_deref()),
            (Some(1), Some("main"))
        );
        assert_eq!(
            (entry.started, entry.ended, entry.exit),
            (190, 200, Some(0))
        );
    }

    #[test]
    fn the_history_is_still_there_when_opened_again() {
        let path = temp_path("again");
        let config = HistoryConfig::default();
        let filter = Filter::new(&config, None);
        {
            let history = History::open(&path, filter.clone(), Limits::from(&config)).unwrap();
            history.record(&record("make", 1)).unwrap();
        }
        let history = History::open(&path, filter, Limits::from(&config)).unwrap();
        assert_eq!(commands(&history.search(&all(10)).unwrap()), ["make"]);
    }

    // It has every command the user ran.
    #[cfg(unix)]
    #[test]
    fn only_its_owner_can_read_it() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_path("private");
        let config = HistoryConfig::default();
        let history =
            History::open(&path, Filter::new(&config, None), Limits::from(&config)).unwrap();
        history.record(&record("ls", 1)).unwrap();

        for file in [path.clone(), path.with_extension("db-wal")] {
            let mode = fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{}", file.display());
        }
    }

    #[test]
    fn commands_after_a_space_and_empty_ones_are_not_kept() {
        let history = open("space", HistoryConfig::default());
        assert_eq!(history.record(&record(" export TOKEN=1", 1)).unwrap(), None);
        assert_eq!(history.record(&record("   ", 2)).unwrap(), None);
        assert!(history.search(&all(10)).unwrap().is_empty());
    }

    #[test]
    fn commands_with_a_secret_are_not_kept() {
        let history = open("secrets", HistoryConfig::default());
        let secrets = [
            "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE",
            "git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/me/x",
            "curl -H 'Authorization: Bearer sk_live_abcdefghijklmnop1234' api",
            "export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
            "echo '-----BEGIN OPENSSH PRIVATE KEY-----' > key",
            "curl -X POST https://hooks.slack.com/services/T000/B000/XXXX",
        ];
        for (i, command) in secrets.iter().enumerate() {
            let kept = history.record(&record(command, i as u64)).unwrap();
            assert_eq!(kept, None, "{command}");
        }
        // Looking like a token is not enough.
        assert!(history
            .record(&record("git checkout akia-fix", 9))
            .unwrap()
            .is_some());
    }

    #[test]
    fn the_secret_filter_can_be_turned_off() {
        let config = HistoryConfig {
            secrets_filter: false,
            ..HistoryConfig::default()
        };
        let history = open("no-secrets", config);
        let command = "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE";
        assert!(history.record(&record(command, 1)).unwrap().is_some());
    }

    #[test]
    fn excluded_commands_are_not_kept() {
        let config = HistoryConfig {
            exclude: vec!["^export ".into(), "password".into()],
            ..HistoryConfig::default()
        };
        let history = open("exclude", config);
        assert_eq!(history.record(&record("export X=1", 1)).unwrap(), None);
        assert_eq!(
            history.record(&record("mysql --password=x", 2)).unwrap(),
            None
        );
        assert!(history.record(&record("echo export", 3)).unwrap().is_some());
    }

    #[test]
    fn nothing_run_in_an_excluded_folder_is_kept() {
        let config = HistoryConfig {
            exclude_folders: vec!["~/clients/acme".into(), "/tmp/*/secret".into()],
            ..HistoryConfig::default()
        };
        let history = open("folders", config);
        let at = |command: &str, cwd: &str| Record {
            cwd: Some(cwd.into()),
            ..record(command, 1)
        };
        assert_eq!(
            history.record(&at("ls", "/Users/me/clients/acme")).unwrap(),
            None
        );
        assert_eq!(
            history
                .record(&at("ls", "/Users/me/clients/acme/api"))
                .unwrap(),
            None
        );
        assert_eq!(history.record(&at("ls", "/tmp/x/secret")).unwrap(), None);
        assert!(history
            .record(&at("ls", "/Users/me/clients/acme2"))
            .unwrap()
            .is_some());
        assert!(history
            .record(&at("ls", "/Users/me/clients"))
            .unwrap()
            .is_some());
    }

    #[test]
    fn past_the_limit_the_oldest_go() {
        let config = HistoryConfig {
            max_entries: 3,
            ..HistoryConfig::default()
        };
        let history = open("limit", config);
        for (i, command) in ["a", "b", "c", "d", "e"].iter().enumerate() {
            history.record(&record(command, i as u64)).unwrap();
        }
        assert_eq!(
            commands(&history.search(&all(10)).unwrap()),
            ["e", "d", "c"]
        );
    }

    #[test]
    fn entries_older_than_the_age_go() {
        let config = HistoryConfig {
            max_age: Some(100),
            ..HistoryConfig::default()
        };
        let history = open("age", config);
        history.record(&record("old", 10)).unwrap();
        history.record(&record("recent", 150)).unwrap();
        history.record(&record("now", 200)).unwrap();
        assert_eq!(
            commands(&history.search(&all(10)).unwrap()),
            ["now", "recent"]
        );
    }

    #[test]
    fn text_is_found_anywhere_in_a_command_case_aside() {
        let history = open("text", HistoryConfig::default());
        history.record(&record("git checkout main", 1)).unwrap();
        history.record(&record("npm run dev", 2)).unwrap();
        history.record(&record("echo \"50% done\"", 3)).unwrap();

        let find = |text: &str| {
            let query = Query {
                text: Some(text.into()),
                ..all(10)
            };
            let entries = history.search(&query).unwrap();
            commands(&entries)
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        };
        assert_eq!(find("CHECK"), ["git checkout main"]);
        assert_eq!(find("un d"), ["npm run dev"]);
        // Fewer than three characters, and the characters LIKE and FTS treat.
        assert_eq!(find("m"), ["npm run dev", "git checkout main"]);
        assert_eq!(find("%"), ["echo \"50% done\""]);
        assert_eq!(find("\"50%"), ["echo \"50% done\""]);
        assert!(find("missing").is_empty());
    }

    #[test]
    fn searches_narrow_by_folder_space_time_and_failure() {
        let history = open("filters", HistoryConfig::default());
        history.record(&record("here", 100)).unwrap();
        history
            .record(&Record {
                cwd: Some("/elsewhere".into()),
                space: Some(2),
                ..record("elsewhere", 200)
            })
            .unwrap();
        history
            .record(&Record {
                exit: Some(1),
                ..record("failed", 300)
            })
            .unwrap();

        let search = |query: Query| {
            let entries = history.search(&query).unwrap();
            commands(&entries)
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        };
        let cwd = Query {
            cwd: Some("/Users/me/work".into()),
            ..all(10)
        };
        assert_eq!(search(cwd), ["failed", "here"]);
        assert_eq!(
            search(Query {
                space: Some(2),
                ..all(10)
            }),
            ["elsewhere"]
        );
        assert_eq!(
            search(Query {
                since: Some(200),
                ..all(10)
            }),
            ["failed", "elsewhere"]
        );
        assert_eq!(
            search(Query {
                failed: true,
                ..all(10)
            }),
            ["failed"]
        );
        assert_eq!(search(all(1)), ["failed"]);
    }

    fn run(history: &History, command: &str, ended: u64, space: Option<u32>, exit: i32) {
        history
            .record(&Record {
                space,
                exit: Some(exit),
                ..record(command, ended)
            })
            .unwrap();
    }

    fn listed(commands: &[Command]) -> Vec<(&str, u32)> {
        commands
            .iter()
            .map(|c| (c.last.command.as_str(), c.runs))
            .collect()
    }

    // `cargo test` thirty times is one row: its last run.
    #[test]
    fn commands_come_once_with_their_last_run() {
        let history = open("commands", HistoryConfig::default());
        run(&history, "cargo test", 10, Some(1), 0);
        run(&history, "ls", 20, Some(1), 0);
        run(&history, "cargo test", 30, Some(1), 101);

        let commands = history.commands(None, "", 10).unwrap();
        assert_eq!(listed(&commands), [("cargo test", 2), ("ls", 1)]);
        assert_eq!(
            (commands[0].last.ended, commands[0].last.exit),
            (30, Some(101))
        );
        assert_eq!(history.commands(None, "", 1).unwrap().len(), 1);
    }

    #[test]
    fn commands_are_per_space_or_all() {
        let history = open("commands-space", HistoryConfig::default());
        run(&history, "make", 10, Some(1), 0);
        run(&history, "make", 20, Some(2), 0);
        run(&history, "npm ci", 30, Some(2), 0);
        run(&history, "top", 40, None, 0);

        assert_eq!(
            listed(&history.commands(Some(1), "", 10).unwrap()),
            [("make", 1)]
        );
        assert_eq!(
            listed(&history.commands(Some(2), "", 10).unwrap()),
            [("npm ci", 1), ("make", 1)]
        );
        assert_eq!(
            listed(&history.commands(None, "", 10).unwrap()),
            [("top", 1), ("npm ci", 1), ("make", 2)]
        );
        assert_eq!(history.count(Some(2)).unwrap(), 2);
        assert_eq!(history.count(None).unwrap(), 3);
    }

    // As fzf does: the letters in order, not side by side.
    #[test]
    fn the_search_is_fuzzy_and_ranks_the_best_first() {
        let history = open("fuzzy", HistoryConfig::default());
        run(&history, "git checkout main", 10, None, 0);
        run(&history, "go test ./...", 20, None, 0);
        run(&history, "cargo clippy", 30, None, 0);

        let found = history.commands(None, "gco", 10).unwrap();
        assert_eq!(found[0].last.command, "git checkout main");
        assert!(listed(&found).iter().all(|(c, _)| *c != "cargo clippy"));
        assert!(history.commands(None, "zzz", 10).unwrap().is_empty());
        // Lower case finds both cases; upper case only itself.
        run(&history, "echo Hello", 40, None, 0);
        assert_eq!(
            listed(&history.commands(None, "hello", 10).unwrap()),
            [("echo Hello", 1)]
        );
        assert!(history.commands(None, "HELLO", 10).unwrap().is_empty());
    }

    #[test]
    fn a_command_is_forgotten_in_its_space_only() {
        let history = open("forget", HistoryConfig::default());
        run(&history, "make", 10, Some(1), 0);
        run(&history, "make", 20, Some(1), 0);
        run(&history, "make", 30, Some(2), 0);

        assert_eq!(history.forget("make", Some(1)).unwrap(), 2);
        assert_eq!(
            listed(&history.commands(None, "", 10).unwrap()),
            [("make", 1)]
        );
        assert_eq!(history.forget("make", None).unwrap(), 1);
        assert!(history.commands(None, "", 10).unwrap().is_empty());
    }

    #[test]
    fn a_space_is_cleared_alone() {
        let history = open("clear-space", HistoryConfig::default());
        run(&history, "make", 10, Some(1), 0);
        run(&history, "make", 20, Some(1), 0);
        run(&history, "ls", 30, Some(1), 0);
        run(&history, "top", 40, Some(2), 0);

        assert_eq!(history.clear_in(Some(1)).unwrap(), 2);
        assert_eq!(
            listed(&history.commands(None, "", 10).unwrap()),
            [("top", 1)]
        );
        assert_eq!(history.clear_in(None).unwrap(), 1);
        assert_eq!(history.count(None).unwrap(), 0);
    }

    #[test]
    fn an_entry_can_go_and_so_can_all_of_them() {
        let history = open("delete", HistoryConfig::default());
        let id = history.record(&record("cargo build", 1)).unwrap().unwrap();
        history.record(&record("cargo test", 2)).unwrap();

        history.delete(id).unwrap();
        let text = Query {
            text: Some("cargo".into()),
            ..all(10)
        };
        assert_eq!(commands(&history.search(&text).unwrap()), ["cargo test"]);

        history.clear().unwrap();
        assert!(history.search(&all(10)).unwrap().is_empty());
        assert!(history.search(&text).unwrap().is_empty());
    }
}
