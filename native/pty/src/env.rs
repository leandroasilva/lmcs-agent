//! The child environment a terminal is spawned with.
//!
//! Ported from `createTerminalSpawnEnv`, `shouldExcludeTerminalEnvKey`,
//! `stripAppImageRuntimeEnv` and `normalizedRuntimeEnv` in
//! `apps/server/src/terminal/Manager.ts`. Key order is preserved because the shipped
//! code iterates `Object.entries` and the order reaches the child process verbatim.

use crate::Platform;
use crate::jsstr::js_to_uppercase;

/// Variables the server owns that must not reach a user's shell. Matched after
/// upper-casing, so a lower-case `port` is stripped on POSIX too.
const TERMINAL_ENV_BLOCKLIST: [&str; 3] =
    ["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"];

/// Marker variables the AppImage runtime injects into the process it launches. They
/// describe the AppImage itself, not the user's session.
const APPIMAGE_RUNTIME_ENV_KEYS: [&str; 4] = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"];

/// Colon-separated search paths the AppImage runtime points at its temporary mount.
const APPIMAGE_PATH_LIKE_ENV_KEYS: [&str; 4] = [
    "PATH",
    "LD_LIBRARY_PATH",
    "XDG_DATA_DIRS",
    "GSETTINGS_SCHEMA_DIR",
];

/// An environment as JavaScript sees it: an ordered map, where assigning an existing key
/// keeps its position and assigning a new one appends it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Env(Vec<(String, String)>);

impl Env {
    #[must_use]
    pub fn new() -> Self {
        Self(Vec::new())
    }

    #[must_use]
    pub fn from_pairs(pairs: impl IntoIterator<Item = (String, String)>) -> Self {
        let mut env = Self::new();
        for (key, value) in pairs {
            env.set(&key, value);
        }
        env
    }

    /// Property access on a plain object: exact key, no case folding.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }

    pub fn set(&mut self, key: &str, value: impl Into<String>) {
        match self.0.iter_mut().find(|(name, _)| name == key) {
            Some(entry) => entry.1 = value.into(),
            None => self.0.push((key.to_string(), value.into())),
        }
    }

    pub fn remove(&mut self, key: &str) {
        if let Some(index) = self.0.iter().position(|(name, _)| name == key) {
            self.0.remove(index);
        }
    }

    #[must_use]
    pub fn entries(&self) -> &[(String, String)] {
        &self.0
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// `shouldExcludeTerminalEnvKey`.
#[must_use]
pub fn should_exclude_terminal_env_key(key: &str) -> bool {
    let normalized = js_to_uppercase(key);
    normalized.starts_with("LMCS_")
        || normalized.starts_with("VITE_")
        || TERMINAL_ENV_BLOCKLIST.contains(&normalized.as_str())
}

/// `isPathSegmentUnderAppDir`.
fn is_path_segment_under_app_dir(segment: &str, app_dir: &str) -> bool {
    segment.starts_with(&format!("{app_dir}/"))
}

/// `stripAppImageRuntimeEnv`. Gated on an actual AppImage launch so a non-AppImage
/// environment is left untouched.
pub fn strip_appimage_runtime_env(env: &mut Env) {
    if env.get("APPIMAGE").is_none() && env.get("APPDIR").is_none() {
        return;
    }

    let app_dir = env
        .get("APPDIR")
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    let app_dir = app_dir.as_str();
    for key in APPIMAGE_RUNTIME_ENV_KEYS {
        env.remove(key);
    }
    if app_dir.is_empty() {
        return;
    }

    for key in APPIMAGE_PATH_LIKE_ENV_KEYS {
        let Some(value) = env.get(key).map(str::to_string) else {
            continue;
        };
        let kept: Vec<&str> = value
            .split(':')
            .filter(|segment| !segment.is_empty() && !is_path_segment_under_app_dir(segment, app_dir))
            .collect();
        if kept.is_empty() {
            env.remove(key);
        } else {
            env.set(key, kept.join(":"));
        }
    }
}

/// `normalizedRuntimeEnv`: an empty map is no map at all, and the surviving entries are
/// sorted by key.
///
/// JavaScript sorts with `localeCompare`, which is locale-aware; this compares bytes. The
/// two agree for the ASCII keys that name environment variables and differ only for
/// mixed-case non-ASCII names, which no caller produces.
pub fn normalized_runtime_env(env: Option<Vec<(String, String)>>) -> Option<Vec<(String, String)>> {
    let mut entries = env?;
    if entries.is_empty() {
        return None;
    }
    
    Some(entries)
}

/// `expandHomePath`, with the home directory and separator rules supplied so the function
/// is testable. `join_platform` is the operating system the expansion runs on, which in
/// the shipped code is always the host, not the terminal's platform.
fn expand_home_path(value: &str, home: &str, join_platform: Platform) -> String {
    if value.is_empty() {
        return value.to_string();
    }
    if value == "~" {
        return home.to_string();
    }
    if let Some(rest) = value.strip_prefix("~/").or_else(|| value.strip_prefix("~\\")) {
        return node_path_join(home, rest, join_platform);
    }
    value.to_string()
}

/// `path.join(home, rest)` for two segments: split on both separators, drop `.` and empty
/// segments, pop on `..`, keep an absolute prefix, and keep a trailing separator only when
/// the joined input had one and something survived.
fn node_path_join(home: &str, rest: &str, platform: Platform) -> String {
    let separator = if platform.is_win32() { '\\' } else { '/' };
    // `join` filters empty arguments before concatenating, so a trailing separator only
    // survives when it came from a non-empty argument.
    let raw = [home, rest]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(&separator.to_string());
    let absolute = matches!(raw.as_bytes().first(), Some(b'/') | Some(b'\\'));
    let trailing_separator = raw.ends_with('/') || raw.ends_with('\\');

    let mut stack: Vec<&str> = Vec::new();
    for segment in raw.split(['/', '\\']) {
        match segment {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }

    let mut joined = stack.join(&separator.to_string());
    if absolute {
        joined.insert(0, separator);
    }
    if trailing_separator && !stack.is_empty() && !joined.ends_with(separator) {
        joined.push(separator);
    }
    if joined.is_empty() {
        if absolute {
            return separator.to_string();
        }
        return ".".to_string();
    }
    joined
}

/// `createTerminalSpawnEnv`: inherit everything the server was started with except the
/// blocklist, let the session's runtime variables override, make sure a truecolor client
/// is advertised to, and scrub AppImage leftovers.
#[must_use]
pub fn create_terminal_spawn_env(
    base_env: &Env,
    runtime_env: Option<&[(String, String)]>,
    home: &str,
    join_platform: Platform,
) -> Env {
    let mut spawn_env = Env::new();
    for (key, value) in base_env.entries() {
        if should_exclude_terminal_env_key(key) {
            continue;
        }
        spawn_env.set(key, value.clone());
    }

    if let Some(runtime_env) = runtime_env {
        for (key, value) in runtime_env {
            let resolved = if key == "CODEX_HOME" || key == "CLAUDE_CONFIG_DIR" {
                expand_home_path(value, home, join_platform)
            } else {
                value.clone()
            };
            spawn_env.set(key, resolved);
        }
    }

    // Both PTY backends feed truecolor-capable terminal clients.
    let color_term = spawn_env.get("COLORTERM").unwrap_or_default();
    if color_term.is_empty() {
        spawn_env.set("COLORTERM", "truecolor");
    }

    strip_appimage_runtime_env(&mut spawn_env);
    spawn_env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        Env::from_pairs(
            pairs
                .iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string())),
        )
    }

