//! Claude Code subscription usage, ported from
//! `apps/server/src/provider/Layers/claudeUsageLimits.ts`.
//!
//! Both sources produce windows with the same ids, so a turn-driven `rate_limit_event` lands
//! on the row the SDK's `get_usage` read established:
//!
//! - `get_usage` (on demand, during the capabilities probe) reports every window at once as
//!   0–100 percentages with ISO reset times.
//! - `rate_limit_event` (streamed during a turn) names one window at a time with a 0–1
//!   utilization fraction and an epoch-seconds reset.
//!
//! The response is read structurally rather than through the SDK's types, exactly as the
//! shipped code does: `model_scoped` shipped in the CLI after the pinned `.d.ts`, and a
//! utilization that is not a number is a thing the CLI does.

use serde_json::Value;

use crate::jsdate;
use crate::limits::{
    Field, UnavailableReason, UsageLimits, UsageLimitsUpdate, UsageWindow, WindowKind,
    clamp_percent, make_unavailable_usage_limits, make_usage_limits,
};
use crate::read;

const SESSION_MINS: f64 = 5.0 * 60.0;
const WEEK_MINS: f64 = 7.0 * 24.0 * 60.0;

/// One account-wide window, keyed by the SDK's `rateLimitType`. Model-scoped weeklies are
/// additive on top of these: the CLI reports them under `rate_limits.model_scoped[]` on
/// `get_usage` and streams the overage-included model bucket as
/// `seven_day_overage_included`.
struct WindowDefinition {
    id: &'static str,
    kind: WindowKind,
    label: &'static str,
    duration_mins: f64,
}

const WINDOWS: [WindowDefinition; 2] = [
    WindowDefinition {
        id: "five_hour",
        kind: WindowKind::Session,
        label: "Session",
        duration_mins: SESSION_MINS,
    },
    WindowDefinition {
        id: "seven_day",
        kind: WindowKind::Weekly,
        label: "Weekly",
        duration_mins: WEEK_MINS,
    },
];

/// The streamed event names the overage-included bucket by type, while `get_usage` names it
/// by the model's `display_name`. Which model that is changes over time, so the probe records
/// the name it saw and the event mapper reuses it; the mid-turn update then lands on the row
/// the probe drew instead of opening a second one.
const OVERAGE_INCLUDED_EVENT_TYPE: &str = "seven_day_overage_included";

/// The scoped-bucket names the last probe saw, in the wording the CLI used.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClaudeScopedNames {
    pub overage_included: Option<String>,
}

fn scoped_window_id(display_name: &str) -> String {
    let mut id = String::from("seven_day_");
    // `replace(/[^a-z0-9]+/g, "_")`: each run of separators becomes one underscore, so
    // `"Opus 4.1 (Preview)"` reads `opus_4_1_preview` rather than `opus_4_1___preview`.
    let mut in_run = false;
    for character in display_name.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            id.push(character);
            in_run = false;
        } else if !in_run {
            id.push('_');
            in_run = true;
        }
    }
    id
}

fn scoped_window(display_name: &str, used_percent: f64, resets_at: Field<String>) -> UsageWindow {
    UsageWindow {
        id: scoped_window_id(display_name),
        kind: WindowKind::Weekly,
        label: format!("Weekly · {display_name}"),
        used_percent: clamp_percent(used_percent),
        resets_at,
        window_duration_mins: Field::Value(WEEK_MINS),
    }
}

fn make_window(
    definition: &WindowDefinition,
    used_percent: f64,
    resets_at: Field<String>,
) -> UsageWindow {
    UsageWindow {
        id: definition.id.to_owned(),
        kind: definition.kind,
        label: definition.label.to_owned(),
        used_percent: clamp_percent(used_percent),
        resets_at,
        window_duration_mins: Field::Value(definition.duration_mins),
    }
}

