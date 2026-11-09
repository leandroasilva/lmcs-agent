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
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";

import {
  AssistantCitation,
  ClientSettingsSchema,
  CodexSettings,
  DesktopPreviewTabIdSchema,
  EnvironmentThemeFile,
  ForwardCompatibleArray,
  ForwardCompatibleNullable,
  ForwardCompatibleOptional,
  NonNegativeInt,
  ORCHESTRATION_WS_METHODS,
  OmittedWhenNull,
  PortSchema,
  PositiveInt,
  ProviderAuthResponse,
  SnapShotKeyChord,
  TerminalOpenInput,
  TerminalResizeInput,
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
// The Rpc envelope
//
// `Rpc.make` defaults are what make the envelope worth dumping rather than
// reading: `payload` falls back to `Schema.Void`, `success` to `Schema.Void`,
// `error` to `Schema.Never`, and `defect` to `Schema.Defect()`. So a method that
// simply omits `success:` returns nothing, and `stream: true` moves the error
// channel *inside* the success schema and replaces `errorSchema` with `Never`.
//
// None of this is visible in the declaration site, which is exactly why the
// golden carries it. Every fact below is measured off the shipped group at
// runtime rather than transcribed from `rpc.ts`.
//
// Identity comparison is the only test that works here. These schemas are
// constructor functions, so `_id` is undefined and `constructor.name` is
// "Function" for all of them — but `Schema.Void`, `Schema.Never` and
// `Schema.Defect()` are all interned singletons, and `Rpc.make` stores the very
// object it defaulted to.
// ---------------------------------------------------------------------------

interface Envelope {
  _tag: string;
  key: string;
  payloadSchema: Schema.Top;
  successSchema: Schema.Top & { success?: Schema.Top; error?: Schema.Top };
  errorSchema: Schema.Top;
  defectSchema: Schema.Top;
}

// The declared key for a tag, so the census can be recorded by *key* — the name a
// Rust server would branch on — rather than by the wire tag. Keyed on `string` for the
// same reason `declaredSet` is: it gets searched with tags that came off the group at
// runtime, which TypeScript only knows as `string`.
const keyOfTag = new Map<string, string>(Object.entries(declared).map(([key, tag]) => [tag, key]));

const streamed: string[] = [];
const voidSuccess: string[] = [];
let voidPayload = 0;
let neverError = 0;
let sharedDefect = 0;
let derivedKey = 0;
// A stream schema is `Schema.declare(Stream.isStream)` with the element schemas hanging
// off it, so it is a *marker* and never a wire codec. These two count how many of the
// streams degenerate to nothing on a channel; zero means every stream carries real
// element schemas on both.
let streamSuccessVoid = 0;
let streamErrorNever = 0;

for (const rpc of requests.values() as Iterable<Envelope>) {
  const key = keyOfTag.get(rpc._tag);
  if (key === undefined) throw new Error(`registered tag has no declaration: ${rpc._tag}`);
  if (rpc.key === `effect/rpc/Rpc/${rpc._tag}`) derivedKey++;
  if (rpc.payloadSchema === Schema.Void) voidPayload++;
  if (rpc.errorSchema === Schema.Never) neverError++;
  if (rpc.defectSchema === Schema.Defect()) sharedDefect++;
  if (RpcSchema.isStreamSchema(rpc.successSchema)) {
    streamed.push(key);
    if (rpc.successSchema.success === Schema.Void) streamSuccessVoid++;
    if (rpc.successSchema.error === Schema.Never) streamErrorNever++;
  } else if (rpc.successSchema === Schema.Void) {
    voidSuccess.push(key);
  }
}

const envelope = {
  total: registered.length,
  // `Rpc.key` is derived from the tag, never overridden.
  derivedKey,
  // The three buckets are exhaustive and disjoint, which the replay asserts by summing.
  streamed: streamed.length,
  voidSuccess: voidSuccess.length,
  plain: registered.length - streamed.length - voidSuccess.length,
  voidPayload,
  neverError,
  sharedDefect,
  streamSuccessVoid,
  streamErrorNever,
  streamedKeys: streamed.sort(),
  voidSuccessKeys: voidSuccess.sort(),
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

// A **field projection**: wrap one field of a shipped struct in a struct of its own, so a
// case exercises the real declaration without dumping the other ~200 keys of
// `ClientSettingsSchema` into the golden for every input.
//
// Reaching the field through `fields` rather than re-spelling it is the point. Both fields
// recorded below are built from module-private schemas — `QuitConfirmationModeSetting` and
// `makeBinaryPathSetting` are not exported — so a copy is the only alternative, and a copy
// would silently drift from the `pipe`s it is supposed to be evidence about: the decoding
// default, the trim, the `annotateKey`.
function projectField(struct: Schema.Top, field: string): Schema.Top {
  const fields = (struct as unknown as { fields?: Record<string, Schema.Top> }).fields;
  const declared = fields?.[field];
  if (declared === undefined) throw new Error(`${field} is not a field of the shipped struct`);
  return Schema.Struct({ [field]: declared });
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
// `Schema.Defect()` — 59 sites in the contracts, 90 across the repo, and **every single
// call passes no options**, so `includeStack` and `excludeCause` are both false everywhere.
// That collapses what looks like a family into one behaviour.
//
// `Defect` is `Json` on the wire and `unknown` in the Type, and it is *not* an identity
// codec. A JSON object carrying a string `message` decodes into a JavaScript `Error`, and
// encoding that Error writes `{name, message}` — a `name` key the input never had. A port
// that treats the wire as pass-through is wrong in the direction that is invisible until a
// client reads `cause.name`.
//
// `stack` is deliberately absent from every case. It embeds absolute paths and line numbers,
// so a golden carrying one would not be reproducible on another machine — and since no site
// passes `includeStack`, a stack never reaches the wire in either direction anyway.
// ---------------------------------------------------------------------------

const DefectSchema = Schema.Defect();
for (const input of [
  // The error shape, and the three ways `name` can be spelled: absent, a custom value, and
  // literally `"Error"` — which `decodeJsonError` skips assigning because it is already the
  // default, so all three have to land on the same encoded bytes.
  { message: "boom" },
  { message: "boom", name: "CustomError" },
  { message: "boom", name: "Error" },
  { message: "boom", name: 5 },
  // `message` present but not a string: `isJsonError` requires `typeof message === "string"`,
  // so this is *not* an error and passes through untouched.
  { message: 1 },
  // `cause` is recursed into; `Object.hasOwn` rather than `!== undefined` decides, so an
  // explicit `null` is a cause and is written back.
  { message: "boom", cause: { message: "inner" } },
  { message: "boom", cause: null },
  { message: "boom", cause: "plain" },
  // An unknown key is dropped, because the value round-trips through an `Error` that has no
  // slot for it. This is the lossy case a pass-through port would get wrong.
  { message: "boom", extra: 1 },
  // A nested error-shaped object is **not** decoded: `decodeDefect` recurses only through
  // `cause`, not through arbitrary members.
  { detail: { message: "inner" } },
  // Everything that is not an error-shaped object at all.
  {},
  "plain",
  5,
  null,
  true,
  [1, { message: "x" }],
]) {
  record("defect", "decode", DefectSchema, input);
}
// The encode side takes an `Error`, whose `message` is non-enumerable and so has no JSON
// spelling; `recordTyped` names the Encoded value and decodes it first.
for (const encoded of [
  { message: "boom" },
  { message: "boom", name: "CustomError" },
  { message: "boom", cause: { message: "inner" } },
  { message: "boom", cause: null },
  { message: "boom", extra: 1 },
  { message: 1 },
  { detail: { message: "inner" } },
  {},
  "plain",
  5,
  null,
  [1, { message: "x" }],
]) {
  recordTyped("defect", DefectSchema, encoded);
}

// ---------------------------------------------------------------------------
// `Schema.TaggedStruct` (24 sites) and `Schema.TaggedError` (126). The latter is
// `Error(identifier ?? tag)(TaggedStruct(tag, fields))`, so **on the wire the two are the
// same shape** — `Struct({_tag: Literal(tag), ...fields})` — and one subject covers all 150.
//
// Field order is *not* asserted, and that is a decision rather than an oversight: the replay
// compares `serde_json::Value`, whose `Map` is a `BTreeMap` without the `preserve_order`
// feature, so key order is not observable in the test. Number formatting *is* observable and
// *is* asserted (`1` must not come back as `1.0`). Key order is not something a JSON client
// may depend on, so it is not something the port has to reproduce.
// ---------------------------------------------------------------------------

const Fill = Schema.TaggedStruct("fill", { detail: Schema.String });
const Idle = Schema.TaggedStruct("Idle", {});
const Viewport = Schema.Union([Fill, Idle]);
for (const input of [
  { _tag: "fill", detail: "x" },
  // Tag last, to confirm the member is picked by the `_tag` value and not by its position.
  { detail: "x", _tag: "fill" },
  { _tag: "Idle" },
  // An extra key on the empty variant: structs are not exact, so it is dropped.
  { _tag: "Idle", detail: "x" },
  // Unknown member, missing payload, and no tag at all.
  { _tag: "nope" },
  { _tag: "fill" },
  { detail: "x" },
  { _tag: "fill", detail: "x", extra: 1 },
  { _tag: "fill", detail: 1 },
]) {
  record("taggedStruct", "decode", Viewport, input);
  record("taggedStruct", "encode", Viewport, input);
}

// The combination that actually ships: all 59 `Defect()` sites are the payload of an error
// struct, usually as `cause`. This is where the two primitives meet, and where a port that
// got each one separately right can still compose them wrong.
const Boom = Schema.TaggedStruct("Boom", { cause: Schema.Defect() });
for (const input of [
  { _tag: "Boom", cause: { message: "inner" } },
  { _tag: "Boom", cause: "plain" },
  { _tag: "Boom", cause: null },
  { _tag: "Boom" },
]) {
  record("defectInTaggedStruct", "decode", Boom, input);
}
for (const encoded of [
  { _tag: "Boom", cause: { message: "inner" } },
  { _tag: "Boom", cause: "plain" },
]) {
  recordTyped("defectInTaggedStruct", Boom, encoded);
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

// ---------------------------------------------------------------------------
// `Schema.Record` with a **schema-validated key**. The plain `Schema.Record(String, Number)`
// case is already the `record` subject above, and it shows a plain map. This one is the
// 23-site reality: `LoadBalancingWeights` (`settings.ts:314`) keys on
// `TrimmedNonEmptyString`, and `providerModelPreferences` (`settings.ts:447`) keys on
// `ProviderInstanceId`. So the key is transformed and checked like any other value, and
// the questions a `HashMap<String, V>` port cannot answer are: does the trimmed key reach
// the wire in place of the arrived one, what happens when two keys trim to the same
// string, and does a rejected key or value drop that entry (which is what
// `ForwardCompatibleArray` does) or take the whole record down.
// ---------------------------------------------------------------------------

const Weights: Schema.Top = Schema.Record(
  TrimmedNonEmptyString,
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
);
for (const input of [
  {},
  { a: 50 },
  // Does the key get trimmed, and does the trimmed form reach the wire?
  { " a ": 50 },
  // Two keys collapsing to one after the trim. The literal is written padded-key-first on
  // purpose: the replay parses the golden through `serde_json::Value`, which sorts keys,
  // and `" a "` sorts before `"a"` — so this order is the one where JavaScript's insertion
  // order and the replay's iteration order agree, and "the later entry wins" means the same
  // thing on both sides. What is being pinned down is that they collapse **silently**, one
  // value lost with no error; which of the two wins is an order question the harness cannot
  // carry for an arbitrary literal.
  { " a ": 2, a: 1 },
  { "": 50 },
  { "   ": 50 },
  // A rejected value: does the entry drop or does the record fail?
  { a: 101 },
  { a: "x" },
  { a: 50, b: 999 },
  // The two failure modes side by side, because encode treats them differently: a key that
  // cannot be encoded drops **its own entry** and leaves the rest, while a value that
  // cannot be encoded takes the whole record down. Both orders, so the drop is not an
  // artefact of which entry came last.
  { "": 50, b: 60 },
  { b: 60, "": 50 },
  { b: 101, c: 60 },
  { b: 60, c: 101 },
  "x",
  [],
  null,
]) {
  record("recordCheckedKey", "decode", Weights, input);
  record("recordCheckedKey", "encode", Weights, input);
}

// ---------------------------------------------------------------------------
// `Schema.Void` — 12 sites, every one of them the `success:` field of an RPC in `rpc.ts`.
// This is the highest-value unknown in the file, because it decides what a Rust server
// writes for a successful call that returns nothing. TypeScript's `void` is `undefined`,
// which has no JSON spelling at all, so the three possible answers are: accept only
// `undefined` (and the wire form has to be something else), accept `null`, or accept
// anything and discard it.
// ---------------------------------------------------------------------------

for (const input of [undefined, null, {}, 0, "", false, []]) {
  record("voidSchema", "decode", Schema.Void, input);
  record("voidSchema", "encode", Schema.Void, input);
}

// `Schema.Never` — the default `error` schema of `Rpc.make`, and therefore the error
// channel of all 24 streaming methods, where `stream: true` moves the real error inside
// the success schema and leaves `Never` behind. It is not a codec that ever carries a
// value; it is the statement that the channel cannot produce one. Characterised anyway,
// because "rejects everything" is a claim a port can get wrong by accepting `undefined`
// the way `Void` does.
for (const input of [undefined, null, {}, 0, "", false, [], { _tag: "x" }]) {
  record("neverSchema", "decode", Schema.Never, input);
  record("neverSchema", "encode", Schema.Never, input);
}

// ---------------------------------------------------------------------------
// `Schema.Unknown` — 7 sites in `orchestration.ts`, deliberately loose so malformed
// provider drafts still reach the transform (`orchestration.ts:82`). Characterised to
// confirm it really is identity in both directions and never rejects, because a port that
// made it `serde_json::Value` would be right only if that holds.
// ---------------------------------------------------------------------------

for (const input of [undefined, null, 0, "", false, [], { a: 1 }, { a: { b: [1, null] } }]) {
  record("unknownSchema", "decode", Schema.Unknown, input);
  record("unknownSchema", "encode", Schema.Unknown, input);
}

// ---------------------------------------------------------------------------
// `Schema.Union` — 81 sites in `rpc.ts` alone. `taggedStruct` already covers the tagged
// case; this covers an **untagged** one, where the interesting properties are which member
// wins when two could match and what the rejection is called when none does.
// ---------------------------------------------------------------------------

const Untagged: Schema.Top = Schema.Union([Schema.String, Schema.Int]);
for (const input of ["x", 1, 1.5, true, null, {}, [], undefined]) {
  record("untaggedUnion", "decode", Untagged, input);
  record("untaggedUnion", "encode", Untagged, input);
}

// ---------------------------------------------------------------------------
// `Schema.makeFilter` — 22 sites in `contracts/`, and the one in `settings.ts` is the
// clearest: `SnapShotKeyChord` is `KeybindingShortcut.check(makeFilter(shortcut =>
// shortcut.metaKey || … || shortcut.modKey || "Snapshot shortcut requires a modifier."))`.
//
// Two things make this worth its own subject rather than another row in `chainedChecks`.
// First, the returned **string is a failure with that message**, not a truthy value that
// passes — a port reading `||` as "the last operand is the result" gets the polarity
// backwards. Second, this is the first check over a *struct* whose base codec can succeed,
// so it is where the layer order is measurable: when `key` fails `isMinLength(1)` and the
// modifier is also missing, which of the two rejects, and does the tag distinguish them.
//
// Encode is recorded because whether `.check` gates the outbound direction at all is a
// property a `Deserialize`-only port cannot see.
// ---------------------------------------------------------------------------

const chord = (
  key: string,
  [metaKey, ctrlKey, shiftKey, altKey, modKey]: [boolean, boolean, boolean, boolean, boolean],
) => ({
  key,
  metaKey,
  ctrlKey,
  shiftKey,
  altKey,
  modKey,
});

for (const input of [
  // One modifier each: the disjunction has five operands and each has to be able to carry
  // the pass on its own.
  chord("s", [true, false, false, false, false]),
  chord("s", [false, true, false, false, false]),
  chord("s", [false, false, true, false, false]),
  chord("s", [false, false, false, true, false]),
  chord("s", [false, false, false, false, true]),
  // None: the single thing the filter exists to reject.
  chord("s", [false, false, false, false, false]),
  // Base codec and filter both rejecting, and only the filter rejecting, so the failing
  // layer is attributable.
  chord("", [false, false, false, false, false]),
  chord("", [true, false, false, false, false]),
  // `TrimmedString` trims before `isMinLength` runs, so padding is invisible to the length
  // floor on decode and present on encode — where the bound measures the raw text.
  chord("  s  ", [true, false, false, false, false]),
  chord("    ", [true, false, false, false, false]),
  // `isMaxLength(64)` on a value that the filter is happy with, so a rejection is the
  // struct's check and not the chord rule.
  chord("x".repeat(64), [true, false, false, false, false]),
  chord("x".repeat(65), [true, false, false, false, false]),
  // Undeclared keys are dropped rather than rejected, and a declared one of the wrong type
  // is the reverse.
  { ...chord("s", [true, false, false, false, false]), unknown: 1 },
  { key: "s" },
  { key: "s", metaKey: "true", ctrlKey: false, shiftKey: false, altKey: false, modKey: false },
  "s",
  [],
  null,
]) {
  record("snapShotKeyChord", "decode", SnapShotKeyChord, input);
  record("snapShotKeyChord", "encode", SnapShotKeyChord, input);
}

// ---------------------------------------------------------------------------
// `Schema.decodeTo` and `Schema.withDecodingDefault`, measured through the two settings
// fields that use them — 13 and 205 sites in `contracts/`, so this pair of shapes covers
// most of the settings surface.
//
// `confirmQuit` is the interesting one because its legacy half is **lossy**:
// `LegacyConfirmQuit` is `Boolean.pipe(decodeTo(QuitConfirmationMode, …))` with
// `encode: mode => mode === "hold"`, so the Type value `"double-click"` has no boolean
// spelling. It never shows up as a failure though, because the field is
// `Union([QuitConfirmationMode, LegacyConfirmQuit])` and member order decides that the
// canonical member answers first in *both* directions. The `recordTyped` cases below are
// the round trips that pin that order down.
//
// The absent-key and bad-key cases together answer the `withDecodingDefault` question: the
// default substitutes for a **missing key only**. A present-but-invalid value still fails,
// which a Rust `unwrap_or(DEFAULT)` would swallow.
// ---------------------------------------------------------------------------

const ConfirmQuitSetting = projectField(ClientSettingsSchema, "confirmQuit");
for (const input of [
  {},
  { confirmQuit: "direct" },
  { confirmQuit: "hold" },
  { confirmQuit: "double-click" },
  { confirmQuit: true },
  { confirmQuit: false },
  // Present but invalid: defaults must not reach here.
  { confirmQuit: "x" },
  { confirmQuit: null },
  { confirmQuit: 1 },
  { confirmQuit: {} },
  { confirmQuit: [] },
]) {
  record("confirmQuitSetting", "decode", ConfirmQuitSetting, input);
  record("confirmQuitSetting", "encode", ConfirmQuitSetting, input);
}
for (const encoded of [
  { confirmQuit: "direct" },
  { confirmQuit: "hold" },
  // The lossy one: `LegacyConfirmQuit` alone would encode this to `false`, and a union that
  // tried the legacy member first on the way out would too.
  { confirmQuit: "double-click" },
]) {
  recordTyped("confirmQuitSetting", ConfirmQuitSetting, encoded);
}

// `binaryPath` stacks all four constructs on one field — `TrimmedString`, a `decodeTo` that
// replaces an empty string with the provider's fallback, `withDecodingDefault`, and an
// `annotateKey` carrying the settings-form metadata. The annotation is here so "annotations
// have no wire effect" is measured against a field that definitely has one.
const BinaryPathSetting = projectField(CodexSettings, "binaryPath");
for (const input of [
  {},
  // Both empties: `""` straight, and whitespace that the trim turns into `""`.
  { binaryPath: "" },
  { binaryPath: "  " },
  { binaryPath: "/usr/bin/codex" },
  { binaryPath: "  /usr/bin/codex  " },
  // Encode is where the asymmetry shows: `decode` maps `""` to the fallback, `encode` is
  // the identity, so an empty Type value goes out empty rather than defaulting.
  { binaryPath: null },
  { binaryPath: 0 },
  { binaryPath: false },
  { binaryPath: [] },
]) {
  record("binaryPathSetting", "decode", BinaryPathSetting, input);
  record("binaryPathSetting", "encode", BinaryPathSetting, input);
}

// ── The last four predicates, and the two `Record` key behaviours ──────────
//
// A census of every `Schema.is*` in `contracts` found four predicates the crate had no
// primitive for: `isGreaterThanOrEqualTo` (26 sites — more than `isBetween` and `isNonEmpty`
// each have), `isLessThanOrEqualTo` (14), `isTrimmed` (6) and `isMaxProperties` (2). The two
// exclusive ones were already ported, so the risk was not a missing type but a **bound off
// by one** at 40 sites, and `isTrimmed` was worse: it refuses edge whitespace where
// `TrimmedString` — one line away in the same files — removes it.
//
// Chasing `isMaxProperties` into its two hosts turned up something the earlier `Record`
// evidence had wrong. Both hosts key on a **plain refinement over `string`**
// (`isPattern`, `isMaxLength`), and for such a key the shipped codec does not fail the
// record at all — it drops the entry. `{"1BAD":"v"}` decodes to `{}` and
// `{"GOOD":"v","1BAD":"w"}` to `{"GOOD":"v"}`, in both key orders. A key schema containing a
// `decodeTo` (`TrimmedNonEmptyString`, and every id made by `makeEntityId`) still fails the
// whole record. So "a bad key rejects the record" — which the 2.7 evidence said flatly —
// holds for 29 of the 31 sites and is wrong for the 2 that are open vocabularies, where
// dropping is the point: `server.ts:509` says a client "may publish roles a newer client
// added without breaking an older one". The subjects below are the two shipped refinement-key
// records plus a shipped transform-key one, so the split is measured rather than asserted.

// Two `.check` calls in a row, which is how `terminal.ts:13` spells a bounded column count —
// `Int.check(isGreaterThanOrEqualTo(1)).check(isLessThanOrEqualTo(1000))`. The subject is the
// shipped field, reached through the struct that requires it.
const TerminalCols = projectField(TerminalResizeInput, "cols");
for (const input of [
  {},
  // Both bounds are inclusive, so these two must pass and the two after them must not.
  { cols: 1 },
  { cols: 1000 },
  { cols: 0 },
  { cols: 1001 },
  { cols: 500 },
  // `Schema.Int` is `Number.isSafeInteger`, so a fraction fails at the type layer and the
  // bound never sees it — the distinction that makes `isInt` and the bound two filters.
  { cols: 1.5 },
  { cols: "80" },
  { cols: null },
  { cols: 9007199254740992 },
]) {
  record("terminalCols", "decode", TerminalCols, input);
  record("terminalCols", "encode", TerminalCols, input);
}

// The `isLessThanOrEqualTo` that can never fire: `assistantCitations.ts:24` puts it on
// `NonNegativeInt`, which is `Int.check(isGreaterThanOrEqualTo(0))`, and `Schema.Int` already
// refuses anything above `MAX_SAFE_INTEGER`. Recorded so the redundancy is a measured fact
// rather than an argument, and so a port that drops the filter cannot be accused of
// changing behaviour.
const CitationStart = projectField(AssistantCitation, "start");
for (const input of [
  {},
  { start: 0 },
  { start: -1 },
  { start: 9007199254740991 },
  // The type layer refuses this one, not the bound.
  { start: 9007199254740992 },
  { start: "0" },
  { start: null },
]) {
  record("citationStart", "decode", CitationStart, input);
  record("citationStart", "encode", CitationStart, input);
}

// `isTrimmed` as the shipped field uses it — `Schema.String.check(isTrimmed()).check(
// isNonEmpty())` (`ipc.ts:655`). The contrast that matters is against the trimming transform:
// `" a "` is a **failure** here and `"a"` out of `TrimmedString`.
for (const input of [
  "a",
  " a ",
  " ",
  "",
  // The BOM is JavaScript whitespace and not Unicode whitespace — the two-character set
  // difference the port has to get right on both sides, here as a rejection rather than a
  // trim.
  "﻿a",
  "a ",
  "a\t",
  1,
  null,
]) {
  record("tabIdTrimmed", "decode", DesktopPreviewTabIdSchema, input);
  record("tabIdTrimmed", "encode", DesktopPreviewTabIdSchema, input);
}

// `TerminalEnv` (`terminal.ts:24`) — a refinement-keyed record under `isMaxProperties(128)`,
// reached through the field that carries it. Note `env` is `Schema.optional`, so an explicit
// `null` is refused for reasons that have nothing to do with either construct.
const TerminalEnvField = projectField(TerminalOpenInput, "env");
const envEntries = (count: number, first = 0) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`K${first + i}`, "v"]));
for (const input of [
  {},
  { env: null },
  { env: [] },
  { env: "PATH=/usr/bin" },
  { env: { PATH: "/usr/bin" } },
  // The drop, twice: a key that fails the `isPattern` and one that fails the `isMaxLength`,
  // each alone and each alongside a key that passes. Order is varied because the survivor
  // set must not depend on it.
  { env: { "1BAD": "v" } },
  { env: { PATH: "/usr/bin", "1BAD": "v" } },
  { env: { "1BAD": "v", PATH: "/usr/bin" } },
  { env: { ["A".repeat(129)]: "v" } },
  { env: { PATH: "/usr/bin", ["A".repeat(129)]: "v" } },
  { env: { _a: "v", A: "v", z9: "v" } },
  // A bad *value* still fails the whole record, which is the half the drop rule does not
  // extend to.
  { env: { PATH: "x".repeat(8193) } },
  { env: { PATH: "/usr/bin", BAD: "x".repeat(8193) } },
  // `isMaxProperties` counts what survived, not what arrived: 128 valid entries is exactly at
  // the bound, 129 is over, and 128 valid plus 1 dropped stays at 128 and passes. That last
  // case is the one an implementation that counted raw JSON keys gets wrong.
  { env: envEntries(128) },
  { env: envEntries(129) },
  { env: { ...envEntries(128), "1BAD": "v" } },
]) {
  record("terminalEnv", "decode", TerminalEnvField, input);
  record("terminalEnv", "encode", TerminalEnvField, input);
}

// `EnvironmentThemeColors` (`server.ts:514`) — the other refinement-keyed record, with a
// pattern-only key and **no** `isMaxProperties`, so the drop rule is shown without the count
// rule in front of it. Its values are the trimming transform, which is where the two key
// behaviours differ on the way out.
const ThemeColors = projectField(EnvironmentThemeFile, "colors");
for (const input of [
  {},
  { colors: { accent: "oklch(0.5 0.1 200)" } },
  { colors: { Accent: "red" } },
  { colors: { ["a".repeat(65)]: "red", accent: "blue" } },
  { colors: { accent: "  red  " } },
  { colors: { accent: "   " } },
  { colors: { accent: "x".repeat(65) } },
  { colors: { "-bad": "red" } },
]) {
  record("themeColors", "decode", ThemeColors, input);
  record("themeColors", "encode", ThemeColors, input);
}

// `ProviderAuthResponse`'s credentials branch — the **transform-keyed** record under
// `isMaxProperties(16)` (`providerSetup.ts:79`). Same two constructs as `terminalEnv`,
// opposite key behaviour, and it is the pair that makes the rule a rule instead of a
// coincidence: `"  "` trims to `""` and then fails `isNonEmpty` **inside the key parse**, so
// the record fails outright rather than losing the entry.
for (const input of [
  { type: "credentials", values: { login: "tok" } },
  { type: "credentials", values: { "  ": "tok" } },
  { type: "credentials", values: { login: "tok", "  ": "tok" } },
  { type: "credentials", values: { "  ": "tok", login: "tok" } },
  { type: "credentials", values: { login: "  tok  " } },
  { type: "credentials", values: { login: "x".repeat(16_385) } },
  { type: "credentials", values: {} },
  { type: "credentials", values: envEntries(17) },
  { type: "credentials", values: envEntries(16) },
]) {
  record("authCredentials", "decode", ProviderAuthResponse, input);
  record("authCredentials", "encode", ProviderAuthResponse, input);
}

// `mutable` is the last construct `orchestration.ts` uses that no earlier subject reached,
// and it needs no subject: it is a **type-level** marker that `effect` hangs off the AST
// without touching the codec, so the two fields that use it (`SnapShotAccessibilityNode`'s
// `actions` and `children`, `orchestration.ts:238` and `:242`) encode exactly as plain arrays
// and the `isMaxLength` bounds sit outside them. Measured directly against the shipped
// schema; recorded here so the census closes without a block of cases that would only
// re-assert the array rules from 2.6a.

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
//
// An `Error` is the third case, and the one that loses data rather than merely needing a
// detour: `message` and `stack` are non-enumerable, so `Object.entries` gives `{}` and
// `JSON.stringify` gives `"{}"`. It is rendered here in exactly the shape `encodeJsonError`
// writes — `name` then `message`, then `cause` when there is one — so the golden's decode
// output and its encode output are the same projection of the same value. `stack` is left
// out on purpose; see the `Defect` section.
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
  if (value instanceof Error) {
    const rendered: Record<string, unknown> = { name: value.name, message: value.message };
    if (value.cause !== undefined) rendered.cause = toWire(value.cause);
    return rendered;
  }
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

const envelopeSummary =
  `envelope: ${envelope.plain} plain + ${envelope.streamed} streamed` +
  ` + ${envelope.voidSuccess} void-success`;

process.stderr.write(
  `declared: ${declaredTags.length} (ws ${Object.keys(WS_METHODS).length} + orchestration ${
    Object.keys(ORCHESTRATION_WS_METHODS).length
  }) registered: ${registered.length} ${envelopeSummary} codec cases: ${cases.length}\n`,
);

const json = [
  "{",
  // `[key, tag]` pairs, not an object: declaration order is part of what the Rust port
  // claims to reproduce, and a JSON object does not carry order through every parser.
  `  "wsMethods": ${JSON.stringify(Object.entries(WS_METHODS))},`,
  `  "orchestrationWsMethods": ${JSON.stringify(Object.entries(ORCHESTRATION_WS_METHODS))},`,
  `  "registered": ${JSON.stringify(registered)},`,
  `  "reconciliation": ${JSON.stringify(reconciliation)},`,
  `  "rpcEnvelope": ${JSON.stringify(envelope)},`,
  `  "codecs": [${cases.map(encodeCase).join(",")}]`,
  "}",
].join("\n");
process.stdout.write(`${json}\n`);
