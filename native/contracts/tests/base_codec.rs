//! Replays `apps/server/scripts/contracts-golden.ts` against the ported codec
//! primitives.
//!
//! The golden records what the **shipped** TypeScript codec does, including the
//! asymmetries, so this test fails when the port drifts rather than when the port
//! disagrees with an opinion about what the schema should have meant.
//!
//! `LMCS_CONTRACTS_GOLDEN=/tmp/contracts-golden.json cargo test`

use lmcs_contracts::base::{
    Absent, Between, Check, Checked, DateTimeUtc, Defect, DurationMillis, EffectOption,
    GreaterThan, JsNumber, Lenient, LessThan, MaxLength, Maybe, MinLength, Never, NonEmpty,
    NonNegativeInt, Nullable, Port, PositiveInt, Record, SafeInt, Trimmed,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::LazyLock;

/// `Schema.Literals(["a", "b"])`, the member set the golden's shapes are built on.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Lit {
    A,
    B,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct PlainOptional {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    v: Absent<Lit>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct ForwardCompatibleOptional {
    #[serde(default, skip_serializing_if = "Maybe::is_none")]
    v: Maybe<Lit>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct ForwardCompatibleNullable {
    v: Maybe<Lit>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct OmittedWhenNull {
    #[serde(default, skip_serializing_if = "Maybe::is_none")]
    v: Maybe<Lit>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Required {
    v: Lit,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
enum Tagged {
    A { detail: String },
    B,
}

// The encode side of every shape is a strictly typed mirror: TypeScript validates the
// Type before running the encode transform, so `{"v":"z"}` is rejected there even where
// decoding swallows it. These mirrors are what makes that rejection reproducible.
#[derive(Serialize, Deserialize)]
struct ForwardCompatibleOptionalEnc {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    v: Absent<Lit>,
}

#[derive(Serialize, Deserialize)]
struct ForwardCompatibleNullableEnc {
    v: Nullable<Lit>,
}

#[derive(Serialize, Deserialize)]
struct OmittedWhenNullEnc {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    v: Option<Lit>,
}

/// The golden's `Schema.isPattern(/^[a-z]+$/)`. A concrete rule is a unit struct plus a
/// `Check` impl; the 28 real ones live beside their payload schemas, not here.
static LOWERCASE: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[a-z]+$").expect("valid"));

struct Lowercase;

impl Check<String> for Lowercase {
    fn passes(value: &String) -> bool {
        LOWERCASE.is_match(value)
    }

    fn describe() -> String {
        "a lowercase alphabetic string".to_owned()
    }
}

/// `withDecodingDefault` and `withDecodingDefaultKey` differ only in the value an absent
/// key decodes to, so the decode side is one shape parameterised by its `default` and the
/// encode side is shared. Encode is shared because neither writes the default: `{}`
/// encodes back to `{}`, which is why the mirror is `Absent` and not `bool`.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct DefaultedToFalse {
    #[serde(default)]
    v: bool,
}

fn truthy() -> bool {
    true
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct DefaultedToTrue {
    #[serde(default = "truthy")]
    v: bool,
}

#[derive(Serialize, Deserialize)]
struct DefaultedEnc {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    v: Absent<bool>,
}

/// The Encoded side of `DateTimeUtcFromString`: an ISO-8601 string.
#[derive(Serialize, Deserialize)]
struct WireTimestamp {
    at: DateTimeUtc,
}

/// The Type side, as the golden records it: `toWire` walks a decoded `DateTime.Utc` into
/// its own fields, so what appears in the golden is the epoch-millis holder rather than
/// the string the wire carries.
#[derive(Serialize, Deserialize)]
struct TypeTimestamp {
    at: EpochMillis,
}

#[derive(Deserialize)]
struct EpochMillis {
    #[serde(rename = "epochMilliseconds")]
    millis: i64,
}

impl Serialize for EpochMillis {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        DateTimeUtc(self.millis).serialize(serializer)
    }
}

type Codec = fn(&Value) -> Result<Value, ()>;

fn round<T>(raw: &Value) -> Result<Value, ()>
where
    T: serde::de::DeserializeOwned + Serialize,
{
    let built: T = serde_json::from_value(raw.clone()).map_err(|_| ())?;
    serde_json::to_value(built).map_err(|_| ())
}

/// Decodes and renders the result the way the TypeScript *Type* side holds it, which is
/// not always what re-serializing it produces: `OmittedWhenNull` decodes `{}` to
/// `{v:null}` and then encodes that back to `{}`.
fn decode_as<T, F>(raw: &Value, describe: F) -> Result<Value, ()>
where
    T: serde::de::DeserializeOwned,
    F: FnOnce(&T) -> Value,
{
    let built: T = serde_json::from_value(raw.clone()).map_err(|_| ())?;
    Ok(describe(&built))
}

/// A Type of `{v: … | null}` — `ForwardCompatibleNullable`, `OmittedWhenNull`. Their
/// Rust structs carry `skip_serializing_if`, so re-serializing a decoded value would
/// drop the key the TypeScript Type still holds.
fn present(value: &Option<impl Serialize>) -> Value {
    json!({ "v": value })
}

/// Builds a string newtype straight from the raw JSON, without validation, so the
/// `Serialize` impl gets to run the Type-side check the way the TS encode path does.
fn string_like<T, F>(raw: &Value, wrap: F) -> Result<Value, ()>
where
    T: Serialize,
    F: FnOnce(String) -> T,
{
    let text = raw.as_str().ok_or(())?;
    serde_json::to_value(wrap(text.to_owned())).map_err(|_| ())
}

fn int_like<T, F>(raw: &Value, wrap: F) -> Result<Value, ()>
where
    T: Serialize,
    F: FnOnce(i64) -> Option<T>,
{
    let number = raw.as_i64().ok_or(())?;
    let built = wrap(number).ok_or(())?;
    serde_json::to_value(built).map_err(|_| ())
}

/// The `Schema.Number` counterpart of [`int_like`]. Keeps the JSON literal instead of
/// going through `as_i64`, both so that `2.5` survives at all and so that `1` does not
/// come back out as `1.0`.
fn number_like<T, F>(raw: &Value, wrap: F) -> Result<Value, ()>
where
    T: Serialize,
    F: FnOnce(serde_json::Number) -> T,
{
    let Value::Number(number) = raw else {
        return Err(());
    };
    serde_json::to_value(wrap(number.clone())).map_err(|_| ())
}

/// The encode side of [`Weights`], and the one subject that cannot use [`round`] for it.
/// `round` decodes first, and `NonEmpty`'s decoder trims and rejects — so a Type-side key
/// of `"   "` would be refused before `Record`'s `Serialize` ever ran, when the shipped
/// encoder accepts it and writes `""`. Every field is built unchecked here so the checks
/// land where TypeScript puts them: on the way out.
fn weights_encode(raw: &Value) -> Result<Value, ()> {
    let fields = raw.as_object().ok_or(())?;
    let built: BTreeMap<NonEmpty, Checked<JsNumber, (SafeInt, Between<0, 100>)>> = fields
        .iter()
        .map(|(key, value)| {
            Ok((
                NonEmpty(key.clone()),
                Checked::wrap(JsNumber(value.as_number().ok_or(())?.clone())),
            ))
        })
        .collect::<Result<_, ()>>()?;
    serde_json::to_value(Record(built)).map_err(|_| ())
}

// ---------------------------------------------------------------------------
// settings.ts — the three constructs that file contributes and no earlier subject
// reached: `Schema.makeFilter` over a struct, and `Schema.decodeTo` under
// `Schema.withDecodingDefault` in both of its flavours (a lossy legacy union member and a
// decode-only fallback). None of them is a new primitive; each is `Checked`, `Trimmed` and
// a pair of hand-written serde impls, which is the finding.
// ---------------------------------------------------------------------------

/// `KeybindingValue` (`keybindings.ts:114`): `TrimmedString.check(isMinLength(1),
/// isMaxLength(64))`. Wrapping [`Trimmed`] rather than a `String` is what makes the two
/// directions disagree the way the shipped codec does — a decode measures the trimmed text,
/// so `"    "` fails the floor, while an encode measures the raw text it was handed, so
/// `"    "` passes it, the trim then empties it, and nothing re-checks.
type KeybindingValue = Checked<Trimmed, (MinLength<1>, MaxLength<64>)>;

/// `KeybindingShortcut` (`keybindings.ts:135`) — six declared fields, and undeclared ones
/// dropped rather than rejected, which is serde's default behaviour already.
#[derive(Deserialize, Serialize)]
struct KeybindingShortcut {
    key: KeybindingValue,
    #[serde(rename = "metaKey")]
    meta_key: bool,
    #[serde(rename = "ctrlKey")]
    ctrl_key: bool,
    #[serde(rename = "shiftKey")]
    shift_key: bool,
    #[serde(rename = "altKey")]
    alt_key: bool,
    #[serde(rename = "modKey")]
    mod_key: bool,
}

/// The `Schema.makeFilter` behind `SnapShotKeyChord` (`settings.ts:185`). The filter returns
/// `shortcut.metaKey || … || "Snapshot shortcut requires a modifier."`, and that trailing
/// string is a **failure carrying that message**, not a truthy value that passes — so the
/// rule is "any one of the five modifiers" and the message is the error.
///
/// This is the first check in the crate whose [`Check::describe`] text was written by the
/// schema author rather than generated from a bound, which is what makes `makeFilter`
/// different from `isBetween`: nothing about the *shape* of the predicate is new.
struct HasModifier;

impl Check<KeybindingShortcut> for HasModifier {
    fn passes(value: &KeybindingShortcut) -> bool {
        value.meta_key || value.ctrl_key || value.shift_key || value.alt_key || value.mod_key
    }

    fn describe() -> String {
        "Snapshot shortcut requires a modifier.".to_owned()
    }
}

/// The encode side of `SnapShotKeyChord`, built field by field instead of through
/// [`round`]: decoding first would run `isMinLength` on the *trimmed* key, and the shipped
/// encoder runs it on the raw one. Every field is wrapped unchecked so both checks land on
/// the way out, outer filter first and inner length second, exactly as TypeScript layers
/// `.check` over a `Struct` whose field is itself a `check`.
fn chord_encode(raw: &Value) -> Result<Value, ()> {
    let fields = raw.as_object().ok_or(())?;
    let shortcut = KeybindingShortcut {
        key: Checked::wrap(Trimmed(text(fields, "key")?.to_owned())),
        meta_key: flag(fields, "metaKey")?,
        ctrl_key: flag(fields, "ctrlKey")?,
        shift_key: flag(fields, "shiftKey")?,
        alt_key: flag(fields, "altKey")?,
        mod_key: flag(fields, "modKey")?,
    };
    serde_json::to_value(Checked::<_, HasModifier>::wrap(shortcut)).map_err(|_| ())
}

fn flag(fields: &Map<String, Value>, name: &str) -> Result<bool, ()> {
    fields.get(name).and_then(Value::as_bool).ok_or(())
}

fn text<'a>(fields: &'a Map<String, Value>, name: &str) -> Result<&'a str, ()> {
    fields.get(name).and_then(Value::as_str).ok_or(())
}

/// `QuitConfirmationMode` — the canonical form, and the whole Type side of the setting.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum QuitConfirmationMode {
    Direct,
    Hold,
    DoubleClick,
}

/// The `Union([QuitConfirmationMode, LegacyConfirmQuit])` order, on the wire: the canonical
/// literal first, so the legacy boolean only ever answers when no literal matched.
#[derive(Deserialize)]
#[serde(untagged)]
enum ConfirmQuitWire {
    Mode(QuitConfirmationMode),
    Legacy(bool),
}

const DEFAULT_QUIT_CONFIRMATION: QuitConfirmationMode = QuitConfirmationMode::Hold;

fn confirm_quit_default() -> QuitConfirmationMode {
    DEFAULT_QUIT_CONFIRMATION
}

/// `LegacyConfirmQuit`'s decode half: `true` meant "confirm", which is `"hold"`, and
/// `false` meant "don't", which is `"direct"`.
fn confirm_quit_from_wire<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<QuitConfirmationMode, D::Error> {
    match ConfirmQuitWire::deserialize(deserializer)? {
        ConfirmQuitWire::Mode(mode) => Ok(mode),
        ConfirmQuitWire::Legacy(true) => Ok(QuitConfirmationMode::Hold),
        ConfirmQuitWire::Legacy(false) => Ok(QuitConfirmationMode::Direct),
    }
}

/// Decode side of the `confirmQuit` field. The key is optional on the wire — that is what
/// `withDecodingDefault` buys — and the default is **substituted**, not left unset, so
/// `{"confirmQuit": true}` decodes all the way to `{"confirmQuit": "hold"}`.
#[derive(Serialize, Deserialize)]
struct ConfirmQuitDec {
    #[serde(
        rename = "confirmQuit",
        default = "confirm_quit_default",
        deserialize_with = "confirm_quit_from_wire"
    )]
    confirm_quit: QuitConfirmationMode,
}

