//! Replays `apps/server/scripts/contracts-golden.ts` against the ported codec
//! primitives.
//!
//! The golden records what the **shipped** TypeScript codec does, including the
//! asymmetries, so this test fails when the port drifts rather than when the port
//! disagrees with an opinion about what the schema should have meant.
//!
//! `LMCS_CONTRACTS_GOLDEN=/tmp/contracts-golden.json cargo test`

use lmcs_contracts::base::{
    Absent, AtLeast, AtMost, Between, Bytes, Check, Checked, DateTimeUtc, Defect, DurationMillis,
    EffectOption, FiniteFromString, GreaterThan, JsNumber, Lenient, LenientKeys, LessThan,
    MaxLength, MaxProperties, Maybe, MinLength, Never, NoEdgeWhitespace, NonEmpty, NonNegativeInt,
    Nullable, Port, PositiveInt, Record, SafeInt, StrictKeys, Trimmed,
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

/// `JSON.stringify` writes an integral number with no fraction, and `serde_json::Number`
/// keeps `1` and `1.0` apart — so a decoded number is rendered the way the golden carries
/// it rather than the way `from_f64` happened to store it. JavaScript has one number type
/// and no such distinction to reproduce; the wire form is unaffected either way, because
/// `FiniteFromString` serializes through `String(n)`.
fn json_number(value: &JsNumber) -> Value {
    let number = value.0.as_f64().unwrap_or(f64::NAN);
    if number.fract() == 0.0 && number >= i64::MIN as f64 && number <= u64::MAX as f64 {
        return if number < 0.0 {
            json!(number as i64)
        } else {
            json!(number as u64)
        };
    }
    Value::Number(value.0.clone())
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
    serde_json::to_value(Weights::new(built)).map_err(|_| ())
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

// ---------------------------------------------------------------------------
// Fatia 3c — the last four predicates, and what a `Record` key's failure costs
// ---------------------------------------------------------------------------

/// `TerminalColsSchema` (`terminal.ts:13`): `Int.check(isGreaterThanOrEqualTo(1))` and then
/// `.check(isLessThanOrEqualTo(1000))`. Two `.check` calls in a row are two filters on one
/// schema, which the tuple instance of [`Check`] already models — the interesting part is
/// that both bounds are **inclusive**, so 1 and 1000 pass and 0 and 1001 do not. Getting
/// that backwards by one unit is the failure mode these 40 sites exist to catch.
///
/// `Schema.Int` and both filters are predicate-only, so Encoded and Type are the same
/// `number` and one shape serves both directions: this subject is the rare case where the
/// encode is exactly the decode backwards.
#[derive(Deserialize, Serialize)]
struct TerminalResizeCols {
    cols: Checked<JsNumber, (SafeInt, (AtLeast<1>, AtMost<1000>))>,
}

/// `assistantCitations.ts:24`'s `start` — `NonNegativeInt.check(isLessThanOrEqualTo(
/// Number.MAX_SAFE_INTEGER))`. The bound is **dead**: `Schema.Int` is
/// `Number.isSafeInteger`, so nothing above it can be an integer, and the value that would
/// test it (`9007199254740992`) is refused by the integer filter instead. Ported anyway,
/// because the census says 26 and 14 sites and a reader should be able to find all of them.
#[derive(Deserialize, Serialize)]
struct AssistantCitationStart {
    start: Checked<JsNumber, (SafeInt, (AtLeast<0>, AtMost<9_007_199_254_740_991>))>,
}

/// `DesktopPreviewTabIdSchema` (`ipc.ts:655`) — `String.check(isTrimmed()).check(isNonEmpty())`
/// on a **bare** string, so this is the rejection and not the trim: `" a "` fails here where
/// the same bytes cross the wire as `"a"` under `TrimmedString`. `isNonEmpty` over an
/// untransformed string is `MinLength<1>` measured in UTF-16 units, which is why no new
/// predicate is needed for it.
type TabId = Checked<String, (NoEdgeWhitespace, MinLength<1>)>;

/// `TerminalEnvSchema` (`terminal.ts:21-25`), reached through `TerminalOpenInput.env`. The
/// key is `String.check(isPattern(…)).check(isMaxLength(128))` — predicates over `string` and
/// no `decodeTo` — which is the shape whose failures **drop the entry** instead of failing
/// the record.
static ENV_KEY_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").expect("valid"));

struct EnvKeyPattern;

impl Check<String> for EnvKeyPattern {
    fn passes(value: &String) -> bool {
        ENV_KEY_PATTERN.is_match(value)
    }

    fn describe() -> String {
        "a shell variable name".to_owned()
    }
}

type EnvKey = Checked<String, (EnvKeyPattern, MaxLength<128>)>;
type EnvValue = Checked<String, MaxLength<8_192>>;
type Env = Checked<Record<EnvKey, EnvValue, LenientKeys>, MaxProperties<128>>;

#[derive(Deserialize, Serialize)]
struct TerminalOpenEnv {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    env: Absent<Env>,
}

/// The encode side builds every key **unchecked**, because that is where TypeScript puts
/// its checks: on the way out. `Checked::wrap` is what makes an over-long or badly-shaped
/// key representable at all, and `Record`'s `Serialize` then drops exactly those entries —
/// after `MaxProperties` has counted them, which is the asymmetry the golden shows.
fn env_encode(raw: &Value) -> Result<Value, ()> {
    let fields = raw.as_object().ok_or(())?;
    let env: Absent<Env> = match fields.get("env") {
        None => Absent(None),
        // `Schema.optional` refuses an explicit `null`, so this is a failure and not an
        // absence — `Absent` is the only field type that gets that distinction.
        Some(Value::Null) => return Err(()),
        Some(entry) => {
            let entries = entry.as_object().ok_or(())?;
            let mut built: BTreeMap<EnvKey, EnvValue> = BTreeMap::new();
            for (key, value) in entries {
                built.insert(
                    Checked::wrap(key.clone()),
                    Checked::wrap(value.as_str().ok_or(())?.to_owned()),
                );
            }
            Absent(Some(Checked::wrap(Record::new(built))))
        }
    };
    serde_json::to_value(TerminalOpenEnv { env }).map_err(|_| ())
}

/// `EnvironmentThemeColors` (`server.ts:514`), the other `LenientKeys` record. Its key is a
/// pattern **only** — the 64-character cap is inside the pattern, not an `isMaxLength` — and
/// it has no `isMaxProperties`, so the drop rule stands here on its own. Its values are the
/// trimming transform, which is what makes the encode side interesting: `"   "` is a decode
/// failure and encodes to `""`.
static THEME_KEY_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z][a-zA-Z0-9]{0,63}$").expect("valid"));

struct ThemeKeyPattern;

impl Check<String> for ThemeKeyPattern {
    fn passes(value: &String) -> bool {
        THEME_KEY_PATTERN.is_match(value)
    }

    fn describe() -> String {
        "a CSS custom-property-style role name".to_owned()
    }
}

type ThemeKey = Checked<String, ThemeKeyPattern>;
type ThemeRole = Checked<NonEmpty, MaxLength<64>>;
type ThemeColors = Record<ThemeKey, ThemeRole, LenientKeys>;

#[derive(Deserialize, Serialize)]
struct ThemeFileColors {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    colors: Absent<ThemeColors>,
}

fn theme_colors_encode(raw: &Value) -> Result<Value, ()> {
    let fields = raw.as_object().ok_or(())?;
    let colors: Absent<ThemeColors> = match fields.get("colors") {
        None => Absent(None),
        Some(Value::Null) => return Err(()),
        Some(entry) => {
            let entries = entry.as_object().ok_or(())?;
            let mut built: BTreeMap<ThemeKey, ThemeRole> = BTreeMap::new();
            for (key, value) in entries {
                built.insert(
                    Checked::wrap(key.clone()),
                    Checked::wrap(NonEmpty(value.as_str().ok_or(())?.to_owned())),
                );
            }
            Absent(Some(Record::new(built)))
        }
    };
    serde_json::to_value(ThemeFileColors { colors }).map_err(|_| ())
}

/// `ProviderAuthResponse`'s credentials branch (`providerSetup.ts:76-81`) — the `StrictKeys`
/// counterpart of [`Env`], and the case that makes the key rule a rule instead of a
/// coincidence. `SetupOperationId` is `TrimmedNonEmptyString.check(isMaxLength(128))`, so the
/// key is *parsed* rather than *tested*: on the way **in**, `{"  ": "tok"}` trims to `""`,
/// fails `isNonEmpty` inside the key parse, and takes the whole record down with it —
/// measured as `AnyOf`, because the union cannot name which member failed.
///
/// On the way **out** it does not, which is the difference between a key that is parsed and a
/// value that is tested: `encodeSync` runs the trim and never re-runs the assertion, so the
/// same input writes `{"": "tok"}`. That makes this the second subject needing a real encode
/// builder rather than [`round`], for the same reason [`weights_encode`] does.
///
/// Same `isMaxProperties` as `env`, and it counts the same way, but nothing is ever dropped
/// first, so there is no ordering to get wrong.
type SetupKeyId = Checked<NonEmpty, MaxLength<128>>;
type SetupToken = Checked<String, MaxLength<16_384>>;
type SetupValues = Checked<Record<SetupKeyId, SetupToken, StrictKeys>, MaxProperties<16>>;

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum CredentialsTag {
    Credentials,
}

#[derive(Debug, PartialEq, Deserialize, Serialize)]
struct AuthCredentials {
    #[serde(rename = "type")]
    kind: CredentialsTag,
    values: SetupValues,
}

fn auth_credentials_encode(raw: &Value) -> Result<Value, ()> {
    let fields = raw.as_object().ok_or(())?;
    let kind: CredentialsTag =
        serde_json::from_value(fields.get("type").cloned().ok_or(())?).map_err(|_| ())?;
    let entries = fields.get("values").and_then(Value::as_object).ok_or(())?;
    let mut built: BTreeMap<SetupKeyId, SetupToken> = BTreeMap::new();
    for (key, value) in entries {
        built.insert(
            Checked::wrap(NonEmpty(key.clone())),
            Checked::wrap(value.as_str().ok_or(())?.to_owned()),
        );
    }
    serde_json::to_value(AuthCredentials {
        kind,
        values: Checked::wrap(Record::new(built)),
    })
    .map_err(|_| ())
}

/// `PullRequestListCursors` (`pullRequest.ts:547`) — the third transform-keyed record, and
/// the one that adds a bound on the **value**. Its cursor is opaque ("only the provider that
/// issued one knows what it means"), so the whole field is four things the port cannot infer
/// and only the shipped codec can say:
///
/// - decode measures the bound **after** the trim, encode **before** it. Four spaces over a
///   full-length cursor is a valid cursor on the way in and a rejected one on the way out,
///   with the same text in hand either time.
/// - the key has no bound at all, so that same 4100-character string is fine as a key.
/// - an empty key on the way out costs **its entry** and nothing else, while a whitespace key
///   survives and is written empty — see [`Record`].
/// - a bad value on the way out takes the record down instead.
type CursorsValue = Checked<NonEmpty, MaxLength<4_096>>;
type Cursors = Record<NonEmpty, CursorsValue>;

fn pull_request_cursors_encode(raw: &Value) -> Result<Value, ()> {
    let fields = raw.as_object().ok_or(())?;
    let mut built: BTreeMap<NonEmpty, CursorsValue> = BTreeMap::new();
    for (key, value) in fields {
        built.insert(
            NonEmpty(key.clone()),
            Checked::wrap(NonEmpty(value.as_str().ok_or(())?.to_owned())),
        );
    }
    serde_json::to_value(Cursors::new(built)).map_err(|_| ())
}

/// `ContextMenuItemSchema` (`ipc.ts:69`) — the shape the desktop's right-click menu crosses
/// in, and the only recursive schema `ipc.ts` declares: `children` is
/// `optionalKey(Array(suspend(…)))`. The annotation `Schema.Codec<ContextMenuItemSchemaType>`
/// is erased at runtime (`.ast._tag` is `Objects`, like the struct under it), so nothing about
/// it is a codec construct; what is, is that a nested failure is reported at
/// `["children"][0]["children"][0]["label"]` — a path, at any depth — and that a `Vec` port
/// either reproduces or flattens.
#[derive(Debug, PartialEq, Deserialize, Serialize)]
struct ContextMenuItem {
    id: String,
    label: String,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    destructive: Absent<bool>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    disabled: Absent<bool>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    header: Absent<bool>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    icon: Absent<String>,
    #[serde(
        rename = "separatorBefore",
        default,
        skip_serializing_if = "Absent::is_none"
    )]
    separator_before: Absent<bool>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    checked: Absent<bool>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    children: Absent<Vec<ContextMenuItem>>,
}

