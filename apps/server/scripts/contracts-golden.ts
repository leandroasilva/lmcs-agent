// Golden generator for the Rust contracts crate. Dumps the shipped RPC dispatch
// surface (both method tables and the tags actually registered on the group) and
// the observed behaviour of the base schema codecs, so `native/contracts` is
// checked against the TypeScript it replaces rather than against a copy of it.
//
// `node apps/server/scripts/contracts-golden.ts > /tmp/contracts-golden.json`

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  ForwardCompatibleNullable,
  ForwardCompatibleOptional,
  NonNegativeInt,
  ORCHESTRATION_WS_METHODS,
  OmittedWhenNull,
  PortSchema,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
  WS_METHODS,
  WsRpcGroup,
} from "@lmcstools/core";

// ---------------------------------------------------------------------------
// Dispatch surface
// ---------------------------------------------------------------------------

const requests = (WsRpcGroup as unknown as { requests: Map<string, unknown> }).requests;
const registered = [...requests.keys()];

const declared = { ...WS_METHODS, ...ORCHESTRATION_WS_METHODS };
const declaredTags = Object.values(declared);
const registeredSet = new Set<string>(registered);
// Widened to `string` because the point of the set is to be searched with tags that came
// off the group at runtime, which TypeScript only knows as `string`.
const declaredSet = new Set<string>(declaredTags);

const reconciliation = {
  declaredNotRegistered: Object.entries(declared)
    .filter(([, tag]) => !registeredSet.has(tag))
    .map(([key, tag]) => ({ key, tag })),
  registeredNotDeclared: registered.filter((tag) => !declaredSet.has(tag)),
  duplicateTags: declaredTags.filter((tag, index) => declaredTags.indexOf(tag) !== index),
};

// ---------------------------------------------------------------------------
// Base codec behaviour
//
// Each case records what the shipped codec actually does. The Rust port has to
// reproduce the asymmetries, not the intent — `TrimmedNonEmptyString` rejects a
// blank string on decode but happily encodes one to `""`.
// ---------------------------------------------------------------------------

type Case = {
  case: string;
  input?: unknown;
  typedInput?: unknown;
  undefinedInput?: true;
} & ({ ok: unknown } | { error: string });

const cases: Case[] = [];

// `Schema.Top` is the loosest schema type and the codec entry points ask for a
// `ConstraintDecoder<unknown, never>`, so these two are the only places the two meet.
// Funnelled through helpers rather than called at each site so the looseness is two
// diagnostics instead of one per function that records.
const decoderFor = (schema: Schema.Top) => Schema.decodeUnknownSync(schema);
const encoderFor = (schema: Schema.Top) => Schema.encodeUnknownSync(schema);

const issueOf = (cause: unknown): string =>
  (cause as { issue?: { _tag?: string } }).issue?._tag ?? "?";

function record(
  name: string,
  op: "decode" | "encode",
  schema: Schema.Top,
  input: unknown,
  isUndefined = false,
): void {
  const run = op === "decode" ? decoderFor(schema) : encoderFor(schema);
  const base = {
    case: `${name}.${op}`,
    ...(isUndefined ? { undefinedInput: true as const } : { input }),
  };
  try {
    cases.push({ ...base, ok: run(input) });
  } catch (cause) {
    cases.push({ ...base, error: issueOf(cause) });
  }
}

// Some Type-side values cannot be spelled in JSON at all, so an encode case taking one as
// input has nothing to put in the golden. A `Duration` renders through `Inspectable`, a
// JavaScript `Error` keeps `message` non-enumerable so `JSON.stringify` gives `"{}"`, and a
// `DateTime` only renders through its `toJSON`. Rather than invent a sentinel per type, the
// golden names the **Encoded** JSON and the replay decodes it first — which also makes the
// case a genuine round trip instead of a one-sided assertion.
//
// The decode is not wrapped: an input that does not decode has no Type value, so there is
// no encode behaviour to record, and crashing here is better than silently dropping a case.
function recordTyped(name: string, schema: Schema.Top, encoded: unknown): void {
  const typed = decoderFor(schema)(encoded);
  const base = { case: `${name}.encode`, typedInput: encoded };
  try {
    cases.push({ ...base, ok: encoderFor(schema)(typed) });
  } catch (cause) {
    cases.push({ ...base, error: issueOf(cause) });
  }
}

