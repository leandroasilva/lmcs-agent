//! Wire codec primitives, ported from `packages/core/src/contracts/baseSchemas.ts`.
//!
//! The Effect Schema JSON codec is not `serde`'s JSON codec. These rules differ and
//! every payload schema in the rest of the crate depends on them:
//!
//! - Structs are **not** exact. `{v:"a", extra:1}` decodes to `{v:"a"}`, so the Rust
//!   structs must ignore unknown fields — serde's default, never `deny_unknown_fields`.
//! - `Schema.optional` rejects an explicit `null` where serde's `Option` accepts it.
//!   [`Absent`] is the field type for those.
//! - A required key whose value may be `null` cannot be `Option<T>` either, because
//!   serde's derive makes an `Option` field implicitly optional. [`Nullable`] keeps the
//!   key required; [`Maybe`] does the same while swallowing unknown members, and an
//!   omittable field opts out with `#[serde(default)]`.
//! - `TrimmedNonEmptyString` trims on **both** directions, and its non-empty check
//!   runs on opposite sides of the trim: a blank decodes as a failure but encodes to
//!   `""`. [`NonEmpty`] reproduces that instead of repairing it.
//! - Text is measured in **UTF-16 code units** and trimmed with **JavaScript's**
//!   whitespace set. See [`utf16_len`] and [`js_trim`].
//! - A `Schema.check` on an untransformed schema runs on **both** directions; on a
//!   transformed one it validates the value pre-transform when encoding and
//!   post-transform when decoding. [`Checked`] gets that for free by wrapping the
//!   transformed type rather than re-deriving the rule.
//! - `Schema.isPattern` is `RegExp.test`, which finds a match **anywhere** in the string
//!   rather than requiring a full match — the patterns that mean to be anchored carry
//!   their own `^…$`. Two of the 28 sites use a negative lookahead, which the `regex`
//!   crate cannot express; both are "matches this shape and is not one of these three
//!   literals", so they port to a check plus a set membership test.
//! - `Schema.Option` crosses the wire in Effect's own internal spelling, so
//!   [`EffectOption`] is not interchangeable with [`Nullable`].
//! - Length is one predicate over two kinds of value: `isMinLength` and `isMaxLength` are
//!   both `input.length`, so they measure a string in UTF-16 code units and an array in
//!   elements. [`Length`] covers both halves.
//! - `Schema.Int` is `Number.isSafeInteger`, not `Number.isInteger`, so it rejects
//!   `2^53` — a value an `i64` holds easily. See [`SafeInt`].
//! - `Schema.Finite` and `Schema.Number` are the same codec for every input JSON can
//!   spell, because `Infinity` and `NaN` cannot cross the wire at all.
//! - `Schema.DurationFromMillis` is [`JsNumber`] on the wire; only its Type side differs.
//! - `Schema.Defect()` is **not** an identity codec, and its Type side is `unknown`.
//!   See [`Defect`].
//! - `Schema.TaggedStruct` and `Schema.TaggedError` are the same thing on the wire: an
//!   internally tagged `_tag` map. serde's `#[serde(tag = "_tag")]` is already it, so
//!   neither needs a type here — the 150 `TaggedError` sites collapse into the enum
//!   pattern the payload schemas use anyway.
//! - `Schema.Record` keys on a **schema**, not on a string, and its two directions disagree
//!   about failure: decoding rejects the whole record, encoding drops only the entry whose
//!   key cannot be encoded. See [`Record`].
//! - `Schema.Void` is declared `Bottom<void, void>` and still accepts *every* input,
//!   discarding it. `Schema.Unknown` is identity in both directions, so it is plain
//!   `serde_json::Value` and needs no type here. An untagged `Schema.Union` is
//!   `#[serde(untagged)]`; only the rejection's tag differs.
//! - `Schema.Never` is the empty enum, and unlike `Void` it really does reject everything
//!   — `undefined` included. It is the default `error` schema of `Rpc.make`, so it is the
//!   error channel of every streaming method. See [`Never`].
//! - `RpcSchema.Stream` is **not a codec**. It is `Schema.declare(Stream.isStream)` with
//!   the element schemas hanging off it, so it never reaches the wire and needs no type
//!   here; framing stream chunks is the transport's job.
//!
//! The TypeScript-only shapes collapse here, and that is deliberate rather than a gap:
//! `Schema.optionalKey` differs from `Schema.optional` only in whether `{v: undefined}`
//! is encodable, and `ForwardCompatibleOptional` differs from `OmittedWhenNull` only in
//! whether `null` is in the Type. Rust has no `undefined`, so both pairs land on the
//! same representation. Cases the TS type system rejects before the codec runs — an
//! encode of `"z"` against `Literals(["a","b"])` — have no Rust input at all.