/// Encode side: the same key, but genuinely absent, because the default is a *decoding*
/// default and `{}` is a legal Type value that has nothing to write. A legacy boolean is
/// refused here — it is not in the Type — which is why this needs its own shape rather than
/// [`round`] over [`ConfirmQuitDec`].
#[derive(Serialize)]
struct ConfirmQuitEnc {
    #[serde(rename = "confirmQuit", skip_serializing_if = "Option::is_none")]
    confirm_quit: Option<QuitConfirmationMode>,
}

fn confirm_quit_encode(raw: &Value) -> Result<Value, ()> {
    let fields = raw.as_object().ok_or(())?;
    let confirm_quit = match fields.get("confirmQuit") {
        None => None,
        Some(value) => {
            Some(serde_json::from_value::<QuitConfirmationMode>(value.clone()).map_err(|_| ())?)
        }
    };
    serde_json::to_value(ConfirmQuitEnc { confirm_quit }).map_err(|_| ())
}

/// `makeBinaryPathSetting(fallback)` (`settings.ts:540`): `TrimmedString` under a `decodeTo`
/// whose decode is `value || fallback` and whose encode is the identity. The asymmetry is
/// the whole subject — `""` decodes to `"codex"` while a Type-side `""` **encodes to `""`**,
/// and `"  "` decodes to `"codex"` while encoding to `""`.
///
/// The fallback is a per-site string constant, so it is supplied where the decode runs
/// instead of being carried in the type; the seven call sites differ only in that literal.
#[derive(Debug, PartialEq)]
struct BinaryPath(String);

