//! The config file: font, theme, shell integration, what to start again on
//! resume and what the history keeps, in TOML.
//!
//! Everything in the file is optional. Serde checks its shape through the
//! `Raw*` types, where every field may be missing; the values are checked
//! here, so the errors can name the field that is wrong.

use std::{
    env,
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    theme::Theme,
};

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub font: Font,
    pub theme: Theme,
    /// Whether the shells Ttylde starts load its integration (see `shell`).
    /// On unless the file turns it off.
    pub shell_integration: bool,
    pub restore: Restore,
    pub history: HistoryConfig,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            font: Font::default(),
            theme: Theme::default(),
            shell_integration: true,
            restore: Restore::default(),
            history: HistoryConfig::default(),
        }
    }
}

/// What the history of commands keeps: see `history`.
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryConfig {
    /// `false`: no command is saved.
    pub enabled: bool,
    /// The oldest entries go once there are more.
    pub max_entries: u32,
    /// Entries older than this go, in milliseconds; `None`: none for age.
    pub max_age: Option<u64>,
    /// Commands with a known key or token in them are not saved.
    pub secrets_filter: bool,
    /// Regexes: a command matching one is not saved. Checked when the file
    /// is read, so these always compile.
    pub exclude: Vec<String>,
    /// Folders, `~` for the home, `*` for any text: nothing run in one of
    /// them, or under it, is saved.
    pub exclude_folders: Vec<String>,
}

impl Default for HistoryConfig {
    fn default() -> Self {
        HistoryConfig {
            enabled: true,
            max_entries: 50_000,
            max_age: None,
            secrets_filter: true,
            exclude: Vec::new(),
            exclude_folders: Vec::new(),
        }
    }
}

/// What happens, when a space is resumed, to the commands that were running
/// in its tabs when it was closed.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Restore {
    pub run: Run,
    /// Globs on the text of a command, for `Run::Matching`: `*` is any text,
    /// `?` any one character.
    pub patterns: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Run {
    /// A banner offers to start each one again with Enter.
    #[default]
    Ask,
    /// Every one starts again by itself.
    All,
    /// The ones that match a pattern start again by itself, the others get
    /// the banner.
    Matching,
}

impl Restore {
    /// Whether `command` starts again without asking.
    pub fn runs_by_itself(&self, command: &str) -> bool {
        match self.run {
            Run::Ask => false,
            Run::All => true,
            Run::Matching => self.patterns.iter().any(|p| glob(p, command)),
        }
    }
}

/// Whether `text` matches `pattern` whole: `*` is any text, `?` any one
/// character, the rest stands for itself.
pub(crate) fn glob(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    // Where to go back to at the last `*`: its position, and the text it
    // has taken so far.
    let mut star: Option<(usize, usize)> = None;
    let (mut p, mut t) = (0, 0);
    while t < text.len() {
        match pattern.get(p) {
            Some('*') => {
                star = Some((p, t));
                p += 1;
            }
            Some(&c) if c == '?' || c == text[t] => {
                p += 1;
                t += 1;
            }
            _ => match star {
                // The `*` takes one more character, and the rest is tried again.
                Some((sp, st)) => {
                    star = Some((sp, st + 1));
                    p = sp + 1;
                    t = st + 1;
                }
                None => return false,
            },
        }
    }
    pattern[p..].iter().all(|&c| c == '*')
}

/// Sent to the frontend as it is: the renderer draws with it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Font {
    pub family: String,
    /// In CSS pixels, between 6 and 72.
    pub size: f32,
}

impl Default for Font {
    fn default() -> Self {
        Font {
            // Shipped with the app: it is there on every machine.
            family: "JetBrains Mono".to_string(),
            size: 13.0,
        }
    }
}

impl Config {
    /// Reads the file at `path`. A missing file is not an error: it means
    /// defaults.
    pub fn load(path: &Path) -> Result<Config> {
        match fs::read_to_string(path) {
            Ok(text) => Config::parse(&text),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(e.into()),
        }
    }

