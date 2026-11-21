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
  classifyTaskAgentKind,
  CodexSettings,
  ContextMenuItemSchema,
  DesktopPreviewRecordingSaveInputSchema,
  DesktopPreviewTabIdSchema,
  EnvironmentOrchestrationHttpApi,
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
  ProviderRuntimeEvent,
  ProviderUsageLimitsUpdate,
  PullRequestListCursors,
  RuntimeEventRaw,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  SnapShotKeyChord,
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalSummary,
  TerminalWriteInput,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
  UserInputQuestion,
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
  // The encode half of the key rule, which the trim makes invisible unless the raw key is
  // empty: `"  "` passes the Type-side check (it is not empty yet) and reaches the wire as
  // `""`, while `""` fails it and **drops its entry** — silently, with the rest intact. A
  // port that only ever trims and validates in that order cannot tell the two apart, and a
  // port that rejects rather than drops takes the whole response down over one bad key.
  { type: "credentials", values: { "": "tok" } },
  { type: "credentials", values: { "": "tok", login: "tok" } },
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

// ---------------------------------------------------------------------------
// 3d: `pullRequest.ts` and `ipc.ts` — the two files the census left, and between them
// exactly one construct no earlier subject reached.
// ---------------------------------------------------------------------------

// `PullRequestListCursors` (`pullRequest.ts:547`) — a transform-keyed record, so it belongs
// with `weights` and `authCredentials`. It earns its own subject for two reasons. Its value
// is the only live `isMaxLength` on the *trimming* key family, which puts the bound and the
// trim in an order the two directions disagree about: decode measures the trimmed text, so
// 4 spaces over a 4096-character cursor fits, while encode measures what it was handed, so
// the same string is over the bound and the whole record fails. And a cursor is opaque, so
// nothing here is a shape the port can guess.
const cursorLong = "x".repeat(4096);
const cursorOver = "x".repeat(4097);
const cursorPadded = `${" ".repeat(4)}${cursorLong}`;
for (const input of [
  {},
  { a: "b" },
  { "  ": "b" },
  // The empty key, alone and beside one that survives — the encode drop, see above.
  { "": "b" },
  { "": "b", a: "c" },
  { a: "  " },
  { a: cursorLong },
  { a: cursorOver },
  // Trim-then-bound versus bound-then-trim, the pair that makes the order visible.
  { a: cursorPadded },
  // The key carries no `isMaxLength` at all, so this is over the *value's* bound and fits.
  { [cursorPadded]: "b" },
  { a: 1 },
  { a: null },
  [],
  null,
  "ab",
]) {
  record("pullRequestCursors", "decode", PullRequestListCursors, input);
  record("pullRequestCursors", "encode", PullRequestListCursors, input);
}

// `ContextMenuItemSchema` (`ipc.ts:69`) — one of the 22 sites that annotate a value with
// `Schema.Codec<T>`, which is a type assertion and nothing more (its `.ast._tag` is
// `Objects`, the struct underneath). What is worth recording is the recursion: the field
// is `optionalKey(Array(suspend(…)))`, and a failure inside it is reported by the path
// through `children`, at any depth. An unbounded `Vec` port either gets that path wrong or
// flattens it.
const menu = (extra: Record<string, unknown>) => ({ id: "a", label: "L", ...extra });
for (const input of [
  menu({}),
  { id: "a" },
  { label: "L" },
  {},
  menu({ children: [] }),
  menu({ children: [{ id: "b", label: "M" }] }),
  // One level and two, because a nested failure is reported by the *path* to it —
  // `["children"][0]["label"]` — and a port that flattens the recursion loses which entry
  // on the menu was broken, which is the only thing that tells the user why.
  menu({ children: [{ id: "b" }] }),
  menu({ children: [menu({ id: "b", children: [{ id: "c" }] })] }),
  menu({ children: { 0: menu({}) } }),
  menu({ children: [null] }),
  menu({ children: "x" }),
  menu({ destructive: "yes" }),
  menu({ icon: 1 }),
  menu({ label: 1 }),
  // Undeclared keys drop rather than reject, and `optionalKey` means an own key holding
  // `undefined` is the one input this shape can express that JSON cannot — see `$undefined`.
  menu({ extra: 1 }),
  menu({ checked: undefined }),
  menu({
    destructive: true,
    disabled: false,
    header: true,
    icon: "x",
    separatorBefore: true,
    checked: true,
  }),
  null,
  [],
]) {
  record("contextMenu", "decode", ContextMenuItemSchema, input);
  record("contextMenu", "encode", ContextMenuItemSchema, input);
}

// `DesktopPreviewRecordingSaveInputSchema` (`ipc.ts:1090`) — `Schema.Uint8Array`, the only
// such site in the repo, and the reason this fatia needed measuring rather than guessing:
// the codec's Encoded side *is* the byte sequence, so it rejects every JSON spelling of one
// including the `{"0":1,…}` object `JSON.stringify` writes for it. There is no round trip
// through JSON to port. The inputs that arrive as `{$bytes: […]}` therefore cannot run
// against the Rust side at all, and the ones that arrive as array, base64, `null` or that
// object can: they are recorded as refusals on both sides, which is the whole behaviour a
// JSON-seeing implementation could ever claim. A Node `Buffer` is included as the second
// spelling the shipped codec accepts, so the golden says "one value" where a port might
// invent "two".
const saveBytes = new Uint8Array([1, 2, 3]);
for (const input of [
  { tabId: "t", mimeType: "m", data: saveBytes },
  { tabId: "t", mimeType: "m", data: Buffer.from([9]) },
  { tabId: "t", mimeType: "m", data: [1, 2, 3] },
  { tabId: "t", mimeType: "m", data: "AQID" },
  { tabId: "t", mimeType: "m", data: null },
  { tabId: "t", mimeType: "m", data: { 0: 1, 1: 2, 2: 3 } },
  { tabId: "t", mimeType: "m" },
  { tabId: " t ", mimeType: "m", data: [1] },
  { tabId: "t", mimeType: " m ", data: [1] },
  { tabId: "t", mimeType: "", data: [1] },
  { tabId: "t", mimeType: "  ", data: [1] },
  {},
]) {
  record("recordingSave", "decode", DesktopPreviewRecordingSaveInputSchema, input);
  record("recordingSave", "encode", DesktopPreviewRecordingSaveInputSchema, input);
}

// ---------------------------------------------------------------------------
// The last constructs the census left, and the only one of them that needs a
// primitive: `Schema.FiniteFromString`. The other two are recorded so that the
// claim "nothing to port" is a measurement rather than an argument.
// ---------------------------------------------------------------------------