use serde::de::{self, Deserializer, SeqAccess, Unexpected, Visitor};
use serde::ser::{SerializeMap, SerializeSeq, Serializer};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::marker::PhantomData;

/// `String.prototype.length`, which counts UTF-16 code units — not codepoints and not
/// bytes. Every `isMaxLength` in the contracts is measured this way, so `"ab😀"` is 4 and
/// fails a bound of 3 even though it is 3 characters.
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `String.prototype.trim`'s character set, which is not `char::is_whitespace`.
/// JavaScript trims WhiteSpace and LineTerminator; that set differs from Unicode's
/// White_Space in exactly two characters, and the port has to differ from `str::trim` in
/// both directions or it silently accepts and rejects the wrong ids:
///
/// - U+FEFF (BOM) **is** trimmed by JavaScript and is not whitespace to Unicode.
/// - U+0085 (NEL) is whitespace to Unicode and is **not** trimmed by JavaScript.
///
/// U+200B (ZWSP) is trimmed by neither, and `char::is_whitespace` already agrees.
fn is_js_whitespace(character: char) -> bool {
    character == '\u{feff}' || (character.is_whitespace() && character != '\u{85}')
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `TrimmedString`: trims on decode and on encode.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Trimmed(pub String);

impl Serialize for Trimmed {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(js_trim(&self.0))
    }
}

impl<'de> Deserialize<'de> for Trimmed {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TrimmedVisitor;
        impl Visitor<'_> for TrimmedVisitor {
            type Value = Trimmed;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a string")
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<Trimmed, E> {
                Ok(Trimmed(js_trim(value).to_owned()))
            }
        }
        deserializer.deserialize_str(TrimmedVisitor)
    }
}

/// `TrimmedNonEmptyString`, and therefore every `makeEntityId` brand — the brand is
/// erased at runtime, so all the entity ids share this one wire shape.
///
/// Holds the pre-trim text: `"   "` is constructible and serializes to `""`, exactly
/// as the shipped codec does. Tightening that would change what a Rust server writes
/// where a TypeScript one wrote an empty string.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NonEmpty(pub String);

impl Serialize for NonEmpty {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if self.0.is_empty() {
            return Err(serde::ser::Error::custom("expected a non-empty string"));
        }
        serializer.serialize_str(js_trim(&self.0))
    }
}

impl<'de> Deserialize<'de> for NonEmpty {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct NonEmptyVisitor;
        impl Visitor<'_> for NonEmptyVisitor {
            type Value = NonEmpty;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a non-empty string")
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<NonEmpty, E> {
                let trimmed = js_trim(value);
                if trimmed.is_empty() {
                    return Err(E::invalid_value(Unexpected::Str(value), &self));
                }
                Ok(NonEmpty(trimmed.to_owned()))
            }
        }
        deserializer.deserialize_str(NonEmptyVisitor)
    }
}

/// `NonNegativeInt`: an integer `>= 0`. `1.5`, `true` and `"a"` are rejected before
/// the range check, which is serde's integer behaviour already.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NonNegativeInt(pub i64);

/// `PositiveInt`: an integer `>= 1`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PositiveInt(pub i64);

/// `PortSchema`: an integer in `1..=65535`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Port(pub u16);

macro_rules! bounded_int {
    ($name:ident, $inner:ty, $range:expr, $unexpected:expr) => {
        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let in_range: fn(&$inner) -> bool = $range;
                if !in_range(&self.0) {
                    return Err(serde::ser::Error::custom(concat!(
                        stringify!($name),
                        " out of range"
                    )));
                }
                self.0.serialize(serializer)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = <$inner>::deserialize(deserializer)?;
                let in_range: fn(&$inner) -> bool = $range;
                if !in_range(&value) {
                    let unexpected: fn($inner) -> Unexpected<'static> = $unexpected;
                    return Err(de::Error::invalid_value(
                        unexpected(value),
                        &stringify!($name),
                    ));
                }
                Ok($name(value))
            }
        }
    };
}