/// `DesktopPreviewRecordingSaveInputSchema` (`ipc.ts:1090`) — the field that made this fatia a
/// measurement rather than a guess. `tabId` and `mimeType` are both
/// `String.check(isTrimmed()).check(isNonEmpty())`, already ported as [`TabId`], and neither is
/// what the subject exists for. `data` is the repo's only `Schema.Uint8Array`, which has no
/// JSON spelling: the two golden cases that carry a real byte sequence are classified as
/// unrunnable, and the seven that carry an *attempted* one — array, base64, `null`, the object
/// `JSON.stringify` writes — are the whole of what a JSON-seeing codec can claim about it.
type RecordingSaveMimeType = TabId;

#[derive(Debug, PartialEq, Deserialize, Serialize)]
struct RecordingSave {
    #[serde(rename = "tabId")]
    tab_id: TabId,
    #[serde(rename = "mimeType")]
    mime_type: RecordingSaveMimeType,
    data: Bytes,
}

/// `Schema.optional(Schema.Literal("true"))` — a one-member literal is the same serde enum
/// pattern [`Lit`] uses, with one variant instead of two.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ReasoningTrue {
    True,
}

/// The `turnLimit` query field of the windowed thread snapshot (`environmentHttp.ts:514`),
/// the repo's only `Schema.FiniteFromString` site. Both predicates run on **encode** too,
/// so the field is `Checked` over the decoded number rather than over the text — which is
/// also why `{turnLimit: 0}` is refused on the way out.
type TurnLimit = Checked<FiniteFromString, (SafeInt, AtLeast<1>)>;

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct TurnLimitQuery {
    #[serde(
        rename = "reasoningMessages",
        default,
        skip_serializing_if = "Absent::is_none"
    )]
    reasoning_messages: Absent<ReasoningTrue>,
    #[serde(rename = "turnLimit", default, skip_serializing_if = "Absent::is_none")]
    turn_limit: Absent<TurnLimit>,
    #[serde(
        rename = "beforeCursor",
        default,
        skip_serializing_if = "Absent::is_none"
    )]
    before_cursor: Absent<NonEmpty>,
}