impl BinaryPath {
    /// The decode half: trim, then `||`.
    fn or_fallback(trimmed: String, fallback: &str) -> Self {
        BinaryPath(if trimmed.is_empty() {
            fallback.to_owned()
        } else {
            trimmed
        })
    }
}

impl Serialize for BinaryPath {
    /// The encode half: the trim, and **not** the fallback.
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        Trimmed(self.0.clone()).serialize(serializer)
    }
}

const CODEX_BINARY: &str = "codex";

fn codex_binary_path() -> BinaryPath {
    BinaryPath(CODEX_BINARY.to_owned())
}

/// Decode side of `CodexSettings.binaryPath`: an absent key or an empty path both become the
/// fallback. A key that is present but not a string still **fails** — the default covers a
/// missing key and nothing else, which is the one property an `unwrap_or(fallback)` port
/// would get wrong across the 205 `withDecodingDefault` sites.
#[derive(Serialize, Deserialize)]
struct BinaryPathDec {
    #[serde(
        rename = "binaryPath",
        default = "codex_binary_path",
        deserialize_with = "binary_path_from_wire"
    )]
    binary_path: BinaryPath,
}

fn binary_path_from_wire<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<BinaryPath, D::Error> {
    let trimmed = Trimmed::deserialize(deserializer)?;
    Ok(BinaryPath::or_fallback(trimmed.0, CODEX_BINARY))
}

/// Encode side: identity over the trimmed text, no fallback, and an absent key stays absent.
#[derive(Serialize)]
struct BinaryPathEnc {
    #[serde(rename = "binaryPath", skip_serializing_if = "Option::is_none")]
    binary_path: Option<BinaryPath>,
}

fn binary_path_encode(raw: &Value) -> Result<Value, ()> {
    let fields = raw.as_object().ok_or(())?;
    let binary_path = match fields.get("binaryPath") {
        None => None,
        Some(value) => Some(BinaryPath(value.as_str().ok_or(())?.to_owned())),
    };
    serde_json::to_value(BinaryPathEnc { binary_path }).map_err(|_| ())
}