bounded_int!(
    NonNegativeInt,
    i64,
    |value: &i64| *value >= 0,
    Unexpected::Signed
);
bounded_int!(
    PositiveInt,
    i64,
    |value: &i64| *value >= 1,
    Unexpected::Signed
);
bounded_int!(Port, u16, |value: &u16| *value >= 1, |value: u16| {
    Unexpected::Unsigned(u64::from(value))
});

/// An optional field whose key must be absent, not null: `Schema.optional` and
/// `Schema.optionalKey`. Plain `Option<T>` is wrong here because serde decodes an
/// explicit `null` into `None`.
///
/// Declare it as `#[serde(default, skip_serializing_if = "Absent::is_none")]`, with both
/// attributes: without the `default` an absent key is an error, and without the skip a
/// `None` is a serialization error rather than an omitted key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Absent<T>(pub Option<T>);

impl<T> Default for Absent<T> {
    fn default() -> Self {
        Absent(None)
    }
}

impl<T> Absent<T> {
    pub fn is_none(&self) -> bool {
        self.0.is_none()
    }

    pub fn into_option(self) -> Option<T> {
        self.0
    }
}

impl<T: Serialize> Serialize for Absent<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match &self.0 {
            None => Err(serde::ser::Error::custom(
                "an absent field cannot serialize null",
            )),
            Some(value) => value.serialize(serializer),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Absent<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_option(AbsentVisitor(PhantomData))
    }
}

struct AbsentVisitor<T>(PhantomData<T>);

impl<'de, T: Deserialize<'de>> Visitor<'de> for AbsentVisitor<T> {
    type Value = Absent<T>;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a non-null value")
    }

    // `deserialize_option` routes `null` here, and serde's missing-key deserializer
    // does the same — so an `Absent` field only tolerates absence through
    // `#[serde(default)]`, never through this impl.
    fn visit_none<E: de::Error>(self) -> Result<Absent<T>, E> {
        Err(E::invalid_type(Unexpected::Option, &self))
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Absent<T>, D::Error> {
        T::deserialize(deserializer).map(|value| Absent(Some(value)))
    }
}

/// `Schema.NullOr(value)` on a **required** key: the field must be present, and its
/// value may be `null`.
///
/// `Option<T>` is wrong for this. serde's derive treats an `Option`-typed field as
/// implicitly optional, so a missing key decodes to `None` instead of failing — and a
/// Rust server would then accept payloads the TypeScript one rejects.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Nullable<T>(pub Option<T>);

impl<T> Default for Nullable<T> {
    fn default() -> Self {
        Nullable(None)
    }
}

impl<T> Nullable<T> {
    pub fn is_none(&self) -> bool {
        self.0.is_none()
    }

    pub fn into_option(self) -> Option<T> {
        self.0
    }
}

impl<T: Serialize> Serialize for Nullable<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Nullable<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // `Value` asks for `deserialize_any`, which serde's missing-key deserializer does
        // not answer, so the key stays required. See the same note on `Maybe`.
        let raw = serde_json::Value::deserialize(deserializer)?;
        Ok(Nullable(
            Option::<T>::deserialize(raw).map_err(de::Error::custom)?,
        ))
    }
}

/// `ForwardCompatibleNullable(value)`, `OmittedWhenNull(value)` and
/// `ForwardCompatibleOptional(value)` — one value whose member set grows over time. A
/// member this build cannot decode becomes `None` rather than failing the enclosing
/// struct, because a client has to keep decoding configs sent by a newer server.
///
/// Which of the three it is comes down to the field attributes, not the type:
/// `ForwardCompatibleNullable` is a required key, the other two are omittable
/// (`#[serde(default, skip_serializing_if = "Maybe::is_none")]`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Maybe<T>(pub Option<T>);

impl<T> Default for Maybe<T> {
    fn default() -> Self {
        Maybe(None)
    }
}

impl<T> Maybe<T> {
    pub fn is_none(&self) -> bool {
        self.0.is_none()
    }

    pub fn into_option(self) -> Option<T> {
        self.0
    }
}

impl<T: Serialize> Serialize for Maybe<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Maybe<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Buffering rather than `Option::<T>::deserialize` is load-bearing: serde
        // feeds a missing key to a deserializer that only answers `deserialize_option`,
        // so an `Option`-shaped reader would accept the absent key that
        // `ForwardCompatibleNullable` requires. `Value` asks for `deserialize_any` and
        // therefore fails on an absent key, leaving `#[serde(default)]` as the only way
        // a field gets to be omittable.
        let raw = serde_json::Value::deserialize(deserializer)?;
        Ok(Maybe(T::deserialize(raw).ok()))
    }
}