const scalars: Array<[string, Schema.Top]> = [
  ["TrimmedString", TrimmedString],
  ["TrimmedNonEmptyString", TrimmedNonEmptyString],
  ["ThreadId", ThreadId],
  ["NonNegativeInt", NonNegativeInt],
  ["PositiveInt", PositiveInt],
  ["PortSchema", PortSchema],
];
const scalarInputs: unknown[] = [
  "  a  ",
  "\t\na\r\n\t",
  "",
  "   ",
  "t-1",
  0,
  1,
  -1,
  1.5,
  65535,
  65536,
  5,
  null,
  true,
];
for (const [name, schema] of scalars) {
  for (const input of scalarInputs) {
    record(name, "decode", schema, input);
    record(name, "encode", schema, input);
  }
  record(name, "decode", schema, undefined, true);
}

const Lit = Schema.Literals(["a", "b"]);
const shapes: Array<[string, Schema.Top]> = [
  ["plainOptional", Schema.Struct({ v: Schema.optional(Lit) })],
  ["optionalKey", Schema.Struct({ v: Schema.optionalKey(Lit) })],
  ["forwardCompatibleOptional", Schema.Struct({ v: ForwardCompatibleOptional(Lit) })],
  ["forwardCompatibleNullable", Schema.Struct({ v: ForwardCompatibleNullable(Lit) })],
  ["omittedWhenNull", Schema.Struct({ v: OmittedWhenNull(Lit) })],
  ["required", Schema.Struct({ v: Lit })],
];
const shapeInputs: unknown[] = [
  {},
  { v: null },
  { v: "a" },
  { v: "z" },
  { v: undefined },
  { v: "a", extra: 1 },
];
for (const [name, schema] of shapes) {
  for (const input of shapeInputs) {
    record(name, "decode", schema, input);
    record(name, "encode", schema, input);
  }
}

const Arr = ForwardCompatibleArray(Lit);
for (const input of [["a", "z", "b", null], ["a", "z"], [], {}]) {
  record("forwardCompatibleArray", "decode", Arr, input);
  record("forwardCompatibleArray", "encode", Arr, input);
}

const ErrA = Schema.Struct({ _tag: Schema.Literal("A"), detail: Schema.String });
const ErrB = Schema.Struct({ _tag: Schema.Literal("B") });
const Union = Schema.Union([ErrA, ErrB]);
for (const input of [{ _tag: "A", detail: "x" }, { _tag: "Z" }, { _tag: "B" }, { _tag: "A" }]) {
  record("taggedUnion", "decode", Union, input);
  record("taggedUnion", "encode", Union, input);
}

// ---------------------------------------------------------------------------
// The rest of the machinery the five big contract files depend on. Same rule as
// above: record what the shipped codec does, not what it looks like it means.
// ---------------------------------------------------------------------------

// ~300 check sites across the contracts. The question that decides all of them is
// whether a check runs on encode too, or only on decode. `TrimmedNonEmptyString`
// already proved the answer is not uniform: its non-empty check rejects a blank on
// decode and passes one on encode. The trimmed variant here is the discriminator —
// if `isMaxLength` runs before the trim on encode, `"  abcd  "` behaves differently
// from `"abcd"`.
const MaxLength = Schema.String.pipe(Schema.check(Schema.isMaxLength(3)));
const TrimmedMaxLength = TrimmedNonEmptyString.check(Schema.isMaxLength(3));
const Pattern = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z]+$/)));
const Between = Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 })));
for (const [name, schema, inputs] of [
  ["maxLength", MaxLength, ["ab", "abc", "abcd", 1]],
  ["trimmedMaxLength", TrimmedMaxLength, ["ab", "  ab  ", "abcd", "  abcd  ", "   "]],
  ["pattern", Pattern, ["abc", "a1", "", 1]],
  ["between", Between, [1, 2, 3, 0, 4, 2.5, "2"]],
] as Array<[string, Schema.Top, ReadonlyArray<unknown>]>) {
  for (const input of inputs) {
    record(name, "decode", schema, input);
    record(name, "encode", schema, input);
  }
}