// `Number(text)` in both directions, which is not `str::parse` and not `f64::to_string`.
// The decode inputs are the ones where a Rust port would reach for the standard library
// and diverge: `""` and `"   "` are 0, `" 1 "` is trimmed, `"+1"` and `"1."` are legal,
// `"0x10"` is 16 but `"-0x10"` is NaN because a radix prefix may not carry a sign,
// `"1_000"` is NaN even though the same spelling is a legal JavaScript *literal*, and
// `"1e309"` overflows to Infinity while `"1e-400"` underflows to 0 — the first refused,
// the second accepted. `"Infinity"` is the case that separates this schema from its
// sibling `NumberFromString`: a string is spellable in JSON where a bare Infinity is not,
// so here the finite gate is a real inbound rule.
const finiteFromStringInputs: unknown[] = [
  "1",
  "1.5",
  "0",
  "-1",
  "-0",
  " 1 ",
  "\t\n1\r\n",
  "\u{feff}1\u{feff}",
  "1\u{85}",
  "",
  "   ",
  "+1",
  "1.",
  ".5",
  ".",
  "1e3",
  "1e",
  "1e+",
  "1e309",
  "1e-400",
  "0x10",
  "-0x10",
  "0X1f",
  "0b101",
  "0o17",
  "0123",
  "0x",
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFF",
  "1_000",
  "Infinity",
  "-Infinity",
  "  Infinity  ",
  "infinity",
  "NaN",
  "abc",
  "1 2",
  "9007199254740993",
  null,
  true,
  1,
  1.5,
  [],
  {},
];
for (const input of finiteFromStringInputs) {
  record("finiteFromString", "decode", Schema.FiniteFromString, input);
  record("finiteFromString", "encode", Schema.FiniteFromString, input);
}

// The encode half on its own, over the ranges where `String(n)` and `f64::to_string`
// disagree. JavaScript switches to exponential notation at 1e21 and below 1e-6 and Rust
// never does, so both boundaries are swept from each side, and the pseudo-random spread
// after them is there to catch a last-digit disagreement between the two shortest
// round-trip algorithms rather than a formatting rule.
const finiteEncodeSweep: number[] = [
  0,
  1,
  -1,
  10,
  100,
  1000,
  0.1,
  0.2,
  1 / 3,
  1.5,
  -1.5,
  1e19,
  1e20,
  1e21,
  1e22,
  1.5e21,
  9.999999999999999e20,
  1e-5,
  1e-6,
  1e-7,
  1e-8,
  1.5e-7,
  -1.5e-7,
  0.000001,
  0.0000001,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  123456789012345678901,
  1.2345678901234567,
  123456789.123456789,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  5e-324,
  1e-323,
  -Number.MAX_VALUE,
];
for (let index = 0; index < 48; index++) {
  const mantissa = (index * 2654435761) % 100000000000000000;
  const value = mantissa / 10 ** ((index * 7) % 40);
  finiteEncodeSweep.push(index % 2 === 0 ? value : -value);
}
for (const input of finiteEncodeSweep) {
  record("finiteFromString", "encode", Schema.FiniteFromString, input);
}

// The one live site, reached through the exported endpoint rather than re-spelled. The
// query object itself (`EnvironmentOrchestrationThreadSnapshotQuery`) is module-private,
// and on a GET it is declared as `payload:`, which the endpoint stores as a map from
// content type to `{encoding, schemas}`. `schemas[0]` is the plain struct; reading through
// the `FormUrlEncoded` wrapper is not porting it, which stays a transport concern.
//
// The checks run outbound as well as inbound — `{turnLimit: 0}` and `{turnLimit: 1.5}`
// are refused on the way out — and `"0x10"` really does arrive as 16 at a live endpoint.
const threadSnapshotPayload = EnvironmentOrchestrationHttpApi.endpoints.threadSnapshot
  .payload as unknown as Map<string, { schemas: ReadonlyArray<Schema.Top> }>;
const threadSnapshotQuery = threadSnapshotPayload.get("application/x-www-form-urlencoded")
  ?.schemas[0];
if (threadSnapshotQuery === undefined) throw new Error("threadSnapshot has no query schema");
for (const input of [
  {},
  { turnLimit: "2" },
  { turnLimit: "1" },
  { turnLimit: "0" },
  { turnLimit: "-1" },
  { turnLimit: "1.5" },
  { turnLimit: "abc" },
  { turnLimit: "" },
  { turnLimit: "Infinity" },
  { turnLimit: "NaN" },
  { turnLimit: " 2 " },
  { turnLimit: "2e3" },
  { turnLimit: "0x10" },
  { turnLimit: "9007199254740993" },
  { turnLimit: "9007199254740991" },
  { turnLimit: null },
  { turnLimit: 2 },
  { turnLimit: undefined },
  { reasoningMessages: "true", turnLimit: "3", beforeCursor: "  c  " },
  { reasoningMessages: "false" },
  { beforeCursor: "   " },
]) {
  record("turnLimit", "decode", threadSnapshotQuery, input);
  record("turnLimit", "encode", threadSnapshotQuery, input);
}

// `Schema.withConstructorDefault` — 1 site — recorded against the plain optional it is
// stacked on, under the *same* subject name. If the constructor default had any wire
// effect the two schemas would disagree and one of them would fail the replay; they do
// not. What it changes is `.make({})`, which fills the key in — a constructor obligation,
// not a codec one, so the Rust field is the same `Absent<bool>` the plain optional gets.
const ConstructorDefault = projectField(UserInputQuestion, "multiSelect");
const ConstructorPlain = Schema.Struct({ multiSelect: Schema.optional(Schema.Boolean) });
for (const input of [
  {},
  { multiSelect: true },
  { multiSelect: false },
  { multiSelect: null },
  { multiSelect: undefined },
  { multiSelect: "x" },
  { multiSelect: 1 },
]) {
  for (const schema of [ConstructorDefault, ConstructorPlain]) {
    record("constructorDefault", "decode", schema, input);
    record("constructorDefault", "encode", schema, input);
  }
}

// ── Fatia 5: `terminal.ts` — the first payload module ported, and the two values the
// numeric sweep never tried ────────────────────────────────────────────────
//
// The scalars were swept with `0, 1, -1, 1.5, 65535, 65536, 5`, which decides nothing about
// `Schema.Int`: it is `Number.isSafeInteger`, so the two values that separate it from an
// `i64` read are `2^53` (an integer, refused) and the integral float spellings `1e3` and
// `80.0` (integers, accepted). Measured: `decode(9007199254740992)` throws and
// `decode(1e3)` gives `1000`. A Rust port that deserialized into `i64` would take the first
// and refuse the second, in both directions silently.
for (const [name, schema] of [
  ["NonNegativeInt", NonNegativeInt],
  ["PositiveInt", PositiveInt],
  ["PortSchema", PortSchema],
] as const) {
  for (const input of [
    9_007_199_254_740_991, 9_007_199_254_740_992, -9_007_199_254_740_992, 1e3, 80.0, -0, 1e300,
  ]) {
    record(name, "decode", schema, input);
    record(name, "encode", schema, input);
  }
}

