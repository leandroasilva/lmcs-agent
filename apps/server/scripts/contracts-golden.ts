// Golden generator for the Rust contracts crate. Dumps the shipped RPC dispatch
// surface (both method tables and the tags actually registered on the group) and
// the observed behaviour of the base schema codecs, so `native/contracts` is
// checked against the TypeScript it replaces rather than against a copy of it.
//
// `node apps/server/scripts/contracts-golden.ts > /tmp/contracts-golden.json`

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
const registeredSet = new Set(registered);
const declaredSet = new Set(declaredTags);

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
  undefinedInput?: true;
} & ({ ok: unknown } | { error: string });

const cases: Case[] = [];

function record(
  name: string,
  op: "decode" | "encode",
  schema: Schema.Top,
  input: unknown,
  isUndefined = false,
): void {
  const run = op === "decode" ? Schema.decodeUnknownSync(schema) : Schema.encodeUnknownSync(schema);
  const base = { case: `${name}.${op}`, ...(isUndefined ? { undefinedInput: true } : { input }) };
  try {
    cases.push({ ...base, ok: run(input) });
  } catch (cause) {
    const issue = (cause as { issue?: { _tag?: string } }).issue?._tag ?? "?";
    cases.push({ ...base, error: issue });
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
// entries would yield `{}`.
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
  if (Array.isArray(value)) return value.map(toWire);
  const rebuilt: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) rebuilt[key] = toWire(member);
  return rebuilt;
};

const encodeInput = (entry: Case): string =>
  "undefinedInput" in entry
    ? '"undefinedInput":true'
    : `"input":${JSON.stringify(toWire(entry.input))}`;

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