// `isMaxLength` measures `String.prototype.length` — UTF-16 code units, not codepoints
// and not bytes. `"ab😀"` is 3 codepoints but 4 units, so a bound of 3 rejects it; `"😀"`
// is 1 codepoint and 2 units but 4 bytes, so it passes. Each input rules out one
// alternative reading: a Rust port comparing `chars().count()` would accept `"ab😀"`, and
// one comparing `len()` would reject `"😀"` as well.
for (const input of ["ab😀", "😀"]) {
  record("maxLength", "decode", MaxLength, input);
  record("maxLength", "encode", MaxLength, input);
}

// JavaScript's `trim` strips WhiteSpace and LineTerminator, a set that differs from
// Unicode's White_Space in exactly two characters: U+FEFF is trimmed by JS but is not
// classified as whitespace by Unicode, and U+0085 (NEL) is the other way round.
// `str::trim` alone therefore diverges in both directions, and these three inputs are
// the minimum that shows it.
for (const [name, schema] of [
  ["TrimmedString", TrimmedString],
  ["TrimmedNonEmptyString", TrimmedNonEmptyString],
] as Array<[string, Schema.Top]>) {
  for (const input of ["\u{feff}a\u{feff}", "a\u{85}", "\u{feff}\u{85}"]) {
    record(name, "decode", schema, input);
    record(name, "encode", schema, input);
  }
}

