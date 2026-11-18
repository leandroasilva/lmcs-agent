// Trace generator for the usage-limits golden. Runs the shipped provider mappers over
// fixture tables and prints what they decided, so the Rust port is checked against the
// real code rather than against a reading of it.
//
// `node apps/server/scripts/usage-limits-trace.ts > /tmp/usage-trace.txt`
//
// Every case is a call into `providerUsageLimits.ts`, `claudeUsageLimits.ts`,
// `codexUsageLimits.ts`, `cursorUsageLimits.ts`, `grokUsageLimits.ts`,
// `openCodeUsageLimits.ts` or `claudeResetCredits.ts`. The first five are pure — no layer, no
// clock, no subprocess — so they need no harness beyond the fixtures. OpenCode and the Claude
// reset credits are not, and get one (see the two sections at the end). Nothing here
// reimplements a rule: if a line looks like it is computing something, it is only normalising
// for the wire.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Url from "effect/unstable/http/Url";
import { HostProcessPlatform } from "@lmcstools/core/hostProcess";

import * as claudeResetCredits from "../src/provider/Layers/claudeResetCredits.ts";
import * as claudeUsageLimits from "../src/provider/Layers/claudeUsageLimits.ts";
import * as codexUsageLimits from "../src/provider/Layers/codexUsageLimits.ts";
import * as cursorUsageLimits from "../src/provider/Layers/cursorUsageLimits.ts";
import * as grokUsageLimits from "../src/provider/Layers/grokUsageLimits.ts";
import * as openCodeUsageLimits from "../src/provider/Layers/openCodeUsageLimits.ts";
import * as providerUsageLimits from "../src/provider/providerUsageLimits.ts";

type Json = unknown;

// Windows and snapshots are compared field by field. JavaScript's object spread gives each
// call site its own key insertion order; that order is not what reaches the wire (the
// `ServerProviderUsageWindow` schema decides it), so the trace normalises it away here and
// in the Rust test with the same field list.
function canonWindow(value: Json): Json {
  if (value === null || typeof value !== "object") return value;
  const window = value as Record<string, Json>;
  const out: [string, Json][] = [
    ["id", window["id"]],
    ["kind", window["kind"]],
    ["label", window["label"]],
    ["usedPercent", window["usedPercent"]],
  ];
  if (window["resetsAt"] !== undefined) out.push(["resetsAt", window["resetsAt"]]);
  if (window["windowDurationMins"] !== undefined) {
    out.push(["windowDurationMins", window["windowDurationMins"]]);
  }
  return out;
}

function canonLimits(value: Json): Json {
  if (value === null || typeof value !== "object") return value;
  const limits = value as Record<string, Json>;
  const out: [string, Json][] = [["checkedAt", limits["checkedAt"]]];
  out.push(["windows", (limits["windows"] as Json[]).map(canonWindow)]);
  const resetCredits = limits["resetCredits"] as Record<string, Json> | undefined;
  if (resetCredits !== undefined) {
    const credits: [string, Json][] = [["availableCount", resetCredits["availableCount"]]];
    if (resetCredits["nextExpiresAt"] !== undefined) {
      credits.push(["nextExpiresAt", resetCredits["nextExpiresAt"]]);
    }
    // Only Claude names the credit a redeem is pinned to; Codex leaves the key out, so the
    // pair list carries it exactly when the shipped object did.
    if (resetCredits["nextCreditId"] !== undefined) {
      credits.push(["nextCreditId", resetCredits["nextCreditId"]]);
    }
    out.push(["resetCredits", credits]);
  }
  const unavailable = limits["unavailable"] as Record<string, Json> | undefined;
  if (unavailable !== undefined) {
    const reason: [string, Json][] = [["reason", unavailable["reason"]]];
    if (unavailable["message"] !== undefined) reason.push(["message", unavailable["message"]]);
    out.push(["unavailable", reason]);
  }
  return out;
}

// The Codex snapshot is the one value the mappers spread rather than build from a literal, so
// its key order depends on which fields an update carried. Same normalisation as a window.
function canonSnapshot(value: Json): Json {
  const snapshot = value as Record<string, Json>;
  const out: [string, Json][] = [];
  for (const field of [
    "limitId",
    "planType",
    "rateLimitReachedType",
    "primary",
    "secondary",
  ] as const) {
    if (snapshot[field] !== undefined) out.push([field, snapshot[field]]);
  }
  return out;
}

function looksLikeSnapshot(record: Record<string, Json>): boolean {
  return ["limitId", "planType", "rateLimitReachedType", "primary", "secondary"].some((field) =>
    Object.hasOwn(record, field),
  );
}

function canon(value: Json): Json {
  if (Array.isArray(value)) return value.map(canon);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, Json>;
  // Checked first: a full snapshot also has `windows`, and normalising it as an update would
  // silently drop `checkedAt`, `resetCredits` and `unavailable` — the fields that carry most of
  // the measured behaviour.
  if ("checkedAt" in record) return canonLimits(value);
  if ("id" in record && "kind" in record) return canonWindow(value);
  if (looksLikeSnapshot(record)) return canonSnapshot(value);
  if (Array.isArray(record["windows"])) {
    return [["windows", (record["windows"] as Json[]).map(canonWindow)]];
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, canon(item)]));
}

// Non-finite numbers survive JSON.stringify only as `null`, which would silently change the
// input the shipped function sees. Tag them instead.
function encode(value: Json): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "number" && !Number.isFinite(item)) {
      return { __number: Number.isNaN(item) ? "NaN" : item > 0 ? "Infinity" : "-Infinity" };
    }
    if (typeof item === "bigint") return { __bigint: String(item) };
    return item;
  });
}

// Several of the shipped functions return `undefined` (a dropped event, a no-op merge that
// hands back nothing). `JSON.stringify(undefined)` is `undefined`, not a string, so an absent
// result gets its own tag rather than the `null` a different call could legitimately return.
const encodeLine = (value: Json): string => encode(value) ?? JSON.stringify({ __absent: true });

const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");

const out: string[] = [];
let calls = 0;

function record(module: string, fn: string, input: Json[], result: Json): void {
  calls += 1;
  out.push(`C ${module} ${fn}`);
  out.push(`I ${hex(encodeLine(input))}`);
  out.push(`R ${hex(encodeLine(canon(result)))}`);
}

const AT = "2026-05-01T12:00:00.000Z";
const window = (
  id: string,
  kind: string,
  label: string,
  usedPercent: number,
  extra: Record<string, Json> = {},
): Json => ({ id, kind, label, usedPercent, ...extra });
const windowOf = (
  id: string,
  usedPercent: number,
  secondsFromAt: number | null,
  durationMins: number | null,
  kind = "session",
  label = kind === "session"
    ? "Session"
    : kind === "weekly"
      ? "Weekly"
      : kind === "monthly"
        ? "Monthly"
        : "Other",
): Json =>
  window(id, kind, label, usedPercent, {
    ...(secondsFromAt === null ? {} : { resetsAt: reset(secondsFromAt) }),
    ...(durationMins === null ? {} : { windowDurationMins: durationMins }),
  });

// -------------------------------------------------------------------------------- core
for (const value of [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -0,
  -0.0001,
  0,
  33.5,
  100,
  100.0001,
  1e308,
  5e-324,
]) {
  record("core", "clampPercent", [value], providerUsageLimits.clampPercent(value));
}

// The comparator is `kindOrder || id.localeCompare`. These rows are the whole evidence for
// what that means: `other` after `monthly`, kind before id, and the collation of `_`,
// digits, upper and lower case in an id. The input is deliberately unsorted, and recorded as
// the argument the call actually received rather than as its result.
const sortInput = {
  checkedAt: AT,
  windows: [
    window("secondary", "weekly", "Weekly", 1),
    window("zzz", "session", "Session", 2),
    window("AAA", "session", "Session", 3),
    window("aaa", "session", "Session", 4),
    window("_x", "session", "Session", 5),
    window("9", "session", "Session", 6),
    window("10", "session", "Session", 7),
    window("a", "other", "Other", 8),
    window("b", "other", "Other", 9),
    window("five_hour", "session", "Session", 10),
    window("five_hour", "weekly", "Weekly", 11),
    window("seven_day", "monthly", "Monthly", 12),
    window("x", "other", "Other", 13),
  ],
};
record("core", "makeUsageLimits.sort", [sortInput], providerUsageLimits.makeUsageLimits(sortInput));

// Ids on their own: every window shares a kind, so the order is entirely `localeCompare`.
// The set is what the shipped mappers can actually emit — the literals in the seven adapters
// plus a Claude display name reduced to `[a-z0-9_]` — and the pairs where ICU collation and
// byte order disagree, which the port has to reproduce rather than approximate.
const idOrderInput = {
  checkedAt: AT,
  windows: [
    window("seven_day_gpt5", "session", "Session", 1),
    window("seven_day_gpt_5", "session", "Session", 2),
    window("seven_day", "session", "Session", 3),
    window("five_hour", "session", "Session", 4),
    window("fivehour", "session", "Session", 5),
    window("primary", "session", "Session", 6),
    window("quota", "session", "Session", 7),
    window("subscription", "session", "Session", 8),
    window("go_rolling", "session", "Session", 9),
    window("gopher", "session", "Session", 10),
    window("a-b", "session", "Session", 11),
    window("a.b", "session", "Session", 12),
    window("a b", "session", "Session", 13),
    window("ab", "session", "Session", 14),
    window("9lives", "session", "Session", 15),
    window("_lead", "session", "Session", 16),
    window("Cap", "session", "Session", 17),
    window("cap", "session", "Session", 18),
    window("CAP", "session", "Session", 19),
  ],
};
record(
  "core",
  "makeUsageLimits.idOrder",
  [idOrderInput],
  providerUsageLimits.makeUsageLimits(idOrderInput),
);

const emptyIterableInput = { checkedAt: AT, windows: [] };
record(
  "core",
  "makeUsageLimits.emptyIterable",
  [emptyIterableInput],
  providerUsageLimits.makeUsageLimits(emptyIterableInput),
);

for (const message of [undefined, "", "boom", "  "]) {
  const input = {
    checkedAt: AT,
    reason: "probeFailed" as const,
    ...(message === undefined ? {} : { message }),
  };
  record(
    "core",
    "makeUnavailableUsageLimits",
    [input],
    providerUsageLimits.makeUnavailableUsageLimits(input),
  );
}

const previousWithWindows = {
  checkedAt: AT,
  windows: [
    window("five_hour", "session", "Session", 20, {
      resetsAt: "2026-05-01T17:00:00.000Z",
      windowDurationMins: 300,
    }),
    window("seven_day", "weekly", "Weekly", 40, { windowDurationMins: 10080 }),
  ],
  resetCredits: { availableCount: 2, nextExpiresAt: "2026-06-01T00:00:00.000Z" },
};

