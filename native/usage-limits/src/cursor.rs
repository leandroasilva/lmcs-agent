//! Cursor subscription usage, ported from
//! `apps/server/src/provider/Layers/cursorUsageLimits.ts`.
//!
//! One billing cycle drives three dashboard percentages, so the mapper answers two questions
//! independently: what does the cycle end, and which of the three buckets did the account
//! report? A missing reset time is not a reason to drop the bars, and a bucket the response
//! left out is not a bar at zero — Cursor's plan simply has no such pool.
//!
//! This is the mapper only. What gates the read at all — the stored CLI login versus an
//! explicit `CURSOR_API_KEY`, the Keychain consent, the endpoint the token belongs to — stays
//! with the adapter that owns the credentials, since none of it is a decision about numbers.

use serde_json::Value;

use crate::jsdate;
use crate::limits::{
    self, Field, UnavailableReason, UsageLimits, UsageWindow, WindowKind, clamp_percent,
};
use crate::read;

struct WindowDefinition {
    id: &'static str,
    label: &'static str,
}

/// `CURSOR_USAGE_WINDOWS` in `packages/core/src/shared/usageLimits.ts`. Every row is
/// `monthly` and shares the cycle end, so after the sort the ids alone decide the order:
/// `apiPercentUsed`, `autoPercentUsed`, `totalPercentUsed` — not the declaration order here.
const WINDOWS: [WindowDefinition; 3] = [
    WindowDefinition {
        id: "totalPercentUsed",
        label: "Overall",
    },
    WindowDefinition {
        id: "autoPercentUsed",
        label: "Cursor Models",
    },
    WindowDefinition {
        id: "apiPercentUsed",
        label: "Other Models",
    },
];

/// `cursorUsageResponseToLimits`.
///
/// `billingCycleEnd` goes through `Number()` twice — once for the date, once for the "is there
/// a reset at all" test — so the coercion is part of the answer: `null` becomes `0` and draws
/// no countdown, an absent key becomes `NaN` and does the same, and a positive number the
/// `Date` range refuses (a cycle end of `"1e999"`) draws none either. A value that coerces to
/// a small positive number is a real reset however silly it looks, since the field is
/// milliseconds: `"0.5"` is a cycle that ended at the epoch.
#[must_use]
pub fn cursor_usage_response_to_limits(response: &Value, checked_at: &str) -> UsageLimits {
    let cycle_end = match read::field(response, "billingCycleEnd") {
        Field::Absent => f64::NAN,
        Field::Null => 0.0,
        Field::Value(value) => read::to_number(value),
    };
    let resets_at: Field<String> = if cycle_end > 0.0 {
        jsdate::to_iso_string(cycle_end).into()
    } else {
        Field::Absent
    };

    let plan_usage = read::property(response, "planUsage");
    let mut windows: Vec<UsageWindow> = Vec::new();
    if read::truthy(plan_usage) {
        for definition in &WINDOWS {
            // `usedPercent === undefined || !Number.isFinite(usedPercent)`: a key that is not
            // there and a value that is not a number are the same silence, and a `NaN` the
            // provider wrote survives neither.
            let used_percent =
                read::as_number(read::property(plan_usage, definition.id)).unwrap_or(f64::NAN);
            if !used_percent.is_finite() {
                continue;
            }
            windows.push(UsageWindow {
                id: definition.id.to_owned(),
                kind: WindowKind::Monthly,
                label: definition.label.to_owned(),
                used_percent: clamp_percent(used_percent),
                resets_at: resets_at.clone(),
                window_duration_mins: Field::Absent,
            });
        }
    }
    if windows.is_empty() {
        return limits::make_unavailable_usage_limits(
            checked_at,
            UnavailableReason::Unsupported,
            None,
        );
    }
    limits::make_usage_limits(checked_at, windows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cycle_end(billing_cycle_end: Value) -> UsageLimits {
        cursor_usage_response_to_limits(
            &json!({"billingCycleEnd": billing_cycle_end, "planUsage": {"totalPercentUsed": 10}}),
            "2026-05-01T12:00:00.000Z",
        )
    }

    fn reset(limits: &UsageLimits) -> Field<String> {
        limits.windows[0].resets_at.clone()
    }

    #[test]
    fn the_cycle_end_is_milliseconds_and_coerced_before_it_is_compared() {
        assert_eq!(
            reset(&cycle_end(json!(1_777_000_000_000i64))),
            Field::Value("2026-04-24T03:06:40.000Z".to_owned())
        );
        // A cycle end written as a string is `Number()`ed, not parsed as a date, so epoch
        // seconds land in January 1970 and still count as a reset.
        assert_eq!(
            reset(&cycle_end(json!("1777000000000"))),
            Field::Value("2026-04-24T03:06:40.000Z".to_owned())
        );
        assert_eq!(
            reset(&cycle_end(json!(" 1777000000000 "))),
            Field::Value("2026-04-24T03:06:40.000Z".to_owned())
        );
        // Nothing survives the comparison, so the bar keeps its percentage and loses the
        // countdown rather than showing a date in 1970.
        for value in [
            Value::Null,
            json!(0),
            json!(-1),
            json!(""),
            json!("1777000000000abc"),
            json!("2026-05-01T00:00:00Z"),
            json!({"__number": "NaN"}),
            // Positive, but past the range a `Date` can hold.
            json!(8.64e15 + 1.0),
            json!("1e999"),
        ] {
            assert_eq!(reset(&cycle_end(value.clone())), Field::Absent, "{value}");
        }
        // The two zeros are not the same number to `>`, but both fail it, and an absent key is
        // `undefined` — which coerces to `NaN`, not to `0`.
        assert_eq!(reset(&cycle_end(json!(-0.0))), Field::Absent);
        assert_eq!(
            reset(&cursor_usage_response_to_limits(
                &json!({"planUsage": {"totalPercentUsed": 10}}),
                "now"
            )),
            Field::Absent
        );
    }

    #[test]
    fn a_reported_bucket_with_no_percentage_draws_nothing() {
        let limits = cursor_usage_response_to_limits(
            &json!({
                "billingCycleEnd": 1_777_000_000_000i64,
                "planUsage": {"totalPercentUsed": 10, "autoPercentUsed": null, "apiPercentUsed": "30"},
            }),
            "now",
        );
        assert_eq!(
            limits
                .windows
                .iter()
                .map(|window| window.id.as_str())
                .collect::<Vec<_>>(),
            ["totalPercentUsed"]
        );
        assert_eq!(limits.windows[0].label, "Overall");
        assert_eq!(limits.windows[0].kind, WindowKind::Monthly);
        assert_eq!(limits.windows[0].window_duration_mins, Field::Absent);

        // A plan with no buckets at all is `unsupported` without a message, which the Limits
        // view mutes; a percentage of zero is a bar, not a silence.
        for plan_usage in [
            Value::Null,
            json!({}),
            json!("10"),
            json!({"totalPercentUsed": "10"}),
        ] {
            let limits = cursor_usage_response_to_limits(&json!({"planUsage": plan_usage}), "now");
            assert_eq!(
                limits.unavailable.map(|unavailable| unavailable.reason),
                Some(UnavailableReason::Unsupported),
                "{plan_usage}"
            );
            assert!(limits.windows.is_empty());
        }
        let zero = cursor_usage_response_to_limits(
            &json!({"billingCycleEnd": 1_777_000_000_000i64, "planUsage": {"totalPercentUsed": -5}}),
            "now",
        );
        assert_eq!(zero.windows[0].used_percent, 0.0);
    }
}