// The seven input shapes. What each one is evidence about is not the field list — the Rust
// struct says that — but the *construct each field is made of*: `optional(NullOr(…))` has
// three states and the two `Absent`/`Nullable` halves each cover only two of them;
// `providerInstanceId` is a brand whose checks run on the untrimmed text going out;
// `data`'s 65 536 is counted in UTF-16 units, so a surrogate pair costs two.
const sessionId = { threadId: "t-1", terminalId: "term-1" };
const paddedLongId = `  ${"a".repeat(129)}  `;
for (const input of [
  {},
  sessionId,
  { ...sessionId, cwd: "/repo" },
  { ...sessionId, cwd: "  " },
  { ...sessionId, cwd: 5 },
  // The three states of `Schema.optional(Schema.NullOr(TrimmedNonEmptyString))`.
  { ...sessionId, cwd: "/repo", worktreePath: null },
  { ...sessionId, cwd: "/repo", worktreePath: " /repo " },
  { ...sessionId, cwd: "/repo", worktreePath: "  " },
  { ...sessionId, cwd: "/repo", worktreePath: 5 },
  // Both bounds inclusive, and the integer filter ahead of them.
  { ...sessionId, cwd: "/repo", cols: 1, rows: 1 },
  { ...sessionId, cwd: "/repo", cols: 0 },
  { ...sessionId, cwd: "/repo", cols: 1001 },
  { ...sessionId, cwd: "/repo", rows: 501 },
  { ...sessionId, cwd: "/repo", cols: 8e1 },
  { ...sessionId, cwd: "/repo", cols: "80" },
  { ...sessionId, cwd: "/repo", cols: null },
  // The `LenientKeys` record: a bad key loses an entry, a bad value loses the field.
  { ...sessionId, cwd: "/repo", env: { PATH: "/usr/bin", "1BAD": "v" } },
  { ...sessionId, cwd: "/repo", env: { PATH: "x".repeat(8_193) } },
  { ...sessionId, cwd: "/repo", env: null },
  // The brand, and the fact that its checks see the padded text on the way out.
  { ...sessionId, cwd: "/repo", providerInstanceId: "codex_work" },
  { ...sessionId, cwd: "/repo", providerInstanceId: " codex_work " },
  { ...sessionId, cwd: "/repo", providerInstanceId: "1bad" },
  { ...sessionId, cwd: "/repo", providerInstanceId: "a".repeat(65) },
  { ...sessionId, cwd: "/repo", providerInstanceId: 5 },
  { ...sessionId, cwd: "/repo", terminalId: paddedLongId },
  { ...sessionId, cwd: "/repo", unknownKey: true },
]) {
  record("terminalOpen", "decode", TerminalOpenInput, input);
  record("terminalOpen", "encode", TerminalOpenInput, input);
}

// `TerminalAttachInput` — the same fields with `cwd` demoted to optional, plus the one flag
// that is not on any other input. `restartIfNotRunning` is a plain `Schema.optional(Boolean)`,
// so an explicit `null` is a failure and not an absence.
for (const input of [
  sessionId,
  { ...sessionId, cwd: "  " },
  { ...sessionId, restartIfNotRunning: true },
  { ...sessionId, restartIfNotRunning: null },
  { ...sessionId, restartIfNotRunning: "yes" },
  { ...sessionId, cols: 100, rows: 30, env: { A: "b" } },
  { ...sessionId, providerInstanceId: "codex" },
]) {
  record("terminalAttach", "decode", TerminalAttachInput, input);
  record("terminalAttach", "encode", TerminalAttachInput, input);
}

// `TerminalWriteInput.data` — `String.check(isNonEmpty()).check(isMaxLength(65_536))` over a
// **bare** string, so nothing trims and the cap counts UTF-16 units. The last two cases are
// the pair that separates UTF-16 from codepoints: 32 768 astral characters are 65 536 units
// and fit, one more is 65 537 and does not, while `String.length`-naive ports see 32 769.
const astral = "😀".repeat(32_768);
for (const input of [
  { ...sessionId, data: "" },
  { ...sessionId, data: "ls\r\n" },
  { ...sessionId, data: "  " },
  { ...sessionId, data: "x".repeat(65_536) },
  { ...sessionId, data: "x".repeat(65_537) },
  { ...sessionId, data: astral },
  { ...sessionId, data: `${astral}x` },
  { ...sessionId, data: 5 },
  { ...sessionId, data: null },
]) {
  record("terminalWrite", "decode", TerminalWriteInput, input);
  record("terminalWrite", "encode", TerminalWriteInput, input);
}

// `TerminalResizeInput` and `TerminalRestartInput` — where `cols`/`rows` are required, which
// is the only structural difference from the open and attach inputs.
for (const input of [
  { ...sessionId },
  { ...sessionId, cols: 1, rows: 1 },
  { ...sessionId, cols: 1000, rows: 500 },
  { ...sessionId, cols: 1001, rows: 500 },
  { ...sessionId, cols: 1, rows: 501 },
  { ...sessionId, cols: 1, rows: 500, cwd: "/repo", env: { LC_ALL: "C" } },
  { ...sessionId, cols: 1, rows: 500, cwd: "  " },
]) {
  record("terminalResize", "decode", TerminalResizeInput, input);
  record("terminalResize", "encode", TerminalResizeInput, input);
}
for (const input of [
  { ...sessionId, cols: 1, rows: 1, cwd: "/repo" },
  { ...sessionId, cols: 1, rows: 1 },
  { ...sessionId, cols: 1, rows: 1, cwd: "/repo", worktreePath: null },
  { ...sessionId, cols: 1, rows: 1, cwd: "/repo", providerInstanceId: "claude" },
]) {
  record("terminalRestart", "decode", TerminalRestartInput, input);
  record("terminalRestart", "encode", TerminalRestartInput, input);
}

// `TerminalCloseInput` — the one input with an optional `terminalId`, which is how a client
// closes every shell on a thread.
for (const input of [
  { threadId: "t-1" },
  { threadId: "  " },
  { threadId: "t-1", terminalId: "term-1" },
  { threadId: "t-1", terminalId: "  " },
  { threadId: "t-1", deleteHistory: true },
  { threadId: "t-1", deleteHistory: null },
  { threadId: "t-1", terminalId: "term-1", deleteHistory: false },
]) {
  record("terminalClose", "decode", TerminalCloseInput, input);
  record("terminalClose", "encode", TerminalCloseInput, input);
}

