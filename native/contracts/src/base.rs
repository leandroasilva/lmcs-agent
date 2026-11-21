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
//!   `Schema.FiniteFromString` is the exception that proves the rule: its Encoded side is a
//!   *string*, `"Infinity"` is spellable, and the finite gate really does reject it. Both
//!   directions are JavaScript's own conversions, not Rust's — `Number("")` is `0`,
//!   `Number("0x10")` is `16`, and `String(1e21)` is `"1e+21"` where `f64::to_string` writes
//!   twenty-one digits. See [`FiniteFromString`].
//! - `Schema.DurationFromMillis` is [`JsNumber`] on the wire; only its Type side differs.
//! - `Schema.Defect()` is **not** an identity codec, and its Type side is `unknown`.
//!   See [`Defect`].
//! - `Schema.TaggedStruct` and `Schema.TaggedError` are the same thing on the wire: an
//!   internally tagged `_tag` map. serde's `#[serde(tag = "_tag")]` is already it, so
//!   neither needs a type here — the 150 `TaggedError` sites collapse into the enum
//!   pattern the payload schemas use anyway.
//! - `Schema.Record` keys on a **schema**, not on a string, and what a bad key costs is
//!   decided by the *shape of that key schema* rather than by the record: a key schema
//!   containing a `decodeTo` (`TrimmedNonEmptyString`, every `makeEntityId` brand) fails the
//!   whole record, and a key schema that is only predicates over `string` drops the entry
//!   and keeps the rest. Both occur on live wire fields. See [`Record`] and [`KeyRejection`].
//! - The four numeric and text bounds `GreaterThan`/`LessThan`/`MaxLength` do not cover —
//!   `isGreaterThanOrEqualTo` (26 sites), `isLessThanOrEqualTo` (14), `isTrimmed` (6) and
//!   `isMaxProperties` (2) — are [`AtLeast`], [`AtMost`], [`NoEdgeWhitespace`] and
//!   [`MaxProperties`]. `isTrimmed` is the one to be careful with: it **refuses** edge
//!   whitespace, where `Trimmed` removes it, and the two spellings sit in adjacent lines of
//!   the same files.
//! - `Schema.Void` is declared `Bottom<void, void>` and still accepts *every* input,
//!   discarding it. `Schema.Unknown` is identity in both directions, so it is plain
//!   `serde_json::Value` and needs no type here. An untagged `Schema.Union` is
//!   `#[serde(untagged)]`; only the rejection's tag differs.
//! - `Schema.Never` is the empty enum, and unlike `Void` it really does reject everything
//!   — `undefined` included. It is the default `error` schema of `Rpc.make`, so it is the
//!   error channel of every streaming method. See [`Never`].
//! - `Schema.Uint8Array` is the crate's first type with **no JSON spelling at all**. It is a
//!   `Declaration`, so its Encoded side *is* the byte sequence and both directions are
//!   identity — measured: `decode(bytes) === bytes` and `encode(bytes) === bytes`. And it
//!   rejects every JSON value that could stand for one: the array `[1,2,3]`, a base64 string,
//!   `null`, and notably the `{"0":1,"1":2,"2":3}` object that `JSON.stringify` writes for it.
//!   So a round trip through JSON is not merely lossy, it is impossible. Its one site
//!   (`ipc.ts:1093`) never goes through JSON: it crosses `ipcMain.handle`, which is structured
//!   clone. In Rust that channel is an in-process call, so neither impl runs — but the type
//!   must still not be silently encodable. See [`Bytes`]. (`Buffer` decodes too and renders as
//!   a *second* JSON spelling, `{"type":"Buffer","data":[…]}`; it is deliberately not
//!   modelled, since modelling it would add a wire form the port cannot reach.)
//! - `RpcSchema.Stream` is **not a codec**. It is `Schema.declare(Stream.isStream)` with
//!   the element schemas hanging off it, so it never reaches the wire and needs no type
//!   here; framing stream chunks is the transport's job.
//! - `Schema.makeFilter` needs no type either: it is [`Check`] with a message the schema
//!   author wrote, which is what [`Check::describe`] exists to carry. The trap is the
//!   JavaScript idiom it is built from — `shortcut.metaKey || … || "requires a modifier."`
//!   — where the trailing **string is a failure with that message**, not a truthy value that
//!   passes. `.check` gates the outbound direction as well as the inbound one.
//! - `Schema.decodeTo` is likewise not a primitive: it is the case where the Encoded and Type
//!   sides differ, and in Rust that is simply two hand-written impls rather than one derive.
//!   The crate has been porting it since the first fatia — `TrimmedString`,
//!   `DurationFromMillis` and the three forward-compatible helpers are all `decodeTo` — and
//!   the settings fields add the flavour none of those had: an encode that is **not** the
//!   decode backwards. `makeBinaryPathSetting` maps `""` to a fallback on the way in and
//!   writes `""` on the way out, and `LegacyConfirmQuit` cannot encode `"double-click"` at
//!   all (its union member never runs, because the canonical member answers first).
//! - `Schema.Codec<T>` — 22 sites, 19 of them in `ipc.ts` — is a *type* annotation, not a
//!   construction: measured through `ContextMenuItemSchema`, whose `.ast._tag` is `Objects`
//!   like the struct it annotates. So there is nothing to port and nothing gained by
//!   pretending there is. The trap it sets is the belief that naming a codec as `Codec<A, A>`
//!   makes it symmetric: `TrimmedString` *is* `Codec<string, string>` and still trims one way
//!   and refuses the other. Asymmetry lives in the transforms, never in the annotation.
//! - `Schema.withDecodingDefault` — 205 sites, most of `settings.ts` — makes the key optional
//!   on both sides and **substitutes the default for an absent key only**. A present value of
//!   the wrong shape still fails, so the port is `#[serde(default = …)]` on the field and
//!   never an `unwrap_or` over the value: the second would turn a corrupt settings file into
//!   a file of defaults, silently.
//! - `Schema.withConstructorDefault` — 1 site (`providerRuntime.ts:489`) — has **no wire
//!   effect at all**: measured against a plain `Schema.optional(Schema.Boolean)` on seven
//!   inputs in both directions, every result is identical. It differs only in `.make({})`,
//!   which fills the key in. So it is a constructor obligation, not a codec one, and the
//!   Rust field is the same `Absent<bool>` the plain optional gets.
//! - `Schema.annotateKey` and `Schema.annotate` (41 sites, all of them form metadata for the
//!   settings screen) have no wire effect at all — measured through a field whose
//!   `annotateKey` carries three annotations at once. They are a UI obligation, not a codec
//!   one. `Schema.deepPartial` has 1 site repo-wide and it is a comment saying it is not
//!   used, so there is nothing to port.
//!
//! The TypeScript-only shapes collapse here, and that is deliberate rather than a gap:
//! `Schema.optionalKey` differs from `Schema.optional` in how an own key holding `undefined`
//! is treated, and it differs **in both directions** — `optional` accepts `{v: undefined}` and
//! re-encodes without the key, `optionalKey` rejects it outright. Measured on a pair of
//! otherwise identical structs, because the difference is not the encode half alone.
//! `ForwardCompatibleOptional` differs from `OmittedWhenNull` only in whether `null` is in the
//! Type. Rust has no `undefined`, so both pairs land on the same representation: a field the
//! caller can leave out, which cannot be conjured into being present-but-unknown. Cases the TS
//! type system rejects before the codec runs — an encode of `"z"` against `Literals(["a","b"])`
//! — have no Rust input at all.