/// The Type side of the query, which is not what re-serializing it writes: `turnLimit`
/// decodes to a *number* and the codec would write the string back.
fn turn_limit_type(query: &TurnLimitQuery) -> Value {
    let mut fields = Map::new();
    if let Some(flag) = &query.reasoning_messages.0 {
        fields.insert("reasoningMessages".to_owned(), json!(flag));
    }
    if let Some(limit) = &query.turn_limit.0 {
        fields.insert("turnLimit".to_owned(), json_number(&limit.0.0));
    }
    if let Some(cursor) = &query.before_cursor.0 {
        fields.insert("beforeCursor".to_owned(), json!(cursor.0));
    }
    Value::Object(fields)
}

/// The encode side, built by hand for the same reason [`pull_request_cursors_encode`] is:
/// `round` decodes first, and the decoder only accepts a string where the Type side holds
/// a number. `turnLimit` is therefore wrapped unchecked so the two predicates land on the
/// way out, and `beforeCursor` keeps its padding for the same reason.
fn turn_limit_encode(raw: &Value) -> Result<Value, ()> {
    let fields = raw.as_object().ok_or(())?;
    let mut query = TurnLimitQuery {
        reasoning_messages: Absent(None),
        turn_limit: Absent(None),
        before_cursor: Absent(None),
    };
    for (key, value) in fields {
        match key.as_str() {
            "reasoningMessages" => {
                query.reasoning_messages =
                    Absent(Some(serde_json::from_value(value.clone()).map_err(|_| ())?));
            }
            "turnLimit" => {
                let Value::Number(number) = value else {
                    return Err(());
                };
                query.turn_limit = Absent(Some(Checked::wrap(FiniteFromString(JsNumber(
                    number.clone(),
                )))));
            }
            "beforeCursor" => {
                query.before_cursor = Absent(Some(NonEmpty(value.as_str().ok_or(())?.to_owned())));
            }
            _ => {}
        }
    }
    serde_json::to_value(query).map_err(|_| ())
}

