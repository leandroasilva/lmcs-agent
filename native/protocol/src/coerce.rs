//! `String(value)` over a decoded JSON value, which is what the two server refusals interpolate.
//!
//! `RpcServer.ts:775` and `:780` build their messages with a template literal, so the value the
//! client sent is rendered by ECMAScript's `ToString` — and over JSON that is a *total* function,
//! because a parsed value cannot carry `Symbol.toPrimitive`, a `toString` method or a `BigInt`.
//! Every branch below is reachable from a frame: the golden measured `null` → `"null"`,
//! `true` → `"true"`, `[]` → the **empty string**, `{}` → `"[object Object]"` and a missing key →
//! `"undefined"`.
//!
//! The empty string is the one that breaks a port that renders values with Rust's `Display`: the
//! frame for `b.idArray` is `{"_tag":"Defect","defect":"Invalid request id: "}`, ending in a space,
//! and a server that wrote `"Invalid request id: []"` there answered a different question.

use serde_json::Value;

/// `String(value)`.
#[must_use]
pub fn to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(true) => "true".to_owned(),
        Value::Bool(false) => "false".to_owned(),
        Value::Number(number) => crate::json::number_text(number),
        Value::String(text) => text.clone(),
        // `Array.prototype.toString` is `join(",")`, and `join` renders a `null` or `undefined`
        // element as the empty string rather than the word — hence `[null]` and `[]` both being "".
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        // `Object.prototype.toString` on a plain object. A `toJSON` key is irrelevant here: it
        // steers `JSON.stringify`, not `String`.
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `String(value)` of a key that may be absent, which the server reads off the object and so sees
/// as `undefined`.
#[must_use]
pub fn to_string_or_absent(value: Option<&Value>) -> String {
    match value {
        Some(value) => to_string(value),
        None => "undefined".to_owned(),
    }
}

/// `value._tag`, read the way JavaScript reads a property off a value.
///
/// `None` marks the case where the read **throws** a TypeError instead of yielding `undefined`,
/// which is the only JSON value that does: `null`. That throw happens inside the transport, so the
/// connection dies with no frame — measured as code `1005`, `wasClean: true`, for both a bare
/// `null` and the `null` inside `[null]`. A number, boolean or string has the property as
/// `undefined` and is answered.
#[must_use]
pub fn underscore_tag(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Object(fields) => Some(to_string_or_absent(fields.get("_tag"))),
        _ => Some("undefined".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::Request;
    use crate::json::parse;

    fn value(text: &str) -> Value {
        parse(text).expect("a test value")
    }

    #[test]
    fn the_four_coercions_the_golden_recorded() {
        assert_eq!(to_string(&value("null")), "null");
        assert_eq!(to_string(&value("true")), "true");
        assert_eq!(to_string(&value("[]")), "");
        assert_eq!(to_string(&value("{}")), "[object Object]");
        assert_eq!(to_string(&value("123")), "123");
        assert_eq!(to_string(&value("\"abc\"")), "abc");
    }

    #[test]
    fn an_array_joins_and_leaves_holes_empty() {
        assert_eq!(to_string(&value("[1,2,3]")), "1,2,3");
        assert_eq!(to_string(&value("[null,{}]")), ",[object Object]");
        assert_eq!(to_string(&value("[[1,2],3]")), "1,2,3");
        assert_eq!(to_string(&value("[null]")), "");
    }

    #[test]
    fn a_missing_key_is_undefined_but_a_missing_tag_is_empty() {
        let fields = value(r#"{"id":1}"#).as_object().unwrap().clone();
        assert_eq!(to_string_or_absent(fields.get("tag")), "undefined");
        // The group key spells the same absence differently (`RpcServer.ts:768`), which is what
        // makes `b.requestWithoutTag` a refusal reading `Unknown request tag: ` rather than one
        // reading `…: undefined`.
        assert_eq!(Request::read(&fields).group_key(), "");
    }

    #[test]
    fn only_null_takes_the_read_down() {
        assert_eq!(underscore_tag(&value("null")), None);
        assert_eq!(underscore_tag(&value("42")).as_deref(), Some("undefined"));
        assert_eq!(underscore_tag(&value("{}")).as_deref(), Some("undefined"));
        assert_eq!(
            underscore_tag(&value(r#"{"_tag":"Nonsense"}"#)).as_deref(),
            Some("Nonsense")
        );
        assert_eq!(
            underscore_tag(&value(r#"{"_tag":1}"#)).as_deref(),
            Some("1")
        );
    }
}
