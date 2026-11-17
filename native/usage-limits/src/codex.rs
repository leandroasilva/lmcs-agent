//! Codex subscription usage, ported from
//! `apps/server/src/provider/Layers/codexUsageLimits.ts`.
//!
//! The `account/rateLimits/read` response and the `account/rateLimits/updated` notification
//! carry the same snapshot shape, so one mapper serves the status probe and the turn-driven
//! update; both emit windows with the same ids so they merge onto the same rows.
//!
//! A snapshot is read structurally, as the shipped code does through
//! `CodexRateLimitSnapshot`: the CLI's generated types and what it writes on stdout are two
//! different things, and `limitId`, `windowDurationMins` and `resetsAt` have all been seen in
//! more than one shape.

use serde_json::{Map, Value};

use crate::jsdate;
use crate::limits::{
    self as core, Field, ResetCredits, UsageLimits, UsageLimitsUpdate, UsageWindow, WindowKind,
};
use crate::read;

const SESSION_MINS: f64 = 5.0 * 60.0;
const WEEK_MINS: f64 = 7.0 * 24.0 * 60.0;
const MONTH_MINS: f64 = 30.0 * 24.0 * 60.0;

/// The snapshot's fields, in the order the shipped partial merge writes them.
const SNAPSHOT_FIELDS: [&str; 5] =
    ["limitId", "planType", "rateLimitReachedType", "primary", "secondary"];

/// The `account/rateLimits/read` failures the message can tell apart. Codex's app-server error
/// union is wider (`packages/providers/src/codex/errors.ts`); everything outside these three
/// answers the same way, so the port groups them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CodexRateLimitsFailure {
    /// A JSON-RPC error. Its code is the only part that reaches the Limits view; the raw
    /// `errorMessage` is for the log.
    Request { code: f64 },
    Spawn,
    ProcessExited,
    Other,
}

/// `kindForDuration`. A duration that is not a number — `NaN` counts — falls through both
/// comparisons and reads as a session.
fn kind_for_duration(mins: f64) -> WindowKind {
    if mins >= MONTH_MINS {
        WindowKind::Monthly
    } else if mins >= WEEK_MINS {
        WindowKind::Weekly
    } else {
        WindowKind::Session
    }
}

fn label_for_kind(kind: WindowKind) -> &'static str {
    match kind {
        WindowKind::Session => "Session",
        WindowKind::Weekly => "Weekly",
        // The shipped ternary's last branch; `kindForDuration` only ever reaches it with
        // `monthly`, so `other` cannot appear here in practice.
        WindowKind::Monthly | WindowKind::Other => "Monthly",
    }
}

/// `codexRateLimitsToWindows`.
///
/// `primary` and `secondary` are positions, not durations. Codex usually sends
/// `windowDurationMins`; when it does not, paid plans expose the 5-hour and weekly pair and
/// Free/Go expose one monthly allowance.
///
/// The result is in position order, not the order the client stacks bars in: this is the
/// shape a notification carries, and only a full snapshot goes through
/// [`codex_rate_limits_to_limits`], which sorts.
#[must_use]
pub fn codex_rate_limits_to_windows(snapshot: &Value) -> Vec<UsageWindow> {
    // Show the main allowance only. Model-specific notifications (such as Spark) must not
    // replace its primary/secondary rows. Older CLIs omit the limit id entirely.
    let limit_id = read::property(snapshot, "limitId");
    if read::truthy(limit_id) && read::as_string(limit_id) != Some("codex") {
        return Vec::new();
    }
    let is_monthly_plan =
        matches!(read::as_string(read::property(snapshot, "planType")), Some("free") | Some("go"));
    let positions = [
        ("primary", read::property(snapshot, "primary"), if is_monthly_plan { MONTH_MINS } else { SESSION_MINS }),
        ("secondary", read::property(snapshot, "secondary"), WEEK_MINS),
    ];
    let mut windows = Vec::new();
    for (id, window, fallback_mins) in positions {
        if !read::truthy(window) {
            continue;
        }
        let Field::Value(used_percent) = read::field_number(window, "usedPercent") else {
            continue;
        };
        if !used_percent.is_finite() {
            continue;
        }
        let window_duration_mins =
            read::field_number(window, "windowDurationMins").into_value().unwrap_or(fallback_mins);
        let kind = kind_for_duration(window_duration_mins);
        let resets_at = read::field_number(window, "resetsAt")
            .into_value()
            .and_then(jsdate::iso_from_epoch_seconds)
            .into();
        windows.push(UsageWindow {
            id: id.to_owned(),
            kind,
            label: label_for_kind(kind).to_owned(),
            used_percent: core::clamp_percent(used_percent),
            resets_at,
            window_duration_mins: Field::Value(window_duration_mins),
        });
    }
    windows
}