// 205 sites. A field absent on the wire gets a computed value on decode; the
// question is what the encode side does with it, and whether a present `null`
// counts as absent.
const Defaulted = Schema.Struct({
  v: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
const DefaultedKey = Schema.Struct({
  v: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});
for (const [name, schema] of [
  ["withDecodingDefault", Defaulted],
  ["withDecodingDefaultKey", DefaultedKey],
] as Array<[string, Schema.Top]>) {
  for (const input of [{}, { v: true }, { v: false }, { v: null }, { v: "x" }]) {
    record(name, "decode", schema, input);
    record(name, "encode", schema, input);
  }
}

// 41 sites use a bare `Schema.DateTimeUtc`, and that one is DateTime↔DateTime: it
// rejects a raw ISO string, so it never decodes straight off JSON. `DateTimeUtcFromString`
// is the form that does, and it pins the wire shape — a decoded `DateTime.Utc` is an
// object carrying `epochMilliseconds` whose `toJSON` emits an ISO-8601 UTC string with
// millisecond precision. Both are recorded, because a port that accepts a bare string
// where the shipped codec demands a `DateTime` is a port that diverges silently.
const BareDateTime = Schema.Struct({ at: Schema.DateTimeUtc });
for (const input of [{ at: "2026-01-01T00:00:00.000Z" }, {}]) {
  record("dateTimeUtcBare", "decode", BareDateTime, input);
}
const FromStringDateTime = Schema.Struct({ at: Schema.DateTimeUtcFromString });
for (const input of [
  { at: "2026-01-01T00:00:00.000Z" },
  { at: "2026-01-01T00:00:00Z" },
  { at: "2026-01-01T00:00:00+01:00" },
  { at: "nope" },
  { at: null },
  { at: 1_767_225_600_000 },
  {},
]) {
  record("dateTimeUtcFromString", "decode", FromStringDateTime, input);
}
// The encode side cannot be spelled in JSON — its input is an already-decoded DateTime —
// so it is fed the value the decode above produced.
record(
  "dateTimeUtcFromString",
  "encode",
  FromStringDateTime,
  Schema.decodeUnknownSync(FromStringDateTime)({ at: "2026-01-01T00:00:00.000Z" }),
);

// 22 sites where an Effect `Option` itself crosses the wire, in two different
// spellings. These need a codec of their own; `Nullable` is not it.
const SomeOption = Option.some(1);
const NoneOption = Option.none();
const OptionNumber = Schema.Option(Schema.Number);
const OptionFromNull = Schema.OptionFromNullOr(Schema.Number);
for (const [name, schema, inputs] of [
  ["option", OptionNumber, [SomeOption, NoneOption, 1, null]],
  ["optionFromNullOr", OptionFromNull, [SomeOption, NoneOption, 1, null, "x"]],
] as Array<[string, Schema.Top, ReadonlyArray<unknown>]>) {
  for (const input of inputs) {
    record(name, "decode", schema, input);
    record(name, "encode", schema, input);
  }
}

// 35 sites. serde gets records for free, but only if the key and value shapes match.
const RecordSchema = Schema.Record(Schema.String, Schema.Number);
for (const input of [{ a: 1, b: 2 }, { a: "x" }, {}, [], null, { "": 1 }]) {
  record("record", "decode", RecordSchema, input);
  record("record", "encode", RecordSchema, input);
}

// ---------------------------------------------------------------------------
// Numeric bases. `Schema.Number` (110 sites) is already covered by `between`, but the
// `isGreaterThan(0)` sites sit on three different bases — `Schema.Int` ×14,
// `Schema.Finite` ×3 and `Schema.Number` ×1 — and `Schema.Int` (82 sites) and
// `Schema.Finite` (12 sites) are primitives in their own right.
// ---------------------------------------------------------------------------

// `Schema.Finite` rejects `Infinity` and `NaN`, and **neither has a JSON spelling**:
// `JSON.stringify` turns both into `null`. So for any input that can arrive on the wire,
// `Finite` and `Number` accept and reject exactly the same set, and a Rust port does not
// need two types. These cases are here to make that an observed fact rather than an
// argument — if a future Effect version gave `Finite` a wire-visible difference, the
// golden would show it.
const Finite = Schema.Finite;
for (const input of [1, 1.5, 0, -1, Number.MAX_SAFE_INTEGER, "1", null, true]) {
  record("finite", "decode", Finite, input);
  record("finite", "encode", Finite, input);
}

// `Schema.Int` is where a JSON number can genuinely fail, and the interesting inputs are
// the ones where "integer" is ambiguous. JavaScript has one number type, so `1.0` and `1`
// are the same value and cannot be separated in JSON; `MAX_SAFE_INTEGER + 1` still passes
// `Number.isInteger` even though it is no longer exactly representable, so a Rust port on
// `i64` and one on `f64` both accept it while a port that checks representability would
// not. `1.5` is the plain rejection.
const Int = Schema.Int;
const IntPositive = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));
for (const [name, schema, inputs] of [
  [
    "int",
    Int,
    [1, 0, -1, 1.5, -1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, "1", null],
  ],
  ["intGreaterThanZero", IntPositive, [1, 0, -1, 1.5, Number.MAX_SAFE_INTEGER, "1"]],
] as Array<[string, Schema.Top, ReadonlyArray<unknown>]>) {
  for (const input of inputs) {
    record(name, "decode", schema, input);
    record(name, "encode", schema, input);
  }
}

// ---------------------------------------------------------------------------
// Numeric and length bounds. 46 `isGreaterThan` + 2 `isLessThan` + 6 `isMinLength`
// sites, and the shape of the call is uniform enough that the only open questions
// are measurement questions.
// ---------------------------------------------------------------------------