fn codecs() -> BTreeMap<&'static str, (Codec, Codec)> {
    let mut map: BTreeMap<&'static str, (Codec, Codec)> = BTreeMap::new();
    map.insert(
        "TrimmedString",
        (|raw| round::<Trimmed>(raw), |raw| string_like(raw, Trimmed)),
    );
    map.insert(
        "TrimmedNonEmptyString",
        (
            |raw| round::<NonEmpty>(raw),
            |raw| string_like(raw, NonEmpty),
        ),
    );
    // A brand is erased at runtime, so `ThreadId` is `TrimmedNonEmptyString` on the wire.
    map.insert(
        "ThreadId",
        (
            |raw| round::<NonEmpty>(raw),
            |raw| string_like(raw, NonEmpty),
        ),
    );
    map.insert(
        "NonNegativeInt",
        (
            |raw| round::<NonNegativeInt>(raw),
            |raw| int_like(raw, |n| (n >= 0).then_some(NonNegativeInt(n))),
        ),
    );
    map.insert(
        "PositiveInt",
        (
            |raw| round::<PositiveInt>(raw),
            |raw| int_like(raw, |n| (n >= 1).then_some(PositiveInt(n))),
        ),
    );
    map.insert(
        "PortSchema",
        (
            |raw| round::<Port>(raw),
            |raw| int_like(raw, |n| u16::try_from(n).ok().filter(|p| *p >= 1).map(Port)),
        ),
    );
    map.insert(
        "plainOptional",
        (
            |raw| round::<PlainOptional>(raw),
            |raw| round::<PlainOptional>(raw),
        ),
    );
    map.insert(
        "optionalKey",
        (
            |raw| round::<PlainOptional>(raw),
            |raw| round::<PlainOptional>(raw),
        ),
    );
    map.insert(
        "forwardCompatibleOptional",
        (
            |raw| round::<ForwardCompatibleOptional>(raw),
            |raw| round::<ForwardCompatibleOptionalEnc>(raw),
        ),
    );
    map.insert(
        "forwardCompatibleNullable",
        (
            |raw| decode_as::<ForwardCompatibleNullable, _>(raw, |shape| present(&shape.v.0)),
            |raw| round::<ForwardCompatibleNullableEnc>(raw),
        ),
    );
    map.insert(
        "omittedWhenNull",
        (
            |raw| decode_as::<OmittedWhenNull, _>(raw, |shape| present(&shape.v.0)),
            |raw| round::<OmittedWhenNullEnc>(raw),
        ),
    );
    map.insert(
        "required",
        (|raw| round::<Required>(raw), |raw| round::<Required>(raw)),
    );
    map.insert(
        "forwardCompatibleArray",
        (
            |raw| round::<Lenient<Lit>>(raw),
            |raw| round::<Vec<Lit>>(raw),
        ),
    );
    map.insert(
        "taggedUnion",
        (|raw| round::<Tagged>(raw), |raw| round::<Tagged>(raw)),
    );
    map.insert(
        "maxLength",
        (
            |raw| round::<MaxLen>(raw),
            |raw| string_like(raw, MaxLen::wrap),
        ),
    );
    // `Checked<NonEmpty, …>` rather than a second combinator: the check measures whatever
    // text `NonEmpty` is holding, which is trimmed after a decode and raw before an
    // encode. That is the whole of the direction rule, and it is why `"   "` encodes to
    // `""` — three units passes the bound, then the trim empties it and nothing re-checks.
    map.insert(
        "trimmedMaxLength",
        (
            |raw| round::<TrimmedMaxLen>(raw),
            |raw| string_like(raw, |text| TrimmedMaxLen::wrap(NonEmpty(text))),
        ),
    );
    map.insert(
        "pattern",
        (
            |raw| round::<Patterned>(raw),
            |raw| string_like(raw, Patterned::wrap),
        ),
    );
    map.insert(
        "between",
        (
            |raw| round::<Bounded>(raw),
            |raw| number_like(raw, |number| Bounded::wrap(JsNumber(number))),
        ),
    );
    map.insert(
        "withDecodingDefault",
        (
            |raw| round::<DefaultedToFalse>(raw),
            |raw| round::<DefaultedEnc>(raw),
        ),
    );
    map.insert(
        "withDecodingDefaultKey",
        (
            |raw| round::<DefaultedToTrue>(raw),
            |raw| round::<DefaultedEnc>(raw),
        ),
    );
    map.insert(
        "option",
        (
            |raw| round::<EffectOption<JsNumber>>(raw),
            |raw| round::<EffectOption<JsNumber>>(raw),
        ),
    );
    // `OptionFromNullOr` has exactly one site in the contracts, so it gets no type of its
    // own: `Nullable` is the wire, `EffectOption` is the Type, and the codec is the
    // conversion between them.
    map.insert(
        "optionFromNullOr",
        (
            |raw| {
                decode_as::<Nullable<JsNumber>, _>(raw, |value| {
                    serde_json::to_value(EffectOption::from(value.0.clone()))
                        .expect("an EffectOption is serializable")
                })
            },
            |raw| {
                let typed: EffectOption<JsNumber> =
                    serde_json::from_value(raw.clone()).map_err(|_| ())?;
                serde_json::to_value(Nullable(typed.into_option())).map_err(|_| ())
            },
        ),
    );
    map.insert(
        "dateTimeUtcFromString",
        (
            |raw| {
                decode_as::<WireTimestamp, _>(
                    raw,
                    |shape| json!({ "at": { "epochMilliseconds": shape.at.epoch_milliseconds() } }),
                )
            },
            |raw| round::<TypeTimestamp>(raw),
        ),
    );
    map.insert(
        "record",
        (
            |raw| round::<BTreeMap<String, JsNumber>>(raw),
            |raw| round::<BTreeMap<String, JsNumber>>(raw),
        ),
    );
    // `Schema.Finite` gets `JsNumber` and no check of its own: nothing JSON can spell is
    // infinite, so there is no wire-visible difference to reproduce.
    map.insert(
        "finite",
        (
            |raw| round::<JsNumber>(raw),
            |raw| number_like(raw, JsNumber),
        ),
    );
    map.insert(
        "int",
        (
            |raw| round::<SafeInteger>(raw),
            |raw| number_like(raw, |number| SafeInteger::wrap(JsNumber(number))),
        ),
    );
    map.insert(
        "intGreaterThanZero",
        (
            |raw| round::<SafePositiveInteger>(raw),
            |raw| number_like(raw, |number| SafePositiveInteger::wrap(JsNumber(number))),
        ),
    );
    map.insert(
        "greaterThanZero",
        (
            |raw| round::<PositiveNumber>(raw),
            |raw| number_like(raw, |number| PositiveNumber::wrap(JsNumber(number))),
        ),
    );
    map.insert(
        "lessThanPort",
        (
            |raw| round::<BelowPortBound>(raw),
            |raw| number_like(raw, |number| BelowPortBound::wrap(JsNumber(number))),
        ),
    );
    map.insert(
        "minLength1",
        (
            |raw| round::<AtLeast1>(raw),
            |raw| string_like(raw, AtLeast1::wrap),
        ),
    );
    map.insert(
        "minLength2",
        (
            |raw| round::<AtLeast2>(raw),
            |raw| string_like(raw, AtLeast2::wrap),
        ),
    );
    map.insert(
        "nonEmptyString",
        (
            |raw| round::<EffectNonEmptyString>(raw),
            |raw| string_like(raw, EffectNonEmptyString::wrap),
        ),
    );
    map.insert(
        "minLengthArray",
        (
            |raw| round::<NonEmptyList>(raw),
            |raw| round::<NonEmptyList>(raw),
        ),
    );
    map.insert(
        "chainedChecks",
        (
            |raw| round::<BoundedList>(raw),
            |raw| round::<BoundedList>(raw),
        ),
    );
    // The encode side arrives as a `typedInput`: a `Duration` has no JSON spelling, so the
    // golden names the Encoded value and this round trip decodes it first. That is also
    // the whole of the finding — on the wire `DurationFromMillis` is `JsNumber`, and the
    // `Millis`/`Nanos` split never leaves the TypeScript process.
    map.insert(
        "durationFromMillis",
        (
            |raw| {
                decode_as::<DurationShape, _>(
                    raw,
                    |shape| json!({ "every": duration_repr(&shape.every) }),
                )
            },
            |raw| round::<DurationShape>(raw),
        ),
    );
    map.insert("templateLiteral", (acp_extension, acp_extension));
    map.insert("templateLiteralChecked", (script_run, script_run));
    map.insert(
        "suspendTree",
        (|raw| round::<Tree>(raw), |raw| round::<Tree>(raw)),
    );
    // Both directions are the same round trip. A decoded `Defect` re-encodes to exactly
    // what the golden records for the decode, because the golden renders a decoded
    // `Error` through `toWire` — `{name, message}` — which is the encoding.
    map.insert(
        "defect",
        (|raw| round::<Defect>(raw), |raw| round::<Defect>(raw)),
    );
    map.insert(
        "taggedStruct",
        (|raw| round::<Viewport>(raw), |raw| round::<Viewport>(raw)),
    );
    map.insert(
        "defectInTaggedStruct",
        (|raw| round::<Boom>(raw), |raw| round::<Boom>(raw)),
    );
    // The key is a schema, so it is `NonEmpty` and not `String`: `{" a ":50}` arrives with
    // a padded key and crosses back as `{"a":50}`. A `BTreeMap<String, _>` port would keep
    // the padding, which is the whole reason this subject exists separately from `record`.
    map.insert(
        "recordCheckedKey",
        (|raw| round::<Weights>(raw), weights_encode),
    );
    map.insert(
        "unknownSchema",
        (|raw| round::<Value>(raw), |raw| round::<Value>(raw)),
    );
    map.insert(
        "untaggedUnion",
        (
            |raw| round::<StringOrInt>(raw),
            |raw| round::<StringOrInt>(raw),
        ),
    );
    // `Schema.Void` is `Bottom<void, void>` and yet accepts **every** input, yielding
    // `undefined` — so all 14 of its cases are unportable, 2 for want of a JSON input and
    // 12 for want of a JSON output, and nothing is compared. What the `is_ok` assertion the
    // replay still makes on those 12 pins down is the half that matters for the RPC
    // `success:` field: a Rust side must not reject a payload here either. `Value` is that,
    // and it is deliberately not `()`, which would refuse everything.
    // `Schema.Never` rejects everything, `undefined` included — the one place it differs
    // from `Void`. `round` fails on the deserialize half, which is also the right answer
    // for the encode half: the Type side of `Never` has no inhabitant to encode either.
    map.insert(
        "neverSchema",
        (|raw| round::<Never>(raw), |raw| round::<Never>(raw)),
    );
    map.insert(
        "voidSchema",
        (|raw| round::<Value>(raw), |raw| round::<Value>(raw)),
    );
    // `SnapShotKeyChord` is the one subject where neither direction can share a shape: the
    // check gates *both* ways, but on different texts. `round` is the decode path — struct
    // first, then the modifier filter — and [`chord_encode`] the encode path, where the
    // length floor sees the untrimmed key.
    map.insert(
        "snapShotKeyChord",
        (
            |raw| round::<Checked<KeybindingShortcut, HasModifier>>(raw),
            chord_encode,
        ),
    );
    map.insert(
        "confirmQuitSetting",
        (|raw| round::<ConfirmQuitDec>(raw), confirm_quit_encode),
    );
    map.insert(
        "binaryPathSetting",
        (|raw| round::<BinaryPathDec>(raw), binary_path_encode),
    );
    map
}