/// `ForwardCompatibleArray(element)`: a server→client array whose element union grows
/// over time. Decoding drops elements this build cannot decode; encoding is the plain
/// array encoding, because a Rust `Vec<T>` cannot hold an element outside `T`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Lenient<T>(pub Vec<T>);

impl<T> Default for Lenient<T> {
    fn default() -> Self {
        Lenient(Vec::new())
    }
}

impl<T: Serialize> Serialize for Lenient<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(self.0.len()))?;
        for element in &self.0 {
            seq.serialize_element(element)?;
        }
        seq.end()
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Lenient<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_seq(LenientVisitor(PhantomData))
    }
}

struct LenientVisitor<T>(PhantomData<T>);

impl<'de, T: Deserialize<'de>> Visitor<'de> for LenientVisitor<T> {
    type Value = Lenient<T>;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an array")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Lenient<T>, A::Error> {
        let mut kept = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        // A rejected element still has to be consumed, or the sequence is left
        // pointing at it and every following read is garbage.
        while let Some(raw) = seq.next_element::<serde_json::Value>()? {
            if let Ok(element) = T::deserialize(raw) {
                kept.push(element);
            }
        }
        Ok(Lenient(kept))
    }
}

/// One `Schema.check` predicate. Implementations are unit structs, so a field reads
/// `Checked<String, MaxLength<3>>` and the bound the TypeScript spelled inline becomes a
/// type parameter.
pub trait Check<T> {
    fn passes(value: &T) -> bool;

    /// Names the constraint in the decode or serialize error. Allocating here is fine:
    /// this only runs on the failure path.
    fn describe() -> String;
}

/// `.check(a, b)` — 3 sites chain two predicates (`pullRequest.ts:1225` and `:1237`,
/// `keybindings.ts:99`). A tuple of checks is itself a check, so the chain reads
/// `Checked<Vec<T>, (MinLength<1>, MaxLength<25>)>` instead of needing a second
/// combinator or a nesting of [`Checked`].
///
/// Conjunction with no ordering, and that is deliberate: the golden shows all three
/// failure modes of a chained check — under the minimum, over the maximum, and a bad
/// element — reporting the *same* `Composite` issue tag, so which predicate rejected is
/// not observable on the wire and does not have to be reproduced.
impl<T, A: Check<T>, B: Check<T>> Check<T> for (A, B) {
    fn passes(value: &T) -> bool {
        A::passes(value) && B::passes(value)
    }

    fn describe() -> String {
        format!("{} and {}", A::describe(), B::describe())
    }
}

/// Anything `isMinLength` / `isMaxLength` can measure.
///
/// Both TypeScript predicates are spelled `input.length`, which makes one rule cover two
/// kinds of value: a string, where `length` is UTF-16 code units, and an array, where it
/// is elements. The contracts use both — `isMinLength` has 3 string sites
/// (`keybindings.ts:115` and `:120`, `orchestration.ts:2300`) and 3 array sites
/// (`git.ts:167`, `pullRequest.ts:1225` and `:1237`) — so a port that only models the
/// string half silently skips half the sites.
pub trait Length {
    fn length(&self) -> usize;
}

impl Length for String {
    fn length(&self) -> usize {
        utf16_len(self)
    }
}

impl Length for Trimmed {
    fn length(&self) -> usize {
        utf16_len(&self.0)
    }
}

impl Length for NonEmpty {
    fn length(&self) -> usize {
        utf16_len(&self.0)
    }
}

impl<T> Length for Vec<T> {
    fn length(&self) -> usize {
        self.len()
    }
}

/// A value together with the check that gates it.
///
/// Wrapping the *transformed* type is what makes the direction rule fall out instead of
/// being re-implemented per site. `Checked<NonEmpty, MaxLength<3>>` measures the trimmed
/// text after a decode and the raw text before an encode, because that is whatever
/// [`NonEmpty`] is holding at the time — which reproduces `TrimmedNonEmptyString.check(…)`
/// including its quirk that `"   "` encodes to `""` (three units passes the bound, then
/// the trim empties it and nothing re-checks). `Checked<String, MaxLength<3>>` measures
/// the same text both ways, which is what an untransformed
/// `Schema.String.pipe(Schema.check(…))` does.
///
/// `PhantomData<fn() -> C>` rather than `PhantomData<C>` so that neither `C`'s variance
/// nor its auto traits leak into this type, and the derived-shaped impls below do not have
/// to ask for `C: Clone` and friends.
pub struct Checked<T, C: Check<T>>(pub T, PhantomData<fn() -> C>);