// Every `isGreaterThan` in the contracts is `isGreaterThan(0)` and both `isLessThan` are
// `isLessThan(65536)`, so the bound is never in doubt — only its strictness is. The
// parameter is named `exclusiveMinimum` / `exclusiveMaximum` in the Effect source, and `0`
// and `65536` are here to confirm that empirically rather than trust the name.
//
// These two sit on a bare `Schema.Number`, the loosest of the three bases, so they isolate
// the check from the base: `0.5` is accepted here and rejected by `intGreaterThanZero`
// above, which is the same check on `Schema.Int`. `MAX_SAFE_INTEGER` is the other end of
// the integer mistake. `Infinity` and `-0` are deliberately absent: neither survives
// `JSON.stringify` (`null` and `0` respectively), so a case carrying one would silently
// test a different input.
const GreaterThanZero = Schema.Number.pipe(Schema.check(Schema.isGreaterThan(0)));
const LessThanPort = Schema.Number.pipe(Schema.check(Schema.isLessThan(65536)));
for (const [name, schema, inputs] of [
  [
    "greaterThanZero",
    GreaterThanZero,
    [1, 0, -1, 0.5, -0.5, Number.MAX_SAFE_INTEGER, "1", null, true],
  ],
  ["lessThanPort", LessThanPort, [65535, 65536, 65537, 0, -1, 1.5, "65535", null]],
] as Array<[string, Schema.Top, ReadonlyArray<unknown>]>) {
  for (const input of inputs) {
    record(name, "decode", schema, input);
    record(name, "encode", schema, input);
  }
}

// `isMinLength` measures `.length`, so it applies to a string in UTF-16 code units and to
// an array in elements — and the contracts use both: 3 string sites (`keybindings.ts:115`
// and `:120`, `orchestration.ts:2300`) and 3 array sites (`git.ts:167`,
// `pullRequest.ts:1225` and `:1237`). `"😀"` is 1 codepoint, 2 code units and 4 bytes, so
// it separates all three readings against a bound of 2 exactly as it did for `isMaxLength`.
const MinLength1 = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));
const MinLength2 = Schema.String.pipe(Schema.check(Schema.isMinLength(2)));
const NonEmptyArray = Schema.Array(Schema.String).check(Schema.isMinLength(1));
for (const [name, schema, inputs] of [
  ["minLength1", MinLength1, ["", "a", "ab", "😀", " a ", 1, null]],
  ["minLength2", MinLength2, ["", "a", "ab", "😀", "a😀", 1]],
  ["minLengthArray", NonEmptyArray, [[], ["a"], ["a", "b"], "a", {}, null]],
] as Array<[string, Schema.Top, ReadonlyArray<unknown>]>) {
  for (const input of inputs) {
    record(name, "decode", schema, input);
    record(name, "encode", schema, input);
  }
}

// `.check(a, b)` chains, and 3 sites do it (`pullRequest.ts:1225` and `:1237`,
// `keybindings.ts:99`). The question a single-check port cannot answer is which one fails
// first, because that decides the error a client sees: `[]` is under the minimum and
// `["a","b","c","d"]` is over the maximum, while `["a", 1]` fails the *element* schema
// before either bound is reached.
const BoundedArray = Schema.Array(Schema.String).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(3),
);
for (const input of [[], ["a"], ["a", "b", "c"], ["a", "b", "c", "d"], ["a", 1]]) {
  record("chainedChecks", "decode", BoundedArray, input);
  record("chainedChecks", "encode", BoundedArray, input);
}

// ---------------------------------------------------------------------------
// `Schema.DurationFromMillis` — 9 sites, all in `settings.ts`, all inside
// `Schema.optionalKey`. Encoded is a number of milliseconds, Type is a `Duration`.
// ---------------------------------------------------------------------------

// `1.5` is the discriminator. `Duration.millis` takes a `number`, and a fractional one
// becomes the `Nanos` variant rather than the `Millis` one — so a Rust port holding `i64`
// millis would reject a value the shipped codec accepts, and one holding `f64` would
// accept it but might write back `1.5` where the shipped codec writes `1.5` only if
// `Duration.toMillis` round-trips it. Negative durations are legal in Effect, so `-1` is
// recorded rather than assumed away.
const DurationShape = Schema.Struct({ every: Schema.DurationFromMillis });
for (const input of [
  { every: 0 },
  { every: 1 },
  { every: 1000 },
  { every: 1.5 },
  { every: -1 },
  { every: Number.MAX_SAFE_INTEGER },
  { every: "1000" },
  { every: null },
  {},
]) {
  record("durationFromMillis", "decode", DurationShape, input);
}
for (const millis of [0, 1, 1000, 1.5, -1]) {
  recordTyped("durationFromMillis", DurationShape, { every: millis });
}

