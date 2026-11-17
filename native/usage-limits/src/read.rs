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

use crate::jsdate;
use crate::limits::{
    Field, ResetCredits, Unavailable, UnavailableReason, UsageLimits, UsageLimitsUpdate,
    UsageWindow, WindowKind,
};

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
            number
                .as_f64()
                .or_else(|| number.as_i64().map(|value| value as f64))
        }
        Value::Object(map) => {
            map.get(NUMBER_TAG)
                .and_then(Value::as_str)
                .and_then(|name| match name {
                    "NaN" => Some(f64::NAN),
                    "Infinity" => Some(f64::INFINITY),
                    "-Infinity" => Some(f64::NEG_INFINITY),
                    _ => None,
                })
        }
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

/// JS `Number(value)`, the coercion Cursor's `billingCycleEnd` goes through twice. The
/// positions it is used in are typed `string | number` by the provider's schema, so the
/// `ToPrimitive` detour an array or object takes (`Number([10])` is `10`, not `NaN`) is not
/// reproduced: neither can survive the decode in front of the mapper.
#[must_use]
pub fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(true) => 1.0,
        Value::Bool(false) => 0.0,
        Value::String(text) => string_to_number(text),
        // A number or the trace's marker keeps its value, infinities included; `undefined`
        // reached through an absent key is [`Value::Null`] here only after [`property`], and
        // callers that must tell those apart use [`field`].
        value => as_number(value).unwrap_or(f64::NAN),
    }
}

/// JS `Number(text)`: ECMAScript whitespace, an optional sign, then either a radix literal —
/// which takes no sign — or a decimal one with an optional exponent. Anything else is `NaN`,
/// including the numeric separators a source literal may use and every legacy date spelling.
fn string_to_number(text: &str) -> f64 {
    let text = jsdate::trim_js(text);
    match text {
        "" => return 0.0,
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        // The only spelling of the `NaN` literal, and indistinguishable from a rejection.
        "NaN" => return f64::NAN,
        _ => {}
    }
    let (negative, body) = match text.as_bytes().first() {
        Some(b'+') => (false, &text[1..]),
        Some(b'-') => (true, &text[1..]),
        _ => (false, text),
    };
    let signed = body.len() != text.len();
    if let Some((radix, digits)) = radix_literal(body) {
        // `Number("-0x10")` is `NaN`: the sign belongs to the decimal grammar only.
        if signed {
            return f64::NAN;
        }
        let mut value = 0.0f64;
        // Accumulating in `f64` is exact up to 2^53, which is below the 8.64e15 a `Date` can
        // hold, so every radix literal whose value could mean a reset time is unaffected by
        // rounding — and every one above it reads as "no reset" whatever digits it has.
        for digit in digits.chars() {
            let Some(digit) = digit.to_digit(radix) else {
                return f64::NAN;
            };
            value = value * f64::from(radix) + f64::from(digit);
        }
        return value;
    }

    let bytes = body.as_bytes();
    let mut index = digits_end(body, 0);
    let integer = &body[..index];
    let mut fraction = "";
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let after = digits_end(body, index);
        fraction = &body[index..after];
        index = after;
    }
    if integer.is_empty() && fraction.is_empty() {
        return f64::NAN;
    }
    let mut exponent = 0i64;
    if bytes
        .get(index)
        .is_some_and(|byte| matches!(byte, b'e' | b'E'))
    {
        index += 1;
        let negative_exponent = match bytes.get(index) {
            Some(b'+') => {
                index += 1;
                false
            }
            Some(b'-') => {
                index += 1;
                true
            }
            _ => false,
        };
        let start = index;
        index = digits_end(body, index);
        if index == start {
            return f64::NAN;
        }
        // Past anything a `f64` can round to, so it only decides infinity versus zero, which
        // the saturated exponent says as well.
        exponent = body[start..index].parse().unwrap_or(i64::MAX);
        exponent = exponent.clamp(-4_000, 4_000);
        if negative_exponent {
            exponent = -exponent;
        }
    }
    if index != bytes.len() {
        return f64::NAN;
    }
    // Rust's float grammar wants a digit on each side of the point, which the ECMAScript one
    // does not ("5.", ".5"), and accepts leading zeros either way ("010" is ten, not eight).
    let normalized = format!(
        "{}.{}e{exponent}",
        if integer.is_empty() { "0" } else { integer },
        if fraction.is_empty() { "0" } else { fraction },
    );
    let value = normalized.parse::<f64>().unwrap_or(f64::NAN);
    if negative { -value } else { value }
}

fn digits_end(text: &str, from: usize) -> usize {
    let bytes = text.as_bytes();
    let mut index = from;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    index
}

/// `0x`/`0b`/`0o` and their digits, so `Number("0b101")` is five. An empty digit run is not a
/// radix literal but a rejection, and is not reported as one.
fn radix_literal(text: &str) -> Option<(u32, &str)> {
    let (radix, digits) = match text.get(..2)? {
        "0x" | "0X" => (16, &text[2..]),
        "0b" | "0B" => (2, &text[2..]),
        "0o" | "0O" => (8, &text[2..]),
        _ => return None,
    };
    (!digits.is_empty()).then_some((radix, digits))
}