const mergeCases: [string, Json, Json][] = [
  // Nothing to fold in: an update with no windows leaves the snapshot alone.
  ["emptyUpdate", previousWithWindows, { windows: [] }],
  // A sparse update inherits `resetsAt` and `windowDurationMins` from the row it lands on,
  // and a row the update never names keeps every value it had.
  ["inherit", previousWithWindows, { windows: [window("five_hour", "session", "Session", 25)] }],
  // `null` is a value, not an omission: an explicit null reset is not inherited.
  [
    "nullIsNotOmission",
    previousWithWindows,
    {
      windows: [window("five_hour", "session", "Session", 25, { resetsAt: null })],
    },
  ],
  // Same numbers, so nothing changed — and the previous snapshot is returned untouched.
  [
    "noOp",
    previousWithWindows,
    {
      windows: [
        window("five_hour", "session", "Session", 20, {
          resetsAt: "2026-05-01T17:00:00.000Z",
          windowDurationMins: 300,
        }),
        window("seven_day", "weekly", "Weekly", 40, { windowDurationMins: 10080 }),
      ],
    },
  ],
  // A no-op over an *unavailable* snapshot is not a no-op: the branch above requires
  // `previous.unavailable === undefined`, so this clears the unavailability.
  [
    "noOpOverProbeFailed",
    {
      ...previousWithWindows,
      unavailable: { reason: "probeFailed", message: "probe timed out" },
    },
    {
      windows: [
        window("five_hour", "session", "Session", 20, {
          resetsAt: "2026-05-01T17:00:00.000Z",
          windowDurationMins: 300,
        }),
        window("seven_day", "weekly", "Weekly", 40, { windowDurationMins: 10080 }),
      ],
    },
  ],
  // `unsupported` is authoritative and blocks the fold entirely.
  [
    "unsupportedGates",
    {
      checkedAt: AT,
      windows: [],
      unavailable: { reason: "unsupported" },
    },
    { windows: [window("five_hour", "session", "Session", 90)] },
  ],
  // A brand new id is appended, and the result is re-sorted by kind then id.
  ["newId", previousWithWindows, { windows: [window("spark", "session", "Spark", 5)] }],
  // Out-of-range and non-finite percentages are clamped on the way through the fold.
  [
    "clamp",
    previousWithWindows,
    {
      windows: [window("five_hour", "session", "Session", 140, { resetsAt: undefined })],
    },
  ],
  [
    "clampNaN",
    previousWithWindows,
    {
      windows: [window("seven_day", "weekly", "Weekly", Number.NaN)],
    },
  ],
  // No previous snapshot at all.
  ["noPrevious", undefined, { windows: [window("primary", "session", "Session", 1)] }],
  // A previous snapshot whose windows the update re-labels.
  [
    "relabel",
    previousWithWindows,
    {
      windows: [
        window("five_hour", "session", "Changed label", 20, {
          resetsAt: "2026-05-01T17:00:00.000Z",
          windowDurationMins: 300,
        }),
      ],
    },
  ],
  // `resetCredits` rides along from the previous snapshot; a previous without it stays without.
  [
    "creditsFromPrevious",
    previousWithWindows,
    {
      windows: [window("seven_day", "weekly", "Weekly", 41)],
    },
  ],
];

for (const [name, previous, update] of mergeCases) {
  const input = { previous, update, checkedAt: AT.replace("12:00", "13:00") };
  record(
    "core",
    "applyUsageLimitsUpdate",
    [input],
    providerUsageLimits.applyUsageLimitsUpdate(input as never),
  );
}

const unavailable = (reason: string, message?: string): Json => ({
  checkedAt: AT,
  windows: [],
  unavailable: { reason, ...(message === undefined ? {} : { message }) },
});

const probeCases: [string, Json, Json][] = [
  ["probeFailedKeepsPublished", unavailable("probeFailed", "timeout"), previousWithWindows],
  ["probeFailedWithoutPublished", undefined, unavailable("probeFailed", "timeout")],
  ["probeFailedOverUnsupported", unavailable("unsupported"), unavailable("probeFailed")],
  ["unsupportedReplacesPublished", previousWithWindows, unavailable("unsupported")],
  ["probeWins", previousWithWindows, previousWithWindows],
  ["probeUndefined", previousWithWindows, undefined],
  ["bothUndefined", undefined, undefined],
  ["publishedUnavailableProbeOk", unavailable("probeFailed"), previousWithWindows],
];
for (const [name, published, probed] of probeCases) {
  record(
    "core",
    "resolveUsageLimitsAfterProbe",
    [{ published, probed }],
    providerUsageLimits.resolveUsageLimitsAfterProbe({
      published: published as never,
      probed: probed as never,
    }),
  );
}

// ------------------------------------------------------------------------------ claude
const names = { overageIncluded: "Claude Fable 3" };

for (const info of [
  { rateLimitType: "five_hour", utilization: 0.25, resetsAt: 1_777_000_000 },
  { rateLimitType: "seven_day", utilization: 1, resetsAt: 1_777_000_000 },
  { rateLimitType: "seven_day_overage_included", utilization: 0.5, resetsAt: 1_777_000_000 },
  { rateLimitType: "seven_day_opus", utilization: 0.5 },
  // `type in WINDOWS` walks the prototype chain, so a key the shipped table never declares
  // still passes the membership test. Whether that is a hole or a curiosity decides the port.
  { rateLimitType: "constructor", utilization: 0.5 },
  { rateLimitType: "toString", utilization: 0.5 },
  { rateLimitType: "__proto__", utilization: 0.5 },
  { rateLimitType: undefined, utilization: 0.5 },
  { rateLimitType: "", utilization: 0.5 },
  { rateLimitType: "five_hour", utilization: "25" },
  { rateLimitType: "five_hour", utilization: null },
  { rateLimitType: "five_hour", utilization: Number.NaN },
  { rateLimitType: "five_hour", utilization: -0.2 },
  { rateLimitType: "five_hour", utilization: 1.5 },
  { rateLimitType: "seven_day_overage_included", utilization: 0.5, resetsAt: 0 },
  { rateLimitType: "seven_day_overage_included", utilization: 0.5, resetsAt: -5 },
  { rateLimitType: "seven_day_overage_included", utilization: 0.5, resetsAt: Number.NaN },
  // 32-bit overflow: `value * 1000` leaves the range `new Date` accepts.
  { rateLimitType: "seven_day", utilization: 0.5, resetsAt: 2 ** 53 },
  { rateLimitType: "seven_day", utilization: 0.5, resetsAt: 9e15 },
  { rateLimitType: "seven_day", utilization: 0.5, resetsAt: 1e9 },
  // A fraction that is not exact in binary: the percent is what the bar shows.
  { rateLimitType: "five_hour", utilization: 1 / 3 },
  { rateLimitType: "five_hour", utilization: 0.1 + 0.2 },
]) {
  for (const scopedNames of [names, { overageIncluded: undefined }]) {
    record(
      "claude",
      "claudeRateLimitEventToUpdate",
      [info, scopedNames],
      claudeUsageLimits.claudeRateLimitEventToUpdate(info as never, scopedNames),
    );
  }
}

// `resets_at` reaches `DateTime.make`, which appends `Z` when its own zone test fails. The
// table is the whole question of which strings that accepts.
const isoStrings: (string | null | undefined)[] = [
  "2026-05-01T12:00:00Z",
  "2026-05-01T12:00:00.000Z",
  "2026-05-01T12:00:00.5Z",
  "2026-05-01T12:00:00",
  "2026-05-01T12:00",
  "2026-05-01T12:00:00.123",
  "2026-05-01",
  "2026-05-01 ",
  "2026-05-01T12:00:00+02:00",
  "2026-05-01T12:00:00-0330",
  "2026-05-01T12:00:00+0200",
  "2026-05-01T12:00:00.000+02:00",
  "2026-05-01T12:00:00-03:30",
  "2026-02-30T12:00:00Z",
  "2024-02-29T12:00:00Z",
  "2026-05-01T12:00:61Z",
  "2026-05-01T12:60:00Z",
  "2026-05-01T12:00:00+02",
  "2026-05-01 12:00:00",
  "2026-05-01T12:00:00GMT",
  "2026-05-01T12:00:00 UTC",
  "Thu, 01 May 2026 12:00:00 GMT",
  "05/01/2026 12:00:00",
  "2026",
  "2026-05",
  "2026-1-1",
  "",
  " ",
  "not a date",
  "2026-13-45T99:99:99Z",
  "2026-05-01T24:00:00Z",
  "2026-05-01T12:00:00.9999Z",
  // Years outside the four-digit form: `toISOString` switches to the expanded spelling.
  "+002026-05-01T12:00:00Z",
  "-000001-01-01T00:00:00Z",
  "2026-05-01T12:00:00Z[Europe/Berlin]",
  null,
  undefined,
];

for (const resetsAt of isoStrings) {
  const input = {
    response: {
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 10, resets_at: resetsAt } },
    },
    checkedAt: AT,
  };
  record(
    "claude",
    "claudeUsageResponseToLimits.resetsAt",
    [input],
    claudeUsageLimits.claudeUsageResponseToLimits(input as never),
  );
}

for (const response of [
  { rate_limits_available: false, rate_limits: undefined },
  { rate_limits_available: true, rate_limits: undefined },
  { rate_limits_available: undefined, rate_limits: { five_hour: { utilization: 5 } } },
  { rate_limits_available: true, rate_limits: {} },
  { rate_limits_available: true, rate_limits: { five_hour: null } },
  { rate_limits_available: true, rate_limits: { five_hour: { utilization: "50" } } },
  { rate_limits_available: true, rate_limits: { five_hour: { utilization: null } } },
  { rate_limits_available: true, rate_limits: { five_hour: { utilization: NaN } } },
  { rate_limits_available: true, rate_limits: { seven_day: { utilization: 77 } } },
  {
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 10, resets_at: "2026-05-01T12:00:00Z" },
      seven_day: { utilization: 20 },
      ten_day: { utilization: 99 },
    },
  },
  // `model_scoped` is read structurally: non-array, junk entries, and the first usable
  // entry naming the bucket the mid-turn events will land on.
  { rate_limits_available: true, rate_limits: { model_scoped: "no" } },
  { rate_limits_available: true, rate_limits: { model_scoped: [] } },
  {
    rate_limits_available: true,
    rate_limits: { model_scoped: [null, 1, {}, { display_name: 5 }] },
  },
  {
    rate_limits_available: true,
    rate_limits: { model_scoped: [{ display_name: "Fable", utilization: null }] },
  },
  {
    rate_limits_available: true,
    rate_limits: {
      model_scoped: [
        { display_name: "Fable", utilization: 0.5, resets_at: "2026-05-02T00:00:00Z" },
        { display_name: "Opus 4.1", utilization: 60 },
      ],
    },
  },
  {
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 1 },
      model_scoped: [
        { display_name: "Claude Fable 3", utilization: 30, resets_at: "2026-05-03T00:00:00Z" },
        { display_name: "Second", utilization: 40 },
      ],
    },
  },
]) {
  const input = { response, checkedAt: AT };
  record(
    "claude",
    "claudeUsageResponseToLimits",
    [input],
    claudeUsageLimits.claudeUsageResponseToLimits(input as never),
  );
}