/// `Schema.withConstructorDefault` (`providerRuntime.ts:489`) and the plain
/// `Schema.optional(Schema.Boolean)` it is stacked on are the *same* Rust field: the
/// constructor default fills `.make({})` in and never reaches the wire. The golden records
/// both schemas under one subject name, so a wire effect would show up as a disagreement.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct ConstructorDefault {
    #[serde(
        rename = "multiSelect",
        default,
        skip_serializing_if = "Absent::is_none"
    )]
    multi_select: Absent<bool>,
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
    // The two inclusive integer bounds, and the predicate-only schema where encode really is
    // the decode backwards.
    map.insert(
        "terminalCols",
        (
            |raw| round::<TerminalResizeCols>(raw),
            |raw| round::<TerminalResizeCols>(raw),
        ),
    );
    map.insert(
        "citationStart",
        (
            |raw| round::<AssistantCitationStart>(raw),
            |raw| round::<AssistantCitationStart>(raw),
        ),
    );
    // `isTrimmed` on a bare string — the rejection, not the trim. Both directions take the
    // string as it stands, so one shape serves them.
    map.insert(
        "tabIdTrimmed",
        (
            |raw| round::<TabId>(raw),
            |raw| string_like(raw, TabId::wrap),
        ),
    );
    // The two records whose keys are predicates only: a bad key costs an entry, not the
    // payload. `themeColors` has no `isMaxProperties`, so it isolates the drop rule.
    map.insert(
        "terminalEnv",
        (|raw| round::<TerminalOpenEnv>(raw), env_encode),
    );
    map.insert(
        "themeColors",
        (|raw| round::<ThemeFileColors>(raw), theme_colors_encode),
    );
    // The counterpart: a key with a `decodeTo` in it, so the same bad-shaped key takes the
    // whole record down on the way in — and writes an empty key on the way out, which is
    // what [`auth_credentials_encode`] is for.
    map.insert(
        "authCredentials",
        (|raw| round::<AuthCredentials>(raw), auth_credentials_encode),
    );
    // The third transform-keyed record, reaching the two facts the first two could not: a
    // bound on the value that sits on the *other* side of the trim, and an empty key that
    // drops rather than rewrites.
    map.insert(
        "pullRequestCursors",
        (|raw| round::<Cursors>(raw), pull_request_cursors_encode),
    );
    // Recursion and `Schema.Codec<T>`: identity in both directions, so no builder — which is
    // the point of the second entry, not a shortcut.
    map.insert(
        "contextMenu",
        (
            |raw| round::<ContextMenuItem>(raw),
            |raw| round::<ContextMenuItem>(raw),
        ),
    );
    // The byte field. Both entries are `round`, and both can only ever be reached by an input
    // whose `data` is something JSON *can* spell — which is exactly what the golden has them
    // be.
    map.insert(
        "recordingSave",
        (
            |raw| round::<RecordingSave>(raw),
            |raw| round::<RecordingSave>(raw),
        ),
    );
    // The Type side is a number and the Encoded side a string, so neither direction is a
    // round trip: decode renders the number it decoded, encode builds from a JSON number
    // and writes the string. `number_like` is what refuses a string on the way out.
    map.insert(
        "finiteFromString",
        (
            |raw| decode_as::<FiniteFromString, _>(raw, |value| json_number(&value.0)),
            |raw| number_like(raw, |number| FiniteFromString(JsNumber(number))),
        ),
    );
    map.insert(
        "turnLimit",
        (
            |raw| decode_as::<TurnLimitQuery, _>(raw, turn_limit_type),
            turn_limit_encode,
        ),
    );
    map.insert(
        "constructorDefault",
        (
            |raw| round::<ConstructorDefault>(raw),
            |raw| round::<ConstructorDefault>(raw),
        ),
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
    if case.contains_key("undefinedInput")
        || case
            .get("input")
            .is_some_and(|input| holds_undefined(input) || holds_bytes(input))
    {
        return Unportable::Input;
    }
    if case.get("ok").is_some_and(holds_undefined) {
        return Unportable::Output;
    }
    Unportable::No
}

/// `$bytes` marks a position that held a byte sequence. Only the input side is tested, and
/// only once: `Schema.Uint8Array`'s Encoded side *is* the bytes, so no JSON input can decode
/// to a value that would put `$bytes` on the `ok` side without putting it on the input side
/// first. An `ok`-only check would be a branch nothing can reach.
fn holds_bytes(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.contains_key("$bytes") || object.values().any(holds_bytes),
        Value::Array(items) => items.iter().any(holds_bytes),
        _ => false,
    }
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