// `TerminalSessionSnapshot` and `TerminalSummary` — the server-written half, where the ids
// are `Schema.String.check(isNonEmpty())` and **not** the trimming spelling the inputs use.
// `"  "` is therefore a valid thread id here and a failure in `terminalOpen`, and the same
// two spaces survive the round trip instead of being trimmed away.
const snapshotBase = {
  threadId: "t-1",
  terminalId: "term-1",
  cwd: "/repo",
  worktreePath: null,
  status: "running",
  pid: 4160,
  history: "",
  exitCode: null,
  exitSignal: null,
  label: "zsh",
  updatedAt: "2026-11-21T00:00:00.000Z",
};
for (const input of [
  {},
  snapshotBase,
  { ...snapshotBase, threadId: "  " },
  { ...snapshotBase, cwd: "  " },
  // A required key, absent. Spelled by removing it rather than setting it to `undefined`,
  // which has no JSON form and would leave the case uncomparable.
  (() => {
    const { history: _history, ...noHistory } = snapshotBase;
    return noHistory;
  })(),
  // `pid` is `NullOr(Int.check(isGreaterThan(0)))`, so 0 and -1 fail and `4160e0` does not.
  { ...snapshotBase, pid: null },
  { ...snapshotBase, pid: 0 },
  { ...snapshotBase, pid: -1 },
  { ...snapshotBase, pid: 4160 },
  { ...snapshotBase, pid: 1.5 },
  { ...snapshotBase, status: "paused" },
  { ...snapshotBase, status: null },
  { ...snapshotBase, exitCode: 1 },
  { ...snapshotBase, exitCode: 1.5 },
  { ...snapshotBase, exitSignal: null },
  { ...snapshotBase, label: "x".repeat(129) },
  { ...snapshotBase, updatedAt: 5 },
  { ...snapshotBase, sequence: 0 },
  { ...snapshotBase, sequence: -1 },
  { ...snapshotBase, sequence: 1e3 },
]) {
  record("terminalSnapshot", "decode", TerminalSessionSnapshot, input);
  record("terminalSnapshot", "encode", TerminalSessionSnapshot, input);
}
for (const input of [
  { ...snapshotBase, hasRunningSubprocess: true },
  { ...snapshotBase, hasRunningSubprocess: false },
  // The summary has no `history` and no `sequence`: both are unknown keys here, dropped
  // rather than refused, which is the only way to tell the two shapes apart from the wire.
  { ...snapshotBase, hasRunningSubprocess: true, history: "ls\r\n", sequence: 3 },
  { ...snapshotBase },
  { ...snapshotBase, hasRunningSubprocess: null },
]) {
  record("terminalSummary", "decode", TerminalSummary, input);
  record("terminalSummary", "encode", TerminalSummary, input);
}

// The three stream unions. Every member is `{…base, type, …}`, so `type` is the **fourth**
// key on the wire for `TerminalEvent` — invisible to this golden, which compares parsed
// JSON, and pinned byte for byte in the Rust crate's own tests. What the golden does decide
// is the member set: `snapshot` is a member of the attach stream and not of the event
// stream, and `started` the other way round.
for (const input of [
  { threadId: "t-1", terminalId: "term-1", type: "output", data: "ls\r\n" },
  { threadId: "t-1", terminalId: "term-1", sequence: 3, type: "output", data: "" },
  { threadId: "  ", terminalId: "term-1", type: "output", data: "x" },
  { threadId: "t-1", terminalId: "term-1", sequence: -1, type: "output", data: "x" },
  { threadId: "t-1", terminalId: "term-1", type: "cleared" },
  { threadId: "t-1", terminalId: "term-1", type: "closed" },
  { threadId: "t-1", terminalId: "term-1", type: "exited", exitCode: 0, exitSignal: null },
  { threadId: "t-1", terminalId: "term-1", type: "error", message: "spawn failed" },
  { threadId: "t-1", terminalId: "term-1", type: "error", message: "  " },
  {
    threadId: "t-1",
    terminalId: "term-1",
    type: "activity",
    hasRunningSubprocess: true,
    label: "vim",
  },
  { threadId: "t-1", terminalId: "term-1", type: "started", snapshot: snapshotBase },
  { threadId: "t-1", terminalId: "term-1", type: "snapshot", snapshot: snapshotBase },
  { threadId: "t-1", terminalId: "term-1", type: "nope" },
  { threadId: "t-1", terminalId: "term-1" },
]) {
  record("terminalEvent", "decode", TerminalEvent, input);
  record("terminalEvent", "encode", TerminalEvent, input);
}
for (const input of [
  { type: "snapshot", terminals: [{ ...snapshotBase, hasRunningSubprocess: true }] },
  { type: "snapshot", terminals: [] },
  { type: "snapshot", terminals: [snapshotBase] },
  { type: "upsert", terminal: { ...snapshotBase, hasRunningSubprocess: false } },
  { type: "remove", threadId: "t-1", terminalId: "term-1" },
  { type: "remove", threadId: "t-1" },
  { type: "remove", threadId: "  ", terminalId: "term-1" },
  { type: "started", threadId: "t-1", terminalId: "term-1", snapshot: snapshotBase },
]) {
  record("terminalMetadata", "decode", TerminalMetadataStreamEvent, input);
  record("terminalMetadata", "encode", TerminalMetadataStreamEvent, input);
}
for (const input of [
  { threadId: "t-1", terminalId: "term-1", type: "snapshot", snapshot: snapshotBase },
  { threadId: "t-1", terminalId: "term-1", type: "started", snapshot: snapshotBase },
  { type: "snapshot", snapshot: snapshotBase },
  { threadId: "t-1", terminalId: "term-1", type: "output", data: "" },
]) {
  record("terminalAttachEvent", "decode", TerminalAttachStreamEvent, input);
  record("terminalAttachEvent", "encode", TerminalAttachStreamEvent, input);
}