/// `codexResetCreditsToContract`. Credits the provider banks for clearing a limit it hit
/// unfairly; only the ones the account can still spend are counted.
#[must_use]
pub fn codex_reset_credits_to_contract(summary: &Value) -> Option<ResetCredits> {
    if !read::truthy(summary) {
        return None;
    }
    let mut expiries: Vec<f64> = Vec::new();
    for credit in read::array(summary, "credits") {
        if read::as_string(read::property(credit, "status")) != Some("available") {
            continue;
        }
        if let Field::Value(expires_at) = read::field_number(credit, "expiresAt") {
            expiries.push(expires_at);
        }
    }
    // One unparsable expiry poisons the minimum, which is how the shipped `Math.min(...)`
    // behaves: the count still shows, the countdown does not.
    let next_expires_at = if expiries.is_empty() {
        Field::Absent
    } else {
        jsdate::iso_from_epoch_seconds(core::js_min_all(&expiries)).into()
    };
    Some(ResetCredits {
        available_count: core::js_max(
            0.0,
            read::as_number(read::property(summary, "availableCount")).unwrap_or(f64::NAN),
        ),
        next_expires_at,
    })
}

/// `codexRateLimitsToLimits`.
///
/// Takes the generated read response's shape — `{snapshot, rateLimitsByLimitId, resetCredits,
/// checkedAt}` — because the main allowance lives under `rateLimitsByLimitId.codex` while the
/// legacy snapshot beside it can name another limit.
#[must_use]
pub fn codex_rate_limits_to_limits(input: &Value) -> UsageLimits {
    let checked_at = read::as_string(read::property(input, "checkedAt")).unwrap_or_default();
    let by_limit_id = read::property(input, "rateLimitsByLimitId");
    let snapshot = match read::field(by_limit_id, "codex") {
        Field::Value(found) if !found.is_null() => found,
        // `??` falls back for both an absent entry and a `null` one.
        _ => read::property(input, "snapshot"),
    };
    let windows = codex_rate_limits_to_windows(snapshot);
    let reset_credits =
        codex_reset_credits_to_contract(read::property(input, "resetCredits"));
    UsageLimits {
        checked_at: checked_at.to_owned(),
        windows: core::sort_windows(windows),
        reset_credits,
        unavailable: None,
    }
}

/// `codexRateLimitsToUpdate`. A notification naming no window the view can draw is nothing to
// publish, so the previous snapshot stands.
#[must_use]
pub fn codex_rate_limits_to_update(snapshot: &Value) -> Option<UsageLimitsUpdate> {
    let windows = codex_rate_limits_to_windows(snapshot);
    (!windows.is_empty()).then_some(UsageLimitsUpdate { windows })
}

/// `codexRateLimitsFailureMessage`. A bounded, client-safe reason for a failed read.
#[must_use]
pub fn codex_rate_limits_failure_message(failure: &CodexRateLimitsFailure) -> String {
    match failure {
        CodexRateLimitsFailure::Request { code } => {
            format!("Codex could not read usage (JSON-RPC {}).", js_number_text(*code))
        }
        CodexRateLimitsFailure::Spawn => "Codex could not be started to read usage.".to_owned(),
        CodexRateLimitsFailure::ProcessExited => {
            "Codex exited before it could report usage.".to_owned()
        }
        CodexRateLimitsFailure::Other => "Codex did not answer the usage request.".to_owned(),
    }
}