use serde::de::{self, DeserializeOwned, Deserializer, SeqAccess, Unexpected, Visitor};
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

/// `NonNegativeInt`: an integer `>= 0`.
///
/// The integer filter is `Number.isSafeInteger`, not serde's integer parse, so `8e1` is
/// accepted and `9007199254740992` is refused — see [`bounded_int!`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NonNegativeInt(pub i64);

/// `PositiveInt`: an integer `>= 1`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PositiveInt(pub i64);

/// `PortSchema`: an integer in `1..=65535`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Port(pub u16);

/// Builds the three `Schema.Int.check(isGreaterThanOrEqualTo(N))` newtypes above.
///
/// Both branches of the divergence that matters are measured, so the decode goes through
/// [`JsNumber`] and narrows afterwards instead of reading `<$inner>::deserialize` directly:
/// a plain `i64` read **accepts** `9007199254740992` (which `Number.isSafeInteger` refuses)
/// and **rejects** `8e1` (which the codec sees as 80). The first is the dangerous direction —
/// a Rust server taking a payload a TypeScript one turns away, failing nothing.
macro_rules! bounded_int {
    ($name:ident, $inner:ty, $range:expr) => {
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
                let number = JsNumber::deserialize(deserializer)?;
                if !<SafeInt as Check<JsNumber>>::passes(&number) {
                    return Err(de::Error::invalid_value(
                        Unexpected::Float(number.0.as_f64().unwrap_or_default()),
                        &concat!(stringify!($name), " (a safe integer)"),
                    ));
                }
                // `SafeInt` has already proved the value integral and inside `2^53-1`, so the
                // only `i64` conversion left to fail is `u16`'s range.
                let integral = number.0.as_f64().unwrap_or_default() as i64;
                let Some(value) = <$inner>::try_from(integral).ok() else {
                    return Err(de::Error::invalid_value(
                        Unexpected::Signed(integral),
                        &stringify!($name),
                    ));
                };
                let in_range: fn(&$inner) -> bool = $range;
                if !in_range(&value) {
                    return Err(de::Error::invalid_value(
                        Unexpected::Signed(integral),
                        &stringify!($name),
                    ));
                }
                Ok($name(value))
            }
        }
    };
}

bounded_int!(NonNegativeInt, i64, |value: &i64| *value >= 0);
bounded_int!(PositiveInt, i64, |value: &i64| *value >= 1);
bounded_int!(Port, u16, |value: &u16| *value >= 1);

/// One member's literal tag inside an untagged union — `Schema.TaggedStruct`'s first argument
/// reached through a `Schema.Union`.
///
/// A shared Rust enum cannot stand in for these: `#[serde(untagged)]` resolves a union by
/// trying members **in declaration order** and taking the first that deserializes, so an enum
/// holding all eight `type` values lets a thin member like `closed` swallow an `error` event
/// and re-serialize it without its `message`. TypeScript picks the member by its tag and
/// cannot make that mistake. Measured on the terminal event union, where `{type:"error",
/// message:"spawn failed"}` decoded to a closed event. Each member therefore gets its own
/// unit struct, which only deserializes its own string and so cannot match another's input.
#[macro_export]
macro_rules! wire_tag {
    ($name:ident, $wire:literal) => {
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
        pub struct $name;

        impl ::serde::Serialize for $name {
            fn serialize<S: ::serde::Serializer>(
                &self,
                serializer: S,
            ) -> ::std::result::Result<S::Ok, S::Error> {
                serializer.serialize_str($wire)
            }
        }

        impl<'de> ::serde::Deserialize<'de> for $name {
            fn deserialize<D: ::serde::Deserializer<'de>>(
                deserializer: D,
            ) -> ::std::result::Result<Self, D::Error> {
                let text = <String as ::serde::Deserialize<'de>>::deserialize(deserializer)?;
                if text == $wire {
                    Ok($name)
                } else {
                    Err(::serde::de::Error::invalid_value(
                        ::serde::de::Unexpected::Str(&text),
                        &$wire,
                    ))
                }
            }
        }
    };
}

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