type MaxLen = Checked<String, MaxLength<3>>;
type TrimmedMaxLen = Checked<NonEmpty, MaxLength<3>>;
type Patterned = Checked<String, Lowercase>;
type Bounded = Checked<JsNumber, Between<1, 3>>;

type SafeInteger = Checked<JsNumber, SafeInt>;
type SafePositiveInteger = Checked<JsNumber, (SafeInt, GreaterThan<0>)>;
type PositiveNumber = Checked<JsNumber, GreaterThan<0>>;
type BelowPortBound = Checked<JsNumber, LessThan<65_536>>;
type AtLeast1 = Checked<String, MinLength<1>>;
type AtLeast2 = Checked<String, MinLength<2>>;
type NonEmptyList = Checked<Vec<String>, MinLength<1>>;
type BoundedList = Checked<Vec<String>, (MinLength<1>, MaxLength<3>)>;

/// `Schema.NonEmptyString` is **not** the repo's `TrimmedNonEmptyString`, and the golden is
/// what shows it: `" "`, `"   "` and `"\u{feff}"` are all members, because the built-in is
/// `isMinLength(1)` with no transform and JavaScript's `trim` would have stripped the last
/// one to nothing. So it needs no type of its own — [`AtLeast1`] is it, untrimmed.
type EffectNonEmptyString = AtLeast1;