// The scoped id is `seven_day_` + lower-cased, non-alphanumeric-collapsed display name.
for (const displayName of [
  "Claude Fable 3",
  "Opus 4.1 (Preview)",
  "  Spaced  Out  ",
  "Ünïcode",
  "İstanbul",
  "Σigma",
  "Жукова",
  "a‐b",
  "日本 語",
  "🚀 model",
  "-",
  "",
]) {
  const input = {
    response: {
      rate_limits_available: true,
      rate_limits: { model_scoped: [{ display_name: displayName, utilization: 1 }] },
    },
    checkedAt: AT,
  };
  record(
    "claude",
    "claudeUsageResponseToLimits.scopedId",
    [input],
    claudeUsageLimits.claudeUsageResponseToLimits(input as never),
  );
}

// -------------------------------------------------------------------------------- codex
for (const snapshot of [
  {},
  { limitId: "", primary: { usedPercent: 10 } },
  { limitId: "codex", primary: { usedPercent: 10 } },
  { limitId: "spark", primary: { usedPercent: 10 } },
  { limitId: null, primary: { usedPercent: 10 } },
  { planType: "free", primary: { usedPercent: 10 }, secondary: { usedPercent: 20 } },
  { planType: "go", primary: { usedPercent: 10 } },
  { planType: "pro", primary: { usedPercent: 10 } },
  { planType: "plus", secondary: { usedPercent: 10 } },
  { primary: null, secondary: null },
  { primary: { usedPercent: Number.NaN } },
  { primary: { usedPercent: "10" } },
  { primary: { usedPercent: 10, windowDurationMins: null } },
  { primary: { usedPercent: 10, windowDurationMins: "300" } },
  { primary: { usedPercent: 10, windowDurationMins: 0 } },
  { primary: { usedPercent: 10, windowDurationMins: 299 } },
  { primary: { usedPercent: 10, windowDurationMins: 300 } },
  { primary: { usedPercent: 10, windowDurationMins: 10_079 } },
  { primary: { usedPercent: 10, windowDurationMins: 10_080 } },
  { primary: { usedPercent: 10, windowDurationMins: 43_199 } },
  { primary: { usedPercent: 10, windowDurationMins: 43_200 } },
  { primary: { usedPercent: 10, windowDurationMins: Number.NaN } },
  { primary: { usedPercent: 10, resetsAt: 1_777_000_000 } },
  { primary: { usedPercent: 10, resetsAt: 0 } },
  { primary: { usedPercent: 10, resetsAt: -1 } },
  { primary: { usedPercent: 10, resetsAt: Number.NaN } },
  { primary: { usedPercent: 10, resetsAt: null } },
  { primary: { usedPercent: 10, resetsAt: "1777000000" } },
  { primary: { usedPercent: -5 } },
  { primary: { usedPercent: 150 } },
  { primary: { usedPercent: 100 }, secondary: { usedPercent: 100, windowDurationMins: 10_080 } },
]) {
  const input = { snapshot, checkedAt: AT };
  record(
    "codex",
    "codexRateLimitsToLimits",
    [input],
    codexUsageLimits.codexRateLimitsToLimits(input as never),
  );
  record(
    "codex",
    "codexRateLimitsToUpdate",
    [snapshot],
    codexUsageLimits.codexRateLimitsToUpdate(snapshot as never),
  );
}

// The probe reads a map keyed by limit id and picks `codex` out of it; the bare snapshot is
// only the fallback.
const byLimitIdInput = {
  snapshot: { limitId: "spark", primary: { usedPercent: 99 } },
  rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 3 } } },
  checkedAt: AT,
};
record(
  "codex",
  "codexRateLimitsToLimits.byLimitId",
  [byLimitIdInput],
  codexUsageLimits.codexRateLimitsToLimits(byLimitIdInput as never),
);
const emptyLimitIdMapInput = {
  snapshot: { primary: { usedPercent: 7 } },
  rateLimitsByLimitId: { codex: null },
  checkedAt: AT,
};
record(
  "codex",
  "codexRateLimitsToLimits.emptyLimitIdMap",
  [emptyLimitIdMapInput],
  codexUsageLimits.codexRateLimitsToLimits(emptyLimitIdMapInput as never),
);

for (const summary of [
  undefined,
  null,
  { availableCount: 0 },
  { availableCount: -3 },
  { availableCount: Number.NaN },
  { availableCount: Number.POSITIVE_INFINITY },
  { availableCount: -0 },
  {
    availableCount: 3,
    credits: [
      { status: "available", expiresAt: Number.NaN },
      { status: "available", expiresAt: 1 },
    ],
  },
  {
    availableCount: 3,
    credits: [
      { status: "available", expiresAt: 1 },
      { status: "available", expiresAt: Number.NaN },
    ],
  },
  { availableCount: 3, credits: [{ status: "available", expiresAt: Number.POSITIVE_INFINITY }] },
  { availableCount: 2.5 },
  { availableCount: 1, credits: null },
  { availableCount: 1, credits: [] },
  { availableCount: 1, credits: [{ status: "redeemed" }] },
  { availableCount: 1, credits: [{ status: "available" }] },
  { availableCount: 1, credits: [{ status: "available", expiresAt: null }] },
  { availableCount: 1, credits: [{ status: "available", expiresAt: "1777000000" }] },
  { availableCount: 1, credits: [{ status: "available", expiresAt: 1_777_000_000 }] },
  {
    availableCount: 3,
    credits: [
      { status: "available", expiresAt: 1_777_000_000 },
      { status: "available", expiresAt: 1_700_000_000 },
      { status: "expired", expiresAt: 1_000_000_000 },
      { status: "available", expiresAt: 1_900_000_000 },
    ],
  },
  { availableCount: 1, credits: [{ status: "Available", expiresAt: 1_777_000_000 }] },
]) {
  record(
    "codex",
    "codexResetCreditsToContract",
    [summary],
    codexUsageLimits.codexResetCreditsToContract(summary as never),
  );
}

const merged: [string, Json, Json][] = [
  ["noPrevious", undefined, { limitId: "codex", primary: { usedPercent: 1 } }],
  ["otherLimitIgnored", { limitId: "codex", primary: { usedPercent: 1 } }, { limitId: "spark" }],
  ["emptyLimitIdPasses", { limitId: "codex", primary: { usedPercent: 1 } }, { limitId: "" }],
  ["nullLimitIdPasses", { limitId: "codex", primary: { usedPercent: 1 } }, { limitId: null }],
  [
    "omittedKept",
    {
      limitId: "codex",
      planType: "pro",
      rateLimitReachedType: "usage_limit_reached",
      primary: { usedPercent: 1 },
      secondary: { usedPercent: 2 },
    },
    { primary: { usedPercent: 9 } },
  ],
  [
    "explicitNullOverwrites",
    { planType: "pro", primary: { usedPercent: 1 } },
    {
      planType: null,
      primary: null,
    },
  ],
  [
    "undefinedOverwrites",
    { planType: "pro", primary: { usedPercent: 1 } },
    {
      planType: undefined,
      secondary: undefined,
    },
  ],
];
for (const [name, previous, update] of merged) {
  record(
    "codex",
    "mergeCodexRateLimits",
    [previous, update],
    codexUsageLimits.mergeCodexRateLimits(previous as never, update as never),
  );
}

for (const error of [
  { _tag: "CodexAppServerRequestError", code: -32601 },
  { _tag: "CodexAppServerRequestError", code: 0 },
  { _tag: "CodexAppServerSpawnError" },
  { _tag: "CodexAppServerProcessExitedError" },
  { _tag: "CodexAppServerProtocolParseError" },
  { _tag: "CodexAppServerTransportError" },
  { _tag: "CodexAppServerInputStreamEndedError" },
]) {
  record(
    "codex",
    "codexRateLimitsFailureMessage",
    [error],
    codexUsageLimits.codexRateLimitsFailureMessage(error as never),
  );
}

// The stop message: which exhausted window is named, and how its wait is rounded.
// A snapshot's `resetsAt` is epoch seconds; `reset` keeps every fixture relative to `AT`, so
// the cases measure the wait rather than accidentally landing in the past.
const AT_EPOCH = Date.parse(AT) / 1000;
const reset = (secondsFromAt: number): number => AT_EPOCH + secondsFromAt;

const limitWindows = (entries: [number, number | null, number | null][]): Json => ({
  primary:
    entries.length > 0
      ? { usedPercent: entries[0][0], windowDurationMins: entries[0][1], resetsAt: entries[0][2] }
      : null,
  secondary:
    entries.length > 1
      ? {
          usedPercent: entries[1][0],
          windowDurationMins: entries[1][1],
          resetsAt: entries[1][2],
        }
      : null,
});