/// `isoFromString` for a bucket's `resets_at`: Effect's `"Z"` rule then UTC formatting, and
/// anything falsy or unparsable leaves the row without a reset time.
fn iso_from_reset(value: &Value) -> Field<String> {
    match read::field(value, "resets_at") {
        Field::Value(text) if read::truthy(text) => {
            read::as_string(text).and_then(jsdate::iso_from_string).into()
        }
        _ => Field::Absent,
    }
}

/// `claudeRateLimitEventToUpdate`.
///
/// Utilization is a 0–1 fraction on the streamed event. An overage-included event before any
/// probe has named the bucket is dropped: guessing a name would draw a row the next probe
/// cannot reconcile.
///
/// An event naming a type the table does not declare is also dropped. The shipped membership
/// test is `type in WINDOWS`, which walks the prototype chain, so `constructor`, `toString`
/// and `__proto__` there open a window with an id and a percentage but no kind or label — a
/// row the contract cannot encode and the client cannot stack. The port treats them as the
/// unknown types they are; the golden states that as a `known_deviation`.
#[must_use]
pub fn claude_rate_limit_event_to_update(
    info: &Value,
    names: &ClaudeScopedNames,
) -> Option<UsageLimitsUpdate> {
    let rate_limit_type = read::as_string(read::property(info, "rateLimitType"))?;
    let Field::Value(utilization) = read::field_number(info, "utilization") else {
        return None;
    };
    let used_percent = utilization * 100.0;
    let resets_at = read::as_number(read::property(info, "resetsAt"))
        .and_then(jsdate::iso_from_epoch_seconds)
        .into();
    if let Some(definition) = WINDOWS.iter().find(|definition| definition.id == rate_limit_type) {
        return Some(UsageLimitsUpdate {
            windows: vec![make_window(definition, used_percent, resets_at)],
        });
    }
    if rate_limit_type == OVERAGE_INCLUDED_EVENT_TYPE
        && let Some(display_name) =
            names.overage_included.as_deref().filter(|name| !name.is_empty())
    {
        return Some(UsageLimitsUpdate {
            windows: vec![scoped_window(display_name, used_percent, resets_at)],
        });
    }
    None
}

/// `claudeUsageResponseToLimits`, plus the scoped-bucket names the response carried.
///
/// Percentages on the `get_usage` response are already 0–100. The CLI filters `model_scoped`
/// to the overage-included allowlist, which today holds one model, so the first usable entry
/// is the one the events refer to — and only a bucket that drew a row may receive events,
/// since naming one that was skipped would let a mid-turn event open a row the probe never
/// showed.
#[must_use]
pub fn claude_usage_response_to_limits(input: &Value) -> (UsageLimits, ClaudeScopedNames) {
    let checked_at = read::as_string(read::property(input, "checkedAt")).unwrap_or_default();
    let response = read::property(input, "response");
    let rate_limits = read::property(response, "rate_limits");
    if !read::truthy(read::property(response, "rate_limits_available"))
        || !read::truthy(rate_limits)
    {
        return (
            make_unavailable_usage_limits(checked_at, UnavailableReason::Unsupported, None),
            ClaudeScopedNames::default(),
        );
    }

    let mut windows: Vec<UsageWindow> = Vec::new();
    for definition in &WINDOWS {
        let bucket = read::property(rate_limits, definition.id);
        if !read::truthy(bucket) {
            continue;
        }
        if let Field::Value(utilization) = read::field_number(bucket, "utilization") {
            windows.push(make_window(definition, utilization, iso_from_reset(bucket)));
        }
    }

    let mut overage_included: Option<String> = None;
    for entry in read::array(rate_limits, "model_scoped") {
        let Some(display_name) = read::as_string(read::property(entry, "display_name")) else {
            continue;
        };
        let Field::Value(utilization) = read::field_number(entry, "utilization") else {
            continue;
        };
        windows.push(scoped_window(display_name, utilization, iso_from_reset(entry)));
        if overage_included.is_none() {
            overage_included = Some(display_name.to_owned());
        }
    }
    (make_usage_limits(checked_at, windows), ClaudeScopedNames { overage_included })
}