// `TerminalError` — ten `Schema.TaggedError` classes flattened through `TerminalCwdError`.
//
// The Type side is an `Error` **instance**, so a wire object handed to `encodeUnknownSync`
// throws `AnyOf` (measured) and the encode cases must go through `recordTyped`, which decodes
// first. That is also the honest round trip. The successful decodes cannot be recorded at all:
// `toWire`'s `Error` branch projects an instance to `{name, message, cause}`, which drops the
// declared fields, so only the **failures** are comparable from the decode side — and they are
// the interesting half of a union: which input matches no member.
//
// Three things the recorded encodes pin. `cause` is `Schema.Defect()`, so `null` stays a
// present null, a `{message}` object comes back as `{name:"Error",message}` in that key order,
// and a non-object like `5` is held verbatim. The optional `cause` of `TerminalHistoryError`
// is written **only when the key arrived** — `Object.hasOwn`, not `!== undefined`. And no
// member carries a `message` field on the wire, because the class getter is not a field.
for (const encoded of [
  { _tag: "TerminalCwdNotFoundError", cwd: "/nope" },
  { _tag: "TerminalCwdNotDirectoryError", cwd: "/etc/hosts" },
  { _tag: "TerminalCwdStatError", cwd: "/x", cause: { message: "EACCES" } },
  { _tag: "TerminalCwdStatError", cwd: "/x", cause: null },
  { _tag: "TerminalHistoryError", operation: "read", threadId: "t-1", terminalId: "term-1" },
  {
    _tag: "TerminalHistoryError",
    operation: "truncate",
    threadId: "t-1",
    terminalId: "term-1",
    cause: { name: "Error", message: "disk", cause: { message: "inner" } },
  },
  { _tag: "TerminalSessionLookupError", threadId: "t-1", terminalId: "term-1" },
  { _tag: "TerminalProviderInstanceNotFoundError", providerInstanceId: "codex_work" },
  { _tag: "TerminalProviderEnvironmentError", providerInstanceId: "codex", cause: 5 },
  { _tag: "TerminalNotRunningError", threadId: "t-1", terminalId: "term-1" },
  {
    _tag: "TerminalWriteError",
    threadId: "t-1",
    terminalId: "term-1",
    terminalPid: 4160,
    cause: { message: "pipe" },
  },
  {
    _tag: "TerminalWriteError",
    threadId: "t-1",
    terminalId: "term-1",
    terminalPid: 1.5,
    cause: { message: "pipe" },
  },
  {
    _tag: "TerminalResizeError",
    threadId: "t-1",
    terminalId: "term-1",
    terminalPid: 4160,
    cols: 8e1,
    rows: 30,
    cause: { message: "ioctl" },
  },
]) {
  recordTyped("terminalError", TerminalError, encoded);
}
for (const input of [
  // No `_tag` at all, an unknown one, and a member whose required `cause` is missing.
  { threadId: "t-1", terminalId: "term-1" },
  { _tag: "TerminalSomethingElseError" },
  { _tag: "TerminalCwdStatError", cwd: "/x" },
  // `operation` is a closed literal set, so a fourth verb matches no member.
  { _tag: "TerminalHistoryError", operation: "nope", threadId: "t-1", terminalId: "term-1" },
  // The size bounds sit inside the error shapes too.
  {
    _tag: "TerminalResizeError",
    threadId: "t-1",
    terminalId: "term-1",
    terminalPid: 4160,
    cols: 1001,
    rows: 30,
    cause: { message: "ioctl" },
  },
  // A brand is erased at runtime but its checks are not.
  { _tag: "TerminalProviderInstanceNotFoundError", providerInstanceId: "1bad" },
]) {
  record("terminalError", "decode", TerminalError, input);
}

// ── Fatia 6: `providerRuntime.ts` + `providerUsageLimits.ts` ───────────────
//
// This is the payload every provider adapter emits, so nothing in the provider phase can be
// ported before it. Two things the terminal union did not exercise: **49 members discriminated
// only by a required literal `type`**, and a base struct whose nine optional fields have to
// round-trip in declaration order — the probe measured the encoder writing
// `eventId, provider, providerInstanceId, threadId, createdAt, turnId, itemId, requestId,
// providerRefs, raw, type, payload`, i.e. exactly the field order of the spread.
//
// `IsoDateTime` is `Schema.String` here, **not** a parsed date: the probe fed
// `2026-11-21T03:04:05.000+02:00` and got the same spelling back. A port that parsed and
// re-rendered it would normalize the offset to `Z` and diverge on every event a non-UTC
// emitter produced.
const rtBase = {
  eventId: "e-1",
  provider: "claude",
  threadId: "t-1",
  createdAt: "2026-11-21T00:00:00.000Z",
};

// One minimal valid payload per tag, **in union declaration order**, so the recorded order is
// also the order the Rust enum declares its variants. Then the same input with `{}` as payload,
// which is only `ok` for the payloads that are entirely optional — the count of those is the
// measurement of which members have a required field.
const rtMinimal: ReadonlyArray<readonly [string, unknown]> = [
  ["session.started", {}],
  ["session.configured", { config: {} }],
  ["session.state.changed", { state: "ready" }],
  ["session.exited", {}],
  ["thread.started", {}],
  ["thread.state.changed", { state: "active" }],
  ["thread.metadata.updated", {}],
  ["thread.token-usage.updated", { usage: { usedTokens: 1 } }],
  ["thread.realtime.started", {}],
  ["thread.realtime.item-added", { item: 1 }],
  ["thread.realtime.audio.delta", { audio: 1 }],
  ["thread.realtime.error", { message: "mic failed" }],
  ["thread.realtime.closed", {}],
  ["turn.started", {}],
  ["turn.completed", { state: "completed" }],
  ["turn.aborted", { reason: "user" }],
  ["turn.plan.updated", { plan: [{ step: "s", status: "pending" }] }],
  ["turn.proposed.delta", { delta: "" }],
  ["turn.proposed.completed", { planMarkdown: "p" }],
  ["turn.diff.updated", { unifiedDiff: "" }],
  ["item.started", { itemType: "plan" }],
  ["item.updated", { itemType: "plan" }],
  ["item.completed", { itemType: "plan" }],
  ["content.delta", { streamKind: "assistant_text", delta: "" }],
  ["request.opened", { requestType: "permission_approval" }],
  ["request.resolved", { requestType: "permission_approval" }],
  [
    "user-input.requested",
    {
      questions: [{ id: "q", header: "h", question: "?", options: [] }],
    },
  ],
  ["user-input.resolved", { answers: {} }],
  ["task.started", { taskId: "tk-1" }],
  ["task.progress", { taskId: "tk-1", description: "d" }],
  ["task.updated", { taskId: "tk-1" }],
  ["task.completed", { taskId: "tk-1", status: "completed" }],
  ["hook.started", { hookId: "h", hookName: "n", hookEvent: "e" }],
  ["hook.progress", { hookId: "h" }],
  ["hook.completed", { hookId: "h", outcome: "success" }],
  ["tool.progress", {}],
  ["tool.summary", { summary: "s" }],
  ["auth.status", {}],
  ["account.updated", { account: 1 }],
  ["account.rate-limits.updated", { limits: { windows: [] } }],
  ["mcp.status.updated", { status: 1 }],
  ["mcp.oauth.completed", { success: true }],
  ["model.rerouted", { fromModel: "a", toModel: "b", reason: "r" }],
  ["config.warning", { summary: "s" }],
  ["deprecation.notice", { summary: "s" }],
  ["files.persisted", { files: [{ filename: "a.png", fileId: "f-1" }] }],
  ["tool.denied", { toolName: "bash" }],
  ["runtime.warning", { message: "m" }],
  ["runtime.error", { message: "m" }],
];
for (const [type, payload] of rtMinimal) {
  record("providerRuntime", "decode", ProviderRuntimeEvent, { ...rtBase, type, payload });
  record("providerRuntime", "encode", ProviderRuntimeEvent, { ...rtBase, type, payload });
  record("providerRuntime", "decode", ProviderRuntimeEvent, { ...rtBase, type, payload: {} });
}