impl<T, C: Check<T>> Checked<T, C> {
    /// Wraps a value without running the check. Lax rather than unsafe: [`Serialize`]
    /// runs it, so an invalid value still cannot reach the wire through this type. This
    /// is the only constructor because `Deserialize` runs the check itself.
    pub fn wrap(value: T) -> Self {
        Checked(value, PhantomData)
    }
}

impl<T: Clone, C: Check<T>> Clone for Checked<T, C> {
    fn clone(&self) -> Self {
        Checked(self.0.clone(), PhantomData)
    }
}

impl<T: fmt::Debug, C: Check<T>> fmt::Debug for Checked<T, C> {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.debug_tuple("Checked").field(&self.0).finish()
    }
}

impl<T: PartialEq, C: Check<T>> PartialEq for Checked<T, C> {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

impl<T: Serialize, C: Check<T>> Serialize for Checked<T, C> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if !C::passes(&self.0) {
            return Err(serde::ser::Error::custom(C::describe()));
        }
        self.0.serialize(serializer)
    }
}

impl<'de, T: Deserialize<'de>, C: Check<T>> Deserialize<'de> for Checked<T, C> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = T::deserialize(deserializer)?;
        if !C::passes(&value) {
            return Err(de::Error::custom(C::describe()));
        }
        Ok(Checked(value, PhantomData))
    }
}

/// `Schema.isMaxLength(N)` — 164 sites, measured through [`Length`].
pub struct MaxLength<const N: usize>;

impl<const N: usize, T: Length> Check<T> for MaxLength<N> {
    fn passes(value: &T) -> bool {
        value.length() <= N
    }

    fn describe() -> String {
        format!("at most {N} long")
    }
}

/// `Schema.isMinLength(N)` — 6 sites, measured through [`Length`] exactly as the maximum
/// is. Effect floors and clamps the bound (`Math.max(0, Math.floor(minLength))`), which is
/// unobservable here because all 6 sites spell an integer literal.
pub struct MinLength<const N: usize>;

impl<const N: usize, T: Length> Check<T> for MinLength<N> {
    fn passes(value: &T) -> bool {
        value.length() >= N
    }

    fn describe() -> String {
        format!("at least {N} long")
    }
}

/// `Schema.isInt()`, which is `Number.isSafeInteger` and **not** `Number.isInteger`. The
/// difference is wire-visible and 82 sites depend on it: `9007199254740991` is accepted and
/// `9007199254740992` is rejected, though both are integers and both fit in an `i64` with
/// room to spare. A port that read these into `i64` would accept the second one, so a Rust
/// server would take a payload the TypeScript server refuses — the direction of divergence
/// that is hardest to notice, because nothing fails.
pub struct SafeInt;

/// `Number.MAX_SAFE_INTEGER`, exactly representable as an `f64`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

impl Check<JsNumber> for SafeInt {
    fn passes(value: &JsNumber) -> bool {
        value
            .0
            .as_f64()
            .is_some_and(|number| number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER)
    }

    fn describe() -> String {
        "a safe integer".to_owned()
    }
}

/// `Schema.isGreaterThan(N)` — 46 sites, every one of them `isGreaterThan(0)`. Exclusive:
/// the Effect parameter is named `exclusiveMinimum` and the golden confirms `0` is
/// rejected.
///
/// Compared as `f64` rather than as an integer because the 46 sites sit on three different
/// bases — `Schema.Int` ×14, `Schema.Finite` ×3, `Schema.Number` ×1 for the `(0)` bound —
/// and on the latter two `0.5` is a legal value. Integer-ness is [`SafeInt`]'s job, not
/// this predicate's, which is why the two compose instead of one subsuming the other.
pub struct GreaterThan<const N: i64>;

impl<const N: i64> Check<JsNumber> for GreaterThan<N> {
    fn passes(value: &JsNumber) -> bool {
        value.0.as_f64().is_some_and(|number| number > N as f64)
    }

    fn describe() -> String {
        format!("a number greater than {N}")
    }
}

/// `Schema.isLessThan(N)` — 2 sites, both `isLessThan(65536)` on a port. Exclusive, so
/// `65536` itself is rejected.
pub struct LessThan<const N: i64>;