/// The four predicates this fatia adds, and the `Record` key rule it corrects 2.7 with —
/// asserted in-crate, so the finding survives without the golden.
#[test]
fn the_last_predicates_and_the_key_rule_hold_their_measured_shape() {
    // 1. `isGreaterThanOrEqualTo`/`isLessThanOrEqualTo` are **inclusive**, so the pair
    // brackets its endpoints. Reading them as the exclusive `GreaterThan`/`LessThan` next to
    // them shifts both bounds by one and still passes every ordinary terminal size.
    for good in [1, 500, 1000] {
        assert_eq!(
            round::<TerminalResizeCols>(&json!({ "cols": good })).expect("inside the bracket"),
            json!({ "cols": good }),
        );
    }
    for bad in [0, 1001] {
        assert!(
            serde_json::from_value::<TerminalResizeCols>(json!({ "cols": bad })).is_err(),
            "{bad} is outside the bracket"
        );
    }
    assert!(round::<TerminalResizeCols>(&json!({ "cols": 1.5 })).is_err());
    assert!(
        round::<TerminalResizeCols>(&json!({})).is_err(),
        "required both ways"
    );

    // 2. The `Number.MAX_SAFE_INTEGER` upper bound on `NonNegativeInt` is **dead** and the
    // measurement shows why: the integer filter is `Number.isSafeInteger`, so the first value
    // the bound would catch is already not an integer. Ported for the census, unreachable on
    // the wire.
    assert_eq!(
        round::<AssistantCitationStart>(&json!({ "start": 0 })).expect("inclusive at the floor"),
        json!({ "start": 0 }),
    );
    assert!(serde_json::from_value::<AssistantCitationStart>(json!({ "start": -1 })).is_err());
    assert_eq!(
        round::<AssistantCitationStart>(&json!({ "start": 9_007_199_254_740_991i64 }))
            .expect("the largest safe integer, which is the bound itself"),
        json!({ "start": 9_007_199_254_740_991i64 }),
    );
    assert!(
        serde_json::from_value::<AssistantCitationStart>(
            json!({ "start": 9_007_199_254_740_992i64 })
        )
        .is_err(),
        "2^53 fails as a non-integer, not as an overflow"
    );

    // 3. The two spellings that sit in adjacent lines of the same files do different things:
    // `TrimmedString` **rewrites** the value, `isTrimmed` **refuses** it.
    assert_eq!(
        round::<Trimmed>(&json!("  a  ")).expect("the transform trims"),
        json!("a"),
    );
    assert!(serde_json::from_value::<TabId>(json!(" a ")).is_err());
    assert_eq!(
        round::<TabId>(&json!("a")).expect("no edges to refuse"),
        json!("a")
    );
    assert!(
        serde_json::from_value::<TabId>(json!("")).is_err(),
        "isNonEmpty"
    );
    assert!(serde_json::from_value::<TabId>(json!(" ")).is_err());

    // 4. The correction to fatia 2.7's evidence, in one pair of assertions. A key schema that
    // is only predicates over `string` is *tested*, so an unmatched key costs its own entry
    // and the rest of the record decodes; a key schema containing a `decodeTo` is *parsed*,
    // so the same-looking key takes the whole record down. Both orders, so the drop cannot be
    // an artefact of iteration.
    for payload in [
        json!({ "env": { "1BAD": "v", "GOOD": "w" } }),
        json!({ "env": { "GOOD": "w", "1BAD": "v" } }),
    ] {
        assert_eq!(
            round::<TerminalOpenEnv>(&payload)
                .expect("the unmatched key is dropped, its neighbour survives"),
            json!({ "env": { "GOOD": "w" } }),
        );
    }
    assert!(
        serde_json::from_value::<AuthCredentials>(
            json!({ "type": "credentials", "values": { "  ": "tok" } })
        )
        .is_err(),
        "the key trims to empty and fails inside its own parse"
    );

    // 5. Outbound, the drop is the same but a parsed key's assertion is not re-run: the trim
    // happens and the empty result goes on the wire. A port that decoded before encoding —
    // `round` for both directions — writes nothing where the shipped codec writes `""`.
    assert_eq!(
        env_encode(&json!({ "env": { "1BAD": "v", "GOOD": "w" } })).expect("encode drops too"),
        json!({ "env": { "GOOD": "w" } }),
    );
    assert_eq!(
        auth_credentials_encode(&json!({ "type": "credentials", "values": { "  ": "tok" } }))
            .expect("the trim runs and nothing re-checks"),
        json!({ "type": "credentials", "values": { "": "tok" } }),
    );
    assert_eq!(
        theme_colors_encode(&json!({ "colors": { "accent": "   " } }))
            .expect("whitespace-only becomes empty on the way out"),
        json!({ "colors": { "accent": "" } }),
    );
    assert!(
        serde_json::from_value::<ThemeFileColors>(json!({ "colors": { "accent": "   " } }))
            .is_err(),
        "and is refused on the way in"
    );

    // 6. `isMaxProperties` counts **survivors** inbound and the **whole map** outbound, so one
    // 129-key payload is legal in a direction and not the other. This only shows up where
    // something can be dropped first, which is exactly the [`LenientKeys`] records — so the
    // two findings of this fatia compose into a third.
    let entries = |count: usize, bad: bool| -> Value {
        let mut map = Map::new();
        for index in 0..count {
            map.insert(format!("K{index}"), json!("v"));
        }
        if bad {
            map.insert("1BAD".to_owned(), json!("v"));
        }
        Value::Object(map)
    };
    let at_the_bound_plus_one_dropped = json!({ "env": entries(128, true) });
    assert!(
        serde_json::from_value::<TerminalOpenEnv>(at_the_bound_plus_one_dropped.clone()).is_ok(),
        "129 arriving keys, 128 survivors"
    );
    assert!(
        env_encode(&at_the_bound_plus_one_dropped).is_err(),
        "129 keys is 129 to the encoder, which counts before it drops"
    );
    assert!(
        serde_json::from_value::<TerminalOpenEnv>(json!({ "env": entries(129, false) })).is_err(),
        "with nothing to drop the two directions agree"
    );

    // 7. `KeyRejection` is a **decode** rule and nothing else. Outbound, both markers keep a
    // key they can encode and drop one they cannot, identically. No live site can show this —
    // both `LenientKeys` records key on predicates, never on a transform — so it is asserted
    // here, and it is why the `Record` doc no longer claims the two differ on the way out.
    type Weight = Checked<JsNumber, Between<0, 100>>;
    let padded: BTreeMap<NonEmpty, Weight> = [("  ", 50), ("b", 60)]
        .into_iter()
        .map(|(key, value)| {
            (
                NonEmpty(key.to_owned()),
                Checked::wrap(JsNumber(json!(value).as_number().unwrap().clone())),
            )
        })
        .collect();
    let both_ways = json!({ "": 50, "b": 60 });
    assert_eq!(
        serde_json::to_value(Record::<NonEmpty, Weight, StrictKeys>::new(padded.clone()))
            .expect("strict"),
        both_ways,
    );
    assert_eq!(
        serde_json::to_value(Record::<NonEmpty, Weight, LenientKeys>::new(padded))
            .expect("lenient"),
        both_ways,
        "the marker changes what a bad key costs on the way in, not on the way out"
    );
}