// The base: which fields are optional, in what order they come back out, and what a
// `type`/`payload` mismatch does. With every member carrying its own required literal the
// union cannot swallow a richer payload the way the terminal one did — recorded so the claim
// is measured rather than assumed.
for (const input of [
  {
    ...rtBase,
    providerInstanceId: "claude_work",
    turnId: "tu-1",
    itemId: "it-1",
    requestId: "rq-1",
    providerRefs: { providerTurnId: "pt", providerItemId: "pi", providerRequestId: "pr" },
    raw: { source: "claude.sdk.message", method: " m ", messageType: "t", payload: { x: [1, 2] } },
    type: "session.configured",
    payload: { config: { a: 1 } },
  },
  { ...rtBase, provider: "  claude  ", type: "session.configured", payload: { config: {} } },
  // A driver kind is an **open** slug, so a fork's unknown provider must still decode.
  { ...rtBase, provider: "ollama_fork", type: "session.configured", payload: { config: {} } },
  { ...rtBase, provider: "1bad", type: "session.configured", payload: { config: {} } },
  { ...rtBase, provider: "", type: "session.configured", payload: { config: {} } },
  {
    ...rtBase,
    createdAt: "2026-11-21T03:04:05.000+02:00",
    type: "session.configured",
    payload: { config: {} },
  },
  { ...rtBase, createdAt: "not a date", type: "session.configured", payload: { config: {} } },
  { ...rtBase, type: "runtime.error", payload: { message: "m", class: "not_a_class" } },
  { ...rtBase, type: "runtime.error", payload: { message: "m", class: 42 } },
  // The mismatch that would have been a swallow: right payload, wrong tag.
  { ...rtBase, type: "tool.denied", payload: { message: "m", class: "unknown" } },
  { ...rtBase, type: "runtime.error", payload: { toolName: "bash" } },
  { ...rtBase, type: "session.started", payload: { message: "  " } },
  { ...rtBase, type: "session.started", payload: { message: " x " } },
  { ...rtBase, type: "session.started", payload: { resume: { any: [1, null, "s"] } } },
  { ...rtBase, type: "unknown-key", payload: {} },
  { ...rtBase, type: "session.started", payload: {}, extra: 1 },
  { ...rtBase, type: "session.started" },
  { ...rtBase, eventId: "", type: "session.configured", payload: { config: {} } },
  { ...rtBase, threadId: " ", type: "session.configured", payload: { config: {} } },
]) {
  record("providerRuntime", "decode", ProviderRuntimeEvent, input);
  record("providerRuntime", "encode", ProviderRuntimeEvent, input);
}

// `contentIndex`/`summaryIndex`/`exitCode` are bare `Schema.Int` and `totalCostUsd`/
// `elapsedSeconds` are bare `Schema.Number`: the same safe-integer gate the newtypes carry, but
// inline, so `2.5` and `2^53` refuse while `80.0` and `-3` do not.
for (const [type, payload] of [
  ["content.delta", { streamKind: "command_output", delta: "x", contentIndex: 2.5 }],
  ["content.delta", { streamKind: "command_output", delta: "x", contentIndex: 80.0 }],
  [
    "content.delta",
    { streamKind: "command_output", delta: "x", contentIndex: 9_007_199_254_740_992 },
  ],
  [
    "content.delta",
    { streamKind: "command_output", delta: "x", contentIndex: -3, summaryIndex: 0 },
  ],
  ["content.delta", { streamKind: "command_output", delta: "x", contentIndex: "1" }],
  ["content.delta", { streamKind: "nope", delta: "" }],
  ["hook.completed", { hookId: "h", outcome: "error", exitCode: 80.0 }],
  ["hook.completed", { hookId: "h", outcome: "error", exitCode: 1.5 }],
  ["hook.completed", { hookId: "h", outcome: "killed" }],
  ["hook.progress", { hookId: "h", output: "", stdout: "", stderr: "" }],
  ["turn.completed", { state: "completed", totalCostUsd: 0.1 }],
  ["turn.completed", { state: "completed", totalCostUsd: 1e21 }],
  ["turn.completed", { state: "completed", totalCostUsd: "1" }],
  ["turn.completed", { state: "completed", stopReason: null }],
  ["turn.completed", { state: "completed", stopReason: "  " }],
  ["turn.completed", { state: "completed", modelUsage: { a: 1, "b c": 2 } }],
  ["turn.completed", { state: "nope" }],
  ["tool.progress", { elapsedSeconds: 1.5, taskId: "tk-1" }],
] as const) {
  record("providerRuntime", "decode", ProviderRuntimeEvent, { ...rtBase, type, payload });
  record("providerRuntime", "encode", ProviderRuntimeEvent, { ...rtBase, type, payload });
}

// The two-member `TurnTokenUsage` union. The members differ by **both** `usageStatus` and
// which counts are required, so declaration order could hide a fallthrough: a `complete`
// missing `inputTokens` must fail rather than be read as `partial`.
for (const tokenUsage of [
  { usageStatus: "complete", inputTokens: 1, outputTokens: 2, hasSubagents: false },
  { usageStatus: "complete", inputTokens: 1, hasSubagents: false },
  { usageStatus: "partial", hasSubagents: true },
  { usageStatus: "unavailable", hasSubagents: false, inputTokens: 9 },
  {
    usageStatus: "complete",
    inputTokens: 1,
    outputTokens: 2,
    hasSubagents: false,
    usageScope: "subagent",
  },
  { usageStatus: "partial", inputTokens: 1.5, hasSubagents: false },
  { usageStatus: "unknown_status", hasSubagents: false },
]) {
  const input = { ...rtBase, type: "turn.aborted", payload: { reason: "r", tokenUsage } };
  record("providerRuntime", "decode", ProviderRuntimeEvent, input);
  record("providerRuntime", "encode", ProviderRuntimeEvent, input);
}