/// `Schema.optional(Schema.NullOr(value))` — the field may be left out, may be `null`, or
/// may hold the value, and the three states are not interchangeable.
///
/// Neither half alone can spell it. [`Absent`] routes an explicit `null` through
/// `visit_none` and **fails**, which is the right rule for `Schema.optional` alone and the
/// wrong one here; [`Nullable`] accepts the null but makes the key required. So this is a
/// third type rather than a nesting of the two: `Absent<Nullable<T>>` holds the three states
/// but cannot decode them, since the outer `Absent` never reaches the inner one on a null.
///
/// Declare it as `#[serde(default, skip_serializing_if = "Optional::is_none")]`. Not
/// [`EffectOption`], which is `Schema.Option` and crosses in Effect's own internal spelling.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Optional<T>(pub Absent<Nullable<T>>);

impl<T> Optional<T> {
    pub fn is_none(&self) -> bool {
        self.0.is_none()
    }

    /// The value, if the key was present and was not null.
    pub fn into_option(self) -> Option<T> {
        self.0
            .into_option()
            .and_then(|nullable| nullable.into_option())
    }
}

impl<T: Serialize> Serialize for Optional<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // A Rust `None` here means "the key is absent", which `is_none` skips; a present
        // null is `Absent(Some(Nullable(None)))` and has to reach the wire as `null`.
        self.0.serialize(serializer)
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Optional<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = serde_json::Value::deserialize(deserializer)?;
        if raw.is_null() {
            return Ok(Optional(Absent(Some(Nullable(None)))));
        }
        Ok(Optional(Absent(Some(Nullable(Some(
            T::deserialize(raw).map_err(de::Error::custom)?,
        ))))))
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

/// Anything the numeric predicates can measure, which is the same idea as [`Length`] one
/// trait over: `isInt`, `isGreaterThan` and friends are spelled over the *number*, so they
/// apply equally to a bare [`JsNumber`] and to a [`FiniteFromString`] that decoded one out
/// of a string. Without this the six predicates would each need a second impl.
pub trait Numeric {
    fn as_number(&self) -> &serde_json::Number;
}

impl Numeric for JsNumber {
    fn as_number(&self) -> &serde_json::Number {
        &self.0
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

impl<T: Eq, C: Check<T>> Eq for Checked<T, C> {}

// A checked newtype is also a `Record` key, and `Record` orders its keys, so the ordering
// has to follow the inner value rather than be refused. The check plays no part in any of
// these three, which is the same reason [`PartialEq`] above ignores it: two values that
// differ only in whether they would pass are still equal, and passing is the `Serialize`
// impl's business.
impl<T: PartialOrd, C: Check<T>> PartialOrd for Checked<T, C> {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        self.0.partial_cmp(&other.0)
    }
}

impl<T: Ord, C: Check<T>> Ord for Checked<T, C> {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.cmp(&other.0)
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

/// `Schema.String.check(isNonEmpty())` — the **untrimmed** sibling of [`NonEmpty`], and the
/// spelling server→client payloads use for ids they generated themselves.
///
/// The difference is wire-visible and it is not cosmetic: `"  "` is a valid `threadId` here
/// because two spaces are non-empty, where `TrimmedNonEmptyString` refuses it. So the two
/// cannot share a type. `Schema.isNonEmpty` over an untransformed string is a length
/// predicate measured in UTF-16 units, which is why no new check is needed for it.
pub type BareNonEmpty = Checked<String, MinLength<1>>;

/// `Schema.Int`, which is [`SafeInt`] and nothing else: the value stays a JSON number, so
/// `1.0` and `1e3` are integers and `2^53` is not.
pub type Int = Checked<JsNumber, SafeInt>;

/// `Schema.Int.check(isGreaterThanOrEqualTo(MIN)).check(isLessThanOrEqualTo(MAX))` — the
/// two-`.check` spelling `terminal.ts:13` uses for a column count. Both bounds are
/// inclusive, and the integer filter runs **before** them, which is why `1.5` fails at the
/// type layer rather than at the bracket.
pub type BoundedInt<const MIN: i64, const MAX: i64> =
    Checked<JsNumber, (SafeInt, (AtLeast<MIN>, AtMost<MAX>))>;

impl<const MIN: i64, const MAX: i64> BoundedInt<MIN, MAX> {
    /// The integer the wire number stands for. Only reachable through a decode or [`new`],
    /// both of which have run the bracket, so no range check happens here.
    ///
    /// Through `f64` rather than `serde_json::Number::as_i64`, because the latter answers
    /// `None` for a float-typed number: `8e1` is a legal column count — `Number.isSafeInteger`
    /// sees 80 — and `as_i64` would drop a value the codec accepts.
    pub fn as_i64(&self) -> i64 {
        self.0
            .0
            .as_f64()
            .expect("SafeInt rejects anything not finite and integral") as i64
    }

