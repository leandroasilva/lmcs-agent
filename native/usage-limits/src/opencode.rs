//! OpenCode Go subscription usage, ported from
//! `apps/server/src/provider/Layers/openCodeUsageLimits.ts`.
//!
//! The other four mappers are handed the provider's answer; this one has to say how the
//! answer is obtained, and the parts of that which are decisions live here: whether the read
//! happens at all, which credential it is allowed to use, what the endpoint's status means,
//! and what the response body has to contain before three bars can be drawn. What is *not* a
//! decision — opening the file, making the request, the five second deadline — stays in the
//! adapter, which is why the probe below is handed the file's text and the response's body
//! rather than an IO layer.
//!
//! One rule here is not a judgment but a fact about the account: an external OpenCode server
//! owns its own credentials, so a configured `serverUrl` means the host's Zen subscription is
//! somebody else's business and the read must not touch it.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::jsdate;
use crate::limits::{
    self, Field, UnavailableReason, UsageLimits, UsageWindow, WindowKind, clamp_percent,
};
use crate::read;

/// The endpoint the shipped call asks, and the only one it can ask: the key is a Zen Go key,
/// not a key for whatever server the account happens to be running.
pub const USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";

/// The sentence `probeFailed` carries. The shipped code says nothing about why the read
/// failed, because every failure it can distinguish lands on this one record.
const PROBE_FAILED_MESSAGE: &str = "OpenCode Go could not read usage.";

/// The process environment, in the three names this read consults. A key missing from the map
/// is what JavaScript sees as `undefined`, and an empty value is one the `||` in front of it
/// rejects — the two are different, since an empty `OPENCODE_AUTH_CONTENT` falls through to
/// `auth.json` while a whitespace-only one is believed and then fails to parse.
pub type Environment<'a> = BTreeMap<&'a str, &'a str>;

/// What the `auth.json` read answered. Only `NotFound` is a normal outcome: the shipped code
/// turns it into the empty object and lets the environment decide, while any other platform
/// error is re-thrown and lands on `probeFailed`.
#[derive(Clone, Copy, Debug)]
pub enum AuthFile<'a> {
    Contents(&'a str),
    NotFound,
    Unreadable,
}

/// What the request answered. A response with no body is the empty text here, which is what
/// a 204 is worth: the status is a success, and the schema then refuses to parse nothing.
#[derive(Clone, Copy, Debug)]
pub struct Response<'a> {
    pub status: u16,
    pub body: &'a str,
}

/// Everything the shipped function reads from the world, as it read it.
pub struct Probe<'a> {
    pub enabled: bool,
    pub server_url: &'a str,
    pub environment: &'a Environment<'a>,
    /// `os.homedir()`, which the shipped code consults only when neither `HOME` nor
    /// `USERPROFILE` names a home. The port cannot ask the host, so the adapter hands over
    /// the answer it would have got.
    pub os_home: &'a str,
    pub auth_file: AuthFile<'a>,
    pub response: Response<'a>,
}

/// One of the two things the call did to the outside world, in the order it did them. The
/// trace records the same pair from its stubs, which is how the port's own IO layer can be
/// checked against the shipped one without either of them reimplementing the other.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    AuthFile { path: String },
    UsageRequest { authorization: String },
}

/// What the read decided, and what it had to do to decide it.
pub struct Outcome {
    pub limits: UsageLimits,
    pub effects: Vec<Effect>,
}

struct WindowDefinition {
    id: &'static str,
    /// The key the response body calls this window, which is not the wire id.
    body_key: &'static str,
    kind: WindowKind,
    label: &'static str,
    /// What the UI can call a length, if the pool has one.
    duration_mins: Option<f64>,
}

/// The three windows the Zen Go response describes, in the order the shipped literal writes
/// them. Only the rolling and weekly pools have a length the UI can show; the monthly one is
/// the calendar month itself.
const WINDOWS: [WindowDefinition; 3] = [
    WindowDefinition {
        id: "go_rolling",
        body_key: "rolling",
        kind: WindowKind::Session,
        label: "Go · Session",
        duration_mins: Some(5.0 * 60.0),
    },
    WindowDefinition {
        id: "go_weekly",
        body_key: "weekly",
        kind: WindowKind::Weekly,
        label: "Go · Weekly",
        duration_mins: Some(7.0 * 24.0 * 60.0),
    },
    WindowDefinition {
        id: "go_monthly",
        body_key: "monthly",
        kind: WindowKind::Monthly,
        label: "Go · Monthly",
        duration_mins: None,
    },
];

