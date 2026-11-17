//! Reading the JSON the provider CLIs write, with the JavaScript predicates the shipped
//! mappers were written against.
//!
//! The shipped adapters take an SDK type and then question it anyway — `typeof info.
//! utilization !== "number"`, `!response.rate_limits`, `update.limitId !== undefined` —
//! because what arrives on stdout is not what the `.d.ts` promises. These helpers are those
//! questions, so the port asks them in the same places instead of trusting the shape.
//!
//! One convention belongs to the golden rather than to any provider: `{"__number": "NaN"}`.
//! Real JSON cannot carry a non-finite number, so the trace generator tags one when it needs
//! to hand the port a `NaN` or `Infinity` (see `apps/server/scripts/usage-limits-trace.ts`).
//! Decoding it here is what lets the measured `Math.max(0, NaN)` reach the same Rust code as
//! the measured `Math.max(0, 3)`.

use serde_json::Value;

use crate::limits::{Field, ResetCredits, Unavailable, UnavailableReason, UsageLimits,
    UsageLimitsUpdate, UsageWindow, WindowKind};

/// The trace's non-finite marker.
const NUMBER_TAG: &str = "__number";

/// JS `value[key]`: `Value::Null` for a key that is not there, matching what reading an
/// absent property gives.
#[must_use]
pub fn property<'a>(value: &'a Value, key: &str) -> &'a Value {
    match value {
        Value::Object(map) => map.get(key).unwrap_or(&Value::Null),
        _ => &Value::Null,
    }
}

/// JS `Object.hasOwn`-style presence, which is what distinguishes `Absent` from `Null` in a
/// partial update. A non-object has no fields, so it reads as absent rather than as a `null`
/// that would overwrite.
#[must_use]
pub fn field<'a>(value: &'a Value, key: &str) -> Field<&'a Value> {
    match value {
        Value::Object(map) => match map.get(key) {
            None => Field::Absent,
            Some(Value::Null) => Field::Null,
            Some(found) => Field::Value(found),
        },
        _ => Field::Absent,
    }
}

/// JS `typeof value === "number"`, so `NaN` and the infinities count and a numeric string
/// does not.
#[must_use]
pub fn as_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => {
            // An integer literal is exact; `as_f64` is the only way to see a float.
            number.as_f64().or_else(|| number.as_i64().map(|value| value as f64))
        }
        Value::Object(map) => map.get(NUMBER_TAG).and_then(Value::as_str).map_or(
            None,
            |name| match name {
                "NaN" => Some(f64::NAN),
                "Infinity" => Some(f64::INFINITY),
                "-Infinity" => Some(f64::NEG_INFINITY),
                _ => None,
            },
        ),
        _ => None,
    }
}

/// `typeof value === "number"` on a field, folded into [`Field`] so a caller can tell "no
/// number was written" from "the field is missing".
#[must_use]
pub fn field_number(value: &Value, key: &str) -> Field<f64> {
    match field(value, key) {
        Field::Absent | Field::Null => Field::Absent,
        Field::Value(found) => as_number(found).map_or(Field::Absent, Field::Value),
    }
}

/// JS `typeof value === "string"`.
#[must_use]
pub fn as_string<'a>(value: &'a Value) -> Option<&'a str> {
    value.as_str()
}

/// A text field, where anything that is not a string reads as absent. The shipped mappers
/// compare these with `===` against a literal or feed them to `Date.parse`, so a number in
/// the position has no meaning to keep.
#[must_use]
pub fn field_string(value: &Value, key: &str) -> Field<String> {
    match field(value, key) {
        Field::Absent | Field::Null => Field::Absent,
        Field::Value(found) => as_string(found).map_or(Field::Absent, |text| {
            Field::Value(text.to_owned())
        }),
    }
}