    /// Build from a Rust integer, which is the one case where the bracket has to be
    /// re-checked: [`Checked::wrap`] is lax on purpose, so a caller that skipped this could
    /// hold an out-of-range size and only find out when serialization refused to write it.
    pub fn new(value: i64) -> Option<Self> {
        (MIN..=MAX)
            .contains(&value)
            .then(|| Checked::wrap(JsNumber(serde_json::Number::from(value))))
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

impl<T: Numeric> Check<T> for SafeInt {
    fn passes(value: &T) -> bool {
        value
            .as_number()
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

impl<const N: i64, T: Numeric> Check<T> for GreaterThan<N> {
    fn passes(value: &T) -> bool {
        value
            .as_number()
            .as_f64()
            .is_some_and(|number| number > N as f64)
    }

    fn describe() -> String {
        format!("a number greater than {N}")
    }
}

/// `Schema.isLessThan(N)` — 2 sites, both `isLessThan(65536)` on a port. Exclusive, so
/// `65536` itself is rejected.
pub struct LessThan<const N: i64>;

impl<const N: i64, T: Numeric> Check<T> for LessThan<N> {
    fn passes(value: &T) -> bool {
        value
            .as_number()
            .as_f64()
            .is_some_and(|number| number < N as f64)
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

/// `Number(text)` — ECMAScript's string-to-number conversion, which is what
/// `SchemaTransformation.numberFromString` decodes through. `None` stands for `NaN`.
///
/// Not `str::parse`, and the differences are all reachable from a query string: JavaScript
/// trims first and reads `""` as `0`, accepts a leading `+`, a trailing `.`, and `0x`/`0b`/`0o`
/// radix prefixes — but only without a sign, so `Number("-0x10")` is `NaN`. It refuses the
/// underscores a JavaScript *literal* allows, and it refuses `inf`/`NaN` spellings that
/// `str::parse` would take. Measured against the shipped codec on 36 inputs.
fn js_number_from_str(text: &str) -> Option<f64> {
    let text = js_trim(text);
    if text.is_empty() {
        return Some(0.0);
    }
    let (negative, body) = match text.as_bytes()[0] {
        b'+' => (false, &text[1..]),
        b'-' => (true, &text[1..]),
        _ => (false, text),
    };
    if body == "Infinity" {
        return Some(if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        });
    }
    if !negative {
        for (prefix, radix) in [
            ("0x", 16),
            ("0X", 16),
            ("0b", 2),
            ("0B", 2),
            ("0o", 8),
            ("0O", 8),
        ] {
            if let Some(digits) = body.strip_prefix(prefix) {
                return radix_value(digits, radix);
            }
        }
    }
    if !is_decimal_literal(body) {
        return None;
    }
    text.parse::<f64>().ok()
}

/// The `StrDecimalLiteral` grammar: digits with an optional fraction and an optional
/// exponent, or a fraction with no leading digits. At least one digit somewhere, which is
/// what refuses `"."`, and at least one after the `e`, which is what refuses `"1e+"`.
fn is_decimal_literal(body: &str) -> bool {
    let bytes = body.as_bytes();
    let mut index = 0;
    let mut digits = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
        digits += 1;
    }
    if index < bytes.len() && bytes[index] == b'.' {
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return false;
    }
    if index < bytes.len() && bytes[index] | 0x20 == b'e' {
        index += 1;
        if index < bytes.len() && (bytes[index] == b'+' || bytes[index] == b'-') {
            index += 1;
        }
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == start {
            return false;
        }
    }
    index == bytes.len()
}

/// A radix literal's value, rounded to an `f64` the way JavaScript rounds it.
///
/// Every radix `Number()` accepts is a power of two, so the value is exactly a mantissa
/// times a power of two and no decimal conversion is needed. Digits past what a `u128`
/// holds are dropped into a sticky bit rather than accumulated, which keeps the rounding
/// exact: 128 bits is far more than the 53 the mantissa is rounded to, so nothing that
/// could change the answer is lost.
fn radix_value(digits: &str, radix: u32) -> Option<f64> {
    if digits.is_empty() {
        return None;
    }
    let bits = radix.trailing_zeros();
    let mut mantissa: u128 = 0;
    let mut dropped = 0i32;
    let mut sticky = false;
    for character in digits.chars() {
        let digit = character.to_digit(radix)?;
        if mantissa >> (128 - bits) != 0 {
            dropped += bits as i32;
            sticky |= digit != 0;
        } else {
            mantissa = (mantissa << bits) | u128::from(digit);
        }
    }
    if mantissa == 0 {
        return Some(0.0);
    }
    let width = 128 - mantissa.leading_zeros();
    if width > 53 {
        let shift = width - 53;
        let halfway = (mantissa >> (shift - 1)) & 1;
        sticky |= mantissa & ((1u128 << (shift - 1)) - 1) != 0;
        mantissa >>= shift;
        dropped += shift as i32;
        // Round half to even, and a carry out of the top bit renormalises the exponent.
        if halfway == 1 && (sticky || mantissa & 1 == 1) {
            mantissa += 1;
            if mantissa == 1u128 << 53 {
                mantissa >>= 1;
                dropped += 1;
            }
        }
    }
    Some(scale_by_power_of_two(mantissa as f64, dropped))
}

/// `mantissa * 2^exponent`, in steps that never build a subnormal intermediate.
///
/// `2f64.powi` is not usable here: for a negative exponent it computes a reciprocal, and
/// `2^1074` overflows to infinity, so the smallest scale would come back as `0` and take a
/// representable result down with it.
fn scale_by_power_of_two(mut value: f64, mut exponent: i32) -> f64 {
    while exponent > 0 {
        let step = exponent.min(1023);
        value *= f64::from_bits(u64::from(1023 + step as u32) << 52);
        exponent -= step;
        if value.is_infinite() {
            return value;
        }
    }
    while exponent < 0 {
        let step = (-exponent).min(1022);
        value *= f64::from_bits(u64::from(1023 - step as u32) << 52);
        exponent += step;
        if value == 0.0 {
            return value;
        }
    }
    value
}

/// `String(number)` — ECMAScript's `Number::toString`, which is not `f64::to_string`.
///
/// Both pick the shortest digits that round-trip, but JavaScript switches to exponential
/// notation outside `1e-6 … 1e21` and Rust never does, so `1e21` comes out as
/// `"1000000000000000000000"` from `to_string` and as `"1e+21"` from the shipped codec.
/// The four branches below are the specification's own, over the digit count `k` and the
/// decimal point position `n`.
fn js_number_to_string(value: f64) -> String {
    // `String(-0)` is `"0"`, so the sign is dropped with the value.
    if value == 0.0 {
        return "0".to_owned();
    }
    let negative = value < 0.0;
    let exponential = format!("{:e}", value.abs());
    let (mantissa, exponent) = exponential.split_once('e').expect("LowerExp writes an e");
    let exponent: i32 = exponent.parse().expect("LowerExp writes an integer");
    let digits: String = mantissa
        .chars()
        .filter(|character| *character != '.')
        .collect();
    let count = digits.len() as i32;
    let point = exponent + 1;
    let mut text = String::new();
    if count <= point && point <= 21 {
        text.push_str(&digits);
        text.push_str(&"0".repeat((point - count) as usize));
    } else if 0 < point && point <= 21 {
        text.push_str(&digits[..point as usize]);
        text.push('.');
        text.push_str(&digits[point as usize..]);
    } else if -6 < point && point <= 0 {
        text.push_str("0.");
        text.push_str(&"0".repeat(-point as usize));
        text.push_str(&digits);
    } else {
        text.push_str(&digits[..1]);
        if count > 1 {
            text.push('.');
            text.push_str(&digits[1..]);
        }
        text.push('e');
        text.push(if point > 0 { '+' } else { '-' });
        text.push_str(&(point - 1).abs().to_string());
    }
    if negative { format!("-{text}") } else { text }
}

/// `Schema.FiniteFromString` — 1 site, the `turnLimit` query field of the windowed thread
/// snapshot (`environmentHttp.ts:517`). Its sibling `Schema.NumberFromString` has **no**
/// site in the contracts, so only the finite half is ported.
///
/// This is the one place where the `Finite`/`Number` collapse recorded on [`JsNumber`] does
/// **not** hold. There, `Infinity` and `NaN` cannot cross the wire because `JSON.stringify`
/// renders both as `null`. Here the Encoded side is a *string*, and `"Infinity"` is a
/// perfectly spellable JSON string — measured, `NumberFromString` decodes it to `Infinity`
/// while `FiniteFromString` refuses it. So the finite gate is a real inbound rule.
///
/// Outbound it is not: the Type side is a [`JsNumber`], which cannot hold a non-finite
/// value in the first place, so `Serialize` has nothing to reject. The shipped encoder does
/// reject `Infinity`, and that rejection is unreachable from Rust for the same reason
/// `Bytes` cannot be serialized — the type makes the bad state unconstructible.
///
/// Holds the number rather than the text because the checks at the one site measure the
/// number: `Checked<FiniteFromString, (SafeInt, AtLeast<1>)>` is the whole field, and both
/// predicates run on **encode** as well as decode — measured, `{turnLimit: 0}` and
/// `{turnLimit: 1.5}` are refused on the way out.
#[derive(Clone, Debug, PartialEq)]
pub struct FiniteFromString(pub JsNumber);

impl Numeric for FiniteFromString {
    fn as_number(&self) -> &serde_json::Number {
        &self.0.0
    }
}

impl Serialize for FiniteFromString {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let number = self.0.0.as_f64().ok_or_else(|| {
            serde::ser::Error::custom("a string that will be decoded as a finite number")
        })?;
        serializer.serialize_str(&js_number_to_string(number))
    }
}

impl<'de> Deserialize<'de> for FiniteFromString {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FiniteVisitor;
        impl Visitor<'_> for FiniteVisitor {
            type Value = FiniteFromString;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a string that will be decoded as a finite number")
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<FiniteFromString, E> {
                let number = js_number_from_str(value)
                    .filter(|number| number.is_finite())
                    .and_then(serde_json::Number::from_f64)
                    .ok_or_else(|| {
                        de::Error::custom("a string that will be decoded as a finite number")
                    })?;
                Ok(FiniteFromString(JsNumber(number)))
            }
        }
        deserializer.deserialize_str(FiniteVisitor)
    }
}

/// `Schema.isBetween({minimum, maximum})` — 24 sites, inclusive at both ends and all with
/// integer bounds, so the bounds fit in a const parameter and the value does not.
pub struct Between<const MIN: i64, const MAX: i64>;

impl<const MIN: i64, const MAX: i64, T: Numeric> Check<T> for Between<MIN, MAX> {
    fn passes(value: &T) -> bool {
        value
            .as_number()
            .as_f64()
            .is_some_and(|number| number >= MIN as f64 && number <= MAX as f64)
    }