/// `readOpenCodeGoUsageLimits`, less the clock and the two effects.
#[must_use]
pub fn read_opencode_go_usage_limits(probe: &Probe<'_>, checked_at: &str) -> Outcome {
    let mut effects = Vec::new();
    let limits = usage_limits(probe, checked_at, &mut effects);
    Outcome { limits, effects }
}

fn usage_limits(probe: &Probe<'_>, checked_at: &str, effects: &mut Vec<Effect>) -> UsageLimits {
    // `!input.enabled || input.serverUrl.trim()`, so a `serverUrl` of only whitespace is not
    // an external server and the read goes ahead.
    if !probe.enabled || !jsdate::trim_js(probe.server_url).is_empty() {
        return unsupported(checked_at);
    }
    let api_key = match credential(probe, effects) {
        Err(()) => return probe_failed(checked_at),
        Ok(None) => return unsupported(checked_at),
        Ok(Some(key)) => key,
    };
    effects.push(Effect::UsageRequest {
        authorization: format!("Bearer {api_key}"),
    });
    // A valid Zen key can exist without a Go subscription, which is the one status that means
    // "nothing to show" rather than "the read went wrong". `filterStatusOk` then answers on
    // the whole 2xx range, so 201 and 299 continue and 204 continues into an empty body.
    if probe.response.status == 403 {
        return unsupported(checked_at);
    }
    if !(200..=299).contains(&probe.response.status) {
        return probe_failed(checked_at);
    }
    match usage_windows(probe.response.body) {
        Err(()) => probe_failed(checked_at),
        Ok(windows) => limits::make_usage_limits(checked_at, windows),
    }
}

/// The key the request is made with, or `None` for "there is no account to ask". `Err` is the
/// one failure the credential stage can produce: a stored `auth.json` that is not the object
/// the schema expects, which the shipped code cannot recover from.
fn credential(probe: &Probe<'_>, effects: &mut Vec<Effect>) -> Result<Option<String>, ()> {
    let stored = environment(probe.environment, "OPENCODE_AUTH_CONTENT");
    let contents = match stored {
        Some(text) => text.to_owned(),
        None => {
            let path = auth_path(probe);
            effects.push(Effect::AuthFile { path: path.clone() });
            match probe.auth_file {
                AuthFile::Contents(text) => text.to_owned(),
                AuthFile::NotFound => "{}".to_owned(),
                AuthFile::Unreadable => return Err(()),
            }
        }
    };
    // The stored credential overlays the environment one, so a readable `auth.json` decides
    // even when its own key is unusable: a blank stored key is `unsupported`, not a reason to
    // try `OPENCODE_API_KEY`.
    let key = match stored_key(&decode_auth_file(&contents)?) {
        Some(key) => Some(key.to_owned()),
        None => environment(probe.environment, "OPENCODE_API_KEY").map(str::to_owned),
    };
    Ok(key
        .map(|key| jsdate::trim_js(&key).to_owned())
        .filter(|key| !key.is_empty()))
}

/// `env.XDG_DATA_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".local",
/// "share")`, then `path.join(dataHome, "opencode", "auth.json")`. The joining is
/// host-native, and every separator rule it has is [`posix_join`]'s.
fn auth_path(probe: &Probe<'_>) -> String {
    let data_home = match environment(probe.environment, "XDG_DATA_HOME") {
        Some(text) => text.to_owned(),
        None => {
            let home = environment(probe.environment, "HOME")
                .or_else(|| environment(probe.environment, "USERPROFILE"))
                .unwrap_or(probe.os_home);
            posix_join(&[home, ".local", "share"])
        }
    };
    posix_join(&[&data_home, "opencode", "auth.json"])
}

fn environment<'a>(values: &'a Environment<'_>, name: &str) -> Option<&'a str> {
    values.get(name).filter(|value| !value.is_empty()).copied()
}