/// `mergeCodexRateLimits`.
///
/// Codex sends `account/rateLimits/updated` as a partial view of the snapshot: a field the
/// update omits keeps the value observed earlier in the session, so a later notification that
/// only names the limit it reached must not drop the windows an earlier one carried. The
/// result stays JSON, because the merged snapshot is what the next partial folds onto.
#[must_use]
pub fn merge_codex_rate_limits(previous: Option<&Value>, update: &Value) -> Option<Value> {
    // Model-specific snapshots (such as Spark) describe a different allowance and must not
    // overwrite the main one, the same rule the usage rows apply.
    let limit_id = read::property(update, "limitId");
    if read::truthy(limit_id) && read::as_string(limit_id) != Some("codex") {
        return previous.cloned();
    }
    let Some(previous) = previous.filter(|value| read::truthy(value)) else {
        return Some(update.clone());
    };
    let mut merged = match previous {
        Value::Object(map) => map.clone(),
        // A truthy value that is not an object has nothing to inherit.
        _ => Map::new(),
    };
    for key in SNAPSHOT_FIELDS {
        match read::field(update, key).merged_with(read::field(previous, key)) {
            Field::Absent => {}
            Field::Null => {
                merged.insert(key.to_owned(), Value::Null);
            }
            Field::Value(value) => {
                merged.insert(key.to_owned(), value.clone());
            }
        }
    }
    Some(Value::Object(merged))
}

/// Coarse remaining wait, matching how the usage rows read: `5d 5h`, `3h 20m`, `12m`.
fn format_codex_usage_limit_wait(wait_ms: f64) -> String {
    let total_minutes = (wait_ms / 60_000.0).ceil();
    let days = (total_minutes / (24.0 * 60.0)).floor();
    let hours = ((total_minutes % (24.0 * 60.0)) / 60.0).floor();
    let minutes = total_minutes % 60.0;
    if days > 0.0 {
        return if hours == 0.0 {
            format!("{}d", js_number_text(days))
        } else {
            format!("{}d {}h", js_number_text(days), js_number_text(hours))
        };
    }
    if hours == 0.0 {
        return format!("{}m", js_number_text(total_minutes));
    }
    if minutes == 0.0 {
        format!("{}h", js_number_text(hours))
    } else {
        format!("{}h {}m", js_number_text(hours), js_number_text(minutes))
    }
}

fn codex_usage_limit_next_step(rate_limit_reached_type: Option<&str>) -> &'static str {
    match rate_limit_reached_type {
        Some(
            "workspace_owner_credits_depleted" | "workspace_member_credits_depleted",
        ) => " The workspace has no credits to continue sooner: ask your workspace owner to add credits, or send the message again once the limit resets.",
        Some("workspace_owner_usage_limit_reached" | "workspace_member_usage_limit_reached") => {
            " The workspace spend limit is reached: ask your workspace owner to raise it, or send the message again once the limit resets."
        }
        _ => " Send the message again once the limit resets.",
    }
}

/// `codexUsageLimitMessage`. What a usage-limit stop shows instead of the provider sentence,
/// which on a Business workspace blames credits for a window that simply ran out. The window
/// named is the exhausted one that has yet to reset, latest first; `at_iso` is the stopping
/// event's timestamp, not the wall clock.
///
/// `snapshot` is whatever the turn carried, including nothing at all: a stop can reach this
/// message without a usage snapshot ever having been read.
#[must_use]
pub fn codex_usage_limit_message(snapshot: &Value, at_iso: &str) -> String {
    let at_ms = jsdate::date_parse(at_iso);
    let windows = if read::truthy(snapshot) && at_ms.is_some() {
        codex_rate_limits_to_windows(snapshot)
    } else {
        Vec::new()
    };
    let at_ms = at_ms.unwrap_or(f64::NAN);
    let mut reset = String::new();
    let mut latest_reset_ms = f64::NEG_INFINITY;
    for window in &windows {
        if window.used_percent < 100.0 {
            continue;
        }
        let Some(resets_at) = window.resets_at.value() else {
            continue;
        };
        let Some(reset_ms) = jsdate::date_parse(resets_at) else {
            continue;
        };
        if reset_ms <= at_ms || reset_ms <= latest_reset_ms {
            continue;
        }
        latest_reset_ms = reset_ms;
        reset = format!(
            " The {} limit resets in {}.",
            window.kind.as_str(),
            format_codex_usage_limit_wait(reset_ms - at_ms)
        );
    }
    format!(
        "Codex usage limit reached.{reset}{}",
        codex_usage_limit_next_step(read::as_string(
            read::property(snapshot, "rateLimitReachedType")
        ))
    )
}

/// `String(value)` for a number in a template literal, which is what the shipped sentences
/// interpolate. Error codes and the coarse wait are whole numbers, so the integer case is the
/// one that matters; everything else gets Rust's nearest spelling.
fn js_number_text(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        return format!("{}", value as i64);
    }
    format!("{value}")
}