/// `SCRIPT_RUN_COMMAND_PATTERN`'s middle member:
/// `NonEmptyString.check(isMaxLength(8), isPattern(/^[a-z0-9][a-z0-9-]*$/))`. The nested
/// tuple is the three chained predicates; only a 2-tuple impl of [`Check`] exists, and
/// nesting is enough because a tuple of checks is itself a check.
type ScriptId = Checked<String, ((MinLength<1>, MaxLength<8>), ScriptIdPattern)>;

static SCRIPT_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^[a-z0-9][a-z0-9-]*$").expect("valid"));

struct ScriptIdPattern;

impl Check<String> for ScriptIdPattern {
    fn passes(value: &String) -> bool {
        SCRIPT_ID.is_match(value)
    }

    fn describe() -> String {
        "a script id".to_owned()
    }
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct DurationShape {
    every: DurationMillis,
}

/// `Schema.suspend`'s only visible property is that the recursion is unbounded, so the port
/// is a plain recursive struct — `Vec` already provides the indirection that lets `Tree`
/// name itself. `children` is required, not `#[serde(default)]`, because the golden rejects
/// `{name:"a"}`.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Tree {
    name: String,
    children: Vec<Tree>,
}

/// `Schema.TaggedStruct` needs no primitive of its own — it *is* serde's internally tagged
/// enum. What the golden adds is the proof that the four properties making it that rather
/// than an externally tagged one all hold: the tag's position in the input is irrelevant,
/// a member drops the keys it does not declare, an unknown member and a missing `detail`
/// both report `AnyOf` because it is the **union** doing the rejecting.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
enum Viewport {
    #[serde(rename = "fill")]
    Fill {
        detail: String,
    },
    Idle,
}

/// `Schema.TaggedError` crosses the wire identically, so the 150 sites using it collapse
/// into the same pattern. This one exists to pin down a composition rather than a shape: a
/// [`Defect`] field inside a tagged enum still rejects an absent key, and it reports
/// `Composite` — the struct objecting to the missing `cause`, not the union.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
enum Boom {
    Boom { cause: Defect },
}

/// `Schema.Record(TrimmedNonEmptyString, Int.check(isBetween(0, 100)))` — the shape of
/// `LoadBalancingWeights` (`settings.ts:314`), and the reason `Record` is a primitive of its
/// own rather than a `BTreeMap` field: the key is a schema, so `{" a ":50}` crosses back as
/// `{"a":50}`, and encoding a key that cannot be encoded drops only its own entry.
type Weights = Record<NonEmpty, Checked<JsNumber, (SafeInt, Between<0, 100>)>>;

/// `Schema.Union([String, Int])` — the untagged case, which `Viewport` does not cover.
/// `#[serde(untagged)]` tries the variants in order, so a bad member reports "did not match
/// any variant" where the golden reports `AnyOf`; the tag differs, the rejection does not.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
enum StringOrInt {
    Text(String),
    Number(Checked<JsNumber, SafeInt>),
}

/// The Type side of a `Duration`, rendered the way Effect's own `toJSON` renders it and
/// therefore the way the golden carries it.
///
/// `Duration.make` picks the `Millis` variant for an integer and `Nanos` for anything else,
/// and `roundMillisToNanos` is `roundTiesAwayFromZero(millis * 1e6)` — which `f64::round`
/// already is, since Rust rounds half away from zero too. The `nanos` field is a *string*
/// because Effect stringifies its `BigInt` there.
fn duration_repr(value: &DurationMillis) -> Value {
    let millis = value.millis();
    if millis.fract() == 0.0 {
        // The original literal rather than `millis`, because an `f64` renders `1000` as
        // `1000.0` where Effect writes the integer it was given.
        return json!({
            "_id": "Duration",
            "_tag": "Millis",
            "millis": Value::Number(value.0 .0.clone()),
        });
    }
    json!({
        "_id": "Duration",
        "_tag": "Nanos",
        "nanos": ((millis * 1_000_000.0).round() as i128).to_string(),
    })
}