/// `path.posix.join`, which is what `Path.layer` hands the shipped code: non-empty segments
/// joined with `/` and then normalised, so empty and `.` segments disappear, `..` pops one
/// segment and is dropped at the root, a leading `/` is kept, and nothing else is special — a
/// `~` is an ordinary directory name and a space is a segment like any other.
fn posix_join(parts: &[&str]) -> String {
    // An empty segment is skipped rather than separated, which is what keeps a home of `""`
    // from turning the path absolute.
    let mut joined = String::new();
    for part in parts {
        if part.is_empty() {
            continue;
        }
        if !joined.is_empty() {
            joined.push('/');
        }
        joined.push_str(part);
    }
    posix_normalize(&joined)
}

fn posix_normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let trailing_separator = path.ends_with('/');
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => match segments.last() {
                Some(last) if *last != ".." => {
                    segments.pop();
                }
                _ if absolute => {}
                _ => segments.push(".."),
            },
            other => segments.push(other),
        }
    }
    let mut joined = segments.join("/");
    if joined.is_empty() && !absolute {
        joined = ".".to_owned();
    }
    if trailing_separator && !joined.is_empty() {
        joined.push('/');
    }
    if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

/// `Schema.decodeEffect(Schema.fromJsonString(AuthFile))` for
/// `Struct({ "opencode-go": optionalKey(Unknown) })`. Anything that is not an object is a
/// decode error rather than an empty file, and the extra keys the account's other providers
/// leave behind are simply dropped.
fn decode_auth_file(contents: &str) -> Result<Value, ()> {
    match serde_json::from_str::<Value>(contents) {
        Ok(value @ Value::Object(_)) => Ok(value),
        _ => Err(()),
    }
}

/// `Schema.decodeUnknownOption(ApiAuth)` for `Struct({ type: Literal("api"), key: String })`:
/// a shape the account does not have is `none`, which is a hand-off rather than an error.
fn stored_key(auth: &Value) -> Option<&str> {
    let credential = read::property(auth, "opencode-go");
    if read::as_string(read::property(credential, "type")) != Some("api") {
        return None;
    }
    read::as_string(read::property(credential, "key"))
}

/// `Schema.decodeUnknownSync(UsageResponse)` over `HttpClientResponse.schemaBodyJson`, whose
/// three windows are all required and whose `percent` is `Schema.Finite`. The failure mode is
/// the one worth recording: one unusable window takes the other two down with it, because the
/// schema answers for the whole body and there is no partial success to fall back on.
fn usage_windows(body: &str) -> Result<Vec<UsageWindow>, ()> {
    // A body that is not an object fails here the same way it fails on a missing window: the
    // schema's shape rule and its required-key rule land on one record, so only the second
    // needs writing down.
    let Ok(parsed) = serde_json::from_str::<Value>(body) else {
        return Err(());
    };
    let usage = read::property(&parsed, "usage");
    WINDOWS
        .iter()
        .map(|definition| {
            let window = read::property(usage, definition.body_key);
            // `percent` is `Schema.Finite`, whose two halves the port cannot separate: V8
            // refuses a percentage that is not a number, and refuses one that is not finite,
            // but a JSON text cannot carry a non-finite number at all. `1e999` overflows V8's
            // parser into `Infinity` for the schema to catch, and makes `serde_json` fail to
            // parse the body at all; both answers are the same record.
            let percent = read::as_number(read::property(window, "percent")).ok_or(())?;
            let resets_at = read::as_string(read::property(window, "resetsAt")).ok_or(())?;
            let resets_at = jsdate::iso_from_string(resets_at).ok_or(())?;
            Ok(UsageWindow {
                id: definition.id.to_owned(),
                kind: definition.kind,
                label: definition.label.to_owned(),
                used_percent: clamp_percent(percent),
                resets_at: Field::Value(resets_at),
                window_duration_mins: definition.duration_mins.map_or(Field::Absent, Field::Value),
            })
        })
        .collect()
}

fn unsupported(checked_at: &str) -> UsageLimits {
    limits::make_unavailable_usage_limits(checked_at, UnavailableReason::Unsupported, None)
}