    fn describe() -> String {
        format!("a number between {MIN} and {MAX}")
    }
}

/// `Schema.isGreaterThanOrEqualTo(N)` — 26 sites, the most-used numeric predicate in the
/// repo and the **inclusive** half of a pair whose exclusive twin is [`GreaterThan`].
///
/// The two are not interchangeable and the difference is on the wire: 20 of the 26 sites
/// sit at `0` or `1`, where the exclusive form rejects exactly one more value than the
/// inclusive one. `PositiveInt` is `Int.check(isGreaterThanOrEqualTo(1))` and *accepts* 1;
/// `Schema.Int.check(isGreaterThan(0))` — which appears separately, 18 times, e.g. on a
/// timeout in milliseconds (`previewAutomation.ts:20`) — rejects it. Porting one as the
/// other shifts the bound by a unit, which is invisible in a test that only tries
/// obviously-valid values.
///
/// Compared as `f64` for the same reason [`GreaterThan`] is: 2 sites (`relay.ts:50`, `:51`)
/// bound a `Schema.Int` to `18` and `24`, and `assets.ts:92`/`orchestration.ts:322` put a
/// floor under a schema that is `Number` rather than `Int`, so a fractional value is legal
/// underneath them and integer-ness is [`SafeInt`]'s business, not this one's.
pub struct AtLeast<const N: i64>;

impl<const N: i64, T: Numeric> Check<T> for AtLeast<N> {
    fn passes(value: &T) -> bool {
        value
            .as_number()
            .as_f64()
            .is_some_and(|number| number >= N as f64)
    }