// `Schema.NonEmptyString` — Effect's built-in, used at 4 sites and embedded in
// `SCRIPT_RUN_COMMAND_PATTERN`. It is **not** the repo's `TrimmedNonEmptyString`, and the
// difference is whether a blank counts as empty: `" "` has `length` 1, so `isMinLength(1)`
// accepts it, where the trimmed variant would reject it. Recorded on its own so that the
// template-literal case below does not have to carry the answer.
const NonEmptyString = Schema.NonEmptyString;
for (const input of ["", "a", " ", "   ", "\u{feff}", "😀", 1, null]) {
  record("nonEmptyString", "decode", NonEmptyString, input);
  record("nonEmptyString", "encode", NonEmptyString, input);
}

// ---------------------------------------------------------------------------
// `Schema.TemplateLiteral` — 2 sites: `SCRIPT_RUN_COMMAND_PATTERN`
// (`keybindings.ts:99`) and `["acp.", Schema.String, ".extension"]`
// (`providerRuntime.ts:32`). A template literal compiles to a regular expression, and
// the two things a port has to get right are anchoring and greediness.
// ---------------------------------------------------------------------------

// `"acp.a.extension.extension"` separates a full-match reading from a search, and from a
// *greedy* full match: an anchored `acp\.(.*)\.extension` accepts it with `a.extension`
// captured, while `acp\.(.*?)\.extension` accepts it with `a` captured. Both accept, so
// the case is about which reading a Rust port must not accidentally narrow. `"acp..extension"`
// separates `Schema.String` (accepts `""`) from a `.+` reading. `"xacp.foo.extension"`
// separates an anchored match from `RegExp.test`'s default substring search — the same
// trap `isPattern` has.
const AcpExtension = Schema.TemplateLiteral(["acp.", Schema.String, ".extension"]);
for (const input of [
  "acp.foo.extension",
  "acp..extension",
  "acp.a.extension.extension",
  "acp.foo",
  "xacp.foo.extension",
  "acp.foo.extensionx",
  "",
  1,
]) {
  record("templateLiteral", "decode", AcpExtension, input);
  record("templateLiteral", "encode", AcpExtension, input);
}

// The other site embeds a **checked** schema in the middle of the literal:
// `NonEmptyString.check(isMaxLength(N), isPattern(/^[a-z0-9][a-z0-9-]*$/))`. Whether the
// check runs against the captured slice or against the whole assembled string is not
// guessable from the call, and `"script.ab.run"` versus `"script..run"` versus a
// too-long id separates the readings.
const ScriptRun = Schema.TemplateLiteral([
  Schema.Literal("script."),
  Schema.NonEmptyString.check(Schema.isMaxLength(8), Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)),
  Schema.Literal(".run"),
]);
for (const input of [
  "script.ab.run",
  "script..run",
  "script.a.run",
  "script.abcdefghijklmnop.run",
  "script.AB.run",
  "script.a-b.run",
]) {
  record("templateLiteralChecked", "decode", ScriptRun, input);
  record("templateLiteralChecked", "encode", ScriptRun, input);
}

// ---------------------------------------------------------------------------
// `Schema.suspend` — 3 sites, all self-recursive: `SnapShotAccessibilityNode`
// (`orchestration.ts:244`), `KeybindingWhenNodeRef` (`keybindings.ts:145`) and
// `ContextMenuItemSchema` (`ipc.ts:78`). Recursion is a shape question rather than a
// codec one, so what gets recorded is whether depth is bounded and whether a wrong
// member at depth is reported or swallowed. A cycle cannot be spelled in JSON, so it is
// not tested here.
// ---------------------------------------------------------------------------