impl<const N: i64> Check<JsNumber> for LessThan<N> {
    fn passes(value: &JsNumber) -> bool {
        value.0.as_f64().is_some_and(|number| number < N as f64)
    }

    fn describe() -> String {
        format!("a number less than {N}")
    }
}

/// `Schema.Number` — 109 sites — and `Schema.Finite` — 12 more, which need no type of
/// their own.
///
/// `Finite` rejects `Infinity` and `NaN`, and neither has a JSON spelling: `JSON.stringify`
/// renders both as `null`. So on any input that can actually arrive, `Finite` and `Number`
/// accept and reject the same set, and the golden records that as an observed fact rather
/// than leaving it as an argument.
///
/// Held as the JSON literal rather than an `f64` because an `f64` re-serializes `1` as
/// `1.0`, and a Rust server has to write the same bytes a TypeScript one wrote. Numeric
/// comparisons go through the inner [`serde_json::Number`], which is not `Copy` — so
/// unlike every other newtype here, neither is this.
#[derive(Clone, Debug, PartialEq)]
pub struct JsNumber(pub serde_json::Number);

impl Serialize for JsNumber {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for JsNumber {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // `Number` answers `deserialize_any` and only accepts the three JSON number
        // forms, so a string, a bool and a null are all rejected here rather than
        // coerced — and an absent key stays an error.
        serde_json::Number::deserialize(deserializer).map(JsNumber)
    }
}

/// `Schema.isBetween({minimum, maximum})` — 24 sites, inclusive at both ends and all with
/// integer bounds, so the bounds fit in a const parameter and the value does not.
pub struct Between<const MIN: i64, const MAX: i64>;

impl<const MIN: i64, const MAX: i64> Check<JsNumber> for Between<MIN, MAX> {
    fn passes(value: &JsNumber) -> bool {
        value
            .0
            .as_f64()
            .is_some_and(|number| number >= MIN as f64 && number <= MAX as f64)
    }

    fn describe() -> String {
        format!("a number between {MIN} and {MAX}")
    }
}

/// `Schema.DurationFromMillis` — 9 sites, all in `settings.ts`, all inside
/// `Schema.optionalKey`.
///
/// It is `Number.pipe(decodeTo(Duration, …))` and the transformation cannot fail, so **on
/// the wire this is indistinguishable from [`JsNumber`]**: every JSON number is accepted,
/// `1.5` round-trips to `1.5` and `-1` to `-1`. The only difference lives on the Type
/// side, where Effect picks a `Millis` variant for an integer and a `Nanos` one for
/// anything else — and that choice never reaches the wire.
///
/// Holds the literal rather than an `f64` for the same reason [`JsNumber`] does: `1000`
/// has to come back out as `1000`, not `1000.0`.
#[derive(Clone, Debug, PartialEq)]
pub struct DurationMillis(pub JsNumber);

impl DurationMillis {
    /// The count in milliseconds, fractional if the wire said so.
    ///
    /// `f64` rather than an integer because `1.5` is legal on this schema and 1 of the 9
    /// sites is a user-editable setting.
    pub fn millis(&self) -> f64 {
        self.0.0.as_f64().unwrap_or(f64::NAN)
    }
}

impl Serialize for DurationMillis {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for DurationMillis {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        JsNumber::deserialize(deserializer).map(DurationMillis)
    }
}

/// `Schema.Option(value)` — 21 sites, and an Effect `Option` crossing the wire in
/// Effect's own internal spelling: `{"_tag":"Some","value":…}` and `{"_tag":"None"}`.
/// There is no `_id` on the wire; it lives on the prototype where `JSON.stringify` cannot
/// see it, and the shipped codec never writes it.
///
/// Not interchangeable with [`Nullable`]: this rejects a bare value and a bare `null`
/// alike, so a client sending the wrong one is a client that has not been ported.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum EffectOption<T> {
    Some { value: T },
    None,
}

impl<T> EffectOption<T> {
    pub fn is_none(&self) -> bool {
        matches!(self, EffectOption::None)
    }

    pub fn into_option(self) -> Option<T> {
        match self {
            EffectOption::Some { value } => Some(value),
            EffectOption::None => None,
        }
    }
}

impl<T> From<Option<T>> for EffectOption<T> {
    fn from(value: Option<T>) -> Self {
        match value {
            Some(value) => EffectOption::Some { value },
            None => EffectOption::None,
        }
    }
}