const messageCases: [string, Json | undefined, string][] = [
  ["noSnapshot", undefined, AT],
  ["unparsableAt", limitWindows([[100, 300, reset(86_400)]]), "not a date"],
  ["epochAt", limitWindows([[100, 300, 1_777_100_000]]), "1970-01-01T00:00:00Z"],
  ["belowFull", limitWindows([[99.999999, 300, reset(3_600)]]), AT],
  // A clamped 100.4 still reads as exhausted, so the sentence still appears.
  ["overFull", limitWindows([[100.4, 300, reset(3_600)]]), AT],
  ["noReset", limitWindows([[100, 300, null]]), AT],
  ["resetOneSecondAgo", limitWindows([[100, 300, reset(-1)]]), AT],
  ["resetAYearAgo", limitWindows([[100, 300, reset(-31_536_000)]]), AT],
  ["resetNow", limitWindows([[100, 300, reset(0)]]), AT],
  ["oneSecondAhead", limitWindows([[100, 300, reset(1)]]), AT],
  ["fiftyNineSeconds", limitWindows([[100, 300, reset(59)]]), AT],
  ["oneMinute", limitWindows([[100, 300, reset(60)]]), AT],
  ["sixtyOneSeconds", limitWindows([[100, 300, reset(61)]]), AT],
  ["oneHourExactly", limitWindows([[100, 300, reset(3_600)]]), AT],
  ["hourAndAMinute", limitWindows([[100, 300, reset(3_660)]]), AT],
  ["threeHours", limitWindows([[100, 300, reset(10_800)]]), AT],
  ["threeHoursTwenty", limitWindows([[100, 300, reset(12_000)]]), AT],
  ["threeHoursTwentyOne", limitWindows([[100, 300, reset(12_001)]]), AT],
  // Sub-minute waits round up, so anything under a minute reads as one minute and 23h59m
  // reads as a day: the day branch is chosen after the ceiling, not before.
  ["justUnderADay", limitWindows([[100, 300, reset(86_399)]]), AT],
  ["oneDay", limitWindows([[100, 300, reset(86_400)]]), AT],
  ["dayAndASecond", limitWindows([[100, 300, reset(86_401)]]), AT],
  ["dayAndAnHour", limitWindows([[100, 300, reset(90_000)]]), AT],
  ["fiveDays", limitWindows([[100, 300, reset(432_000)]]), AT],
  ["fiveDaysFiveHours", limitWindows([[100, 300, reset(450_000)]]), AT],
  ["aCentury", limitWindows([[100, 300, reset(3_155_760_000)]]), AT],
  // `windowDurationMins` only labels the sentence; the kind it maps to is what is named.
  ["weeklyWindow", limitWindows([[100, 10_080, reset(450_000)]]), AT],
  ["monthlyWindow", limitWindows([[100, 43_200, reset(450_000)]]), AT],
  ["otherWindow", limitWindows([[100, 1, reset(450_000)]]), AT],
  // Past the range a Date can hold the reset is dropped, so no sentence appears at all.
  ["beyondDateRange", limitWindows([[100, 300, 8.64e12 + 1]]), AT],
  ["atDateRangeEdge", limitWindows([[100, 300, 8.64e12]]), AT],
  // Two exhausted windows: the later reset wins, an equal one does not displace it, and a
  // window that is not exhausted never names the sentence however far ahead it resets.
  [
    "laterWins",
    limitWindows([
      [100, 300, reset(86_400)],
      [100, 10_080, reset(604_800)],
    ]),
    AT,
  ],
  [
    "earlierListedLast",
    limitWindows([
      [100, 300, reset(604_800)],
      [100, 10_080, reset(86_400)],
    ]),
    AT,
  ],
  [
    "tieKeepsFirst",
    limitWindows([
      [100, 300, reset(604_800)],
      [100, 10_080, reset(604_800)],
    ]),
    AT,
  ],
  [
    "oneExhaustedOneNot",
    limitWindows([
      [100, 300, reset(604_800)],
      [50, 10_080, reset(1_209_600)],
    ]),
    AT,
  ],
  [
    "neitherExhausted",
    limitWindows([
      [50, 300, reset(604_800)],
      [50, 10_080, reset(1_209_600)],
    ]),
    AT,
  ],
  // A model-scoped snapshot must not name the main windows it does not describe.
  ["otherLimitId", { ...limitWindows([[100, 300, reset(86_400)]]), limitId: "spark" }, AT],
];
for (const [name, snapshot, atIso] of messageCases) {
  record(
    "codex",
    "codexUsageLimitMessage",
    [snapshot, atIso],
    codexUsageLimits.codexUsageLimitMessage(snapshot as never, atIso),
  );
}

const nextStepCases: [string, Json][] = [
  ["undefined", undefined],
  ["null", null],
  ["empty", ""],
  ["other", "other"],
  ["personalCredits", { rateLimitReachedType: "personal_credits_depleted" }],
  ["ownerCredits", { rateLimitReachedType: "workspace_owner_credits_depleted" }],
  ["memberCredits", { rateLimitReachedType: "workspace_member_credits_depleted" }],
  ["ownerSpend", { rateLimitReachedType: "workspace_owner_usage_limit_reached" }],
  ["memberSpend", { rateLimitReachedType: "workspace_member_usage_limit_reached" }],
];
for (const [name, snapshot] of nextStepCases) {
  record(
    "codex",
    "codexUsageLimitMessage.nextStep",
    [snapshot, AT],
    codexUsageLimits.codexUsageLimitMessage(snapshot as never, AT),
  );
}

// -------------------------------------------------------------------------------- cursor
// `cursorUsageResponseToLimits` runs `billingCycleEnd` through `Number()` twice — once to
// build the Date, once to ask whether a reset exists at all — so the coercion table is part
// of the decision and not a detail of parsing. A key written `undefined` and a key that is
// absent are the same value to `Number`, but `null` is not: it coerces to 0.
const CURSOR_PLAN_USAGE: Json = { totalPercentUsed: 10 };
for (const billingCycleEnd of [
  undefined,
  null,
  0,
  -0,
  -1,
  1_777_000_000_000,
  // Epoch seconds handed to a milliseconds Date: a reset in January 1970, which is still a
  // reset, so the bar carries it.
  1_777_000_000,
  1.5,
  8.64e15,
  8.64e15 + 1,
  -8.64e15,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  "1777000000000",
  "0",
  " 0 ",
  "-1",
  " 1777000000000 ",
  "1e12",
  "1E12",
  "0x10",
  "0b101",
  "Infinity",
  "-Infinity",
  "+Infinity",
  "NaN",
  "",
  " ",
  "\t\n1777000000000\r",
  "1,000",
  "1777000000000abc",
  "2026-05-01T00:00:00Z",
  "1e999",
  "0.5",
  "  ",
  // The rest of the `StringNumericLiteral` grammar. A value that coerces to a positive
  // number is visible as a reset time in the range of milliseconds, so each of these is a
  // discriminating case rather than another way to say `NaN`.
  "nan",
  "NAN",
  "infinity",
  "INFINITY",
  "0X10",
  "0xff",
  "-0x10",
  "+0x10",
  "0o17",
  "0b1",
  ".5",
  "5.",
  "+.5",
  "-.5",
  "1e",
  "e5",
  "1.2.3",
  "010",
  "-0",
  "1_0",
  "1e-323",
  "١٢",
  "½",
]) {
  const body = { billingCycleEnd, planUsage: CURSOR_PLAN_USAGE };
  record(
    "cursor",
    "cursorUsageResponseToLimits.billingCycleEnd",
    [body, AT],
    cursorUsageLimits.cursorUsageResponseToLimits(body as never, AT),
  );
}

// The three rows Cursor's dashboard reports, and what each value does to the row. The table
// order is the declaration order; the published order is `kindOrder || localeCompare`, and
// every cursor row is `monthly`, so ids alone decide it.
for (const planUsage of [
  undefined,
  null,
  {},
  { totalPercentUsed: undefined },
  { totalPercentUsed: null },
  { totalPercentUsed: 0 },
  { totalPercentUsed: -0 },
  { totalPercentUsed: -5 },
  { totalPercentUsed: 33.5 },
  { totalPercentUsed: 100 },
  { totalPercentUsed: 140 },
  { totalPercentUsed: Number.NaN },
  { totalPercentUsed: Number.POSITIVE_INFINITY },
  { totalPercentUsed: "10" },
  { totalPercentUsed: true },
  { autoPercentUsed: 20 },
  { apiPercentUsed: 30 },
  { totalPercentUsed: 10, autoPercentUsed: 20, apiPercentUsed: 30 },
  { totalPercentUsed: 10, unknownBucket: 99 },
  { unknownBucket: 99 },
  "not an object",
  5,
  true,
  [10],
]) {
  record(
    "cursor",
    "cursorUsageResponseToLimits.planUsage",
    [{ billingCycleEnd: 1_777_000_000_000, planUsage }, AT],
    cursorUsageLimits.cursorUsageResponseToLimits(
      { billingCycleEnd: 1_777_000_000_000, planUsage } as never,
      AT,
    ),
  );
}

// ---------------------------------------------------------------------------------- grok
// `grokUsageResponseToLimits`: the decision that a billing read with no percentage is an
// account with nothing metered yet (`windows: []`, drawn) rather than an unsupported account
// (dropped from the view) is the whole reason this mapper is not a clamp and a row.
for (const creditUsagePercent of [
  undefined,
  null,
  0,
  -0,
  -5,
  12.5,
  100,
  140,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  "10",
  "0",
  "",
  true,
  5e-324,
  1e308,
]) {
  record(
    "grok",
    "grokUsageResponseToLimits.creditUsagePercent",
    [
      {
        config: {
          creditUsagePercent,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-05-08T00:00:00Z" },
        },
      },
      AT,
    ],
    grokUsageLimits.grokUsageResponseToLimits(
      {
        config: {
          creditUsagePercent,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-05-08T00:00:00Z" },
        },
      } as never,
      AT,
    ),
  );
}