const Tree: Schema.Top = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Top => Tree)),
});
const deep = (depth: number): unknown =>
  depth === 0 ? { name: "leaf", children: [] } : { name: `n${depth}`, children: [deep(depth - 1)] };
for (const input of [
  { name: "a", children: [] },
  deep(1),
  deep(20),
  { name: "a", children: [{}] },
  { name: "a", children: [{ name: "b", children: "x" }] },
  { children: [] },
  { name: "a" },
]) {
  record("suspendTree", "decode", Tree, input);
  record("suspendTree", "encode", Tree, input);
}

// The golden has to carry wire bytes, and two kinds of value do not survive
// `JSON.stringify` on their own:
//
// - `undefined` vanishes, and `{ v: undefined }` collapses to `{}`. Neither has a JSON
//   form, so each becomes a sentinel the Rust replay recognises and skips rather than
//   guesses at.
// - An Effect `Option` holds `_id` and `_tag` on its prototype, where neither
//   `Object.entries` nor `JSON.stringify` can see them — `Option.some(1)` renders as
//   `{"value":1}` and `Option.none()` as `{}`, losing exactly the part that identifies
//   the wire form. `Schema.Option` crosses the wire in that internal spelling, so the
//   walk reads both fields off the object and materialises them as own keys.
//
// A `Date` (and therefore a `DateTime.Utc`) has to pass through as itself: `JSON.stringify`
// runs its `toJSON` to produce the wire form, and rebuilding it from its own enumerable
// entries would yield `{}`. A `Duration` is the same case with a sharper edge — its internal
// `value.nanos` is a `BigInt`, so walking it does not merely lose information, it throws.
// Passing it through yields `{_id, _tag, millis}` or `{_id, _tag, nanos}` with the bigint
// already stringified by `Duration`'s own `toJSON`, which is lossless and machine-stable.
const toWire = (value: unknown): unknown => {
  if (value === undefined) return { $undefined: true };
  if (Option.isOption(value)) {
    const option = value as unknown as { _id: string; _tag: string; value?: unknown };
    return Option.isSome(value)
      ? { _id: option._id, _tag: option._tag, value: toWire(option.value) }
      : { _id: option._id, _tag: option._tag };
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (Duration.isDuration(value)) return value;
  if (Array.isArray(value)) return value.map(toWire);
  const rebuilt: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) rebuilt[key] = toWire(member);
  return rebuilt;
};

const encodeInput = (entry: Case): string => {
  if ("undefinedInput" in entry) return '"undefinedInput":true';
  if ("typedInput" in entry) return `"typedInput":${JSON.stringify(toWire(entry.typedInput))}`;
  return `"input":${JSON.stringify(toWire(entry.input))}`;
};

const encodeCase = (entry: Case): string => {
  const outcome =
    "ok" in entry ? `"ok":${JSON.stringify(toWire(entry.ok))}` : `"error":"${entry.error}"`;
  return `{"case":"${entry.case}",${encodeInput(entry)},${outcome}}`;
};

process.stderr.write(
  `declared: ${declaredTags.length} (ws ${Object.keys(WS_METHODS).length} + orchestration ${
    Object.keys(ORCHESTRATION_WS_METHODS).length
  }) registered: ${registered.length} codec cases: ${cases.length}\n`,
);

const json = [
  "{",
  // `[key, tag]` pairs, not an object: declaration order is part of what the Rust port
  // claims to reproduce, and a JSON object does not carry order through every parser.
  `  "wsMethods": ${JSON.stringify(Object.entries(WS_METHODS))},`,
  `  "orchestrationWsMethods": ${JSON.stringify(Object.entries(ORCHESTRATION_WS_METHODS))},`,
  `  "registered": ${JSON.stringify(registered)},`,
  `  "reconciliation": ${JSON.stringify(reconciliation)},`,
  `  "codecs": [${cases.map(encodeCase).join(",")}]`,
  "}",
].join("\n");
process.stdout.write(`${json}\n`);