/// A `Schema.TemplateLiteral` whose parts are two literal bounds and one captured member.
///
/// Spelled as a strip rather than as a regular expression because that is what an anchored
/// literal-bounded template reduces to, and it keeps the non-overlap requirement explicit:
/// both bounds have to fit side by side, which is what rejects `"acp.extension"` — a case a
/// naive prefix-then-suffix test would accept.
///
/// The captured slice is what the member schema validates, not the assembled string — the
/// golden pins that with a 16-character id against a bound of 8 — but the **result is the
/// whole string**, not the capture. A template literal is a string schema; its parts are
/// constraints on it, not a decomposition of it.
fn templated<T: Serialize>(
    raw: &Value,
    prefix: &str,
    suffix: &str,
    wrap: impl FnOnce(String) -> T,
) -> Result<Value, ()> {
    let text = raw.as_str().ok_or(())?;
    if !text.starts_with(prefix)
        || !text.ends_with(suffix)
        || text.len() < prefix.len() + suffix.len()
    {
        return Err(());
    }
    let middle = &text[prefix.len()..text.len() - suffix.len()];
    // Serializing is what runs the member's checks, so the value is built and then
    // discarded; the string that crosses the wire is the one that arrived.
    serde_json::to_value(wrap(middle.to_owned())).map_err(|_| ())?;
    Ok(Value::String(text.to_owned()))
}

fn acp_extension(raw: &Value) -> Result<Value, ()> {
    templated(raw, "acp.", ".extension", |middle| middle)
}

fn script_run(raw: &Value) -> Result<Value, ()> {
    templated(raw, "script.", ".run", ScriptId::wrap)
}

/// Golden subjects that have **no** Rust input, because their Encoded side is not a JSON
/// value. Named rather than silently skipped, so the gap is a list a reader can check
/// against the plan, and so a subject moving out of it is visible in a diff.
///
/// `dateTimeUtcBare` is `Schema.DateTimeUtc` used without `FromString`: DateTime↔DateTime,
/// so no JSON can satisfy it and every decode throws. It is recorded rather than dropped
/// because 42 sites spell it this way, and how any of them gets a value off the wire is
/// an open question for the protocol runtime, not something a codec can answer.
const NO_JSON_FORM: &[&str] = &["dateTimeUtcBare"];

/// Which side of a golden case JSON cannot express. `$undefined` marks a position that
/// held TypeScript's `undefined`, and it can appear on either side — easy to miss, since
/// `forwardCompatibleOptional` decodes the perfectly ordinary `{v:null}` and yields
/// `{v:undefined}`.
enum Unportable {
    /// Nothing to do: both sides are ordinary JSON.
    No,
    /// There is no Rust input to feed, so the case cannot run at all.
    Input,
    /// The input runs, but the result cannot be compared.
    Output,
}

fn unportable_side(case: &Map<String, Value>) -> Unportable {
    if case.contains_key("undefinedInput") || case.get("input").is_some_and(holds_undefined) {
        return Unportable::Input;
    }
    if case.get("ok").is_some_and(holds_undefined) {
        return Unportable::Output;
    }
    Unportable::No
}

fn holds_undefined(value: &Value) -> bool {
    match value {
        Value::Object(object) => {
            object.contains_key("$undefined") || object.values().any(holds_undefined)
        }
        Value::Array(items) => items.iter().any(holds_undefined),
        _ => false,
    }
}

/// `SnapShotKeyChord` as the port spells it: a filter over a struct whose field is itself a
/// checked transform.
type Chord = Checked<KeybindingShortcut, HasModifier>;

fn chord(key: &str, [meta, ctrl, shift, alt, modifier]: [bool; 5]) -> Value {
    json!({
        "key": key,
        "metaKey": meta,
        "ctrlKey": ctrl,
        "shiftKey": shift,
        "altKey": alt,
        "modKey": modifier,
    })
}

/// The claims this slice is about, asserted in Rust so they hold without a golden to replay.
#[test]
fn the_settings_constructs_are_ported_as_layered_ones() {
    // 1. `makeFilter`'s disjunction: each of the five operands carries the pass **alone**,
    // and none of them present is a rejection — the trailing string in the `||` chain is a
    // failure message, not a truthy value that lets the filter pass.
    for index in 0..5 {
        let mut flags = [false; 5];
        flags[index] = true;
        assert!(
            serde_json::from_value::<Chord>(chord("s", flags)).is_ok(),
            "modifier {index} alone should satisfy the chord rule"
        );
    }
    assert!(serde_json::from_value::<Chord>(chord("s", [false; 5])).is_err());
    // `.check` gates the way out too, so the very same value cannot be written.
    assert!(chord_encode(&chord("s", [false; 5])).is_err());

    // 2. A field the struct itself rejects fails even when the chord rule is satisfied, so
    // the two layers cannot be conflated into one predicate.
    assert!(
        serde_json::from_value::<Chord>(chord("", [true, false, false, false, false])).is_err()
    );
    assert!(chord_encode(&chord("", [true, false, false, false, false])).is_err());

    // 3. `isMinLength` measures the **trimmed** text arriving and the **raw** one leaving.
    // A port that read the key into a `String` and trimmed on the way in only would accept
    // what the last line writes here.
    assert!(
        serde_json::from_value::<Chord>(chord("    ", [true, false, false, false, false])).is_err()
    );
    assert_eq!(
        chord_encode(&chord("    ", [true, false, false, false, false]))
            .expect("four units clear the floor"),
        chord("", [true, false, false, false, false]),
    );

    // 4. `withDecodingDefault` is the property a `unwrap_or(default)` port gets wrong: the
    // default stands in for an **absent key** and nothing else, so corrupt settings still
    // fail instead of quietly becoming the default.
    assert_eq!(
        round::<ConfirmQuitDec>(&json!({})).expect("absent decodes to the default"),
        json!({ "confirmQuit": "hold" }),
    );
    assert!(serde_json::from_value::<ConfirmQuitDec>(json!({ "confirmQuit": "x" })).is_err());

    // 5. The legacy boolean is decode-only, and the canonical union member answers first in
    // both directions — which is what keeps `LegacyConfirmQuit`'s lossy encode (`"hold"` is
    // the only mode it can write) off the wire entirely.
    for (legacy, canonical) in [(true, "hold"), (false, "direct")] {
        assert_eq!(
            round::<ConfirmQuitDec>(&json!({ "confirmQuit": legacy }))
                .expect("the legacy form decodes"),
            json!({ "confirmQuit": canonical }),
        );
        assert!(confirm_quit_encode(&json!({ "confirmQuit": legacy })).is_err());
    }
    assert_eq!(
        confirm_quit_encode(&json!({ "confirmQuit": "double-click" }))
            .expect("a mode the legacy member could not write"),
        json!({ "confirmQuit": "double-click" }),
    );

    // 6. `binaryPath` is the same default rule with a second asymmetry: `""` arrives as the
    // fallback and leaves as `""`, so the decode is not reversible and the encode is not
    // the decode backwards.
    assert_eq!(
        round::<BinaryPathDec>(&json!({ "binaryPath": "" })).expect("empty becomes the fallback"),
        json!({ "binaryPath": CODEX_BINARY }),
    );
    assert_eq!(
        binary_path_encode(&json!({ "binaryPath": "" })).expect("the Type side keeps its empty"),
        json!({ "binaryPath": "" }),
    );
    assert!(serde_json::from_value::<BinaryPathDec>(json!({ "binaryPath": 0 })).is_err());
    assert_eq!(
        binary_path_encode(&json!({})).expect("absent is a legal Type value"),
        json!({}),
    );
}

