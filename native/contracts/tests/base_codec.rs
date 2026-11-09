//! Replays `apps/server/scripts/contracts-golden.ts` against the ported codec
//! primitives.
//!
//! The golden records what the **shipped** TypeScript codec does, including the
//! asymmetries, so this test fails when the port drifts rather than when the port
//! disagrees with an opinion about what the schema should have meant.
//!
//! `LMCS_CONTRACTS_GOLDEN=/tmp/contracts-golden.json cargo test`

use lmcs_contracts::base::{
    Absent, Between, Check, Checked, DateTimeUtc, DurationMillis, EffectOption, GreaterThan,
    JsNumber, Lenient, LessThan, MaxLength, Maybe, MinLength, NonEmpty, NonNegativeInt, Nullable,
    Port, PositiveInt, SafeInt, Trimmed,
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
    assert_eq!(table.len(), 38, "ported subject count changed");
    assert_eq!(
        unrepresentable, 2,
        "dateTimeUtcBare was supposed to be the only subject with no JSON form"
    );
    assert_eq!(
        skipped, 18,
        "6 scalars take `undefined` outright and 12 shape cases take `{{v: undefined}}`"
    );
    assert_eq!(
        incomparable, 2,
        "the two forwardCompatibleOptional decodes that yield `{{v: undefined}}`"
    );
    assert_eq!(
        typed, 5,
        "the durationFromMillis encodes, whose Type side is a `Duration` and so has no JSON spelling"
    );
    assert!(replayed >= 550, "only replayed {replayed} cases");
}