/// `Schema.DateTimeUtcFromString` — 42 sites, and the only date form that has a JSON
/// representation at all. A bare `Schema.DateTimeUtc` is `DateTime`↔`DateTime`: nothing
/// arriving as JSON can satisfy it, so every contract field that actually crosses the
/// wire is this variant.
///
/// Decoding accepts any RFC 3339 offset, with or without a fraction, and normalises to
/// UTC. Encoding always writes the `Z` form with exactly three fraction digits, which is
/// what `DateTime.Utc`'s `toJSON` emits — not `to_rfc3339`, which would widen to
/// nanoseconds when the value happens to carry them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DateTimeUtc(pub i64);

impl DateTimeUtc {
    /// The Type side of the codec: milliseconds since the Unix epoch.
    pub fn epoch_milliseconds(self) -> i64 {
        self.0
    }
}

impl Serialize for DateTimeUtc {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let stamp = chrono::DateTime::from_timestamp_millis(self.0).ok_or_else(|| {
            serde::ser::Error::custom(format!("{} is out of range for a timestamp", self.0))
        })?;
        serializer.serialize_str(&stamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    }
}

impl<'de> Deserialize<'de> for DateTimeUtc {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct StampVisitor;
        impl Visitor<'_> for StampVisitor {
            type Value = DateTimeUtc;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an ISO-8601 timestamp")
            }
            // `deserialize_str` and no `visit_u64`: a bare epoch-millis number is
            // rejected, which is what the shipped codec does.
            fn visit_str<E: de::Error>(self, value: &str) -> Result<DateTimeUtc, E> {
                let parsed = chrono::DateTime::parse_from_rfc3339(value)
                    .map_err(|_| E::invalid_value(Unexpected::Str(value), &self))?;
                Ok(DateTimeUtc(parsed.timestamp_millis()))
            }
        }
        deserializer.deserialize_str(StampVisitor)
    }
}

/// `Schema.Defect()` — 59 sites, and every one of them calls it with **no options**, so
/// `includeStack` is false and `excludeCause` is false at all 59. It is one behaviour, not
/// a family, and the port does not carry the options.
///
/// **This is not an identity codec**, which is the trap. A value that looks like an error
/// is rebuilt through a JavaScript `Error` on the way in, so decoding `{message:"boom"}`
/// and re-encoding it yields `{name:"Error",message:"boom"}` — a key that never arrived.
/// The rebuild is lossy in the other direction too: `extra` is dropped because an `Error`
/// carries only `name`, `message` and `cause`, and a `stack` key is read on decode but
/// never written back, since `includeStack` is false everywhere.
///
/// What counts as an error is narrow: an **object** whose `message` is a **string**.
/// `{message:1}` is held verbatim, and so is an array that merely *contains* something
/// error-shaped — the recursion follows `cause` and nothing else, so
/// `{detail:{message:"inner"}}` is never descended into.
#[derive(Clone, Debug, PartialEq)]
pub enum Defect {
    /// The rebuilt error. `name` is always present on the wire: a missing name, a
    /// non-string one and an explicit `"Error"` all normalise to `"Error"`.
    Error {
        name: String,
        message: String,
        /// `Object.hasOwn(input, "cause")`, **not** `cause !== undefined`. An explicit
        /// `"cause": null` is a present key and survives the round trip as
        /// `Some(Other(null))`; only an absent key is `None`.
        cause: Option<Box<Defect>>,
    },
    /// Anything the rebuild did not recognise, held exactly as it arrived.
    Other(serde_json::Value),
}

impl Defect {
    /// The message a decoded [`Defect::Error`] carries, for the callers that only need to
    /// log it.
    pub fn message(&self) -> Option<&str> {
        match self {
            Defect::Error { message, .. } => Some(message),
            Defect::Other(_) => None,
        }
    }
}