#[test]
fn replays_the_golden_codec_behaviour() {
    let Some(path) = env::var_os("LMCS_CONTRACTS_GOLDEN").map(PathBuf::from) else {
        eprintln!(
            "LMCS_CONTRACTS_GOLDEN unset; skipping. Generate with:\n  \
             node apps/server/scripts/contracts-golden.ts > /tmp/contracts-golden.json"
        );
        return;
    };
    let golden: Value = serde_json::from_str(&fs::read_to_string(&path).expect("golden readable"))
        .expect("golden is JSON");
    let cases = golden["codecs"].as_array().expect("codecs array");
    let table = codecs();

    let mut replayed = 0usize;
    let mut typed = 0usize;
    let mut skipped = 0usize;
    let mut incomparable = 0usize;
    let mut unrepresentable = 0usize;
    let mut subjects = std::collections::BTreeSet::new();
    for case in cases {
        let case = case.as_object().expect("case object");
        let name = case["case"].as_str().expect("case name");
        let (subject, op) = name.rsplit_once('.').expect("name.op");
        subjects.insert(subject);

        let Some((decode, encode)) = table.get(subject) else {
            assert!(
                NO_JSON_FORM.contains(&subject),
                "{name} has no Rust codec and is not listed in NO_JSON_FORM"
            );
            unrepresentable += 1;
            continue;
        };
        let run = if op == "decode" { *decode } else { *encode };

        match unportable_side(case) {
            Unportable::Input => {
                skipped += 1;
                continue;
            }
            Unportable::Output => {
                // The value cannot be compared, but that it decoded at all is the whole
                // point of a forward-compatible field: `{v:"z"}` is a member this build
                // does not know, and it must not take the enclosing struct down with it.
                incomparable += 1;
                assert!(
                    run(&case["input"]).is_ok(),
                    "{name} should have decoded to an absent value"
                );
                continue;
            }
            Unportable::No => {}
        }
        replayed += 1;

        // A `typedInput` case names the **Encoded** JSON because the Type-side value has no
        // JSON spelling at all, so the subject's encode codec is the round trip that decodes
        // it first. `durationFromMillis` is the only such subject today.
        let input = match case.get("typedInput") {
            Some(encoded) => {
                typed += 1;
                encoded
            }
            None => &case["input"],
        };
        let actual = run(input);
        match case.get("ok") {
            Some(expected) => assert_eq!(
                actual,
                Ok(expected.clone()),
                "{name} on {input} should have succeeded"
            ),
            None => {
                let tag = case["error"].as_str().expect("error tag");
                assert!(
                    actual.is_err(),
                    "{name} on {input} should have thrown [{tag}]"
                );
            }
        }
    }

    // Guards against the generator quietly shrinking and against this list going stale:
    // every golden subject is either ported or named as unrepresentable, and nothing is
    // named as unrepresentable that the golden no longer produces.
    let stale: Vec<_> = NO_JSON_FORM
        .iter()
        .filter(|subject| !subjects.contains(**subject))
        .collect();
    assert!(
        stale.is_empty(),
        "NO_JSON_FORM lists absent subjects: {stale:?}"
    );
    assert_eq!(
        table.len() + NO_JSON_FORM.len(),
        subjects.len(),
        "golden subjects and the Rust tables disagree"
    );
    assert_eq!(table.len(), 49, "ported subject count changed");
    assert_eq!(
        unrepresentable, 2,
        "dateTimeUtcBare was supposed to be the only subject with no JSON form"
    );
    assert_eq!(
        skipped, 26,
        "6 scalars take `undefined` outright and 20 shape cases take `{{v: undefined}}` — \
         or, for Void/Unknown/Union/Never, `undefined` itself"
    );
    assert_eq!(
        incomparable, 14,
        "the two forwardCompatibleOptional decodes that yield `{{v: undefined}}`, and the 12 \
         voidSchema cases that yield bare `undefined`"
    );
    assert_eq!(
        typed, 22,
        "5 durationFromMillis encodes whose Type side is a `Duration`, and the 14 defect \
         encodes whose Type side is an `Error` — neither has a JSON spelling"
    );
    assert!(replayed >= 755, "only replayed {replayed} cases");
}
