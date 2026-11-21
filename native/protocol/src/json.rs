//! The text half of the wire: what `JSON.stringify` writes and what `JSON.parse` accepts.
//!
//! `RpcSerialization.layerJson` is two calls and nothing else (`RpcSerialization.ts:126-132`):
//! `encode` is `JSON.stringify` of the message the server built, `decode` is `JSON.parse` with the
//! one rule that an array is a batch. So the crate's byte-exactness claim lives here, and it is
//! not the same as serde's:
//!
//! - `JSON.stringify` escapes U+0008 as `\b` and U+000C as `\f`; serde's writer spells both
//!   `\u0008` and `\u000c`. Lowercase `c` versus a named escape is a byte.
//! - `JSON.stringify` switches to exponential form outside `1e-6 .. 1e21` and signs the exponent
//!   (`1e+21`); Rust's `Display` never does either.
//! - `JSON.stringify(-0)` is `"0"` and `JSON.stringify(Infinity)` is `"null"`, because the string
//!   writer goes through `Number::toString`, not through a float formatter.
//!
//! The parse side is deliberately narrower than V8's: the golden measured the one message that a
//! real frame produces ([`Syntax::UnexpectedEnd`], from both `""` and a truncated object), and
//! [`Syntax::Other`] carries serde's text with the divergence named rather than hidden.

use std::fmt::Write as _;

use serde_json::{Number, Value};

/// Why `JSON.parse` refused a frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Syntax {
    /// V8's `Unexpected end of JSON input`, which is what both an empty frame and a frame cut off
    /// mid-value produce. The server wraps this in a `Schema.Defect`-encoded error object, so the
    /// two words are bytes on the wire: measured for `{"_tag":` and for `""`.
    UnexpectedEnd,
    /// Any other refusal. V8's text for these names the offending token and its position, which
    /// this port has not measured, so the crate keeps serde's message and says so rather than
    /// inventing a V8-shaped string.
    Other(String),
}

impl Syntax {
    /// The `message` half of the SyntaxError object the shipped server writes into a `Defect`.
    #[must_use]
    pub fn message(&self) -> &str {
        match self {
            Self::UnexpectedEnd => "Unexpected end of JSON input",
            Self::Other(message) => message,
        }
    }
}

/// `JSON.parse(text)`.
pub fn parse(text: &str) -> Result<Value, Syntax> {
    serde_json::from_str(text).map_err(|cause| match cause.classify() {
        serde_json::error::Category::Eof => Syntax::UnexpectedEnd,
        _ => Syntax::Other(cause.to_string()),
    })
}

/// `JSON.stringify(value)`.
#[must_use]
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

/// One JavaScript string as JSON text, escapes included.
#[must_use]
pub fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    write_string(&mut out, text);
    out
}

/// `JSON.stringify` of a JSON member, which is also what an envelope writes into its holes.
fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&number_text(number)),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(fields) => {
            out.push('{');
            for (index, (key, value)) in fields.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, value);
            }
            out.push('}');
        }
    }
}

/// `QuoteJSONString` from the JSON spec: the two named escapes beyond serde's set, and four-digit
/// lowercase hex for the rest of the C0 range. Non-ASCII is written as itself — `JSON.stringify`
/// does not escape U+2028, which is the other place a hand-rolled writer usually differs.
fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            other if (other as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", other as u32);
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

/// `Number::toString` for the numbers JSON can hold: the integer path first, because a parsed
/// `1` and a written `1.0` are the same number to JavaScript and must be the same bytes.
#[must_use]
pub fn number_text(number: &Number) -> String {
    if let Some(value) = number.as_i64() {
        return value.to_string();
    }
    if let Some(value) = number.as_u64() {
        return value.to_string();
    }
    match number.as_f64() {
        Some(value) => float_text(value),
        // Only reachable with `arbitrary_precision`, where serde keeps the token it read — and the
        // token is already the text JavaScript would have written for it.
        None => number.to_string(),
    }
}

#[must_use]
pub fn float_text(value: f64) -> String {
    // Both are `Number::toString` results rather than float formatting: `-0` and `0` are one
    // string, and a non-finite number has no JSON spelling so `JSON.stringify` writes `null`.
    if value == 0.0 {
        return "0".to_owned();
    }
    if !value.is_finite() {
        return "null".to_owned();
    }
    // `{:e}` is Rust's shortest round-trip exponent form, so its exponent is the decimal exponent
    // ECMAScript switches on without the rounding a `log10` would introduce.
    let scientific = format!("{value:e}");
    let exponent: i32 = scientific
        .split_once('e')
        .expect("Rust's exponent form always carries an e")
        .1
        .parse()
        .expect("the exponent after e is an integer");
    if (-6..21).contains(&exponent) {
        return format!("{value}");
    }
    // JavaScript signs the exponent; Rust does not.
    match scientific.split_once('e') {
        Some((mantissa, tail)) if !tail.starts_with('-') => format!("{mantissa}e+{tail}"),
        _ => scientific,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn number(value: f64) -> Number {
        Number::from_f64(value).expect("a finite number")
    }

    #[test]
    fn the_two_escapes_serde_does_not_share() {
        assert_eq!(quote("a\u{8}b\u{c}c"), "\"a\\bb\\fc\"");
        assert_eq!(quote("\u{1}\u{1f}"), "\"\\u0001\\u001f\"");
        assert_eq!(
            quote("é\u{2028}\"\\"),
            "\"é\u{2028}\\\"\\\\\"",
            "non-ASCII and the line separator stay as themselves"
        );
    }

    #[test]
    fn numbers_take_javas_spelling() {
        assert_eq!(float_text(-0.0), "0");
        assert_eq!(float_text(f64::INFINITY), "null");
        assert_eq!(float_text(1.0), "1");
        assert_eq!(float_text(1.5), "1.5");
        assert_eq!(float_text(1e20), "100000000000000000000");
        assert_eq!(float_text(1e21), "1e+21");
        assert_eq!(float_text(1.5e22), "1.5e+22");
        assert_eq!(float_text(1e-6), "0.000001");
        assert_eq!(float_text(1e-7), "1e-7");
        assert_eq!(float_text(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(
            number_text(&number(9_007_199_254_740_991.0)),
            "9007199254740991"
        );
    }

    #[test]
    fn an_ordered_document_keeps_its_keys_as_read() {
        let value = parse(r#"{"z":1,"a":{"b":[true,null,2.5]},"m":"é"}"#).unwrap();
        assert_eq!(
            stringify(&value),
            r#"{"z":1,"a":{"b":[true,null,2.5]},"m":"é"}"#
        );
    }

    #[test]
    fn a_cut_off_frame_is_the_measured_refusal() {
        assert_eq!(parse(""), Err(Syntax::UnexpectedEnd));
        assert_eq!(parse(r#"{"_tag":"#), Err(Syntax::UnexpectedEnd));
        assert!(matches!(parse("4 4"), Err(Syntax::Other(_))));
    }
}