    fn describe() -> String {
        format!("a value greater than or equal to {N}")
    }
}

/// `Schema.isLessThanOrEqualTo(N)` — 14 sites, the inclusive twin of [`LessThan`].
///
/// Every bound is a real maximum rather than a formality: `1000` and `500` columns and rows
/// (`terminal.ts:13-17`), `65_535` (`relay.ts:176`), `60_000` milliseconds
/// (`previewAutomation.ts:21`), and four named constants
/// (`PROJECT_SEARCH_ENTRIES_MAX_LIMIT`, `PROJECT_SEARCH_CONTENTS_MAX_LIMIT`,
/// `GIT_LIST_BRANCHES_MAX_LIMIT`, `PROVIDER_SEND_TURN_MAX_{IMAGE,FILE}_BYTES`).
///
/// Two sites — `assistantCitations.ts:24` and `:25` — are **dead** and this crate ports
/// them as if they were live, which is the safe direction. `NonNegativeInt` is already
/// `Int.check(isGreaterThanOrEqualTo(0))`, and `Schema.Int` is
/// `Number.isSafeInteger`, so no value can be an integer above `MAX_SAFE_INTEGER` and the
/// `isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)` above it can never be the thing that
/// fails. Measured: `9007199254740992` is refused by the integer check with "Expected an
/// integer", not by this bound. A port that omitted the predicate would agree on every
/// input, so the redundancy is recorded rather than optimized away.
pub struct AtMost<const N: i64>;

impl<const N: i64, T: Numeric> Check<T> for AtMost<N> {
    fn passes(value: &T) -> bool {
        value
            .as_number()
            .as_f64()
            .is_some_and(|number| number <= N as f64)
    }

    fn describe() -> String {
        format!("a value less than or equal to {N}")
    }
}

/// `Schema.isTrimmed()` — 6 sites, and the only text predicate in the repo that **refuses**
/// edge whitespace instead of removing it.
///
/// That makes it the opposite of [`Trimmed`] on the same bytes: `TrimmedString` decodes
/// `" a "` to `"a"`, while `Schema.String.check(Schema.isTrimmed())` fails `" a "` with
/// "Expected a string with no leading or trailing whitespace". A Rust field written as
/// `Trimmed` where the TypeScript spells `check(isTrimmed())` would accept payloads the
/// TypeScript server rejects, silently, and both spellings appear in adjacent lines of the
/// same files — `previewAutomation.ts:14` uses this one while `:16`-adjacent schemas use
/// `TrimmedNonEmptyString`.
///
/// All 6 sites are on a bare `Schema.String` and none is stacked on the trimming transform,
/// so the two never meet; the check is therefore spelled over `String` and not over a
/// trimmed newtype. Four of the 6 chain `isNonEmpty()` immediately after, which is a
/// different pair of rejections: `"   "` fails *this* check in the 5 sites where it comes
/// first, and would fail `isNonEmpty` in the one place it does not
/// (`previewAutomation.ts:14` orders trimmed → non-empty → maxLength).
///
/// Measured against JavaScript's set, not Unicode's — see [`js_trim`], whose two-character
/// disagreement with `str::trim` is exactly what this predicate inherits.
pub struct NoEdgeWhitespace;

impl Check<String> for NoEdgeWhitespace {
    fn passes(value: &String) -> bool {
        let text = value.as_str();
        js_trim(text) == text
    }

    fn describe() -> String {
        "a string with no leading or trailing whitespace".to_owned()
    }
}

/// `Schema.isMaxProperties(N)` — 2 sites, both `Schema.Record(...).check(isMaxProperties(n))`
/// with `n` of `128` (`terminal.ts:24`) and `16` (`providerSetup.ts:79`).
///
/// It counts **entries of the record**, and Effect's own message says "entries", which is
/// where the ordering fact lives: the count runs on the entries the record actually holds,
/// so for a [`LenientKeys`] record a key that was dropped never counts toward the bound.
/// Measured against the shipped codec, with a bound of 4 and a rejecting key: 5 valid keys
/// fail, 4 valid keys plus 1 rejected key **pass**. A port that counted raw JSON keys would
/// reject a payload the TypeScript server accepts, and it would do so on the least likely
/// input — a malformed key arriving alongside a full record.
///
/// The encode direction measures the map as handed over, before any key is dropped, because
/// that is the Type side: 3 keys of which 1 fails the key predicate and a bound of 2
/// **throws**. Same rule as every other check here, arriving by a different route.
pub struct MaxProperties<const N: usize>;

impl<const N: usize, K: Ord, V, Keys: KeyRejection> Check<Record<K, V, Keys>> for MaxProperties<N> {
    fn passes(value: &Record<K, V, Keys>) -> bool {
        value.len() <= N
    }