// `ToolActivityIcon` is three `TaggedStruct`s whose tag is a key named `type` *inside* the
// icon, one of which nests a further two-member tagged union with a checked leaf
// (`isMaxLength(512)` **and** `isPattern(/^[A-Za-z0-9._-]+$/u)`). The `_` in the pattern is the
// reason a `\w` port is not equivalent, and the `u` flag means a non-ASCII astral appId is
// refused rather than counted as one code point.
for (const payload of [
  {
    itemType: "mcp_tool_call",
    toolIcon: { _tag: "website", pageUrl: "https://a" },
    toolSource: { key: "k", name: "n", kind: "browser" },
  },
  {
    itemType: "mcp_tool_call",
    toolIcon: {
      _tag: "website",
      pageUrl: "https://a",
      faviconUrl: "  https://f  ",
      faviconUrlDark: "",
    },
  },
  {
    itemType: "mcp_tool_call",
    toolIcon: { _tag: "native-app", app: { _tag: "app-id", appId: "com_a.B-1" } },
  },
  {
    itemType: "mcp_tool_call",
    toolIcon: { _tag: "native-app", app: { _tag: "app-id", appId: "_leading" } },
  },
  {
    itemType: "mcp_tool_call",
    toolIcon: { _tag: "native-app", app: { _tag: "app-id", appId: "a".repeat(513) } },
  },
  {
    itemType: "mcp_tool_call",
    toolIcon: { _tag: "native-app", app: { _tag: "app-id", appId: "a😀" } },
  },
  {
    itemType: "mcp_tool_call",
    toolIcon: { _tag: "native-app", app: { _tag: "display-name", displayName: "  Notes  " } },
  },
  {
    itemType: "mcp_tool_call",
    toolIcon: { _tag: "native-app", app: { _tag: "display-name", displayName: "x".repeat(161) } },
  },
  {
    itemType: "mcp_tool_call",
    toolIcon: { _tag: "themed-logo", logoUrl: "https://l".padEnd(4096, "x") },
  },
  {
    itemType: "mcp_tool_call",
    toolIcon: { _tag: "themed-logo", logoUrl: "https://l".padEnd(4097, "x") },
  },
  { itemType: "mcp_tool_call", toolIcon: { type: "other" } },
  { itemType: "mcp_tool_call", toolSource: { key: "k", name: "n", kind: "nope" } },
  {
    itemType: "mcp_tool_call",
    toolSource: {
      key: "k",
      name: "n",
      kind: "integration",
      icon: { _tag: "themed-logo", logoUrl: "u" },
    },
  },
  { itemType: "nope" },
  { itemType: "command_execution", status: "declined", agentId: " a ", parentToolUseId: "" },
  { itemType: "command_execution", data: { nested: { deep: [1, "a", null] } }, detail: " d " },
]) {
  const input = { ...rtBase, type: "item.updated", payload };
  record("providerRuntime", "decode", ProviderRuntimeEvent, input);
  record("providerRuntime", "encode", ProviderRuntimeEvent, input);
}

// The task linkage spread onto four payloads: 19 optional fields, one array of structs, one
// closed literal pair, and a boolean that clients read as "keep this out of the parent log".
for (const payload of [
  {
    taskId: "tk-1",
    taskType: "subagent",
    agentKind: "agent",
    agentId: "a",
    phases: [{ index: 0, title: "p" }],
  },
  { taskId: "tk-1", taskType: "subagent", agentKind: "background" },
  { taskId: "tk-1", agentKind: "nope" },
  { taskId: "tk-1", phases: [{ index: 1.5, title: "p" }] },
  { taskId: "tk-1", phases: [{ index: 0, title: "  " }] },
  { taskId: "tk-1", runHandles: { runId: " r " }, timelineBypass: true, agentPath: "/root/marlow" },
  { taskId: "tk-1", typedUsage: { totalTokens: 0 }, usage: { any: "shape" } },
  { taskId: "tk-1", typedUsage: {} },
  { taskId: "tk-1", attempt: -1, agentIndex: 0, phaseIndex: 2, isBackgrounded: false },
  { taskId: "tk-1", endedAt: "2026-11-21T00:00:00.000Z" },
]) {
  const input = { ...rtBase, type: "task.progress", payload };
  record("providerRuntime", "decode", ProviderRuntimeEvent, input);
  record("providerRuntime", "encode", ProviderRuntimeEvent, input);
}

// `Schema.withConstructorDefault` was measured wire-neutral at the top level in fatia 4;
// re-measured here where the field sits inside a struct **inside an array**, which is the case
// a nested default could plausibly behave differently in.
for (const payload of [
  { questions: [{ id: "q", header: "h", question: "?", options: [] }] },
  { questions: [{ id: "q", header: "h", question: "?", options: [], multiSelect: false }] },
  { questions: [{ id: "q", header: "h", question: "?", options: [], multiSelect: true }] },
  { questions: [{ id: "q", header: "h", question: "?", options: [], multiSelect: null }] },
  {
    questions: [
      { id: "q", header: "h", question: "?", options: [{ label: " l ", description: "" }] },
    ],
    responseMode: "message",
  },
  { questions: [{ id: "q", header: "h", question: "?", options: [{ label: "l" }] }] },
  { questions: [] },
]) {
  const input = { ...rtBase, type: "user-input.requested", payload };
  record("providerRuntime", "decode", ProviderRuntimeEvent, input);
  record("providerRuntime", "encode", ProviderRuntimeEvent, input);
}

for (const payload of [
  {
    options: [
      { decision: "accept", label: "l" },
      { decision: "cancel", label: " c ", warning: "w" },
    ],
  },
  { options: [{ decision: "nope", label: "l" }] },
  { options: [{ label: "l" }] },
  { args: [1, "a", null] },
]) {
  const input = {
    ...rtBase,
    type: "request.opened",
    payload: { requestType: "command_execution_approval", ...payload },
  };
  record("providerRuntime", "decode", ProviderRuntimeEvent, input);
  record("providerRuntime", "encode", ProviderRuntimeEvent, input);
}

for (const payload of [
  { files: [{ filename: "a", fileId: "b" }], failed: [{ filename: "c", error: "e" }] },
  { files: [] },
  { files: [{ filename: "  ", fileId: "b" }] },
  { files: [{ filename: "a" }] },
  { limits: { windows: [] } },
  { limits: {} },
  { status: null },
  { success: "yes" },
  { summary: "s", precedingToolUseIds: [" a ", ""] },
]) {
  const type =
    payload.files !== undefined
      ? "files.persisted"
      : payload.limits !== undefined
        ? "account.rate-limits.updated"
        : payload.status !== undefined
          ? "mcp.status.updated"
          : payload.success !== undefined
            ? "mcp.oauth.completed"
            : "tool.summary";
  const input = { ...rtBase, type, payload };
  record("providerRuntime", "decode", ProviderRuntimeEvent, input);
  record("providerRuntime", "encode", ProviderRuntimeEvent, input);
}

// `RuntimeEventRaw.source` is eight literals plus a `TemplateLiteral(["acp.", String, ".extension"])`.
// Measured: the template accepts `acp..extension` (the middle `String` matches empty) and
// `acp.a.b.extension`, and rejects anything else — so the port is a prefix/suffix test, not a
// regex, and a `acp.` **or** `.extension` alone is not enough.
for (const source of [
  "codex.app-server.notification",
  "codex.app-server.request",
  "codex.eventmsg",
  "claude.sdk.message",
  "claude.sdk.permission",
  "codex.sdk.thread-event",
  "opencode.sdk.event",
  "acp.jsonrpc",
  "acp.x.extension",
  "acp..extension",
  "acp.a.b.extension",
  "acp.",
  ".extension",
  "acp.x",
  "x.extension",
  "",
]) {
  record("runtimeEventRaw", "decode", RuntimeEventRaw, { source, payload: {} });
  record("runtimeEventRaw", "encode", RuntimeEventRaw, { source, payload: {} });
}
for (const raw of [
  { source: "acp.jsonrpc", method: "", payload: 1 },
  { source: "acp.jsonrpc", messageType: " m ", payload: null },
  { source: "acp.jsonrpc" },
  { source: "acp.jsonrpc", payload: undefined },
]) {
  record("runtimeEventRaw", "decode", RuntimeEventRaw, raw);
  record("runtimeEventRaw", "encode", RuntimeEventRaw, raw);
}