fn probe_failed(checked_at: &str) -> UsageLimits {
    limits::make_unavailable_usage_limits(
        checked_at,
        UnavailableReason::ProbeFailed,
        Some(PROBE_FAILED_MESSAGE.to_owned()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A body the read is happy with, so a test that only wants the path gets one.
    const BODY: &str = r#"{"usage":{"rolling":{"percent":10,"resetsAt":"2026-05-08T00:00:00.000Z"},
        "weekly":{"percent":20,"resetsAt":"2026-05-11T00:00:00.000Z"},
        "monthly":{"percent":30,"resetsAt":"2026-06-01T00:00:00.000Z"}}}"#;
    /// Likewise a credential, since a read that stops for want of one never reaches the wire.
    const AUTH_FILE: &str = r#"{"opencode-go":{"type":"api","key":"testkey"}}"#;

    fn outcome(pairs: &[(&str, &str)]) -> Outcome {
        let environment: Environment<'_> = pairs.iter().copied().collect();
        read_opencode_go_usage_limits(
            &Probe {
                enabled: true,
                server_url: "",
                environment: &environment,
                os_home: "/host/home",
                auth_file: AuthFile::Contents(AUTH_FILE),
                response: Response {
                    status: 200,
                    body: BODY,
                },
            },
            "2026-05-01T12:00:00.000Z",
        )
    }

    fn auth_path(pairs: &[(&str, &str)]) -> String {
        let outcome = outcome(pairs);
        let [Effect::AuthFile { path }, Effect::UsageRequest { .. }] = outcome.effects.as_slice()
        else {
            panic!(
                "the read should have opened {pairs:?} and then asked, got {:?}",
                outcome.effects
            );
        };
        path.clone()
    }

    #[test]
    fn the_host_home_is_consulted_only_when_neither_variable_names_one() {
        // Both are tested with `||`, so an empty one is not a home and the host's answer is
        // used — the last branch the trace cannot reach, since every fixture names a home.
        assert_eq!(auth_path(&[]), "/host/home/.local/share/opencode/auth.json");
        for environment in [
            [("HOME", ""), ("USERPROFILE", "")].as_slice(),
            [("USERPROFILE", "")].as_slice(),
        ] {
            assert_eq!(
                auth_path(environment),
                "/host/home/.local/share/opencode/auth.json",
                "{environment:?}"
            );
        }
        // `HOME` outranks it, and the host outranks nothing at all once a variable answers.
        assert_eq!(
            auth_path([("USERPROFILE", "/from/profile")].as_slice()),
            "/from/profile/.local/share/opencode/auth.json"
        );
        assert_eq!(
            auth_path([("HOME", ""), ("USERPROFILE", "/from/profile")].as_slice()),
            "/from/profile/.local/share/opencode/auth.json"
        );
        // A named data directory skips the home entirely, so the host is never consulted.
        assert_eq!(
            auth_path([("XDG_DATA_HOME", "/xdg")].as_slice()),
            "/xdg/opencode/auth.json"
        );
    }

    #[test]
    fn the_auth_path_is_normalised_the_way_path_posix_normalises() {
        // Every answer here is what `path.posix.join` gives, measured rather than derived.
        assert_eq!(
            auth_path([("HOME", "/a//b/")].as_slice()),
            "/a/b/.local/share/opencode/auth.json"
        );
        assert_eq!(
            auth_path([("HOME", "/a/b/../c")].as_slice()),
            "/a/c/.local/share/opencode/auth.json"
        );
        assert_eq!(
            auth_path([("HOME", "~")].as_slice()),
            "~/.local/share/opencode/auth.json"
        );
        assert_eq!(
            auth_path([("XDG_DATA_HOME", "/xdg/")].as_slice()),
            "/xdg/opencode/auth.json"
        );
        assert_eq!(
            auth_path([("XDG_DATA_HOME", "a/./b")].as_slice()),
            "a/b/opencode/auth.json"
        );
        // A `..` at the root has nothing above it to pop, and a doubled leading slash is one.
        assert_eq!(
            auth_path([("XDG_DATA_HOME", "/a/../..")].as_slice()),
            "/opencode/auth.json"
        );
        assert_eq!(
            auth_path([("XDG_DATA_HOME", "//a")].as_slice()),
            "/a/opencode/auth.json"
        );
        assert_eq!(
            auth_path([("XDG_DATA_HOME", "/")].as_slice()),
            "/opencode/auth.json"
        );
        // The joining itself skips an empty segment rather than separating it, which is the
        // one rule the guards above cannot reach: no variable that is empty gets here.
        assert_eq!(posix_join(&["", ".local", "share"]), ".local/share");
        assert_eq!(posix_join(&[]), ".");
    }
}