    fn describe() -> String {
        format!("a value with at most {N} entries")
    }
}

// `Schema.isFinite()` — 1 site (`settings.ts:527`, inside `UsageModelTokenPrice`) — and
// `Schema.isInt()` spelled as its own filter rather than through `Schema.Int`, also 1 site
// (`environmentHttp.ts:517`).
//
// Neither gets a primitive, and the reason is worth keeping beside the census rather than
// losing. `isFinite` **cannot fail on this wire**: `JSON.stringify` renders `Infinity` and
// `NaN` as `null`, and `null` is refused as a number before the filter runs — the same
// vacuity `JsNumber` records for `Schema.Finite` versus `Schema.Number`. A check that can
// never reject is not a codec rule, so `UsageModelTokenPrice` ports as
// `Checked<JsNumber, AtLeast<0>>` and the `isFinite` is left where it is: unobservable.
// `isInt()` is `SafeInt`, which already exists — measured rather than assumed: on
// `Schema.Number.check(isInt())` and on `Schema.Int` alike, `9007199254740991` passes and
// `9007199254740992` fails, so the filter is `Number.isSafeInteger` and not
// `Number.isInteger`. The one site stacks it on [`FiniteFromString`], where it is the
// difference between `"9007199254740993"` decoding to a rounded `9007199254740992` and
// being refused.
//
// `Schema.UndefinedOr` — 1 site (`baseSchemas.ts:56`) — is inside `ForwardCompatibleOptional`,
// which this crate already ports; `Schema.NumberFromString` has no site at all.
//
// The census, counted rather than asserted: 59 distinct `Schema.X` spellings across the 48
// non-test files of `packages/core/src/contracts`. Seven carry no wire form — `Top` (a type),
// `Codec`/`annotate` (annotations erased at runtime), `decodeSync`/`decodeUnknownOption`
// (runtime decode calls, the latter inside the four `ForwardCompatible*`/`OmittedWhenNull`
// helpers already ported), `is` (a type guard, so it belongs to the Rust code that calls it),
// and `deepPartial`, which appears only in a comment at `settings.ts:1500` and has no call
// site. Of the other 52, all but `mutable` are ported or recorded here; `mutable` is a
// type-level marker, measured and recorded in the golden generator beside its two
// `orchestration.ts` sites.

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

/// What [`Record`] does with an entry whose **key** the key schema does not accept, and
/// the one measured fact that decides it: whether the key schema contains a
/// `Schema.decodeTo`.
///
/// Both spellings exist in `contracts`, and the difference is wire-visible, so the choice
/// is per field rather than a policy the port can pick once:
///
/// - A key schema built by **transforming** a string — `TrimmedNonEmptyString`, and every
///   entity id made by `makeEntityId` (`baseSchemas.ts:129`, which is
///   `TrimmedNonEmptyString.pipe(Schema.brand(…))`), so `ProjectId`, `ThreadId`,
///   `EnvironmentId` and the rest, plus `ProviderInstanceId`, `DeviceHostId` and
///   `SetupOperationId`. The key is *parsed*, and a parse failure is a failure: the whole
///   record is rejected with a `Composite` at the offending key. 29 of the 31 sites.
/// - A key schema that is **only predicates over `string`** — `.check(isPattern(…))`,
///   `.check(isMaxLength(…))`, with no `pipe`. The key is *tested*, and a key that fails
///   test simply is not one of the record's keys: the entry is dropped and the rest of the
///   record decodes. `{"1BAD":"v"}` gives `{}` and `{"GOOD":"v","1BAD":"w"}` gives
///   `{"GOOD":"v"}`, in both key orders. Exactly 2 sites — `TerminalEnv`
///   (`terminal.ts:21-25`) and `EnvironmentThemeColors` (`server.ts:514-517`) — but both
///   are live wire fields, and both are the "open vocabulary" kind where dropping is the
///   point: `server.ts:509` documents that a client "may publish roles a newer client
///   added without breaking an older one".
pub trait KeyRejection {}

/// [`Record`]'s default, and the majority: a key the key schema will not take fails the
/// whole record.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StrictKeys {}

impl KeyRejection for StrictKeys {}

/// The 2 refinement-keyed sites: an unmatched key costs its own entry and nothing else.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LenientKeys {}

impl KeyRejection for LenientKeys {}

/// `Schema.Record(key, value)` — 31 sites, and not a plain map, because the **key is a
/// schema**: `LoadBalancingWeights` (`settings.ts:314`) keys on `TrimmedNonEmptyString` and
/// `providerModelPreferences` (`settings.ts:447`) keys on `ProviderInstanceId`. So a key is
/// trimmed and checked like any other value, and `{" a ":50}` crosses back as `{"a":50}`.
///
/// Two keys that trim to the same string collapse silently, the later one winning — the
/// shipped codec reports no collision, so neither does this.
///
/// What a failure costs is [`KeyRejection`], and it differs by direction on top of that:
///
/// - **Decoding** rejects the whole record for a bad *value*. A bad *key* rejects it too
///   for a [`StrictKeys`] record and drops one entry for a [`LenientKeys`] one.
/// - **Encoding** rejects the whole record for a bad value, but a key that cannot be
///   encoded drops **only its own entry**: `{"":50, b:60}` encodes to `{"b":60}`, and both
///   orders of that input give the same result. A key that encodes but fails a predicate
///   survives and is written transformed — `{"  ":50, b:60}` encodes to `{"":50,"b":60}`,
///   because the trim is the transform and the trailing `isNonEmpty` is never re-checked on
///   the way out. [`KeyRejection`] is a **decode** rule and nothing else: measured, both
///   markers encode that input identically, so a port that branched on it here would be
///   inventing a difference the shipped codec does not have.
///
/// So what gates the outbound direction depends on **where the assertion sits**, and it sits
/// differently on the two sides of a key. A key's assertion runs against the text as it was
/// handed over, **before** the trim: an empty key therefore fails and drops its entry
/// (`{"":50, b:60}` → `{"b":60}`, measured on all three transform-keyed records) while a
/// whitespace-only key *passes* — it is not empty yet — and the trim then empties it with
/// nothing re-checking, so `PullRequestListCursors` (`pullRequest.ts:547`) writes `{"":"b"}`
/// for `{"  ":"b"}`, exactly as `LoadBalancingWeights` and `ProviderAuthResponse` do. An
/// assertion written on the **value** schema is re-run on the way out, and against the
/// untrimmed text too: the same cursors schema throws on a 4097-character cursor in both
/// directions, and takes the whole record down rather than losing one entry. The field
/// comment says the cap is there because the value "arrives from the page and is unfolded
/// into a host's own filter". A port that decoded before encoding gets all of this wrong at
/// once, and silently.
///
/// Keys are held in a `BTreeMap`, so the wire order is sorted rather than insertion order.
/// No JSON client may depend on key order, and the golden does not assert it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record<K, V, Keys: KeyRejection = StrictKeys>(
    pub std::collections::BTreeMap<K, V>,
    PhantomData<fn() -> Keys>,
);

impl<K, V, Keys: KeyRejection> Default for Record<K, V, Keys> {
    fn default() -> Self {
        Record(std::collections::BTreeMap::new(), PhantomData)
    }
}

impl<K, V, Keys: KeyRejection> Record<K, V, Keys> {
    pub fn new(entries: std::collections::BTreeMap<K, V>) -> Self {
        Record(entries, PhantomData)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }
}

impl<K: Serialize + Ord, V: Serialize, Keys: KeyRejection> Serialize for Record<K, V, Keys> {
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

impl<'de, K: Deserialize<'de> + Ord, V: Deserialize<'de>> Deserialize<'de>
    for Record<K, V, StrictKeys>
{
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Record(
            std::collections::BTreeMap::deserialize(deserializer)?,
            PhantomData,
        ))
    }
}

/// The buffered path exists only to make one key's failure survivable: `BTreeMap`'s own
/// deserializer aborts the whole map on the first key `K` refuses, which is the
/// [`StrictKeys`] rule. A value that fails still rejects, as it does for every record.
impl<'de, K: DeserializeOwned + Ord, V: DeserializeOwned> Deserialize<'de>
    for Record<K, V, LenientKeys>
{
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = serde_json::Map::<String, serde_json::Value>::deserialize(deserializer)?;
        let mut entries = std::collections::BTreeMap::new();
        for (key, value) in raw {
            let Ok(parsed) = serde_json::from_value::<K>(serde_json::Value::String(key)) else {
                continue;
            };
            let parsed_value = serde_json::from_value::<V>(value).map_err(de::Error::custom)?;
            entries.insert(parsed, parsed_value);
        }
        Ok(Record(entries, PhantomData))
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

/// `Schema.Uint8Array` — 1 site repo-wide (`ipc.ts:1093`, the screen-recording save payload),
/// and the crate's first type with **no JSON spelling at all**.
///
/// `Schema.Uint8Array` is a `Declaration` rather than a `Transformation`, so its Encoded side
/// *is* `Uint8Array`: the shipped codec accepts a byte sequence and hands back **the same
/// reference**, and rejects the array, the base64 string, `null`, and — this is the part worth
/// stopping on — the `{"0":1,"1":2,"2":3}` object that `JSON.stringify` of a `Uint8Array`
/// writes. The codec's own JSON rendering does not decode, which is what makes this a
/// measurement rather than an opinion: there is no JSON this field can be carried in, in either
/// direction.
///
/// Which is fine on the wire it actually sits on. `ipcMain.handle` receives a *structured
/// clone*, so the bytes arrive intact and no serialiser is involved; the same field on the RPC
/// transport would fail at every hop, and nothing in `contracts` puts it there. In the Rust
/// product this channel is an in-process call, so the field is a plain `Vec<u8>` and neither
/// impl below runs. They exist so that a `#[derive(Serialize, Deserialize)]` on a struct
/// containing one cannot silently invent a representation.
///
/// Deliberately not modelled: a Node `Buffer` also passes, because it *is* a `Uint8Array`, and
/// renders as `{"type":"Buffer","data":[…]}` — a second and different JSON spelling of the same
/// declared value. That is a property of who calls the channel, not of the schema, and the Rust
/// port has no `Buffer`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Bytes(pub Vec<u8>);

impl Serialize for Bytes {
    fn serialize<S: Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
        Err(serde::ser::Error::custom(
            "a byte sequence has no JSON form: see `Bytes`",
        ))
    }
}

impl<'de> Deserialize<'de> for Bytes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct BytesVisitor;
        impl Visitor<'_> for BytesVisitor {
            type Value = Bytes;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a byte sequence, which no JSON value is")
            }
        }
        // No `visit_*` method, so serde's defaults turn every input into an invalid-type error —
        // which is the measured behaviour, and why this is not `Vec<u8>` under a `serde(with)`.
        deserializer.deserialize_any(BytesVisitor)
    }
}