impl Serialize for Defect {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Defect::Other(value) => value.serialize(serializer),
            Defect::Error {
                name,
                message,
                cause,
            } => {
                // A map rather than a struct because `cause` is written only when the key
                // was present, and `serialize_map` is what makes that conditional.
                let mut map = serializer.serialize_map(Some(2 + usize::from(cause.is_some())))?;
                map.serialize_entry("name", name)?;
                map.serialize_entry("message", message)?;
                if let Some(cause) = cause {
                    map.serialize_entry("cause", cause)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for Defect {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Buffering through `Value` for the same reason as `Maybe`: it asks for
        // `deserialize_any`, so a missing key stays missing instead of decoding to a
        // defect.
        Ok(decode_defect(serde_json::Value::deserialize(deserializer)?))
    }
}

fn decode_defect(value: serde_json::Value) -> Defect {
    match value {
        serde_json::Value::Object(fields) => decode_json_error(fields),
        // `isObject` excludes arrays, so `[1,{message:"x"}]` is held verbatim rather than
        // scanned for a member that looks like an error.
        other => Defect::Other(other),
    }
}

fn decode_json_error(mut fields: serde_json::Map<String, serde_json::Value>) -> Defect {
    // `typeof input["message"] === "string"` is the whole recognition test. It is a peek
    // rather than a `remove`, because the reject path has to hand the object back exactly
    // as it arrived — `{message:1}` keeps its `message`.
    let Some(message) = fields
        .get("message")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
    else {
        return Defect::Other(serde_json::Value::Object(fields));
    };
    // `typeof input.name === "string" && input.name !== "Error"`, and everything else
    // falls through to the `new Error(…)` default.
    let name = match fields.get("name").and_then(serde_json::Value::as_str) {
        Some(name) if name != "Error" => name.to_owned(),
        _ => "Error".to_owned(),
    };
    let cause = fields
        .remove("cause")
        .map(|cause| Box::new(decode_defect(cause)));
    // Whatever is left in `fields` — `extra`, `stack` — is dropped here by never being
    // read, which is the lossiness the doc comment describes.
    Defect::Error {
        name,
        message,
        cause,
    }
}

/// `Schema.Record(key, value)` — 23 sites, and not a plain map, because the **key is a
/// schema**: `LoadBalancingWeights` (`settings.ts:314`) keys on `TrimmedNonEmptyString` and
/// `providerModelPreferences` (`settings.ts:447`) keys on `ProviderInstanceId`. So a key is
/// trimmed and checked like any other value, and `{" a ":50}` crosses back as `{"a":50}`.
///
/// Two keys that trim to the same string collapse silently, the later one winning — the
/// shipped codec reports no collision, so neither does this.
///
/// The asymmetry that a `BTreeMap` field cannot express is what failure does, and it
/// differs by direction:
///
/// - **Decoding** rejects the whole record for a bad key *or* a bad value.
/// - **Encoding** rejects the whole record for a bad value, but a key that cannot be
///   encoded drops **only its own entry**: `{"":50, b:60}` encodes to `{"b":60}`, and both
///   orders of that input give the same result.
///
/// Keys are held in a `BTreeMap`, so the wire order is sorted rather than insertion order.
/// No JSON client may depend on key order, and the golden does not assert it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record<K, V>(pub std::collections::BTreeMap<K, V>);

impl<K, V> Default for Record<K, V> {
    fn default() -> Self {
        Record(std::collections::BTreeMap::new())
    }
}

impl<K, V> Record<K, V> {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl<K: Serialize + Ord, V: Serialize> Serialize for Record<K, V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            // Probing the key rather than trusting `serialize_entry` is what makes the
            // drop possible at all: once `serialize_entry` has failed the map is half
            // written and cannot be continued, so the failure has to be found before the
            // entry is started.
            if serde_json::to_value(key).is_ok() {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}

impl<'de, K: Deserialize<'de> + Ord, V: Deserialize<'de>> Deserialize<'de> for Record<K, V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Record(std::collections::BTreeMap::deserialize(
            deserializer,
        )?))
    }
}

/// `Schema.Never` — the default `error` schema of `Rpc.make`, and therefore the error
/// channel of all 24 streaming methods, since `stream: true` moves the real error *inside*
/// the success schema and leaves `Never` behind. Measured against the shipped codec: it
/// rejects every input with `InvalidType`, **`undefined` included** — which is exactly
/// where it differs from `Schema.Void`, which accepts everything and discards it.
///
/// The empty enum is the port rather than a stand-in for one. A value of this type cannot
/// exist, and that impossibility is the whole claim: a handler typed against it cannot
/// produce an error on that channel, and the compiler enforces it. `Serialize` has no case
/// to write, and the visitor implements no `visit_*` method, so serde's defaults turn every
/// input into an invalid-type error.
pub enum Never {}

impl Serialize for Never {
    fn serialize<S: Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
        match *self {}
    }
}

impl<'de> Deserialize<'de> for Never {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct NeverVisitor;
        impl Visitor<'_> for NeverVisitor {
            type Value = Never;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("nothing: this channel cannot carry a value")
            }
        }
        deserializer.deserialize_any(NeverVisitor)
    }
}