for (const config of [
  undefined,
  null,
  {},
  { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-05-08T00:00:00Z" } },
]) {
  record(
    "grok",
    "grokUsageResponseToLimits.config",
    [config === undefined ? {} : { config }, AT],
    grokUsageLimits.grokUsageResponseToLimits(
      (config === undefined ? {} : { config }) as never,
      AT,
    ),
  );
}

// The period type decides kind and label after a prefix strip, and the period end is the only
// date in these mappers that reaches `DateTime.make` without a guard in front of it.
for (const currentPeriod of [
  undefined,
  null,
  {},
  { type: undefined },
  { type: "" },
  { type: "USAGE_PERIOD_TYPE_WEEKLY" },
  { type: "USAGE_PERIOD_TYPE_MONTHLY" },
  { type: "USAGE_PERIOD_TYPE_DAILY" },
  { type: "weekly" },
  { type: "WEEKLY" },
  { type: "USAGE_PERIOD_TYPE_" },
  { type: "USAGE_PERIOD_TYPE_weekly" },
  { type: null },
  { end: "2026-05-08T00:00:00Z" },
  { end: "2026-05-08" },
  { end: "2026-05-08T00:00" },
  { end: "2026-05-08T00:00:00" },
  { end: "2026-05-08T00:00:00+02:00" },
  { end: "2026-05-08T00:00:00-0330" },
  { end: "2026-05-08T00:00:00 GMT" },
  { end: "2026-05-08T00:00:00GMT" },
  { end: "Fri, 08 May 2026 00:00:00 GMT" },
  { end: "05/08/2026 00:00:00" },
  { end: "2026-02-30T00:00:00Z" },
  { end: "not a date" },
  { end: "" },
  { end: null },
  { end: 1_777_000_000_000 },
  { end: "2026-05-08T00:00:00Z[Europe/Berlin]" },
  { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-05-08T00:00:00Z" },
  { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "2026-05-08T00:00:00.000Z" },
]) {
  record(
    "grok",
    "grokUsageResponseToLimits.currentPeriod",
    [{ config: { creditUsagePercent: 40, currentPeriod } }, AT],
    grokUsageLimits.grokUsageResponseToLimits(
      { config: { creditUsagePercent: 40, currentPeriod } } as never,
      AT,
    ),
  );
}

// ------------------------------------------------------------------------------- opencode
// `readOpenCodeGoUsageLimits` is the one usage read here that is not a pure function: it asks
// the clock for `checkedAt`, the filesystem for `auth.json`, and `opencode.ai` for the usage
// body. Its decisions are still worth measuring byte for byte, so the trace drives the
// shipped code through stubs rather than reimplementing it: `TestClock` pins the timestamp,
// `FileSystem.makeNoop` answers the auth read, and an `HttpClient` built from the fixture
// replies with the status and body the case names. The input line is the fixture, so the Rust
// replay feeds the same one to its own port and compares the record the call produced *and*
// the side effects it took — which file was read and what went on the wire.
//
// Two things the fixture cannot reach, and why neither is a hole: a socket that never answers
// and the five second deadline both land in the same `probeFailed` record the tables below
// already capture, and the deadline itself is the port's IO layer rather than a decision.

// The pinned instant, in the milliseconds `TestClock` takes. It is `AT`, so an OpenCode record
// and a Cursor record agree on when they were read.
const OPENCODE_AT = 1_777_000_000_000;
// The same instant in the spelling a `checkedAt` takes. The shipped function reads it from the
// clock instead of from its arguments, so the fixture names it on the input line and the Rust
// replay hands its port that same reading rather than a clock of its own.
const OPENCODE_CHECKED_AT = new Date(OPENCODE_AT).toISOString();

interface OpenCodeFixture {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: Record<string, string | undefined>;
  readonly authFile:
    | { readonly contents: string }
    | { readonly notFound: true }
    | { readonly blocked: true };
  readonly response: { readonly status: number; readonly body: string };
}

function openCodeStubFileSystem(authFile: OpenCodeFixture["authFile"], seen: { path?: string }) {
  return FileSystem.makeNoop({
    readFileString: (path) => {
      seen.path = path;
      if ("contents" in authFile) return Effect.succeed(authFile.contents);
      if ("blocked" in authFile) {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFileString",
            description: "blocked",
            pathOrDescriptor: path,
          }),
        );
      }
      return Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
          description: "No such file or directory",
          pathOrDescriptor: path,
        }),
      );
    },
  });
}