/// An optional contract field that can also be written as an explicit `null`, which is not
/// the same answer as leaving it out: a stored window whose `resetsAt` was cleared keeps that
/// `null` when a sparse update folds onto it, and the published snapshot re-publishes it.
/// Anything else in the position is outside what `ServerProviderUsageWindow` declares and
/// reads as absent.
#[must_use]
pub fn optional_string(value: &Value, key: &str) -> Field<String> {
    match field(value, key) {
        Field::Absent => Field::Absent,
        Field::Null => Field::Null,
        Field::Value(found) => as_string(found).map_or(Field::Absent, |text| {
            Field::Value(text.to_owned())
        }),
    }
}

/// JS truthiness. `null`, `false`, `0`, `""`, `NaN` and an absent key (which reads as
/// `Value::Null` here after [`property`]) are falsy.
#[must_use]
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Bool(true) | Value::Array(_) | Value::Object(_) => true,
        Value::String(text) => !text.is_empty(),
        // `NaN` is falsy and so is `-0`, which `!= 0.0` already rejects.
        Value::Number(_) => {
            as_number(value).is_some_and(|number| number != 0.0 && !number.is_nan())
        }
    }
}

/// A field that must be an array to be walked, as `readModelScoped` requires.
#[must_use]
pub fn array<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
    match field(value, key) {
        Field::Value(Value::Array(items)) => items.iter().collect(),
        _ => Vec::new(),
    }
}

/// A `ServerProviderUsageWindow` as it arrives from the wire or from a stored snapshot.
///
/// A non-numeric `usedPercent` becomes `NaN`, which is what `clampPercent` turns into `0` and
/// what the shipped code's `Number.isFinite` guard rejects — the same answer either way.
/// An unrecognised `kind` is not silently downgraded: it means the fixture or the provider
/// disagrees with the contract, and the golden is where that should surface.
#[must_use]
pub fn window_from_value(value: &Value) -> UsageWindow {
    UsageWindow {
        id: as_string(property(value, "id")).unwrap_or_default().to_owned(),
        kind: as_string(property(value, "kind"))
            .and_then(WindowKind::parse)
            .expect("a window kind the contract declares"),
        label: as_string(property(value, "label")).unwrap_or_default().to_owned(),
        used_percent: as_number(property(value, "usedPercent")).unwrap_or(f64::NAN),
        resets_at: optional_string(value, "resetsAt"),
        window_duration_mins: match field(value, "windowDurationMins") {
            Field::Absent => Field::Absent,
            Field::Null => Field::Null,
            Field::Value(found) => Field::Value(as_number(found).unwrap_or(f64::NAN)),
        },
    }
}

#[must_use]
pub fn update_from_value(value: &Value) -> UsageLimitsUpdate {
    UsageLimitsUpdate {
        windows: match field(value, "windows") {
            Field::Value(Value::Array(items)) => items.iter().map(window_from_value).collect(),
            _ => Vec::new(),
        },
    }
}

#[must_use]
pub fn reset_credits_from_value(value: &Value) -> ResetCredits {
    ResetCredits {
        available_count: as_number(property(value, "availableCount")).unwrap_or(f64::NAN),
        next_expires_at: optional_string(value, "nextExpiresAt"),
    }
}

/// A `ServerProviderUsageLimits` as it arrives from the wire or from a stored snapshot.
#[must_use]
pub fn limits_from_value(value: &Value) -> UsageLimits {
    UsageLimits {
        checked_at: as_string(property(value, "checkedAt")).unwrap_or_default().to_owned(),
        windows: match field(value, "windows") {
            Field::Value(Value::Array(items)) => items.iter().map(window_from_value).collect(),
            _ => Vec::new(),
        },
        reset_credits: match field(value, "resetCredits") {
            Field::Value(credits) => Some(reset_credits_from_value(credits)),
            _ => None,
        },
        unavailable: match field(value, "unavailable") {
            Field::Value(unavailable) => Some(Unavailable {
                reason: as_string(property(unavailable, "reason"))
                    .and_then(UnavailableReason::parse)
                    .expect("an unavailability reason the contract declares"),
                message: optional_string(unavailable, "message"),
            }),
            _ => None,
        },
    }
}