/// JS `typeof value === "string"`.
#[must_use]
pub fn as_string(value: &Value) -> Option<&str> {
    value.as_str()
}

/// A text field, where anything that is not a string reads as absent. The shipped mappers
/// compare these with `===` against a literal or feed them to `Date.parse`, so a number in
/// the position has no meaning to keep.
#[must_use]
pub fn field_string(value: &Value, key: &str) -> Field<String> {
    match field(value, key) {
        Field::Absent | Field::Null => Field::Absent,
        Field::Value(found) => {
            as_string(found).map_or(Field::Absent, |text| Field::Value(text.to_owned()))
        }
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
        Field::Value(found) => {
            as_string(found).map_or(Field::Absent, |text| Field::Value(text.to_owned()))
        }
    }
}

/// JS truthiness. `null`, `false`, `0`, `""`, `NaN` and an absent key (which reads as
/// `Value::Null` here after [`property`]) are falsy.
#[must_use]
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Bool(true) | Value::Array(_) => true,
        Value::String(text) => !text.is_empty(),
        // `NaN` is falsy and so is `-0`, which `!= 0.0` already rejects.
        Value::Number(_) => {
            as_number(value).is_some_and(|number| number != 0.0 && !number.is_nan())
        }
        // The trace's marker is the same question in object clothing, so it answers as the
        // number it stands for; a real object — a bucket, a snapshot — is truthy whatever it
        // holds.
        Value::Object(map) if map.contains_key(NUMBER_TAG) => {
            as_number(value).is_some_and(|number| number != 0.0 && !number.is_nan())
        }
        Value::Object(_) => true,
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
        id: as_string(property(value, "id"))
            .unwrap_or_default()
            .to_owned(),
        kind: as_string(property(value, "kind"))
            .and_then(WindowKind::parse)
            .expect("a window kind the contract declares"),
        label: as_string(property(value, "label"))
            .unwrap_or_default()
            .to_owned(),
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
        checked_at: as_string(property(value, "checkedAt"))
            .unwrap_or_default()
            .to_owned(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truthiness_answers_for_javascript_not_for_rust() {
        // `-0` is falsy in JavaScript, and a percentage or duration of `-0` would otherwise
        // print as a real answer.
        for value in [json!(null), json!(false), json!(0), json!(-0.0), json!("")] {
            assert!(!truthy(&value), "{value} should be falsy");
        }
        for value in [
            json!(true),
            json!(1),
            json!(-1),
            json!("0"),
            json!([]),
            json!({}),
        ] {
            assert!(truthy(&value), "{value} should be truthy");
        }
        // A key that is not there reads as `undefined`, which is falsy, and so does anything
        // reached through a non-object.
        assert!(!truthy(property(&json!({}), "missing")));
        assert!(!truthy(property(&json!("text"), "length")));

        // JSON cannot carry a non-finite number, so the trace's marker object stands for one
        // and answers as the number it represents: `NaN` is falsy, an infinity is not. A plain
        // object stays truthy, because that is what `typeof x === "object"` is worth.
        assert!(!truthy(&json!({"__number": "NaN"})));
        assert!(truthy(&json!({"__number": "Infinity"})));
        assert!(truthy(&json!({"utilization": null})));
    }

    #[test]
    fn presence_distinguishes_an_omission_from_an_answer() {
        let written = json!({"limitId": null, "planType": "plus"});
        assert_eq!(field(&written, "limitId"), Field::Null);
        assert_eq!(field(&written, "planType"), Field::Value(&json!("plus")));
        assert_eq!(field(&written, "primary"), Field::Absent);
        // Only an object has fields, so a `null` snapshot cannot look like a cleared one.
        assert_eq!(field(&Value::Null, "limitId"), Field::Absent);
        assert_eq!(optional_string(&written, "limitId"), Field::Null);
        assert_eq!(field_string(&written, "limitId"), Field::Absent);
        assert_eq!(optional_string(&written, "primary"), Field::Absent);
    }

    #[test]
    fn number_coercion_follows_the_string_numeric_grammar() {
        // Whitespace on either end, the empty string, and the only three words it knows.
        assert_eq!(to_number(&json!(" 12 ")), 12.0);
        assert_eq!(to_number(&json!("")), 0.0);
        assert_eq!(to_number(&json!("   ")), 0.0);
        assert_eq!(to_number(&json!("Infinity")), f64::INFINITY);
        assert_eq!(to_number(&json!("+Infinity")), f64::INFINITY);
        assert_eq!(to_number(&json!("-Infinity")), f64::NEG_INFINITY);
        for text in ["infinity", "INFINITY", "NaN", "nan"] {
            assert!(to_number(&json!(text)).is_nan(), "{text}");
        }

        // A radix literal takes no sign, a decimal one does, and a leading zero is decimal.
        assert_eq!(to_number(&json!("0x10")), 16.0);
        assert_eq!(to_number(&json!("0X10")), 16.0);
        assert_eq!(to_number(&json!("0xff")), 255.0);
        assert_eq!(to_number(&json!("0b101")), 5.0);
        assert_eq!(to_number(&json!("0o17")), 15.0);
        assert!(to_number(&json!("-0x10")).is_nan());
        assert!(to_number(&json!("+0x10")).is_nan());
        assert!(to_number(&json!("0x")).is_nan());
        assert_eq!(to_number(&json!("010")), 10.0);
        assert!(to_number(&json!("-0")).is_sign_negative());

        // The exponent and point forms, and the round trip an out-of-range one takes.
        assert_eq!(to_number(&json!("1e12")), 1e12);
        assert_eq!(to_number(&json!("1E12")), 1e12);
        assert_eq!(to_number(&json!(".5")), 0.5);
        assert_eq!(to_number(&json!("5.")), 5.0);
        assert_eq!(to_number(&json!("+.5")), 0.5);
        assert_eq!(to_number(&json!("-.5")), -0.5);
        assert_eq!(to_number(&json!("1e-323")), 1e-323);
        assert_eq!(to_number(&json!("1e999")), f64::INFINITY);
        assert_eq!(to_number(&json!("1e-999")), 0.0);
        // An exponent too long to hold is still only a question of which end it saturates at.
        assert_eq!(to_number(&json!("1e99999999999999999999")), f64::INFINITY);
        for text in [
            "1e",
            "e5",
            "1.2.3",
            "1_0",
            "1,000",
            "1777000000000abc",
            "١٢",
            "½",
        ] {
            assert!(to_number(&json!(text)).is_nan(), "{text}");
        }

        // The non-string coercions. An array is `NaN` here where JS would call `toString`.
        assert_eq!(to_number(&Value::Null), 0.0);
        assert_eq!(to_number(&json!(true)), 1.0);
        assert_eq!(to_number(&json!(false)), 0.0);
        assert_eq!(to_number(&json!(-5.5)), -5.5);
        assert!(to_number(&json!({})).is_nan());
        assert!(to_number(&json!([10])).is_nan());
        assert_eq!(
            to_number(&json!({"__number": "-Infinity"})),
            f64::NEG_INFINITY
        );
    }

    #[test]
    fn a_number_is_what_typeof_number_sees() {
        assert_eq!(as_number(&json!(3)), Some(3.0));
        assert_eq!(as_number(&json!(3.5)), Some(3.5));
        assert_eq!(as_number(&json!("3")), None);
        assert_eq!(as_number(&json!(true)), None);
        assert!(as_number(&json!({"__number": "NaN"})).is_some_and(f64::is_nan));
        assert_eq!(
            as_number(&json!({"__number": "Infinity"})),
            Some(f64::INFINITY)
        );
        assert_eq!(
            as_number(&json!({"__number": "-Infinity"})),
            Some(f64::NEG_INFINITY)
        );
        assert_eq!(as_number(&json!({"__number": "3"})), None);
        // The marker is only a number where the shipped code could send one, so a plain object
        // in a numeric position is still not one.
        assert_eq!(as_number(&json!({"utilization": 1})), None);
        assert_eq!(field_number(&json!({"a": 1}), "a"), Field::Value(1.0));
        assert_eq!(field_number(&json!({"b": null}), "b"), Field::Absent);
        assert_eq!(field_number(&json!({"c": "2"}), "c"), Field::Absent);
    }

    #[test]
    fn a_list_is_only_a_list_when_it_is_one() {
        assert_eq!(array(&json!({"a": [1, 2]}), "a").len(), 2);
        assert!(array(&json!({"a": {}}), "a").is_empty());
        assert!(array(&json!({"a": null}), "a").is_empty());
        assert!(array(&json!({}), "a").is_empty());
    }

    #[test]
    fn a_window_reads_with_the_defaults_the_mappers_assume() {
        let window = window_from_value(&json!({"id": "x", "kind": "weekly", "label": "Weekly"}));
        assert!(window.used_percent.is_nan());
        assert_eq!(window.resets_at, Field::Absent);
        assert_eq!(window.window_duration_mins, Field::Absent);

        // A `null` the provider writes is kept, because the merge step has to be able to clear
        // a countdown rather than inherit it.
        let cleared = window_from_value(&json!({
            "id": "x", "kind": "session", "label": "Session", "usedPercent": 12,
            "resetsAt": null, "windowDurationMins": null,
        }));
        assert_eq!(cleared.used_percent, 12.0);
        assert_eq!(cleared.resets_at, Field::Null);
        assert_eq!(cleared.window_duration_mins, Field::Null);

        let credits = reset_credits_from_value(&json!({"availableCount": 2.5}));
        assert_eq!(credits.available_count, 2.5);
        assert_eq!(credits.next_expires_at, Field::Absent);
    }
}
