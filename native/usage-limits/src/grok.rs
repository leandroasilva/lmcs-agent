//! Grok subscription usage, ported from
//! `apps/server/src/provider/Layers/grokUsageLimits.ts`.
//!
//! The billing read reports one percentage for the whole account, so there is a single bar and
//! two things to work out from the response: whether the account is metered at all, and what
//! the provider's own enum spelling for the period means.
//!
//! Like the Cursor mapper this is the arithmetic only. Which credential may be read at all —
//! the default grok.com login, and none of the twelve variables that select another account,
//! endpoint or API key — belongs to the adapter that owns the credential.

use serde_json::Value;

use crate::jsdate;
use crate::limits::{self, Field, UsageLimits, UsageWindow, WindowKind, clamp_percent};
use crate::read;

/// The wire spelling is `USAGE_PERIOD_TYPE_WEEKLY`; the shipped mapper strips the prefix and
/// then compares the remainder, so a period type that is already bare (`"WEEKLY"`) matches and
/// one spelled lowercase does not.
const PERIOD_PREFIX: &str = "USAGE_PERIOD_TYPE_";

/// `period?.end ? DateTime.make(period.end) : none`. The truthiness test comes first, so an
/// empty string never reaches the parser, and unlike every other date in these mappers the
/// value is passed on unguarded — which is why a number in the position is read as epoch
/// milliseconds rather than rejected.
fn iso_from_period_end(value: &Value) -> Field<String> {
    if !read::truthy(value) {
        return Field::Absent;
    }
    if let Some(millis) = read::as_number(value) {
        return jsdate::to_iso_string(millis).into();
    }
    read::as_string(value)
        .and_then(jsdate::iso_from_string)
        .into()
}

/// `grokUsageResponseToLimits`.
///
/// A read that succeeded but carries no percentage is an account with nothing metered yet, not
/// one that can never report: xAI omits the field until usage registers. Drawing it as
/// `windows: []` keeps the account in the Limits view and keeps `applyUsageLimitsUpdate`
/// willing to accept the mid-turn windows that would fill the bar in, which `unsupported`
/// would strand.
#[must_use]
pub fn grok_usage_response_to_limits(response: &Value, checked_at: &str) -> UsageLimits {
    let config = read::property(response, "config");
    let Some(used_percent) = read::field_number(config, "creditUsagePercent")
        .into_value()
        .filter(|percent| percent.is_finite())
    else {
        return limits::make_usage_limits(checked_at, []);
    };
    let period = read::property(config, "currentPeriod");
    let period_type = read::as_string(read::property(period, "type"))
        .map(|text| text.strip_prefix(PERIOD_PREFIX).unwrap_or(text));
    let (kind, label) = match period_type {
        Some("WEEKLY") => (WindowKind::Weekly, "Weekly"),
        Some("MONTHLY") => (WindowKind::Monthly, "Monthly"),
        _ => (WindowKind::Other, "Subscription"),
    };
    limits::make_usage_limits(
        checked_at,
        [UsageWindow {
            id: "subscription".to_owned(),
            kind,
            label: label.to_owned(),
            used_percent: clamp_percent(used_percent),
            resets_at: iso_from_period_end(read::property(period, "end")),
            window_duration_mins: Field::Absent,
        }],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn usage(credit_usage_percent: Value) -> UsageLimits {
        grok_usage_response_to_limits(
            &json!({"config": {"creditUsagePercent": credit_usage_percent,
                                "currentPeriod": {"type": "USAGE_PERIOD_TYPE_WEEKLY"}}}),
            "2026-05-01T12:00:00.000Z",
        )
    }

    #[test]
    fn an_unmetered_account_draws_no_bars_rather_than_none_of_itself() {
        for percent in [
            Value::Null,
            json!("10"),
            json!(true),
            json!({"__number": "NaN"}),
            json!({"__number": "Infinity"}),
        ] {
            let limits = grok_usage_response_to_limits(
                &json!({"config": {"creditUsagePercent": percent}}),
                "now",
            );
            assert!(limits.windows.is_empty(), "{percent}");
            assert_eq!(limits.unavailable, None, "{percent}");
        }
        // What actually decides it is the percentage, so the same shape with a number draws.
        assert_eq!(usage(json!(0)).windows.len(), 1);
        assert_eq!(usage(json!(140)).windows[0].used_percent, 100.0);
        assert_eq!(usage(json!(-5)).windows[0].used_percent, 0.0);
        // A percentage too small to round away stays, because the clamp only caps the top.
        assert_eq!(usage(json!(5e-324)).windows[0].used_percent, 5e-324);
        assert_eq!(
            grok_usage_response_to_limits(&json!({}), "now").unavailable,
            None
        );
    }

    #[test]
    fn the_period_type_is_stripped_before_it_is_named() {
        assert_eq!(usage(json!(1)).windows[0].kind, WindowKind::Weekly);
        for (period, kind) in [
            (
                json!({"type": "USAGE_PERIOD_TYPE_MONTHLY"}),
                WindowKind::Monthly,
            ),
            (json!({"type": "WEEKLY"}), WindowKind::Weekly),
            (json!({"type": "weekly"}), WindowKind::Other),
            (
                json!({"type": "USAGE_PERIOD_TYPE_DAILY"}),
                WindowKind::Other,
            ),
            (json!({"type": "USAGE_PERIOD_TYPE_"}), WindowKind::Other),
            (json!({"type": null}), WindowKind::Other),
            (Value::Null, WindowKind::Other),
        ] {
            let limits = grok_usage_response_to_limits(
                &json!({"config": {"creditUsagePercent": 40, "currentPeriod": period}}),
                "now",
            );
            assert_eq!(limits.windows[0].kind, kind, "{period}");
            let expected_label = match kind {
                WindowKind::Weekly => "Weekly",
                WindowKind::Monthly => "Monthly",
                _ => "Subscription",
            };
            assert_eq!(limits.windows[0].label, expected_label);
        }
        assert_eq!(usage(json!(1)).windows[0].id, "subscription");
    }

    #[test]
    fn the_period_end_is_the_one_date_read_without_a_guard_in_front_of_it() {
        let reset = |end: Value| {
            grok_usage_response_to_limits(
                &json!({"config": {"creditUsagePercent": 40, "currentPeriod": {"end": end}}}),
                "now",
            )
            .windows[0]
                .resets_at
                .clone()
        };
        assert_eq!(
            reset(json!("2026-05-08T00:00:00+02:00")),
            Field::Value("2026-05-07T22:00:00.000Z".to_owned())
        );
        // Zone-less text gets Effect's `"Z"` before parsing, and a number is milliseconds.
        assert_eq!(
            reset(json!("2026-05-08")),
            Field::Value("2026-05-08T00:00:00.000Z".to_owned())
        );
        assert_eq!(
            reset(json!(1_777_000_000_000i64)),
            Field::Value("2026-04-24T03:06:40.000Z".to_owned())
        );
        for end in [
            json!(""),
            Value::Null,
            json!("not a date"),
            json!("2026-05-08T00:00:00 GMT"),
            json!("2026-05-08T00:00:00Z[Europe/Berlin]"),
        ] {
            assert_eq!(reset(end.clone()), Field::Absent, "{end}");
        }
    }
}