// `usedPercent` is the **only** `Schema.isBetween` in the ported surface: inclusive at both ends,
// and `NaN`/`Infinity` fall out because the comparisons are false — a Rust `>= && <=` over
// `f64` reproduces that without an explicit gate, which is worth pinning. `-0` decodes and the
// wire writes `0`. `NaN` and `Infinity` cannot be expressed as JSON at all (the walk renders
// them as `null`), which is a declared blind spot rather than a gap: a runtime event only ever
// arrives over JSON, so the wire cannot carry them either.
for (const usedPercent of [0, 1, 100, 100.000001, -0, -0.000001, 1e308, 1e-320, "50", null]) {
  const window = { id: "five_hour", kind: "session", label: "5h", usedPercent };
  record("providerUsageWindow", "decode", ServerProviderUsageWindow, window);
  record("providerUsageWindow", "encode", ServerProviderUsageWindow, window);
}
for (const window of [
  {
    id: " five_hour ",
    kind: "weekly",
    label: " 1w ",
    usedPercent: 1,
    resetsAt: "2026-11-22T00:00:00.000Z",
  },
  { id: "five_hour", kind: "session", label: "5h", usedPercent: 1, windowDurationMins: 300 },
  { id: "five_hour", kind: "session", label: "5h", usedPercent: 1, windowDurationMins: -1 },
  { id: "five_hour", kind: "session", label: "5h", usedPercent: 1, windowDurationMins: 1.5 },
  { id: "", kind: "session", label: "5h", usedPercent: 1 },
  { id: "five_hour", kind: "daily", label: "5h", usedPercent: 1 },
  { id: "five_hour", kind: "session", usedPercent: 1 },
]) {
  record("providerUsageWindow", "decode", ServerProviderUsageWindow, window);
  record("providerUsageWindow", "encode", ServerProviderUsageWindow, window);
}
// `windows` is `ForwardCompatibleArray`, so an element that does not decode is **dropped**
// rather than failing the whole snapshot — the one place in this file where a bad row is
// silently discarded instead of refused.
for (const limits of [
  { checkedAt: "2026-11-21T00:00:00.000Z", windows: [] },
  {
    checkedAt: "2026-11-21T00:00:00.000Z",
    windows: [
      { id: "ok", kind: "other", label: "l", usedPercent: 1 },
      "junk",
      null,
      { id: "bad", kind: "session", label: "l", usedPercent: 200 },
      { id: "ok2", kind: "monthly", label: "m", usedPercent: 0 },
    ],
  },
  { checkedAt: "2026-11-21T00:00:00.000Z", windows: [], resetCredits: { availableCount: 0 } },
  {
    checkedAt: "2026-11-21T00:00:00.000Z",
    windows: [],
    resetCredits: {
      availableCount: 2,
      nextCreditId: " c ",
      nextExpiresAt: "2026-12-01T00:00:00.000Z",
    },
  },
  { checkedAt: "2026-11-21T00:00:00.000Z", windows: [], resetCredits: {} },
  { checkedAt: "2026-11-21T00:00:00.000Z", windows: [], unavailable: { reason: "unsupported" } },
  {
    checkedAt: "2026-11-21T00:00:00.000Z",
    windows: [],
    unavailable: { reason: "probeFailed", message: "  " },
  },
  { checkedAt: "2026-11-21T00:00:00.000Z", windows: [], unavailable: { reason: "other" } },
  { checkedAt: "2026-11-21T00:00:00.000Z", windows: [], unavailable: null },
  { checkedAt: "2026-11-21T00:00:00.000Z" },
  { checkedAt: "not a date", windows: [] },
  { checkedAt: "2026-11-21T00:00:00.000Z", windows: {} },
]) {
  record("providerUsageLimits", "decode", ServerProviderUsageLimits, limits);
  record("providerUsageLimits", "encode", ServerProviderUsageLimits, limits);
}
for (const update of [
  { windows: [] },
  {},
  { windows: [{ id: "a", kind: "session", label: "l", usedPercent: 50 }] },
  { windows: "x" },
]) {
  record("providerUsageLimitsUpdate", "decode", ProviderUsageLimitsUpdate, update);
  record("providerUsageLimitsUpdate", "encode", ProviderUsageLimitsUpdate, update);
}

// `classifyTaskAgentKind` is not a codec: it is the one pure function in this module, twelve
// lines of `!== undefined` and a `trim().length > 0` gate over two denylists. Its rows join the
// same `codecs` list under their own subject, because the replay dispatches by subject name and
// a function is just another builder that maps an input row to an output value. The table is
// exhaustive over the interesting space rather than sampled, because the whole
// point is which of the four conditions is load-bearing — `""` and `"  "` are **not** agent
// linkage, `MONITOR` and `" monitor "` are **not** in the set, and an absent `taskType` with a
// real `agentId` is background.
const pureRows: Array<{ input: unknown; ok: unknown }> = [];
for (const taskType of [
  undefined,
  "monitor",
  "monitor_mcp",
  "local_bash",
  "shell",
  "plan",
  "dream",
  "subagent",
  "local_agent",
  "local_workflow",
  "MONITOR",
  " monitor ",
  "",
  "  ",
] as const) {
  for (const agentId of [undefined, "", " ", "  ", "a1", " a "] as const) {
    pureRows.push({
      input: { taskType, agentId },
      ok: classifyTaskAgentKind({ taskType, agentId }),
    });
  }
}
for (const row of pureRows) {
  cases.push({ case: `classifyTaskAgentKind.decode`, input: row.input, ok: row.ok });
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
//
// An `Error` is the third case, and the one that loses data rather than merely needing a
// detour: `message` and `stack` are non-enumerable, so `Object.entries` gives `{}` and
// `JSON.stringify` gives `"{}"`. It is rendered here in exactly the shape `encodeJsonError`
// writes — `name` then `message`, then `cause` when there is one — so the golden's decode
// output and its encode output are the same projection of the same value. `stack` is left
// out on purpose; see the `Defect` section.
//
// A byte sequence is the fourth case, and unlike the three above it has **no** JSON form:
// `Schema.Uint8Array`'s Encoded side *is* the `Uint8Array`, and the schema rejects the
// `{"0":1,"1":2,"2":3}` object that `Object.entries` would build for it — so walking it
// normally would produce an input the shipped codec refuses and record that as its
// behaviour. `{$bytes: […]}` is named instead, and the replay classifies any case carrying
// it as one JSON cannot express. A Node `Buffer` is the same value to the codec (it is a
// `Uint8Array` subclass) and renders identically here, which is what the golden should show:
// one wire value, not two.
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
  if (value instanceof Uint8Array) return { $bytes: Array.from(value) };
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
