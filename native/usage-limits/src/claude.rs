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
        Field::Value(text) if read::truthy(text) => read::as_string(text)
            .and_then(jsdate::iso_from_string)
            .into(),
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
    if let Some(definition) = WINDOWS
        .iter()
        .find(|definition| definition.id == rate_limit_type)
    {
        return Some(UsageLimitsUpdate {
            windows: vec![make_window(definition, used_percent, resets_at)],
        });
    }
    if rate_limit_type == OVERAGE_INCLUDED_EVENT_TYPE
        && let Some(display_name) = names
            .overage_included
            .as_deref()
            .filter(|name| !name.is_empty())
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
        windows.push(scoped_window(
            display_name,
            utilization,
            iso_from_reset(entry),
        ));
        if overage_included.is_none() {
            overage_included = Some(display_name.to_owned());
        }
    }
    (
        make_usage_limits(checked_at, windows),
        ClaudeScopedNames { overage_included },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_scoped_id_folds_every_separator_into_one_underscore() {
        assert_eq!(
            scoped_window_id("Opus 4.1 (Preview)"),
            "seven_day_opus_4_1_preview_",
            "the trailing run of separators is folded too, because `+` replaces every match"
        );
        assert_eq!(scoped_window_id("Fable"), "seven_day_fable");
        assert_eq!(
            scoped_window_id("Claude Fable 3"),
            "seven_day_claude_fable_3"
        );
        // Several characters in a row are one underscore, not several.
        assert_eq!(scoped_window_id("a  -- b"), "seven_day_a_b");
        assert_eq!(scoped_window_id(""), "seven_day_");
    }

    #[test]
    fn a_streamed_event_needs_a_number_and_a_type_the_table_declares() {
        let names = ClaudeScopedNames {
            overage_included: Some("Opus 4.1".to_owned()),
        };
        let update = claude_rate_limit_event_to_update(
            &json!({"rateLimitType": "five_hour", "utilization": 0.25, "resetsAt": 1_777_000_000}),
            &names,
        )
        .expect("a session event draws the session bar");
        assert_eq!(
            update.windows,
            vec![UsageWindow {
                id: "five_hour".to_owned(),
                kind: WindowKind::Session,
                label: "Session".to_owned(),
                used_percent: 25.0,
                resets_at: Field::Value("2026-04-24T03:06:40.000Z".to_owned()),
                window_duration_mins: Field::Value(300.0),
            }]
        );

        // Utilization is a fraction, and the CLI has been seen sending something else.
        assert_eq!(
            claude_rate_limit_event_to_update(
                &json!({"rateLimitType": "five_hour", "utilization": "0.25"}),
                &names
            ),
            None
        );
        // A `NaN` utilization survives the guard, because `typeof NaN === "number"`, and
        // `clampPercent` then draws it as an empty bar rather than dropping the row.
        let stalled = claude_rate_limit_event_to_update(
            &json!({"rateLimitType": "five_hour", "utilization": {"__number": "NaN"}}),
            &names,
        )
        .expect("a `NaN` utilization is still a number to `typeof`");
        assert_eq!(stalled.windows[0].used_percent, 0.0);
        assert_eq!(stalled.windows[0].resets_at, Field::Absent);
        // An overage event before the probe has named the bucket cannot guess its row, and a
        // type outside the table has no row to land on.
        assert_eq!(
            claude_rate_limit_event_to_update(
                &json!({"rateLimitType": "seven_day_overage_included", "utilization": 0.5}),
                &ClaudeScopedNames::default()
            ),
            None
        );
        assert_eq!(
            claude_rate_limit_event_to_update(
                &json!({"rateLimitType": "twenty_minute", "utilization": 0.5}),
                &names
            ),
            None
        );

        let scoped = claude_rate_limit_event_to_update(
            &json!({"rateLimitType": "seven_day_overage_included", "utilization": 1.5}),
            &names,
        )
        .expect("an overage event lands on the row the probe drew");
        assert_eq!(
            scoped.windows,
            vec![UsageWindow {
                id: "seven_day_opus_4_1".to_owned(),
                kind: WindowKind::Weekly,
                label: "Weekly · Opus 4.1".to_owned(),
                used_percent: 100.0,
                resets_at: Field::Absent,
                window_duration_mins: Field::Value(WEEK_MINS),
            }]
        );
    }

    #[test]
    fn the_probe_names_the_bucket_its_events_will_use() {
        let (limits, names) = claude_usage_response_to_limits(&json!({
            "checkedAt": "2026-05-01T12:00:00.000Z",
            "response": {
                "rate_limits_available": true,
                "rate_limits": {
                    "seven_day": {"utilization": 40, "resets_at": "2026-05-08T00:00:00Z"},
                    "five_hour": {"utilization": 10, "resets_at": "2026-05-01T17:00:00Z"},
                    "model_scoped": [
                        {"display_name": "Opus 4.1", "utilization": 70},
                        {"display_name": "Skip Me", "utilization": "n/a"},
                    ],
                },
            },
        }));
        assert_eq!(names.overage_included.as_deref(), Some("Opus 4.1"));
        assert_eq!(
            limits
                .windows
                .iter()
                .map(|window| window.id.as_str())
                .collect::<Vec<_>>(),
            ["five_hour", "seven_day", "seven_day_opus_4_1"]
        );
        assert_eq!(limits.windows[2].label, "Weekly · Opus 4.1");
        assert_eq!(limits.windows[2].resets_at, Field::Absent);
        assert_eq!(limits.unavailable, None);

        let (unavailable, names) = claude_usage_response_to_limits(&json!({
            "checkedAt": "2026-05-01T12:00:00.000Z",
            "response": {"rate_limits_available": false, "rate_limits": null},
        }));
        assert_eq!(names, ClaudeScopedNames::default());
        assert_eq!(unavailable.windows, Vec::new());
        assert_eq!(
            unavailable
                .unavailable
                .map(|unavailable| unavailable.reason),
            Some(UnavailableReason::Unsupported)
        );
    }

    #[test]
    fn a_reset_time_the_parser_refuses_leaves_the_bar_without_a_countdown() {
        let (limits, _) = claude_usage_response_to_limits(&json!({
            "checkedAt": "now",
            "response": {
                "rate_limits_available": true,
                "rate_limits": {"five_hour": {"utilization": 10, "resets_at": "2026-05-01T12:00:00GMT"}},
            },
        }));
        assert_eq!(limits.windows[0].resets_at, Field::Absent);

        // An empty string is falsy, so it never reaches the parser at all.
        let (limits, _) = claude_usage_response_to_limits(&json!({
            "checkedAt": "now",
            "response": {
                "rate_limits_available": true,
                "rate_limits": {"five_hour": {"utilization": 10, "resets_at": ""}},
            },
        }));
        assert_eq!(limits.windows[0].resets_at, Field::Absent);
    }
}