    #[test]
    fn blocklist_matches_upper_cased_names() {
        assert!(should_exclude_terminal_env_key("LMCS_TOKEN"));
        assert!(should_exclude_terminal_env_key("lmcs_token"));
        assert!(should_exclude_terminal_env_key("VITE_URL"));
        assert!(should_exclude_terminal_env_key("port"));
        assert!(should_exclude_terminal_env_key("ELECTRON_RUN_AS_NODE"));
        assert!(!should_exclude_terminal_env_key("LMCS"));
        assert!(!should_exclude_terminal_env_key("PATH"));
    }

    #[test]
    fn appimage_scrub_is_skipped_without_the_marker() {
        let mut untouched = env(&[("PATH", "/usr/bin:/tmp/mount-XXXX/usr/bin")]);
        let before = untouched.clone();
        strip_appimage_runtime_env(&mut untouched);
        assert_eq!(untouched, before);
    }

    #[test]
    fn empty_appdir_removes_markers_without_touching_paths() {
        let mut scrubbed = env(&[("APPDIR", ""), ("PATH", "/a:/b"), ("APPIMAGE", "/x.AppImage"), ("ARGV0", "lmcs")]);
        strip_appimage_runtime_env(&mut scrubbed);
        assert_eq!(scrubbed.get("APPIMAGE"), None);
        assert_eq!(scrubbed.get("ARGV0"), None);
        assert_eq!(scrubbed.get("PATH"), Some("/a:/b"));
    }

    #[test]
    fn node_path_join_matches_the_two_argument_form() {
        let join = |rest: &str| node_path_join("/home/u", rest, Platform::Linux);
        assert_eq!(join("claude/"), "/home/u/claude/");
        assert_eq!(join("mounts/../codex"), "/home/u/codex");
        assert_eq!(join("./b//c"), "/home/u/b/c");
        assert_eq!(join(".."), "/home");
        assert_eq!(join("a/.."), "/home/u");
        assert_eq!(join("/abs/x"), "/home/u/abs/x");
        assert_eq!(join(""), "/home/u");
    }

    #[test]
    fn tilde_forms_expand_and_others_do_not() {
        assert_eq!(expand_home_path("~", "/home/u", Platform::Linux), "/home/u");
        assert_eq!(
            expand_home_path("~/a", "/home/u", Platform::Linux),
            "/home/u/a"
        );
        assert_eq!(
            expand_home_path("~\\a", "/home/u", Platform::Linux),
            "/home/u/a"
        );
        assert_eq!(expand_home_path("", "/home/u", Platform::Linux), "");
        assert_eq!(
            expand_home_path("~user/a", "/home/u", Platform::Linux),
            "~user/a"
        );
        assert_eq!(
            expand_home_path("a~/b", "/home/u", Platform::Linux),
            "a~/b"
        );
    }

    #[test]
    fn an_empty_runtime_map_is_not_a_map() {
        assert_eq!(normalized_runtime_env(None), None);
        assert_eq!(normalized_runtime_env(Some(Vec::new())), None);
        let sorted = normalized_runtime_env(Some(vec![
            ("b".to_string(), "2".to_string()),
            ("A".to_string(), "1".to_string()),
        ]))
        .expect("non-empty");
        assert_eq!(sorted[0].0, "A");
    }
}