/// The byte field, the opaque cursor and the recursive menu — the three things 3d measures,
/// each with the half the golden cannot reach.
#[test]
fn the_byte_field_the_cursor_and_the_menu_hold_their_measured_shape() {
    let cursor = "x".repeat(4_096);
    let over = "x".repeat(4_097);
    let padded = format!("    {cursor}");

    // 1. `Bytes` refuses every JSON value, and that is the *whole* behaviour. The four
    // spellings here are the four a port might be tempted to accept: `Vec<u8>`'s own, base64
    // (which is what every other Rust serialiser would choose), `null`, and the object
    // `JSON.stringify` writes for a byte sequence — the last being the one that would pass a
    // `HashMap<String, u8>`-shaped reading of the schema. Even the golden's own `$bytes`
    // sentinel is refused, which is the point: it names a value the codec cannot see, so
    // nothing may decode *into* it either.
    for rejected in [
        json!([1, 2, 3]),
        json!("AQID"),
        json!(null),
        json!({ "0": 1, "1": 2, "2": 3 }),
        json!({ "$bytes": [1, 2, 3] }),
        json!(""),
        json!([]),
    ] {
        assert!(
            serde_json::from_value::<Bytes>(rejected.clone()).is_err(),
            "{rejected} is not a byte sequence to the shipped codec"
        );
    }

    // 2. And it refuses to be *written*, which is the half that keeps a derived struct from
    // inventing a form. Without this, `#[derive(Serialize)]` on a struct holding a `Vec<u8>`
    // would silently write the array the schema rejects, and the failure would surface on the
    // other side of the wire as a decode error in code that never calls a codec.
    assert!(serde_json::to_value(Bytes(vec![1, 2, 3])).is_err());
    assert!(
        serde_json::to_value(RecordingSave {
            tab_id: TabId::wrap("t".to_owned()),
            mime_type: TabId::wrap("m".to_owned()),
            data: Bytes(vec![1, 2, 3]),
        })
        .is_err(),
        "the field that carries the bytes cannot be serialized either"
    );

    // 3. A wrong `data` is refused inside the struct, at the same position, and the two
    // string fields still refuse on their own — which no case in the golden can show, because
    // every input that gets past `data` carries a value JSON cannot spell.
    let mut json_form = Map::new();
    json_form.insert("tabId".into(), json!("t"));
    json_form.insert("mimeType".into(), json!("m"));
    json_form.insert("data".into(), json!({ "0": 1 }));
    assert!(serde_json::from_value::<RecordingSave>(Value::Object(json_form)).is_err());
    for (field, bad) in [
        ("tabId", json!(" t ")),
        ("mimeType", json!(" m ")),
        ("mimeType", json!("")),
        ("mimeType", json!("  ")),
    ] {
        let mut input = Map::new();
        input.insert("tabId".into(), json!("t"));
        input.insert("mimeType".into(), json!("m"));
        input.insert(field.to_owned(), bad);
        input.insert("data".into(), json!([1]));
        assert!(
            serde_json::from_value::<RecordingSave>(Value::Object(input)).is_err(),
            "{field} is `isTrimmed` + `isNonEmpty`, the same pair the tab id already uses"
        );
    }

    // 4. The cursor bound sits on the **far side** of the trim, and the two directions
    // therefore disagree about the same four spaces: decode trims then measures, so a padded
    // full-length cursor fits and comes back trimmed; encode measures what it was handed, so
    // the same text is over the bound and takes the record down.
    let entry = |key: &str, value: &str| {
        let mut entries = Map::new();
        entries.insert(key.to_owned(), json!(value));
        Value::Object(entries)
    };
    assert_eq!(
        round::<Cursors>(&entry("a", &padded)).expect("trimmed, then measured"),
        json!({ "a": cursor }),
    );
    assert!(
        pull_request_cursors_encode(&entry("a", &padded)).is_err(),
        "measured first, then trimmed — the same text is over the bound"
    );
    assert!(round::<Cursors>(&entry("a", &over)).is_err());
    // The bound is on the value only: the same 4100-character string is accepted as a key,
    // trimmed, and accepted again on the way out.
    assert_eq!(
        round::<Cursors>(&entry(&padded, "b")).expect("keys have no bound"),
        json!({ cursor.clone(): "b" }),
    );
    assert_eq!(
        pull_request_cursors_encode(&entry(&padded, "b")).expect("and no bound outbound"),
        json!({ cursor.clone(): "b" }),
    );

    // 5. The two empty-key outcomes, one field apart. Whitespace survives the outbound check
    // (the text is not empty *yet*) and is written empty; an empty key fails it and drops the
    // entry, taking nothing else with it. A port that validates after trimming gets the first
    // wrong; one that rejects gets the second wrong, and loudly.
    assert_eq!(
        pull_request_cursors_encode(&json!({ "  ": "b" })).expect("not empty yet"),
        json!({ "": "b" }),
    );
    assert_eq!(
        pull_request_cursors_encode(&json!({ "": "b", "a": "c" })).expect("one entry dropped"),
        json!({ "a": "c" }),
    );
    assert!(
        round::<Cursors>(&json!({ "": "b" })).is_err(),
        "inbound it is fatal"
    );

    // 6. The recursion has no depth the port chose: three levels in, three levels out, and a
    // missing `label` at the bottom fails the whole menu however deep it is nested. The golden
    // records the *path* TypeScript reports; what it cannot record is that this representation
    // can express the tree at all, so that is asserted here.
    let deep = json!({
        "id": "a", "label": "L",
        "children": [{ "id": "b", "label": "M", "children": [
            { "id": "c", "label": "N", "children": [{ "id": "d", "label": "O" }] }] }],
    });
    assert_eq!(round::<ContextMenuItem>(&deep).expect("three levels"), deep);
    for depth in 0..4 {
        let mut broken = json!({ "id": "x" });
        for _ in 0..depth {
            broken = json!({ "id": "x", "label": "L", "children": [broken] });
        }
        assert!(
            serde_json::from_value::<ContextMenuItem>(broken).is_err(),
            "a missing label at depth {depth} still fails"
        );
    }

    // 7. `Schema.Codec<T>` is an annotation, so nothing here is a construct — the proof being
    // that an undeclared key is dropped rather than rejected, and that a value which is a
    // legal Type in both fields is byte-identical in both directions.
    assert_eq!(
        round::<ContextMenuItem>(&json!({ "id": "a", "label": "L", "extra": 1 })).expect("dropped"),
        json!({ "id": "a", "label": "L" }),
    );
    assert_eq!(
        round::<ContextMenuItem>(
            &json!({ "id": "a", "label": "L", "icon": "x", "separatorBefore": true, "checked": false })
        )
        .expect("every optionalKey present"),
        json!({ "id": "a", "label": "L", "icon": "x", "separatorBefore": true, "checked": false }),
    );
}