function openCodeStubClient(response: OpenCodeFixture["response"], seen: { auth?: string }) {
  return HttpClient.make((request) => {
    seen.auth = request.headers["authorization"];
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(response.status === 204 ? null : response.body, {
          status: response.status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
}

async function recordOpenCode(table: string, fixture: OpenCodeFixture): Promise<void> {
  const fileRead: { path?: string } = {};
  const requestMade: { auth?: string } = {};
  const limits = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(OPENCODE_AT);
      return yield* openCodeUsageLimits.readOpenCodeGoUsageLimits({
        enabled: fixture.enabled,
        serverUrl: fixture.serverUrl,
        environment: fixture.environment as never,
      });
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(
        Layer.succeed(FileSystem.FileSystem, openCodeStubFileSystem(fixture.authFile, fileRead)),
      ),
      Effect.provide(Path.layer),
      Effect.provide(
        Layer.succeed(HttpClient.HttpClient, openCodeStubClient(fixture.response, requestMade)),
      ),
    ),
  );
  // Absent rather than empty when the stage was never reached, so a case that stopped at the
  // gate cannot be confused with one that read a file and made no request.
  const effects: Json[] = [];
  if (fileRead.path !== undefined) effects.push({ authPath: fileRead.path });
  if (requestMade.auth !== undefined) {
    effects.push({ url: "https://opencode.ai/zen/go/v1/usage", authorization: requestMade.auth });
  }
  record(
    "opencode",
    `readOpenCodeGoUsageLimits.${table}`,
    [
      {
        ...fixture,
        checkedAt: OPENCODE_CHECKED_AT,
        // A 204 carries no body, which is not something the stub could fake: `new Response`
        // refuses a body for that status. The input line therefore says what the wire said,
        // and the port is handed no text rather than the text the case happened to name.
        response:
          fixture.response.status === 204 ? { status: fixture.response.status } : fixture.response,
      },
    ],
    { limits, effects },
  );
}

const openCodeGo = (key: Json): string => JSON.stringify({ "opencode-go": { type: "api", key } });
const GOOD_USAGE: Json = {
  rolling: { percent: 12.5, resetsAt: "2026-05-08T00:00:00.000Z" },
  weekly: { percent: 40, resetsAt: "2026-05-11T00:00:00.000Z" },
  monthly: { percent: 99.9, resetsAt: "2026-06-01T00:00:00.000Z" },
};
const goodBody = JSON.stringify({ usage: GOOD_USAGE });
// The body reaches the schema as text, so a case can name a spelling `JSON.stringify` would
// never emit — `1e999` for the infinity `Schema.Finite` rejects, `-0` for the zero it keeps.
const rawBody = (rolling: string, weekly = "1e0", monthly = "2e0"): string =>
  `{"usage":{"rolling":${rolling},"weekly":{"percent":${weekly},"resetsAt":"2026-05-11T00:00:00.000Z"},"monthly":{"percent":${monthly},"resetsAt":"2026-06-01T00:00:00.000Z"}}}`;
const percentWindow = (percent: string): string =>
  `{"percent":${percent},"resetsAt":"2026-05-08T00:00:00.000Z"}`;
const resetsWindow = (resetsAt: string): string => `{"percent":10,"resetsAt":${resetsAt}}`;

const openCodeReady = (
  over: Partial<
    Pick<OpenCodeFixture, "enabled" | "serverUrl" | "environment" | "authFile" | "response">
  >,
): OpenCodeFixture => ({
  enabled: over.enabled ?? true,
  serverUrl: over.serverUrl ?? "",
  // A home is always named, either the default one or the one the table supplies: without a
  // home the shipped code falls back to the host's own home directory, which is this machine's
  // and not a fact about the reader, so no row may reach that branch. An `undefined` value is
  // how a table writes "this key is not in the environment at all", since JSON drops it.
  environment: over.environment ?? {
    HOME: "/home/tester",
    OPENCODE_AUTH_CONTENT: openCodeGo("abc"),
  },
  authFile: over.authFile ?? { notFound: true },
  response: over.response ?? { status: 200, body: goodBody },
});

// `!input.enabled || input.serverUrl.trim()`. An external server owns its own credentials, so
// the read must not touch the host's account — and `.trim()` means a serverUrl of only
// whitespace is not an external server.
for (const enabled of [true, false]) {
  for (const serverUrl of [
    "",
    " ",
    "  ",
    "\t\n",
    "http://127.0.0.1:4096",
    "0",
    " https://opencode.ai ",
  ]) {
    await recordOpenCode("gate", openCodeReady({ enabled, serverUrl }));
  }
}

// Where the key comes from, and when there is no key at all. `OPENCODE_AUTH_CONTENT` is
// checked with `||`, so an empty one falls through to the file; the stored credential is
// decoded as an `Option`, so anything that is not `{type:"api", key:string}` silently hands
// the decision to `OPENCODE_API_KEY`; and the key is trimmed before the falsiness test, so a
// whitespace-only key is "no key" (`unsupported`) rather than a failed probe.
for (const authContent of [
  undefined,
  "",
  " ",
  "{}",
  openCodeGo("abc"),
  openCodeGo(" abc "),
  openCodeGo("   "),
  openCodeGo(""),
  openCodeGo(5),
  openCodeGo(null),
  JSON.stringify({ "opencode-go": { type: "Bearer", key: "abc" } }),
  JSON.stringify({ "opencode-go": { key: "abc" } }),
  JSON.stringify({ "opencode-go": "abc" }),
  JSON.stringify({ "opencode-go": null }),
  JSON.stringify({ "opencode-go": null, other: 1 }),
  JSON.stringify({ other: 1 }),
  "not json",
  "null",
  "5",
  "[]",
  "true",
  '"abc"',
]) {
  for (const envKey of [undefined, "envkey", "  ", ""]) {
    const environment: Record<string, string | undefined> = {
      HOME: "/home/tester",
      OPENCODE_AUTH_CONTENT: authContent,
    };
    if (envKey !== undefined) environment["OPENCODE_API_KEY"] = envKey;
    await recordOpenCode("credentials", openCodeReady({ environment }));
  }
}

// The file branch, and what the two failure modes of the read are worth. A missing
// `auth.json` is answered with `"{}"` and the decision moves on to the environment key; any
// other platform error is re-thrown, which the outer handler turns into `probeFailed`.
for (const authFile of [
  { contents: openCodeGo("filekey") },
  { contents: "{}" },
  { contents: "" },
  { contents: "not json" },
  { contents: JSON.stringify({ "opencode-go": { type: "api", key: "filekey" }, other: 1 }) },
  { notFound: true },
  { blocked: true },
] as const) {
  for (const environment of [
    {},
    { OPENCODE_API_KEY: "envkey" },
    { OPENCODE_AUTH_CONTENT: openCodeGo("overlay") },
  ]) {
    await recordOpenCode(
      "authFile",
      openCodeReady({ authFile, environment: { HOME: "/home/tester", ...environment } }),
    );
  }
}

// Both sources at once: stored credentials overlay environment credentials, so the file wins,
// and the environment key decides nothing. The `authorization` effect is what proves the order.
for (const stored of [openCodeGo("filekey"), "{}"]) {
  await recordOpenCode(
    "overlay",
    openCodeReady({
      environment: { HOME: "/home/tester", OPENCODE_API_KEY: "envkey" },
      authFile: { contents: stored },
    }),
  );
}

// Which file gets read. `XDG_DATA_HOME` wins outright, otherwise the home is `HOME`, then
// `USERPROFILE`; both are tested with `||`, so an empty one is not a home. A machine with
// neither falls back to the OS home directory, which is the host's own and cannot be pinned
// here — the port reads it from the same place, and no fixture needs to say so.
//
// The joining is what is under test, so every home here is spelled the way the layer that did
// the joining reads it: `Path.layer` is host-native, and on this machine that is `path.posix`,
// which treats `\` as an ordinary character. A Windows spelling would record the posix answer
// and ship a different one, so the port takes the same separator rules and the adapter that
// owns the host path supplies an already-joined home.
for (const environment of [
  { HOME: "/home/tester" },
  { HOME: "/home/tester", XDG_DATA_HOME: "/xdg" },
  { XDG_DATA_HOME: "/xdg" },
  { XDG_DATA_HOME: " " },
  { XDG_DATA_HOME: "/xdg/" },
  { HOME: "", USERPROFILE: "/from/profile" },
  { USERPROFILE: "/from/userprofile" },
  { HOME: "/a//b/" },
  { HOME: "/a/b/../c" },
  { HOME: "~" },
  { HOME: "/home/tester", OPENCODE_AUTH_CONTENT: openCodeGo("abc") },
]) {
  await recordOpenCode(
    "authPath",
    openCodeReady({ environment, authFile: { contents: openCodeGo("filekey") } }),
  );
}

// A valid Zen key can exist without a Go subscription, so 403 is "this account has nothing to
// show" (`unsupported`) while every other non-2xx status is a failed read. `filterStatusOk`
// answers on the 2xx range, so 201 draws and 299 does not.
for (const status of [200, 201, 202, 204, 299, 300, 301, 400, 401, 403, 404, 429, 500, 503]) {
  await recordOpenCode("status", openCodeReady({ response: { status, body: goodBody } }));
}

// `Schema.Finite` is the gate in front of `clampPercent`: a percentage that is not a finite
// number fails the whole decode, so one bad window takes the other two with it. That is the
// opposite of the Cursor mapper, which drops a non-numeric bucket and keeps the rest. The
// values that do survive are `clampPercent`'s to decide, which the core table already covers —
// these rows are here for the range and the sign that reaches it.
for (const percent of [
  "0",
  "-0",
  "0.4",
  "12.5",
  "100",
  "100.0001",
  "140",
  "-5",
  "1e999",
  "-1e999",
  '"10"',
  "true",
  "false",
  "null",
  "1e-324",
  "{}",
  "[]",
]) {
  await recordOpenCode(
    "percent",
    openCodeReady({ response: { status: 200, body: rawBody(percentWindow(percent)) } }),
  );
}

// The response shape is all-or-nothing: three named windows, each with both fields.
for (const body of [
  goodBody,
  '{"usage":{}}',
  '{"usage":null}',
  "{}",
  '{"usage":{"rolling":{},"weekly":{},"monthly":{}}}',
  `{"usage":${JSON.stringify({ ...GOOD_USAGE, extra: GOOD_USAGE.rolling })}}`,
  `{"usage":{"rolling":${JSON.stringify(GOOD_USAGE.rolling)},"weekly":${JSON.stringify(GOOD_USAGE.weekly)}}}`,
  '{"usage":[1,2,3]}',
  "5",
  "[]",
  '""',
  "",
  "not json",
]) {
  await recordOpenCode("usageBody", openCodeReady({ response: { status: 200, body } }));
}

// `Schema.DateTimeUtcFromString` in front of `DateTime.formatIso`. Every spelling has to be
// accepted by the schema *and* survive the round trip through the formatter, so this table is
// the evidence for what the port's ISO grammar must be: the same ECMAScript-shaped grammar the
// Grok period end reaches, or a narrower one.
for (const resetsAt of [
  '"2026-05-08T00:00:00.000Z"',
  '"2026-05-08T00:00:00Z"',
  '"2026-05-08T00:00:00"',
  '"2026-05-08T00:00"',
  '"2026-05-08"',
  '"2026-05-08T00:00:00.00Z"',
  '"2026-05-08T00:00:00.1Z"',
  '"2026-05-08T00:00:00.123456789Z"',
  '"2026-05-08T00:00:00+02:00"',
  '"2026-05-08T00:00:00-0330"',
  '"2026-05-08T00:00:00+0200"',
  '"2026-05-08t00:00:00z"',
  '"2026-05-08 00:00:00Z"',
  '"2026-05-08T00:00:00 GMT"',
  '"Fri, 08 May 2026 00:00:00 GMT"',
  '"05/08/2026 00:00:00"',
  '"2026-02-30T00:00:00Z"',
  '"2026-13-01T00:00:00Z"',
  '"2026-05-08T25:00:00Z"',
  '"1970-01-01T00:00:00.000Z"',
  '"1969-12-31T23:59:59.999Z"',
  '"9999-12-31T23:59:59.999Z"',
  '"+002026-05-08T00:00:00Z"',
  '"-000001-01-01T00:00:00Z"',
  '"999999-12-31T23:59:59Z"',
  '" 2026-05-08T00:00:00Z "',
  '""',
  '"not a date"',
  '"1777000000000"',
  "1777000000000",
  "0",
  '"2026-05-08T00:00:00Z[Europe/Berlin]"',
  "null",
  "true",
  "{}",
]) {
  await recordOpenCode(
    "resetsAt",
    openCodeReady({ response: { status: 200, body: rawBody(resetsWindow(resetsAt)) } }),
  );
}

// Padding, measured separately because Effect's `"Z"` rule decides it: a string with no zone
// gets one appended, so the whitespace ends up *inside* the text the parser sees, while an
// already-zoned string is handed over as written. The rule the shipped code follows is that
// only the `T` form is strict — a padded `2026-05-08T00:00:00Z` is refused while a padded bare
// date, a space-separated date-time and the legacy forms are all taken.
//
// `" 2026-05-08"` (leading space, date-only, no zone) is deliberately absent: the shipped
// answer is `03:00Z` here and `09:00Z` under `TZ=Asia/Tokyo`, because V8's legacy parser reads
// that one spelling in the host's own zone. A golden cannot carry a value that changes with the
// machine that generated it, so the case stays unmeasured and the port keeps its UTC-only
// stance for it.
for (const resetsAt of [
  '"2026-05-08T00:00:00Z "',
  '" 2026-05-08T00:00:00Z"',
  '"\\t2026-05-08T00:00:00Z\\n"',
  '"2026-05-08T00:00:00 "',
  '" 2026-05-08T00:00:00 "',
  '"2026-05-08 "',
  '"2026-05-08Z "',
  '" 05/08/2026 00:00:00"',
  '"05/08/2026 00:00:00 "',
  '" Fri, 08 May 2026 00:00:00 GMT "',
  '"2026-05-08T00:00:00Z\\t"',
  // The other side of the same question: padding on a date-only text, a space between a bare
  // date and its zone, and padding after an explicit offset rather than a `Z`.
  '"  2026-05-08  "',
  '"2026-05-08 Z"',
  '"2026-05-08T00:00:00+02:00 "',
  '" 2026-05-08T00:00:00+02:00"',
  '"2026-05-08 00:00:00 Z"',
]) {
  await recordOpenCode(
    "padding",
    openCodeReady({ response: { status: 200, body: rawBody(resetsWindow(resetsAt)) } }),
  );
}

// ---------------------------------------------------------------- claude reset credits
// `claudeResetCredits.ts` is the bank behind Claude's "redeem a reset" button: the grants the
// usage endpoint reports, and the claim that spends one. Its first export is a pure function of
// a block and an instant, so those tables need no harness. The other three read the account — a
// login file, an account file, the platform, the path layer, the wire — so they run through the
// same stubs OpenCode uses, with `HostProcessPlatform` pinned per case. Leaving it to the
// machine would record this host's operating system, which is a fact about the laptop that
// generated the trace and not about the reader.
//
// Two things no fixture can reach: the ten and twenty-five second timeouts, and the keychain a
// macOS login lives in. Neither is a hole. A timeout is answered the way an unreadable answer
// already is, and the darwin rows record the *absence* of a credentials read, which is the part
// of the keychain branch anything outside the CLI can see.

const CREDITS_NOW = Date.parse("2026-05-08T12:00:00.000Z");
const grant = (over: Record<string, Json> = {}): Json => ({
  id: "g1",
  resets_left: 2,
  usable_now: true,
  ...over,
});
// The smallest bank the endpoint can send. `next_grant_id` is written only when the table names
// one: JSON drops an `undefined`, and an absent key is a different block from a null one.
const bank = (grants: Json[], next?: Json): Json => ({
  eligible: true,
  grants,
  ...(next === undefined ? {} : { next_grant_id: next }),
});
const toCredits = (block: Json) =>
  claudeResetCredits.claudeResetCreditsToContract(block, CREDITS_NOW);

// The block is decoded all-or-nothing by `decodeUnknownOption`, which is what makes a junk grant
// different from a junk block: one grant is dropped and the bank keeps reporting the others,
// while a bad block reports nothing at all. An eligible block with nothing spendable still says
// `availableCount: 0`, so the bars may draw zero but never go missing.
for (const block of [
  bank([grant()], "g1"),
  { eligible: false, grants: [grant()], next_grant_id: "g1" },
  { grants: [grant()], next_grant_id: "g1" },
  { eligible: "true", grants: [grant()] },
  { eligible: 1, grants: [grant()] },
  { eligible: null, grants: [grant()] },
  bank([]),
  { eligible: true },
  { eligible: true, grants: "no" },
  { eligible: true, grants: {} },
  { eligible: true, grants: null },
  { eligible: true, grants: [grant()], next_grant_id: null },
  { eligible: true, grants: [grant()], next_grant_id: 7 },
  { eligible: true, grants: [grant()], next_grant_id: "g1", other: 1 },
  { eligible: true, grants: [null, 5, "x", {}, grant()], next_grant_id: "g1" },
  null,
  undefined,
  "cedar",
  0,
  [],
]) {
  record("credits", "claudeResetCreditsToContract.shape", [block, CREDITS_NOW], toCredits(block));
}

// One grant at a time, every spelling of every field. Each row is a bank of one or a bank of
// nothing, because a field of the wrong type is the end of that grant and of nothing else.
for (const over of [
  {},
  { id: "G1" },
  { id: "g.dot" },
  { id: "" },
  { id: "g".repeat(41) },
  { id: "g".repeat(40) },
  { id: "a_b-c0" },
  { id: "g 1" },
  { id: "bé" },
  { id: 5 },
  { id: null },
  { resets_left: 0 },
  { resets_left: -0 },
  { resets_left: 1.5 },
  { resets_left: -1 },
  { resets_left: "2" },
  { resets_left: null },
  { resets_left: 1e21 },
  { resets_left: 9007199254740991 },
  { resets_left: 9007199254740992 },
  { resets_left: undefined },
  { paused: true },
  { paused: false },
  { paused: "true" },
  { paused: null },
  { usable_now: false },
  { usable_now: undefined },
  { usable_now: "yes" },
  { usable_now: 1 },
  { usable_now: null },
  { ends_at: null },
  { ends_at: undefined },
  { ends_at: 1777000000000 },
  { ends_at: true },
  { ends_at: [] },
  { ends_at: {} },
  { other: 1 },
]) {
  const block = bank([grant(over)], "g1");
  record("credits", "claudeResetCreditsToContract.grant", [block, CREDITS_NOW], toCredits(block));
}

// `ends_at` carries the whole grammar: `COMPLETE_TIMESTAMP` first, then the instant has to be
// strictly after `nowMs`, then the day has to exist in its own month. Everything that passes the
// pattern is dated after the reference instant unless the row says otherwise, so "future" and
// "well-formed" stop being the same answer. The rows past the pattern are the evidence that the
// local check is stricter than the parser behind it: a compact offset, a lowercase `t`, a padded
// text and the legacy spellings all reach `Date.parse` in other mappers and die here.
for (const endsAt of [
  "2026-05-08T12:00:00.001Z",
  "2026-05-08T12:00:00Z",
  "2026-05-08T12:00:00.000Z",
  "2026-05-08T13:00:00Z",
  "2026-05-08T11:00:00Z",
  "2027-01-01T00:00:00Z",
  "2027-02-29T00:00:00Z",
  "2028-02-29T00:00:00Z",
  "2026-02-30T00:00:00Z",
  "2026-04-31T00:00:00Z",
  "2026-05-32T00:00:00Z",
  "2026-12-32T00:00:00Z",
  "2026-13-01T00:00:00Z",
  "2026-00-10T00:00:00Z",
  "2026-05-08T25:00:00Z",
  "2026-05-08T12:60:00Z",
  "2026-05-08T12:00:60Z",
  "2026-05-08T12:00:00+02:00",
  "2026-05-08T23:00:00+02:00",
  "2026-05-08T12:00:00-03:30",
  "2026-05-08T12:00:00+0200",
  "2026-05-08T12:00:00+00:00",
  "2026-05-08T12:00:00.123456Z",
  "2026-05-08T12:00:00.1Z",
  "2026-05-08T12:00:00.12Z",
  "2026-05-08T12:00:00.Z",
  "2026-05-08t12:00:00z",
  "2026-05-08T12:00:00z",
  "2026-05-08t12:00:00Z",
  " 2026-05-09T00:00:00Z",
  "2026-05-09T00:00:00Z ",
  "2026-05-09",
  "2026-05-09 00:00:00",
  "2026-05-09T00:00:00",
  "Fri, 09 May 2026 00:00:00 GMT",
  "05/09/2026",
  "2026-05-09T00:00:00Z[Europe/Berlin]",
  "2026-05-09T00:00:00 GMT",
  "9999-12-31T23:59:59Z",
  "275760-09-13T00:00:00Z",
  "-000001-01-01T00:00:00Z",
  "2026-05-08T12:00:00.000+00:00",
  "2026-05-09T00:00:00+14:00",
  "2026-05-08T00:00:00-14:00",
  "",
  "not a date",
]) {
  const block = bank([grant({ ends_at: endsAt })], "g1");
  record(
    "credits",
    "claudeResetCreditsToContract.timestamp",
    [block, CREDITS_NOW],
    toCredits(block),
  );
}

// The bank's own pointer decides whether the count is said at all: a `next_grant_id` that names
// nothing live answers zero and names no credit, while one that lands sums every live grant —
// duplicates, other live grants, and the grant it pointed at.
const nextCases: [string, Json][] = [
  ["no-next-id", bank([grant(), grant({ id: "g2" })])],
  ["next-is-second", bank([grant(), grant({ id: "g2", resets_left: 5 })], "g2")],
  ["next-not-live", bank([grant()], "g9")],
  ["next-is-paused", bank([grant({ paused: true }), grant({ id: "g2" })], "g1")],
  ["next-is-expired", bank([grant({ ends_at: "2026-05-01T00:00:00Z" })], "g1")],
  ["next-is-dropped-grant", bank([{ id: "g1", resets_left: 1 }, grant({ id: "g2" })], "g1")],
  ["duplicate-ids", bank([grant({ resets_left: 1 }), grant({ resets_left: 2 })], "g1")],
  ["next-with-null-end", bank([grant({ ends_at: null }), grant({ id: "g2" })], "g1")],
  [
    "expires-from-next",
    bank(
      [
        grant({ ends_at: "2026-06-01T00:00:00Z" }),
        grant({ id: "g2", ends_at: "2026-07-01T00:00:00.5Z" }),
      ],
      "g2",
    ),
  ],
  ["only-dropped", bank([grant({ usable_now: false })], "g1")],
  [
    "sum-over-twelve",
    bank(
      Array.from({ length: 12 }, (_, index) => ({
        id: `g${index}`,
        resets_left: 1,
        usable_now: true,
      })),
      "g0",
    ),
  ],
  [
    "zero-and-huge",
    bank([grant({ resets_left: -0 }), grant({ id: "g2", resets_left: 1e21 }), grant()], "g1"),
  ],
];
for (const [, block] of nextCases) {
  record(
    "credits",
    "claudeResetCreditsToContract.nextGrant",
    [block, CREDITS_NOW],
    toCredits(block),
  );
}

interface CreditFile {
  readonly contents?: string;
  readonly notFound?: true;
  readonly blocked?: true;
}

interface CreditReply {
  readonly status: number;
  readonly body?: string;
}

const CRED_TOKEN = JSON.stringify({ claudeAiOauth: { accessToken: "tok" } });
const CRED_ACCOUNT = JSON.stringify({ oauthAccount: { organizationUuid: "org-1" } });
const claimReply = (result: string): CreditReply => ({
  status: 200,
  body: JSON.stringify({ result }),
});
const claimReset = claimReply("reset");

function creditStubFileSystem(files: readonly CreditFile[], seen: string[]) {
  return FileSystem.makeNoop({
    readFileString: (path: string) => {
      // The two files are told apart by the names they were opened under, which is the only
      // thing that distinguishes them here, and the order the reads arrive in is the order the
      // record keeps.
      seen.push(path);
      const file = path.endsWith(".credentials.json") ? files[0]! : files[1]!;
      if (file.contents !== undefined) return Effect.succeed(file.contents);
      if (file.blocked === true) {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFileString",
            description: "blocked",
            pathOrDescriptor: path,
          }),
        );
      }
      return Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
          description: "No such file or directory",
          pathOrDescriptor: path,
        }),
      );
    },
  });
}