    /// Parses the text of a config file: what it does not set keeps its
    /// default.
    pub fn parse(raw: &str) -> Result<Config> {
        let parsed: RawConfig = toml::from_str(raw).map_err(|e| Error::Config(e.to_string()))?;

        let d_font = Font::default();
        // The colors the file leaves out are those of the theme it names.
        let d_theme = base(parsed.theme.base)?;

        let config: Config = Config {
            shell_integration: parsed.shell_integration.unwrap_or(true),
            restore: Restore {
                run: run(parsed.restore.run)?,
                patterns: parsed.restore.patterns.unwrap_or_default(),
            },
            history: history(parsed.history)?,
            font: Font {
                family: parsed.font.family.unwrap_or(d_font.family),
                size: size(parsed.font.size, d_font.size)?,
            },
            theme: Theme {
                foreground: color(
                    "theme.foreground",
                    parsed.theme.foreground,
                    d_theme.foreground,
                )?,
                background: color(
                    "theme.background",
                    parsed.theme.background,
                    d_theme.background,
                )?,
                cursor: color("theme.cursor", parsed.theme.cursor, d_theme.cursor)?,
                selection: color("theme.selection", parsed.theme.selection, d_theme.selection)?,
                ansi: ansi(parsed.theme.ansi, d_theme.ansi)?,
            },
        };

        Ok(config)
    }
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct RawConfig {
    font: RawFont,
    theme: RawTheme,
    shell_integration: Option<bool>,
    restore: RawRestore,
    history: RawHistory,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct RawHistory {
    enabled: Option<bool>,
    max_entries: Option<u32>,
    max_age: Option<String>,
    secrets_filter: Option<bool>,
    exclude: Option<Vec<String>>,
    exclude_folders: Option<Vec<String>>,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct RawRestore {
    run: Option<String>,
    #[serde(rename = "match")]
    patterns: Option<Vec<String>>,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct RawFont {
    family: Option<String>,
    size: Option<f32>,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct RawTheme {
    base: Option<String>,
    background: Option<String>,
    foreground: Option<String>,
    cursor: Option<String>,
    selection: Option<String>,
    ansi: Option<Vec<String>>,
}

/// `#rrggbb` to a color; `None` if the text is anything else.
fn parse_color(text: &str) -> Option<u32> {
    let hex = text.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }

    u32::from_str_radix(hex, 16).ok()
}

/// The color a field sets, or `default` if the file leaves it out.
fn color(field: &str, value: Option<String>, default: u32) -> Result<u32> {
    match value {
        None => Ok(default),
        Some(text) => parse_color(&text)
            .ok_or_else(|| Error::Config(format!("{field}: `{text}` is not a color"))),
    }
}

/// The theme a file starts from: `light`, which is the default, or `dark`.
fn base(value: Option<String>) -> Result<Theme> {
    match value.as_deref() {
        None | Some("light") => Ok(Theme::light()),
        Some("dark") => Ok(Theme::dark()),
        Some(name) => Err(Error::Config(format!(
            "theme.base: `{name}` is not `light` or `dark`"
        ))),
    }
}

/// The 16 ANSI colors the file sets, or `default` if it leaves them out.
fn ansi(value: Option<Vec<String>>, default: [u32; 16]) -> Result<[u32; 16]> {
    let Some(texts) = value else {
        return Ok(default);
    };

    if texts.len() != 16 {
        return Err(Error::Config(format!(
            "theme.ansi: expected 16 colors, found {}",
            texts.len()
        )));
    }

    let mut colors = default;
    for (i, text) in texts.into_iter().enumerate() {
        colors[i] = color(&format!("theme.ansi[{i}]"), Some(text), default[i])?;
    }
    Ok(colors)
}

/// What to start again on resume: `ask`, the default, `all` or `matching`.
fn run(value: Option<String>) -> Result<Run> {
    match value.as_deref() {
        None | Some("ask") => Ok(Run::Ask),
        Some("all") => Ok(Run::All),
        Some("matching") => Ok(Run::Matching),
        Some(other) => Err(Error::Config(format!(
            "restore.run: `{other}` is not `ask`, `all` or `matching`"
        ))),
    }
}

/// The `[history]` the file sets; what it leaves out keeps its default.
fn history(raw: RawHistory) -> Result<HistoryConfig> {
    let default = HistoryConfig::default();
    let max_entries = raw.max_entries.unwrap_or(default.max_entries);
    if max_entries == 0 {
        return Err(Error::Config(
            "history.max_entries: 0 keeps nothing, set `enabled = false` instead".into(),
        ));
    }
    let max_age = raw
        .max_age
        .map(|text| {
            age(&text).ok_or_else(|| {
                Error::Config(format!(
                    "history.max_age: `{text}` is not an age like `30d`, `12w`, `6m` or `1y`"
                ))
            })
        })
        .transpose()?;
    let exclude = raw.exclude.unwrap_or_default();
    for (i, pattern) in exclude.iter().enumerate() {
        if let Err(e) = regex::Regex::new(pattern) {
            return Err(Error::Config(format!("history.exclude[{i}]: {e}")));
        }
    }
    Ok(HistoryConfig {
        enabled: raw.enabled.unwrap_or(default.enabled),
        max_entries,
        max_age,
        secrets_filter: raw.secrets_filter.unwrap_or(default.secrets_filter),
        exclude,
        exclude_folders: raw.exclude_folders.unwrap_or_default(),
    })
}

/// `30d`, `12w`, `6m`, `1y` in milliseconds: days, weeks, months of 30
/// days, years of 365.
fn age(text: &str) -> Option<u64> {
    let text = text.trim();
    let unit = text.chars().last()?;
    let count: u64 = text[..text.len() - unit.len_utf8()].trim().parse().ok()?;
    let days = match unit {
        'd' => 1,
        'w' => 7,
        'm' => 30,
        'y' => 365,
        _ => return None,
    };
    (count > 0).then(|| count * days * 24 * 3600 * 1000)
}

/// The font size the file sets, or `default` if it leaves it out.
fn size(value: Option<f32>, default: f32) -> Result<f32> {
    match value {
        None => Ok(default),
        Some(n) if (6.0..=72.0).contains(&n) => Ok(n),
        Some(n) => Err(Error::Config(format!(
            "font.size: {n} is not between 6 and 72"
        ))),
    }
}

/// Where the config file lives: under `$XDG_CONFIG_HOME`, or `~/.config`.
pub fn default_path() -> Option<PathBuf> {
    path_from(env::var_os("XDG_CONFIG_HOME"), env::var_os("HOME"))
}

// An empty variable counts as unset, as the XDG specification asks.
fn path_from(xdg: Option<OsString>, home: Option<OsString>) -> Option<PathBuf> {
    let base = match xdg.filter(|dir| !dir.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(home.filter(|dir| !dir.is_empty())?).join(".config"),
    };

    Some(base.join("ttylde").join("config.toml"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hex_color() {
        assert_eq!(parse_color("#ffffff"), Some(0xffffff));
        assert_eq!(parse_color("#16161A"), Some(0x16161a));
    }

    // Only `#` and six hex digits: no short form, no names, no alpha.
    #[test]
    fn anything_but_six_hex_digits_is_not_a_color() {
        assert_eq!(parse_color("ffffff"), None);
        assert_eq!(parse_color("#fff"), None);
        assert_eq!(parse_color("#ffffffff"), None);
        assert_eq!(parse_color("#gggggg"), None);
        assert_eq!(parse_color("white"), None);
        assert_eq!(parse_color(""), None);
    }

    // `from_str_radix` alone would take a sign for a digit.
    #[test]
    fn a_sign_is_not_a_hex_digit() {
        assert_eq!(parse_color("#+fffff"), None);
        assert_eq!(parse_color("#-fffff"), None);
    }

    // Six bytes that are not six characters.
    #[test]
    fn non_ascii_text_is_not_a_color() {
        assert_eq!(parse_color("#ééé"), None);
    }

    fn config_error(text: &str) -> String {
        match Config::parse(text) {
            Err(Error::Config(message)) => message,
            other => panic!("expected a config error, got {other:?}"),
        }
    }

    // An empty file is a valid one: everything keeps its default.
    #[test]
    fn empty_text_gives_the_defaults() {
        assert_eq!(Config::parse("").unwrap(), Config::default());
    }

    // What the file sets wins, the rest stays as it was.
    #[test]
    fn set_values_replace_the_defaults() {
        let config = Config::parse(
            r##"
            [font]
            family = "JetBrains Mono"
            size = 14

            [theme]
            background = "#101014"
            "##,
        )
        .unwrap();
        let default = Config::default();

        assert_eq!(config.font.family, "JetBrains Mono");
        assert_eq!(config.font.size, 14.0);
        assert_eq!(config.theme.background, 0x101014);
        assert_eq!(config.theme.foreground, default.theme.foreground);
        assert_eq!(config.theme.ansi, default.theme.ansi);
    }

    // A section may set one field and leave the other alone.
    #[test]
    fn a_section_can_be_partial() {
        let config = Config::parse("[font]\nsize = 16.5").unwrap();
        assert_eq!(config.font.size, 16.5);
        assert_eq!(config.font.family, Config::default().font.family);
    }

    #[test]
    fn the_base_theme_can_be_chosen() {
        assert_eq!(Config::parse("").unwrap().theme, Theme::light());
        assert_eq!(
            Config::parse("[theme]\nbase = \"light\"").unwrap().theme,
            Theme::light()
        );
        assert_eq!(
            Config::parse("[theme]\nbase = \"dark\"").unwrap().theme,
            Theme::dark()
        );
    }

    // A color set in the file wins over the one of the base theme.
    #[test]
    fn colors_are_set_on_top_of_the_base_theme() {
        let theme = Config::parse("[theme]\nbase = \"dark\"\ncursor = \"#ff0000\"")
            .unwrap()
            .theme;

        assert_eq!(theme.cursor, 0xff0000);
        assert_eq!(theme.background, Theme::dark().background);
    }

    #[test]
    fn an_unknown_base_theme_is_an_error() {
        let message = config_error("[theme]\nbase = \"sepia\"");
        assert!(message.contains("theme.base"), "{message}");
        assert!(message.contains("sepia"), "{message}");
    }

    #[test]
    fn all_theme_colors_can_be_set() {
        let ansi: Vec<String> = (0..16).map(|i| format!("\"#0000{i:02x}\"")).collect();
        let text = format!(
            r##"
            [theme]
            foreground = "#111111"
            background = "#222222"
            cursor = "#333333"
            selection = "#444444"
            ansi = [{}]
            "##,
            ansi.join(", ")
        );
        let theme = Config::parse(&text).unwrap().theme;

        assert_eq!(theme.foreground, 0x111111);
        assert_eq!(theme.background, 0x222222);
        assert_eq!(theme.cursor, 0x333333);
        assert_eq!(theme.selection, 0x444444);
        assert_eq!(theme.ansi[0], 0x000000);
        assert_eq!(theme.ansi[15], 0x00000f);
    }

    // The error names the field, so the user knows where to look.
    #[test]
    fn a_bad_color_names_its_field() {
        let message = config_error("[theme]\ncursor = \"red\"");
        assert!(message.contains("theme.cursor"), "{message}");
        assert!(message.contains("red"), "{message}");
    }

    #[test]
    fn ansi_needs_sixteen_colors() {
        let message = config_error("[theme]\nansi = [\"#000000\", \"#111111\"]");
        assert!(message.contains("theme.ansi"), "{message}");
        assert!(message.contains("found 2"), "{message}");
    }

    // The index tells which of the sixteen is wrong.
    #[test]
    fn a_bad_ansi_color_names_its_position() {
        let mut ansi = vec!["\"#000000\""; 16];
        ansi[3] = "\"nope\"";
        let message = config_error(&format!("[theme]\nansi = [{}]", ansi.join(", ")));
        assert!(message.contains("theme.ansi[3]"), "{message}");
    }

    #[test]
    fn font_size_has_limits() {
        assert!(config_error("[font]\nsize = 5").contains("font.size"));
        assert!(config_error("[font]\nsize = 73").contains("font.size"));
        assert_eq!(Config::parse("[font]\nsize = 6").unwrap().font.size, 6.0);
        assert_eq!(Config::parse("[font]\nsize = 72").unwrap().font.size, 72.0);
    }

    // A typo in a name is an error, not a setting silently ignored.
    #[test]
    fn unknown_names_are_errors() {
        assert!(config_error("[font]\nfamly = \"Menlo\"").contains("famly"));
        assert!(config_error("[fonts]\nsize = 12").contains("fonts"));
    }

    #[test]
    fn wrong_types_and_broken_toml_are_errors() {
        config_error("[font]\nsize = \"big\"");
        config_error("[font\nsize = 12");
    }

    #[test]
    fn shell_integration_is_on_unless_turned_off() {
        assert!(Config::parse("").unwrap().shell_integration);
        assert!(
            !Config::parse("shell_integration = false")
                .unwrap()
                .shell_integration
        );
    }

    #[test]
    fn restore_asks_by_default() {
        let restore = Config::parse("").unwrap().restore;
        assert_eq!(restore.run, Run::Ask);
        assert!(!restore.runs_by_itself("npm run dev"));
    }

    #[test]
    fn restore_can_run_everything() {
        let restore = Config::parse("[restore]\nrun = \"all\"").unwrap().restore;
        assert!(restore.runs_by_itself("rm -rf build"));
    }

    // The patterns are on the whole text: `npm run *` is not `npm publish`.
    #[test]
    fn restore_can_run_what_matches() {
        let restore = Config::parse(
            r#"
            [restore]
            run = "matching"
            match = ["npm run *", "cargo watch*"]
            "#,
        )
        .unwrap()
        .restore;

        assert!(restore.runs_by_itself("npm run dev"));
        assert!(restore.runs_by_itself("cargo watch -x test"));
        assert!(!restore.runs_by_itself("npm publish"));
        assert!(!restore.runs_by_itself("sudo npm run dev"));
    }

    #[test]
    fn an_unknown_restore_mode_is_an_error() {
        let message = config_error("[restore]\nrun = \"always\"");
        assert!(message.contains("restore.run"), "{message}");
    }

    #[test]
    fn globs_match_the_whole_text() {
        assert!(glob("npm run *", "npm run dev"));
        assert!(glob("npm run *", "npm run "));
        assert!(!glob("npm run *", "npm run"));
        assert!(glob("*", ""));
        assert!(glob("*dev*", "npm run dev -- --port 3000"));
        assert!(glob("make ?", "make a"));
        assert!(!glob("make ?", "make ab"));
        assert!(glob("a*b*c", "a-b-b-c"));
        assert!(!glob("a*b*c", "a-b-b-d"));
        assert!(glob("caffè *", "caffè lungo"));
        assert!(!glob("ls", "ls -la"));
    }

    // The file debug builds start from: as it is, and with every option
    // turned on, it is a valid config.
    #[test]
    fn the_example_config_is_valid() {
        let example = include_str!("../../dev/config.example.toml");
        assert_eq!(Config::parse(example).unwrap(), Config::default());

        let uncommented: String = example
            .lines()
            .filter(|line| !line.contains("..."))
            .map(|line| match line.strip_prefix("# ") {
                Some(option) if option.contains(" = ") => option,
                _ => line,
            })
            .collect::<Vec<_>>()
            .join("\n");
        let config = Config::parse(&uncommented).unwrap();
        assert_eq!(config.restore.run, Run::Ask);
        assert_eq!(config.restore.patterns.len(), 2);
    }

    // The example in the README, between ```toml and ```.
    #[test]
    fn the_config_in_the_readme_is_valid() {
        let readme = include_str!("../../README.md");
        let start = readme.find("```toml\n").unwrap() + "```toml\n".len();
        let end = start + readme[start..].find("```").unwrap();
        let config = Config::parse(&readme[start..end]).unwrap();
        assert!(config.shell_integration);
        assert_eq!(config.restore.run, Run::Matching);
    }

    #[test]
    fn the_history_keeps_fifty_thousand_entries_and_filters_secrets() {
        let history = Config::parse("").unwrap().history;
        assert!(history.enabled);
        assert_eq!(history.max_entries, 50_000);
        assert_eq!(history.max_age, None);
        assert!(history.secrets_filter);
    }

    #[test]
    fn the_history_can_be_set() {
        let history = Config::parse(
            r#"
            [history]
            enabled = false
            max_entries = 1000
            max_age = "2w"
            secrets_filter = false
            exclude = ["^export ", "password"]
            exclude_folders = ["~/clients/*"]
            "#,
        )
        .unwrap()
        .history;
        assert!(!history.enabled);
        assert_eq!(history.max_entries, 1000);
        assert_eq!(history.max_age, Some(14 * 24 * 3600 * 1000));
        assert!(!history.secrets_filter);
        assert_eq!(history.exclude, ["^export ", "password"]);
        assert_eq!(history.exclude_folders, ["~/clients/*"]);
    }

    #[test]
    fn ages_are_days_weeks_months_years() {
        let day = 24 * 3600 * 1000;
        assert_eq!(age("30d"), Some(30 * day));
        assert_eq!(age("6m"), Some(180 * day));
        assert_eq!(age("1y"), Some(365 * day));
        assert_eq!(age("0d"), None);
        assert_eq!(age("1h"), None);
        assert_eq!(age("y"), None);
        assert_eq!(age(""), None);
    }

    // The errors name the field, and the pattern that does not compile.
    #[test]
    fn a_bad_history_setting_is_an_error() {
        assert!(config_error("[history]\nmax_age = \"soon\"").contains("history.max_age"));
        assert!(config_error("[history]\nmax_entries = 0").contains("history.max_entries"));
        let message = config_error("[history]\nexclude = [\"ok\", \"(\"]");
        assert!(message.contains("history.exclude[1]"), "{message}");
    }

    fn temp_file(name: &str) -> PathBuf {
        env::temp_dir().join(format!("ttylde-{}-{name}", std::process::id()))
    }

    // No file means the user configured nothing.
    #[test]
    fn a_missing_file_gives_the_defaults() {
        let path = temp_file("missing.toml");
        assert_eq!(Config::load(&path).unwrap(), Config::default());
    }

    #[test]
    fn a_file_is_read_and_parsed() {
        let path = temp_file("valid.toml");
        fs::write(&path, "[font]\nsize = 15").unwrap();
        let config = Config::load(&path);
        fs::remove_file(&path).unwrap();

        assert_eq!(config.unwrap().font.size, 15.0);
    }

    // The error of a broken file reaches the caller, who decides what to do.
    #[test]
    fn a_broken_file_is_an_error() {
        let path = temp_file("broken.toml");
        fs::write(&path, "[font]\nsize = 500").unwrap();
        let config = Config::load(&path);
        fs::remove_file(&path).unwrap();

        assert!(matches!(config, Err(Error::Config(_))));
    }

    // A path that is there but cannot be read as a file is not "missing".
    #[test]
    fn an_unreadable_path_is_an_io_error() {
        assert!(matches!(Config::load(&env::temp_dir()), Err(Error::Io(_))));
    }

    #[test]
    fn the_path_prefers_xdg_config_home() {
        let path = path_from(Some("/xdg".into()), Some("/home/me".into()));
        assert_eq!(path, Some(PathBuf::from("/xdg/ttylde/config.toml")));
    }

    #[test]
    fn the_path_falls_back_to_dot_config() {
        let expected = Some(PathBuf::from("/home/me/.config/ttylde/config.toml"));
        assert_eq!(path_from(None, Some("/home/me".into())), expected);
        assert_eq!(
            path_from(Some("".into()), Some("/home/me".into())),
            expected
        );
    }

    #[test]
    fn without_a_home_there_is_no_path() {
        assert_eq!(path_from(None, None), None);
    }
}