/// The two constructs this fatia adds — a number that crosses the wire as a *string*, and a
/// constructor default that turns out to have no wire effect at all — asserted in-crate, so
/// the findings survive without the golden.
#[test]
fn the_string_number_and_the_constructor_default_hold_their_measured_shape() {
    // 1. `FiniteFromString` is the one place the `Finite`/`Number` collapse does **not** hold.
    // A bare JSON number has no spelling for `Infinity`, so the finite gate on `Schema.Finite`
    // is unreachable; here the Encoded side is a string, `"Infinity"` is spellable, and the
    // gate really does refuse it — along with the overflow that produces one.
    for text in [
        "Infinity",
        "-Infinity",
        "  Infinity  ",
        "1e309",
        "-1e309",
        "NaN",
        "abc",
        "1e",
        "1e+",
        "1_000",
        ".",
        "1 2",
        "0x",
    ] {
        assert!(
            serde_json::from_value::<FiniteFromString>(json!(text)).is_err(),
            "{text:?} is not a finite number"
        );
    }
    assert!(
        serde_json::from_value::<JsNumber>(json!("Infinity")).is_err(),
        "and on the bare primitive the same text is not a number at all"
    );

    // 2. Decoding is JavaScript's `Number()`, not `str::parse::<f64>()`: the empty string is
    // zero, radix prefixes are honoured, a leading `+` and a bare `.` fraction are legal, and
    // `0123` is decimal rather than octal. Rust's own parser refuses the first two outright,
    // which is the whole reason this primitive carries its own conversion.
    assert!("".parse::<f64>().is_err());
    assert!("0x10".parse::<f64>().is_err());
    for (text, number) in [
        ("", 0.0),
        ("   ", 0.0),
        ("0x10", 16.0),
        ("0X1f", 31.0),
        ("0b101", 5.0),
        ("0o17", 15.0),
        ("0123", 123.0),
        ("1.", 1.0),
        (".5", 0.5),
        ("+1", 1.0),
        (" 1 ", 1.0),
        ("\t\n1\r\n", 1.0),
    ] {
        let decoded = serde_json::from_value::<FiniteFromString>(json!(text))
            .unwrap_or_else(|_| panic!("{text:?} is a JavaScript number"));
        assert_eq!(
            decoded.0.0.as_f64().expect("a JSON number"),
            number,
            "Number({text:?})"
        );
    }

    // 3. Encoding is `String(n)`, where the ECMAScript exponent thresholds live: 1e21 is the
    // first large value written exponentially and 1e-7 the first small one. Rust's `Display`
    // writes neither, so a port that reached for `to_string` would put twenty-one digits on
    // the wire where the shipped codec puts five characters.
    assert_eq!(format!("{}", 1e21f64), "1000000000000000000000");
    assert_eq!(format!("{}", 1e-7f64), "0.0000001");
    for (number, text) in [
        (1e20, "100000000000000000000"),
        (1e21, "1e+21"),
        (1.5e21, "1.5e+21"),
        (1e-6, "0.000001"),
        (1e-7, "1e-7"),
        (-1.5e-7, "-1.5e-7"),
        (0.0, "0"),
        (-0.0, "0"),
        (1.0 / 3.0, "0.3333333333333333"),
    ] {
        let value = FiniteFromString(JsNumber(
            serde_json::Number::from_f64(number).expect("finite"),
        ));
        assert_eq!(
            serde_json::to_value(&value).expect("a finite number always encodes"),
            json!(text),
            "String({number})"
        );
    }

    // 4. `turnLimit` is `isInt()` + `isGreaterThanOrEqualTo(1)` over the **decoded** number, so
    // the predicates see 16 for `"0x10"` and 2000 for `"2e3"`. This is what the `Numeric` trait
    // buys: without it the six checks would apply only to a bare `JsNumber` and this field
    // could not carry them at all.
    for (text, number) in [
        ("1", 1),
        ("2", 2),
        (" 2 ", 2),
        ("0x10", 16),
        ("2e3", 2000),
        ("9007199254740991", 9_007_199_254_740_991i64),
    ] {
        assert_eq!(
            decode_as::<TurnLimitQuery, _>(&json!({ "turnLimit": text }), turn_limit_type)
                .expect("a legal window"),
            json!({ "turnLimit": number }),
            "turnLimit {text:?}"
        );
    }
    for text in [
        "0",
        "-1",
        "1.5",
        "abc",
        "",
        "Infinity",
        "NaN",
        "9007199254740993",
    ] {
        assert!(
            serde_json::from_value::<TurnLimitQuery>(json!({ "turnLimit": text })).is_err(),
            "{text:?} is not a positive safe integer"
        );
    }

    // 5. All three fields are optional, and `reasoningMessages` is the *string* literal
    // `"true"` — a boolean `true` is not it, and neither is `"false"`. Omitting everything
    // keeps the full-snapshot behaviour the declaration's comment promises.
    assert_eq!(
        round::<TurnLimitQuery>(&json!({})).expect("every field optional"),
        json!({}),
    );
    assert_eq!(
        round::<TurnLimitQuery>(&json!({ "reasoningMessages": "true" })).expect("the literal"),
        json!({ "reasoningMessages": "true" }),
    );
    for bad in [json!(true), json!("false"), json!(1)] {
        assert!(
            serde_json::from_value::<TurnLimitQuery>(json!({ "reasoningMessages": bad })).is_err(),
            "reasoningMessages is one literal"
        );
    }
    assert_eq!(
        round::<TurnLimitQuery>(&json!({ "beforeCursor": "  c  " })).expect("trims, then checks"),
        json!({ "beforeCursor": "c" }),
    );
    assert!(
        serde_json::from_value::<TurnLimitQuery>(json!({ "beforeCursor": "   " })).is_err(),
        "whitespace-only trims to empty"
    );

    // 6. `withConstructorDefault` is a constructor obligation, not a codec one: measured
    // against a plain `Schema.optional(Schema.Boolean)` on seven inputs in both directions,
    // every result is identical. It fills `.make({})`, never the wire — so the Rust field is
    // the same `Absent<bool>` the plain optional gets. Reading it as `withDecodingDefault`
    // would write `{"multiSelect":false}` for `{}`, which is the mutation this guards.
    assert_eq!(
        round::<ConstructorDefault>(&json!({})).expect("absent stays absent"),
        json!({}),
    );
    assert_eq!(
        round::<ConstructorDefault>(&json!({ "multiSelect": false }))
            .expect("an explicit false is kept, not defaulted away"),
        json!({ "multiSelect": false }),
    );
    for bad in [json!(null), json!("x"), json!(1)] {
        assert!(
            serde_json::from_value::<ConstructorDefault>(json!({ "multiSelect": bad })).is_err(),
            "the default does not widen the field"
        );
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
    assert_eq!(table.len(), 61, "ported subject count changed");
    assert_eq!(
        unrepresentable, 2,
        "dateTimeUtcBare was supposed to be the only subject with no JSON form, and every \
         subject contributes one case per direction"
    );
    assert_eq!(
        skipped, 38,
        "6 scalars take `undefined` outright, 20 shape cases take `{{v: undefined}}` — or, \
         for Void/Unknown/Union/Never, `undefined` itself — the 2 contextMenu, 2 turnLimit and \
         4 constructorDefault cases take an `optionalKey` own key holding `undefined`, and the \
         4 recordingSave cases take an actual byte sequence"
    );
    assert_eq!(
        incomparable, 14,
        "the two forwardCompatibleOptional decodes that yield `{{v: undefined}}`, and the 12 \
         voidSchema cases that yield bare `undefined`"
    );
    assert_eq!(
        typed, 22,
        "5 durationFromMillis encodes whose Type side is a `Duration`, the 14 defect encodes \
         whose Type side is an `Error`, and the 3 confirmQuitSetting encodes that \
         `recordTyped` feeds as a Type-side mode — in all three the golden names the Encoded \
         JSON and this replay decodes it first"
    );
    // Every case is accounted for by exactly one of these five counts, so the sum is the
    // golden's own `codec cases` line and the arithmetic is what a shrink would break.
    assert_eq!(
        replayed + skipped + incomparable + unrepresentable,
        cases.len(),
        "some case was neither replayed nor classified"
    );
    assert_eq!(replayed, 1202, "only replayed {replayed} cases");
}