// The URL as the executor would have sent it. `Url.make` is exactly what `HttpClient` calls to
// turn a request's `url` and `urlParams` into the wire URL, so the record says what would have
// left the process rather than what the builder was handed — which is the only way the usage
// read's two parameters appear anywhere.
function wireUrl(request: HttpClient.HttpClientRequest): string {
  const made = Url.make(request.url, request.urlParams, undefined);
  return Result.isSuccess(made) ? made.success.toString() : `unmakeable: ${request.url}`;
}

function creditStubClient(reply: CreditReply, seen: Json[]) {
  return HttpClient.make((request) => {
    const headers = { ...request.headers };
    seen.push({
      method: request.method,
      url: wireUrl(request),
      authorization: headers["authorization"],
      beta: headers["anthropic-beta"],
      userAgent: headers["user-agent"],
      body: (request.body as { text?: string } | undefined)?.text,
    });
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(reply.status === 204 || reply.body === undefined ? null : reply.body, {
          status: reply.status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
}

const creditEffect = (path: string): Json =>
  path.endsWith(".credentials.json") ? { credentialsFile: path } : { accountFile: path };

// Files first, in the order they were opened, then the request. A case that stopped before the
// wire has no `request` entry at all, which is what makes "did not send" a measured answer
// rather than an assumption.
function creditEffects(files: readonly string[], requests: readonly Json[]): Json[] {
  return [
    ...files.map(creditEffect),
    ...requests.map((request) => {
      const sent = request as Record<string, Json>;
      return {
        request: {
          method: sent["method"],
          url: sent["url"],
          authorization: sent["authorization"],
          beta: sent["beta"],
          userAgent: sent["userAgent"],
          // A GET carries no body, and `bodyJsonUnsafe` is the only thing that ever wrote one.
          ...(sent["body"] === undefined ? {} : { body: sent["body"] }),
        },
      };
    }),
  ];
}

function creditLayers(
  platform: "darwin" | "linux",
  files: readonly CreditFile[],
  seenFiles: string[],
  reply: CreditReply,
  seenRequests: Json[],
) {
  return [
    TestClock.layer(),
    Layer.succeed(HostProcessPlatform, platform),
    Layer.succeed(FileSystem.FileSystem, creditStubFileSystem(files, seenFiles)),
    Path.layer,
    Layer.succeed(HttpClient.HttpClient, creditStubClient(reply, seenRequests)),
  ] as const;
}

async function runClaim(fixture: {
  readonly platform: "darwin" | "linux";
  readonly configDir: string;
  readonly accountConfigPath: string;
  readonly version: string;
  readonly grantId: string;
  readonly requestId: string;
  readonly credentials: CreditFile;
  readonly account: CreditFile;
  readonly reply: CreditReply;
}): Promise<Json> {
  const seenFiles: string[] = [];
  const seenRequests: Json[] = [];
  const [clock, host, fs, path, client] = creditLayers(
    fixture.platform,
    [fixture.credentials, fixture.account],
    seenFiles,
    fixture.reply,
    seenRequests,
  );
  const decided = await Effect.runPromise(
    claudeResetCredits
      .consumeClaudeResetCredit({
        configDir: fixture.configDir,
        accountConfigPath: fixture.accountConfigPath,
        version: fixture.version,
        grantId: fixture.grantId,
        requestId: fixture.requestId,
      })
      .pipe(
        Effect.match({
          onFailure: (error) => ({
            outcome: null,
            failure: error.reason,
            message: error.message,
            settled: claudeResetCredits.isSettledClaudeResetCreditFailure(error),
          }),
          onSuccess: (outcome) => ({
            outcome: outcome ?? null,
            failure: null,
            message: null,
            settled: null,
          }),
        }),
        Effect.provide(clock),
        Effect.provide(host),
        Effect.provide(fs),
        Effect.provide(path),
        Effect.provide(client),
      ),
  );
  return { ...decided, effects: creditEffects(seenFiles, seenRequests) };
}

const claimCase = (table: string, over: Partial<Parameters<typeof runClaim>[0]>): Promise<void> =>
  recordClaim(table, {
    platform: "linux",
    configDir: "/cfg",
    accountConfigPath: "/cfg/.claude.json",
    version: "1.2.3",
    grantId: "g1",
    requestId: "req1",
    credentials: { contents: CRED_TOKEN },
    account: { contents: CRED_ACCOUNT },
    reply: claimReset,
    ...over,
  });

async function recordClaim(table: string, fixture: Parameters<typeof runClaim>[0]): Promise<void> {
  const result = await runClaim(fixture);
  record(
    "credits",
    `consumeClaudeResetCredit.${table}`,
    [
      {
        ...fixture,
        reply: fixture.reply.status === 204 ? { status: 204 } : fixture.reply,
      },
    ],
    result,
  );
}

// Both ids are checked before anything is read, so a claim that cannot be named never opens a
// file and never puts an id on the wire. The `effects` half of each record is the proof.
for (const [, over] of [
  ["grant-upper", { grantId: "G1" }],
  ["grant-dot", { grantId: "g.1" }],
  ["grant-empty", { grantId: "" }],
  ["grant-too-long", { grantId: "g".repeat(41) }],
  ["grant-non-ascii", { grantId: "gã" }],
  ["request-bang", { requestId: "req!" }],
  ["request-empty", { requestId: "" }],
  ["request-too-long", { requestId: "r".repeat(65) }],
  ["request-lowercase-ok", { requestId: "req_-abc123" }],
] as const) {
  await claimCase("ids", over as never);
}

// The login stage: which file is opened on which platform, and what an unreadable one is worth.
// A missing credentials file is answered with `{}` and the claim goes on to ask about the
// account; anything else the reader could not do is `loginUnreadable`, and nothing further runs.
for (const [, over] of [
  ["darwin", { platform: "darwin" }],
  ["not-found", { credentials: { notFound: true } }],
  ["blocked", { credentials: { blocked: true } }],
  [
    "blank-token",
    { credentials: { contents: JSON.stringify({ claudeAiOauth: { accessToken: "  " } }) } },
  ],
  ["no-oauth", { credentials: { contents: "{}" } }],
  [
    "token-number",
    { credentials: { contents: JSON.stringify({ claudeAiOauth: { accessToken: 5 } }) } },
  ],
  ["oauth-not-object", { credentials: { contents: JSON.stringify({ claudeAiOauth: 5 }) } }],
  ["oauth-null", { credentials: { contents: JSON.stringify({ claudeAiOauth: null }) } }],
  [
    "token-null",
    { credentials: { contents: JSON.stringify({ claudeAiOauth: { accessToken: null } }) } },
  ],
  ["not-an-object", { credentials: { contents: "[]" } }],
  ["bad-json", { credentials: { contents: "not json" } }],
  ["empty-file", { credentials: { contents: "" } }],
  ["config-dir-empty", { configDir: "" }],
  ["config-dir-odd", { configDir: "/a//b/../cfg" }],
] as const) {
  await claimCase("credentials", over as never);
}

// The account stage, which the claim reaches even when it has no login: the two files are read
// before either is asked about.
for (const [, over] of [
  ["not-found", { account: { notFound: true } }],
  ["blocked", { account: { blocked: true } }],
  [
    "blank-org",
    { account: { contents: JSON.stringify({ oauthAccount: { organizationUuid: "  " } }) } },
  ],
  ["no-account", { account: { contents: "{}" } }],
  ["account-null", { account: { contents: JSON.stringify({ oauthAccount: null }) } }],
  [
    "org-number",
    { account: { contents: JSON.stringify({ oauthAccount: { organizationUuid: 7 } }) } },
  ],
  [
    "org-null",
    { account: { contents: JSON.stringify({ oauthAccount: { organizationUuid: null } }) } },
  ],
  ["not-an-object", { account: { contents: "5" } }],
  ["path-is-verbatim", { accountConfigPath: " /odd/../path/.claude.json" }],
] as const) {
  await claimCase("account", over as never);
}

// The answers a claim can arrive under. `429`, `401` and `403` are decided on the status alone,
// before the body is read; everything else in the 2xx range is asked what it said, and a body
// that cannot answer is `requestFailed` — which, like `unconfirmed`, is not settled.
for (const [, reply] of [
  ["reset", claimReply("reset")],
  ["not-limited", claimReply("not_limited")],
  ["already-used", claimReply("already_used")],
  ["ineligible", claimReply("ineligible")],
  ["cooldown", claimReply("cooldown")],
  ["unavailable", claimReply("unavailable")],
  ["unknown-result", { status: 200, body: JSON.stringify({ result: "maybe" }) }],
  ["missing-result", { status: 200, body: "{}" }],
  ["bad-json", { status: 200, body: "not json" }],
  ["empty-body", { status: 200, body: "" }],
  ["204", { status: 204 }],
  ["201", { status: 201, body: JSON.stringify({ result: "reset" }) }],
  ["401", { status: 401, body: JSON.stringify({ result: "reset" }) }],
  ["403", { status: 403, body: JSON.stringify({ result: "reset" }) }],
  ["404", { status: 404, body: JSON.stringify({ result: "reset" }) }],
  ["429", { status: 429, body: JSON.stringify({ result: "reset" }) }],
  ["500", { status: 500, body: JSON.stringify({ result: "reset" }) }],
] as const) {
  await claimCase("status", { reply } as never);
}

// What went on the wire: the organization is escaped into the path, the token and the version
// are spelled into headers, and the body is the three keys the CLI sends. The escaping is the
// part a port gets to get wrong.
for (const [, organizationUuid] of [
  ["plain", "org-1"],
  ["slash", "or/g1"],
  ["hash", "org#1"],
  ["space", "org 1"],
  ["percent", "org%41"],
  ["unicode", "orgçã"],
  ["plus", "org+1"],
  ["query", "org?1"],
  // `encodeURIComponent` leaves exactly these five punctuation marks as they are, and no other
  // spelling of a quote belongs in a URL path.
  ["quote", 'org"1'],
  ["apostrophe", "org'1"],
  ["parens", "org(1)"],
  ["star", "org*1"],
  ["tilde", "org~1"],
  ["trimmed", "  org-1  "],
] as const) {
  await claimCase("request", {
    account: { contents: JSON.stringify({ oauthAccount: { organizationUuid } }) },
    version: "2.0.0-rc",
    grantId: "credit_9",
    requestId: "req_-abc123",
  } as never);
}

async function runRead(fixture: {
  readonly platform: "darwin" | "linux";
  readonly configDir: string;
  readonly version: string;
  readonly credentials: CreditFile;
  readonly reply: CreditReply;
}): Promise<Json> {
  const seenFiles: string[] = [];
  const seenRequests: Json[] = [];
  const [clock, host, fs, path, client] = creditLayers(
    fixture.platform,
    [fixture.credentials],
    seenFiles,
    fixture.reply,
    seenRequests,
  );
  const read = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(CREDITS_NOW);
      return yield* claudeResetCredits.readClaudeResetCredits(fixture.configDir, fixture.version);
    }).pipe(
      Effect.provide(clock),
      Effect.provide(host),
      Effect.provide(fs),
      Effect.provide(path),
      Effect.provide(client),
    ),
  );
  // Every failure this read can raise ends in `orElseSucceed(() => undefined)`, so the record
  // says nothing rather than which thing went wrong. The effects are what tell the cases apart.
  return {
    credits: read === undefined ? { __absent: true } : read,
    effects: creditEffects(seenFiles, seenRequests),
  };
}

// `table` groups the rows, because naming each case its own label would leave most labels with
// a single record. Which case a row is travels on the input line, in the fixture itself.
const readCase = (table: string, over: Partial<Parameters<typeof runRead>[0]>): Promise<void> =>
  recordRead(table, {
    platform: "linux",
    configDir: "/cfg",
    version: "1.2.3",
    credentials: { contents: CRED_TOKEN },
    reply: { status: 200, body: JSON.stringify({ cedar_ember: bank([grant()], "g1") }) },
    ...over,
  });

async function recordRead(table: string, fixture: Parameters<typeof runRead>[0]): Promise<void> {
  const result = await runRead(fixture);
  // A `204` cannot carry the body the fixture named: the stub hands the response a null one, and
  // the input line has to say what the shipped call was actually given.
  const reply = fixture.reply.status === 204 ? { status: 204 } : fixture.reply;
  record(
    "credits",
    `readClaudeResetCredits.${table}`,
    [{ ...fixture, nowMs: CREDITS_NOW, reply }],
    result,
  );
}

// The usage read: the instant it is made at comes from the clock, so it is named on the input
// line for the port to be handed the same one. A grant that ends exactly at that instant is not
// live, which is the difference between the two `at-now` rows and the empty bank.
await readCase("bank", {});
await readCase("bank", {
  reply: {
    status: 200,
    body: JSON.stringify({
      cedar_ember: bank([grant({ ends_at: "2026-05-08T12:00:00.000Z" })], "g1"),
    }),
  },
});
await readCase("bank", {
  reply: {
    status: 200,
    body: JSON.stringify({
      cedar_ember: bank([grant({ ends_at: "2026-05-08T12:00:01.000Z" })], "g1"),
    }),
  },
});
await readCase("bank", {
  reply: {
    status: 200,
    body: JSON.stringify({ cedar_ember: bank([grant({ ends_at: "2026-05-01T00:00:00Z" })], "g1") }),
  },
});
await readCase("bank", { reply: { status: 200, body: "{}" } });
await readCase("bank", { reply: { status: 200, body: '{"cedar_ember":null}' } });
await readCase("bank", { reply: { status: 200, body: '{"cedar_ember":5}' } });
await readCase("bank", {
  reply: {
    status: 200,
    body: `{"cedar_ember":${JSON.stringify({ ...bank([grant()], "g1"), other: 1 })},"spam":1}`,
  },
});

// What the read can get back from the credential file. Every one of these ends as "no resets",
// so the effects — which file was opened, whether anything went on the wire — are the record.
await readCase("credentials", { platform: "darwin" });
await readCase("credentials", { credentials: { notFound: true } });
await readCase("credentials", { credentials: { blocked: true } });
await readCase("credentials", {
  credentials: { contents: JSON.stringify({ claudeAiOauth: { accessToken: " " } }) },
});
await readCase("credentials", {
  credentials: { contents: JSON.stringify({ claudeAiOauth: { accessToken: 5 } }) },
});

// `filterStatusOk` is decided before the body is read, so a status that is not 2xx has to be
// tried against a body that would have answered. Without these rows the read would accept a
// redirect's or a server error's bank, and nothing here would say so.
const bankBody = JSON.stringify({ cedar_ember: bank([grant()], "g1") });
for (const status of [200, 201, 204, 300, 301, 400, 403, 429, 500, 503]) {
  await readCase("status", { reply: { status } });
  await readCase("status", { reply: { status, body: bankBody } });
}

// Where the account record lives. `configDir ? path.join(configDir, ".claude.json") :
// path.join(os.homedir(), …)` — the second branch is this machine's home, so no row may take it
// and the empty directory is decided by the port's own unit test instead.
for (const configDir of [
  "/cfg",
  "/cfg/",
  "//cfg",
  "/cfg/../x",
  "/cfg/./x",
  "~",
  "/cfg with space",
  ".",
  "a/b",
  "/cfg with space/nested",
]) {
  record(
    "credits",
    "claudeAccountConfigPath",
    [configDir],
    await Effect.runPromise(
      claudeResetCredits.claudeAccountConfigPath(configDir).pipe(Effect.provide(Path.layer)),
    ),
  );
}

process.stderr.write(`usage-limits records: ${out.length}, calls: ${calls}\n`);
process.stdout.write(`${out.join("\n")}\n`);
