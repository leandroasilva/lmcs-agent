// Trace generator for terminal-history DELETION. It drives the shipped `TerminalManager`
// (real code, not a reimplementation) and records, in one chronological stream per case, every
// history-file `FileSystem` call, every published `TerminalEvent`, every Manager call boundary
// and every captured Warn/Error log line, so the Rust port can replay deletion as a golden.
// Nothing here waits on a sleep or a poll loop: the only waits are receipts (event-queue takes
// and the persist write latch already proven deterministic by terminal-persist-calls-trace.ts).
// Publish is awaited inside closeSession, so every `closed` event row lands before the awaited
// close returns; file order comes from the runtime's real readdir order and is never sorted.
//
// Read-only probe: scoped temp directories only, no live install, no dev server, no source edits.
//
// Run from the repository root:
//   node apps/server/scripts/terminal-history-delete-trace.ts [outFile]
// Writes the trace to <outFile> and a decoded copy to the same path with the `.txt` suffix
// replaced by `-decoded.txt`.
//
// ---------------------------------------------------------------------------
// Record grammar. Tab separated, one record per line; field 1 is the record code.
// Data-derived strings (thread ids, basenames, contents, messages, notes) are UTF-8 hex so a tab
// or newline cannot corrupt a row; "-" means absent. `seq` is a single global issue counter that
// never resets, so rows from different sources interleave in real order: M rows carry their issue
// seq and their completion seq (`done`), E/O/G rows carry the seq current at their occurrence.
//   H  defaultTerminalIdHex                         harness constants, once
//   Q  noteHex                                      measurement note (explicit, never a guess)
//   C  name threadIdHex createLogsDir               case header
//   O  seq phase id statusHex                       Manager call boundary (issue / return);
//                                                      status "-" at issue, else "ok" or the
//                                                      rendered failure at return
//   S  id statusHex historyHex pid                  open snapshot returned by the Manager; sorts
//                                                      directly after the O return row that
//                                                      carries it (shares its seq)
//   E  seq typeHex terminalIdHex eventSeq valid     a published TerminalEvent
//   M  seq method target basenameHex optsHex payloadHex
//                                                      a tracked FileSystem call issued inside
//                                                      the logs dir: method is rm / readdir /
//                                                      write, target is the basename or "-" for
//                                                      the directory itself, opts records the
//                                                      options argument (force / flat), payload
//                                                      is the write content or "-"
//   N  seq done method target status [payloadHex]  the same call settled; status "ok" or the
//                                                      rendered PlatformError; on readdir success
//                                                      the payload is the RAW readdir entry
//                                                      order, deliberately never sorted
//   D  phase basenameHex f|d contentHex             on-disk sample, raw readdir order; phase
//                                                      "pre" (before the traced close) or "post"
//                                                      (after it); content "-" for a directory
//                                                      or an absent entry
//   R  phase                                        sample terminator, "1" when the sample
//                                                      failed (missing logs dir), "0" otherwise
//   G  seq level messageHex fieldsHex inj errTagHex a captured Warn/Error log: message text, the
//                                                      metadata object's own key order, whether
//                                                      metadata.error/cause is the injected
//                                                      PlatformError, and the error _tag
//   L  label method basename hit                    declared fault spec and whether it was hit
//   A  claim match|diff detailHex                   one measured answer to the task questions;
//                                                      "diff" marks an observation that
//                                                      contradicts the expectation, it never
//                                                      aborts the run
//   X  name                                         case terminator
//   Z  caseCount sweepRepeats end                   global terminator
// ---------------------------------------------------------------------------

import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_TERMINAL_ID, TerminalEvent } from "@lmcstools/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../src/processRunner.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";
import type * as PtyAdapter from "../src/terminal/PtyAdapter.ts";

const isTerminalEvent = Schema.is(TerminalEvent);

const OUT_FILE =
  process.argv[2] ??
  "/Users/leandroadasilva/.cache/lmcs-port-traces/terminal-history-delete-trace.txt";
const DECODED_FILE = OUT_FILE.replace(/\.txt$/, "-decoded.txt");

const SWEEP_REPEATS = 5;
// Separator for readdir payload lists; 0x01 cannot appear in a filename.
const ENTRY_SEPARATOR = String.fromCharCode(1);

// ---------------------------------------------------------------------------
// Record encoding
// ---------------------------------------------------------------------------

type Field =
  | { readonly kind: "raw"; readonly value: string | number }
  | { readonly kind: "hex"; readonly value: string };

const raw = (value: string | number): Field => ({ kind: "raw", value });
const hexOf = (value: string): Field => ({ kind: "hex", value });
const hyphenOrHex = (value: string | null): Field => (value === null ? raw("-") : hexOf(value));

interface Row {
  readonly code: string;
  readonly fields: ReadonlyArray<Field>;
}

const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");

// Repository lint forbids JSON.stringify; quote control characters by hand so the note rows stay
// readable for ids like "a\u000f\u00c3".
const showId = (value: string): string =>
  `"${Array.from(value)
    .map((char) => {
      if (char === '"' || char === "\\") return `\\${char}`;
      const code = char.codePointAt(0)!;
      return code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : char;
    })
    .join("")}"`;

const encodeRow = (row: Row): string => {
  const line = [row.code]
    .concat(
      row.fields.map((field) => {
        if (field.kind === "raw") {
          const value = String(field.value);
          NodeAssert.ok(
            !value.includes("\t") && !value.includes("\n") && value.length > 0,
            `raw trace field must be a token: ${value}`,
          );
          return value;
        }
        return hex(field.value);
      }),
    )
    .join("\t");
  NodeAssert.equal(line.split("\t").length, row.fields.length + 1, "record field contained a tab");
  return line;
};

// The decoded copy hex-decodes the ENCODED line (not the in-memory field value) according to the
// row's field kinds, so what a human reads is exactly what the machine row encodes.
const decodeRow = (row: Row, line: string): string => {
  const parts = line.split("\t");
  const decoded = row.fields.map((field, index) => {
    const value = parts[index + 1] ?? "";
    if (field.kind === "raw") return value;
    const text = Buffer.from(value, "hex").toString("utf8");
    return `"${text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
  });
  return [parts[0], ...decoded].join("\t");
};

const ident = (value: string) => {
  NodeAssert.match(value, /^[a-z0-9-]+$/, `trace-unsafe identifier: ${value}`);
  return value;
};

// ---------------------------------------------------------------------------
// Fake PTY: no real process, no timers beyond the persist debounce the write latch absorbs.
// ---------------------------------------------------------------------------

class TracePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid: number;
  private dataCallback: ((data: string) => void) | null = null;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(): void {}
  resize(): void {}
  kill(): void {}

  onData(callback: (data: string) => void): () => void {
    this.dataCallback = callback;
    return () => {
      this.dataCallback = null;
    };
  }

  onExit(): () => void {
    return () => {};
  }

  emitOutput(data: string): void {
    NodeAssert.ok(this.dataCallback !== null, `pty ${this.pid}: output handler was unsubscribed`);
    this.dataCallback(data);
  }
}

class TracePtyAdapter {
  readonly processes: TracePtyProcess[] = [];
  private nextPid = 9300;

  spawn(): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    const process = new TracePtyProcess(this.nextPid);
    this.nextPid += 1;
    this.processes.push(process);
    return Effect.succeed(process);
  }

  live(): TracePtyProcess {
    const process = this.processes.at(-1);
    NodeAssert.ok(process !== undefined, "no pty has been spawned yet");
    return process;
  }
}

// ---------------------------------------------------------------------------
// Log sink. Deletion failures surface only as swallowed warnings, so message text, metadata key
// order and cause identity must be captured, never guessed. publishEvent ignores listener
// failures, so the sink is collected on a module reference gated per case.
// ---------------------------------------------------------------------------

interface CapturedLog {
  readonly level: string;
  readonly message: unknown;
  readonly seq: number;
}

let logSink: { readonly entries: CapturedLog[]; readonly seq: () => number } | null = null;

const traceLogger = Logger.make(({ logLevel, message }) => {
  if (logSink === null) return;
  logSink.entries.push({ level: logLevel, message, seq: logSink.seq() });
});

const warnText = (message: unknown): string => {
  if (typeof message === "string") return message;
  if (Array.isArray(message) && typeof message[0] === "string") return message[0];
  return "<structured>";
};

const warnMeta = (message: unknown): Record<string, unknown> | undefined => {
  if (!Array.isArray(message)) return undefined;
  const parts = message
    .slice(1)
    .filter(
      (part): part is Record<string, unknown> =>
        typeof part === "object" && part !== null && !Array.isArray(part),
    );
  if (parts.length === 0) return undefined;
  const merged: Record<string, unknown> = {};
  for (const part of parts) Object.assign(merged, part);
  return merged;
};

const renderError = (error: unknown): string => {
  if (error instanceof PlatformError.PlatformError && Predicate.hasProperty(error, "reason")) {
    const reason = error.reason as unknown;
    const tag =
      reason !== null && Predicate.hasProperty(reason, "_tag")
        ? String((reason as { _tag: unknown })._tag)
        : "?";
    const method =
      reason !== null && Predicate.hasProperty(reason, "method")
        ? String((reason as { method: unknown }).method)
        : "?";
    return `PlatformError/${tag}/${method}`;
  }
  if (Predicate.hasProperty(error, "_tag")) {
    return String((error as { _tag: unknown })._tag);
  }
  return "unknown";
};

// ---------------------------------------------------------------------------
// Filename oracles, deliberately reimplemented here (Buffer base64url) instead of importing the
// Manager's private helpers, so a rename inside the Manager fails the harness, not the trace.
// ---------------------------------------------------------------------------

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const threadPart = (threadId: string) => `terminal_${b64(threadId)}`;
const currentBasename = (threadId: string, terminalId: string) =>
  terminalId === DEFAULT_TERMINAL_ID
    ? `${threadPart(threadId)}.log`
    : `${threadPart(threadId)}_${b64(terminalId)}.log`;
const legacyBasename = (threadId: string) => `${threadId.replace(/[^a-zA-Z0-9._-]/g, "_")}.log`;

// A real base64url prefix collision: OTHER's encoded thread id starts with HOST's encoded id
// followed by "_", so HOST's thread-wide prefix rule `terminal_<b64(HOST)>_` matches OTHER's
// current-file name even though OTHER is a different thread.
const HOST = "a";
const OTHER = "a\u000f\u00c3";
NodeAssert.equal(b64(HOST), "YQ");
NodeAssert.equal(b64(OTHER), "YQ_Dgw");
NodeAssert.equal(
  Buffer.from(OTHER, "utf8").toString("base64url"),
  "YQ_Dgw",
  "effect and node base64url disagree",
);
NodeAssert.ok(b64(OTHER).startsWith(`${b64(HOST)}_`), "prefix collision lost its property");

// Two distinct thread ids whose legacy sanitization collides on `x_y.log`.
const LEGACY_A = "x/y";
const LEGACY_B = "x:y";
NodeAssert.equal(legacyBasename(LEGACY_A), "x_y.log");
NodeAssert.equal(legacyBasename(LEGACY_B), "x_y.log");
NodeAssert.notEqual(
  currentBasename(LEGACY_A, DEFAULT_TERMINAL_ID),
  currentBasename(LEGACY_B, DEFAULT_TERMINAL_ID),
);

// ---------------------------------------------------------------------------
// Case model
// ---------------------------------------------------------------------------

type SeedEntry =
  | { readonly kind: "file"; readonly basename: string; readonly content: string }
  | { readonly kind: "dir"; readonly basename: string; readonly child: string };

interface FaultSpec {
  readonly method: "remove" | "readDirectory";
  readonly basename: string | null;
  readonly label: string;
  error?: PlatformError.PlatformError;
  hit?: boolean;
}

interface CloseSpec {
  readonly threadId: string;
  readonly terminalId?: string;
  readonly deleteHistory?: boolean;
}

type Step =
  | { readonly kind: "open"; readonly id: string; readonly terminalId: string }
  | { readonly kind: "emit"; readonly id: string; readonly data: string }
  | { readonly kind: "awaitWrites"; readonly id: string; readonly count: number }
  | { readonly kind: "awaitEvent"; readonly id: string; readonly type: string }
  | { readonly kind: "close"; readonly id: string; readonly spec: CloseSpec }
  | { readonly kind: "seed"; readonly entries: ReadonlyArray<SeedEntry> }
  // makeWithOptions creates the logs dir at startup (Manager.ts:1524), so probing a genuinely
  // missing directory requires wiping it after construction and before the traced close.
  | { readonly kind: "wipeLogsDir" }
  | { readonly kind: "sample"; readonly phase: "pre" | "post" };

interface CaseSpec {
  readonly name: string;
  readonly threadId: string;
  readonly createLogsDir: boolean;
  readonly seeds: ReadonlyArray<SeedEntry>;
  readonly steps: ReadonlyArray<Step>;
  readonly faults: ReadonlyArray<FaultSpec>;
}

const CURRENT = DEFAULT_TERMINAL_ID;

const caseSpecs: ReadonlyArray<CaseSpec> = [
  // Q1: default terminal, live session, deleteHistory true. Legacy and current are pre-seeded so
  // the trace shows the persist write overwriting the file that is then removed.
  {
    name: "default-live-delete",
    threadId: "thread-1",
    createLogsDir: true,
    seeds: [
      { kind: "file", basename: currentBasename("thread-1", CURRENT), content: "stale-current\n" },
      { kind: "file", basename: legacyBasename("thread-1"), content: "legacy\n" },
      { kind: "file", basename: currentBasename("thread-1", "term-2"), content: "other-term\n" },
      { kind: "file", basename: "unrelated.log", content: "keep\n" },
      { kind: "file", basename: "notes", content: "keep\n" },
      { kind: "dir", basename: "somedir", child: "inner.log" },
    ],
    steps: [
      { kind: "open", id: "open-1", terminalId: CURRENT },
      { kind: "emit", id: "emit-1", data: "alpha\n" },
      { kind: "awaitEvent", id: "event-output", type: "output" },
      { kind: "awaitWrites", id: "debounce-1", count: 1 },
      { kind: "sample", phase: "pre" },
      {
        kind: "close",
        id: "close-1",
        spec: { threadId: "thread-1", terminalId: CURRENT, deleteHistory: true },
      },
      { kind: "sample", phase: "post" },
    ],
    faults: [],
  },
  // Q2: secondary terminal, deleteHistory true. Legacy is seeded AFTER the opens: seeding it
  // before opening the default terminal would trigger the open-time migration instead.
  {
    name: "secondary-live-delete",
    threadId: "thread-1",
    createLogsDir: true,
    seeds: [],
    steps: [
      { kind: "open", id: "open-1", terminalId: CURRENT },
      { kind: "open", id: "open-2", terminalId: "term-2" },
      {
        kind: "seed",
        entries: [{ kind: "file", basename: legacyBasename("thread-1"), content: "legacy\n" }],
      },
      { kind: "sample", phase: "pre" },
      {
        kind: "close",
        id: "close-1",
        spec: { threadId: "thread-1", terminalId: "term-2", deleteHistory: true },
      },
      { kind: "sample", phase: "post" },
    ],
    faults: [],
  },
  // Q3: deleteHistory false on a live default terminal.
  {
    name: "default-live-delete-false",
    threadId: "thread-1",
    createLogsDir: true,
    seeds: [
      { kind: "file", basename: currentBasename("thread-1", CURRENT), content: "stale-current\n" },
      { kind: "file", basename: legacyBasename("thread-1"), content: "legacy\n" },
    ],
    steps: [
      { kind: "open", id: "open-1", terminalId: CURRENT },
      { kind: "sample", phase: "pre" },
      {
        kind: "close",
        id: "close-1",
        spec: { threadId: "thread-1", terminalId: CURRENT, deleteHistory: false },
      },
      { kind: "sample", phase: "post" },
    ],
    faults: [],
  },
  // Q3: deleteHistory absent on a live default terminal. Must behave like false (`=== true`).
  {
    name: "default-live-delete-absent",
    threadId: "thread-1",
    createLogsDir: true,
    seeds: [
      { kind: "file", basename: currentBasename("thread-1", CURRENT), content: "stale-current\n" },
      { kind: "file", basename: legacyBasename("thread-1"), content: "legacy\n" },
    ],
    steps: [
      { kind: "open", id: "open-1", terminalId: CURRENT },
      { kind: "sample", phase: "pre" },
      { kind: "close", id: "close-1", spec: { threadId: "thread-1", terminalId: CURRENT } },
      { kind: "sample", phase: "post" },
    ],
    faults: [],
  },
  // Q4: close a terminal that was never opened; pre-existing files on disk.
  {
    name: "never-opened-delete",
    threadId: "thread-1",
    createLogsDir: true,
    seeds: [
      { kind: "file", basename: currentBasename("thread-1", CURRENT), content: "stale-current\n" },
      { kind: "file", basename: legacyBasename("thread-1"), content: "legacy\n" },
      { kind: "file", basename: currentBasename("thread-1", "term-2"), content: "other-term\n" },
    ],
    steps: [
      { kind: "sample", phase: "pre" },
      {
        kind: "close",
        id: "close-1",
        spec: { threadId: "thread-1", terminalId: CURRENT, deleteHistory: true },
      },
      { kind: "sample", phase: "post" },
    ],
    faults: [],
  },
  // Q5: live session whose current file never existed on disk (open wrote nothing, no seed).
  {
    name: "live-delete-missing-current",
    threadId: "thread-1",
    createLogsDir: true,
    seeds: [],
    steps: [
      { kind: "open", id: "open-1", terminalId: CURRENT },
      { kind: "sample", phase: "pre" },
      {
        kind: "close",
        id: "close-1",
        spec: { threadId: "thread-1", terminalId: CURRENT, deleteHistory: true },
      },
      { kind: "sample", phase: "post" },
    ],
    faults: [],
  },
  // Q5 contrast: force:true removal of paths that never existed, no session at all.
  {
    name: "never-opened-delete-no-files",
    threadId: "thread-1",
    createLogsDir: true,
    seeds: [],
    steps: [
      {
        kind: "close",
        id: "close-1",
        spec: { threadId: "thread-1", terminalId: CURRENT, deleteHistory: true },
      },
      { kind: "sample", phase: "post" },
    ],
    faults: [],
  },
  // Q6: thread-wide close (no terminalId) with two live sessions and a full decoy set, including
  // a subdirectory whose name matches the prefix rule and a different thread whose current file
  // matches HOST's prefix.
  {
    name: "thread-sweep-multi",
    threadId: HOST,
    createLogsDir: true,
    seeds: [
      { kind: "file", basename: currentBasename(HOST, CURRENT), content: "stale-current\n" },
      { kind: "file", basename: legacyBasename(HOST), content: "legacy\n" },
      { kind: "file", basename: currentBasename(HOST, "term-2"), content: "host-term-2\n" },
      { kind: "file", basename: currentBasename(HOST, "term-9"), content: "host-term-9\n" },
      { kind: "file", basename: currentBasename(OTHER, CURRENT), content: "other-current\n" },
      { kind: "file", basename: legacyBasename(OTHER), content: "other-legacy\n" },
      { kind: "dir", basename: `${threadPart(HOST)}_sub`, child: "inner.log" },
      { kind: "file", basename: "unrelated.log", content: "keep\n" },
      { kind: "file", basename: "notes", content: "keep\n" },
    ],
    steps: [
      { kind: "open", id: "open-1", terminalId: CURRENT },
      { kind: "open", id: "open-2", terminalId: "term-2" },
      { kind: "sample", phase: "pre" },
      { kind: "close", id: "close-1", spec: { threadId: HOST, deleteHistory: true } },
      { kind: "sample", phase: "post" },
    ],
    faults: [],
  },
  // Q7: sweep repeats (executed SWEEP_REPEATS times below) to measure removal-order stability and
  // whether the discard:true forEach is sequential or concurrent. Never opened: only the sweep.
  {
    name: "sweep-repeat",
    threadId: HOST,
    createLogsDir: true,
    seeds: [
      { kind: "file", basename: currentBasename(HOST, CURRENT), content: "stale-current\n" },
      { kind: "file", basename: currentBasename(HOST, "term-2"), content: "host-term-2\n" },
      { kind: "file", basename: currentBasename(HOST, "term-9"), content: "host-term-9\n" },
      { kind: "file", basename: currentBasename(OTHER, CURRENT), content: "other-current\n" },
    ],
    steps: [
      { kind: "close", id: "close-1", spec: { threadId: HOST, deleteHistory: true } },
      { kind: "sample", phase: "post" },
    ],
    faults: [],
  },
  // Q6 without the thread-wide delete: per-session closes only, no readdir, no removes.
  {
    name: "thread-close-no-delete",
    threadId: HOST,
    createLogsDir: true,
    seeds: [
      { kind: "file", basename: currentBasename(HOST, CURRENT), content: "stale-current\n" },
      { kind: "file", basename: legacyBasename(HOST), content: "legacy\n" },
    ],
    steps: [
      { kind: "open", id: "open-1", terminalId: CURRENT },
      { kind: "sample", phase: "pre" },
      { kind: "close", id: "close-1", spec: { threadId: HOST } },
      { kind: "sample", phase: "post" },
    ],
    faults: [],
  },
  // Q8(i): injected failure on the current-file remove of a single-terminal close.
  {
    name: "fault-remove-current",
    threadId: "thread-1",
    createLogsDir: true,
    seeds: [
      { kind: "file", basename: currentBasename("thread-1", CURRENT), content: "stale-current\n" },
      { kind: "file", basename: legacyBasename("thread-1"), content: "legacy\n" },
    ],
    steps: [
      { kind: "open", id: "open-1", terminalId: CURRENT },
      {
        kind: "close",
        id: "close-1",
        spec: { threadId: "thread-1", terminalId: CURRENT, deleteHistory: true },
      },
      { kind: "sample", phase: "post" },
    ],
    faults: [
      { method: "remove", basename: currentBasename("thread-1", CURRENT), label: "current" },
    ],
  },
  // Q8(ii): injected failure on the legacy-file remove.
  {
    name: "fault-remove-legacy",
    threadId: "thread-1",
    createLogsDir: true,
    seeds: [
      { kind: "file", basename: currentBasename("thread-1", CURRENT), content: "stale-current\n" },
      { kind: "file", basename: legacyBasename("thread-1"), content: "legacy\n" },
    ],
    steps: [
      { kind: "open", id: "open-1", terminalId: CURRENT },
      {
        kind: "close",
        id: "close-1",
        spec: { threadId: "thread-1", terminalId: CURRENT, deleteHistory: true },
      },
      { kind: "sample", phase: "post" },
    ],
    faults: [{ method: "remove", basename: legacyBasename("thread-1"), label: "legacy" }],
  },
  // Q8(iii): injected failure on the FIRST file of the thread-wide sweep (readdir order puts
  // the default-terminal name first), so the later removals prove the sweep continues past a
  // failure instead of aborting the forEach.
  {
    name: "fault-sweep-one-file",
    threadId: HOST,
    createLogsDir: true,
    seeds: [
      { kind: "file", basename: currentBasename(HOST, CURRENT), content: "stale-current\n" },
      { kind: "file", basename: currentBasename(HOST, "term-2"), content: "host-term-2\n" },
      { kind: "file", basename: currentBasename(HOST, "term-9"), content: "host-term-9\n" },
    ],
    steps: [
      { kind: "close", id: "close-1", spec: { threadId: HOST, deleteHistory: true } },
      { kind: "sample", phase: "post" },
    ],
    faults: [{ method: "remove", basename: currentBasename(HOST, CURRENT), label: "sweep-first" }],
  },
  // Q8(iv): injected failure on readDirectory itself during the sweep.
  {
    name: "fault-read-directory",
    threadId: HOST,
    createLogsDir: true,
    seeds: [
      { kind: "file", basename: currentBasename(HOST, CURRENT), content: "stale-current\n" },
      { kind: "file", basename: legacyBasename(HOST), content: "legacy\n" },
      { kind: "file", basename: currentBasename(HOST, "term-2"), content: "host-term-2\n" },
    ],
    steps: [
      { kind: "close", id: "close-1", spec: { threadId: HOST, deleteHistory: true } },
      { kind: "sample", phase: "post" },
    ],
    faults: [{ method: "readDirectory", basename: null, label: "readdir" }],
  },
  // Q8(v): the logs directory is genuinely missing when the sweep runs (Manager creates it at
  // startup, so wipe it right before the traced close): readDirectory fails and the failure is
  // swallowed by orElseSucceed.
  {
    name: "missing-logs-dir-sweep",
    threadId: HOST,
    createLogsDir: false,
    seeds: [],
    steps: [
      { kind: "wipeLogsDir" },
      { kind: "close", id: "close-1", spec: { threadId: HOST, deleteHistory: true } },
      { kind: "sample", phase: "post" },
    ],
    faults: [],
  },
  // Q8(v) contrast: missing logs directory, single-terminal close with deleteHistory true:
  // force:true makes both removals of absent paths silent successes.
  {
    name: "missing-logs-dir-single",
    threadId: HOST,
    createLogsDir: false,
    seeds: [],
    steps: [
      { kind: "wipeLogsDir" },
      {
        kind: "close",
        id: "close-1",
        spec: { threadId: HOST, terminalId: CURRENT, deleteHistory: true },
      },
    ],
    faults: [],
  },
  // Q9: the thread-wide sweep of "x/y" removes the shared sanitized legacy file `x_y.log` even
  // though it was written for "x:y" (legacy rule is exact-name on the sanitized id). The b64
  // prefix rule does NOT catch "x:y"'s current file: b64("x/y")="eC95" is not a prefix of the
  // "eDp5" path segment, so the victim's current file must survive. (The b64 prefix collision
  // itself is proven separately in thread-sweep-multi via HOST/OTHER.)
  {
    name: "legacy-name-sweep-collision",
    threadId: LEGACY_A,
    createLogsDir: true,
    seeds: [
      { kind: "file", basename: legacyBasename(LEGACY_B), content: "shared-of-x-colon-y\n" },
      {
        kind: "file",
        basename: currentBasename(LEGACY_B, CURRENT),
        content: "other-thread-current\n",
      },
    ],
    steps: [
      { kind: "close", id: "close-1", spec: { threadId: LEGACY_A, deleteHistory: true } },
      { kind: "sample", phase: "post" },
    ],
    faults: [],
  },
  // Q9 contrast: a single-terminal close also deletes the shared legacy name (deleteHistory
  // always removes legacyPath for the default terminal), regardless of which thread owns it.
  {
    name: "legacy-name-single-close",
    threadId: LEGACY_A,
    createLogsDir: true,
    seeds: [
      { kind: "file", basename: legacyBasename(LEGACY_B), content: "shared-of-x-colon-y\n" },
      {
        kind: "file",
        basename: currentBasename(LEGACY_B, CURRENT),
        content: "other-thread-current\n",
      },
    ],
    steps: [
      {
        kind: "close",
        id: "close-1",
        spec: { threadId: LEGACY_A, terminalId: CURRENT, deleteHistory: true },
      },
      { kind: "sample", phase: "post" },
    ],
    faults: [],
  },
];

// ---------------------------------------------------------------------------
// Observations collected per case
// ---------------------------------------------------------------------------

interface ObsCall {
  readonly seq: number;
  done: number;
  readonly method: "rm" | "readdir" | "write";
  readonly basename: string;
  readonly opts: string;
  payload: string | null;
  status: string;
}

interface ObsEvent {
  readonly seq: number;
  readonly type: string;
  readonly terminalId: string;
  readonly eventSeq: number;
  readonly valid: boolean;
}

interface ObsBoundary {
  readonly seq: number;
  readonly phase: "issue" | "return";
  readonly id: string;
  readonly status: string | null;
}

interface ObsSampleEntry {
  readonly basename: string;
  readonly isDir: boolean;
  readonly content: string | null;
}

interface ObsSample {
  readonly seq: number;
  readonly phase: "pre" | "post";
  readonly failed: boolean;
  readonly entries: ReadonlyArray<ObsSampleEntry>;
}

interface ObsWarn {
  readonly seq: number;
  readonly level: string;
  readonly message: string;
  readonly keys: ReadonlyArray<string>;
  readonly injected: boolean;
  readonly errorTag: string;
}

interface CaseResult {
  readonly name: string;
  readonly threadId: string;
  readonly createLogsDir: boolean;
  readonly calls: ReadonlyArray<ObsCall>;
  readonly events: ReadonlyArray<ObsEvent>;
  readonly boundaries: ReadonlyArray<ObsBoundary>;
  readonly snapshots: ReadonlyArray<{
    id: string;
    seq: number;
    status: string;
    history: string;
    pid: number;
  }>;
  readonly samples: ReadonlyArray<ObsSample>;
  readonly warns: ReadonlyArray<ObsWarn>;
  readonly closeOk: boolean;
  readonly faults: ReadonlyArray<{ label: string; method: string; basename: string; hit: boolean }>;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

let globalSeq = 0;
const nextSeq = () => {
  globalSeq += 1;
  return globalSeq;
};

const methodToken = (method: string) =>
  method === "remove"
    ? "rm"
    : method === "readDirectory"
      ? "readdir"
      : method === "writeFileString"
        ? "write"
        : method;

const runCase = Effect.fnUntraced(function* (spec: CaseSpec) {
  const fs = yield* FileSystem.FileSystem;
  const { join, basename, dirname } = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: `lmcs-delete-${spec.name}-` });
  const logsDir = join(baseDir, "userdata", "logs", "terminals");
  const cwd = join(baseDir, "cwd");
  yield* fs.makeDirectory(cwd, { recursive: true });
  if (spec.createLogsDir) yield* fs.makeDirectory(logsDir, { recursive: true });

  // Faults carry mutable state, so each run owns a fresh copy of the spec's fault list.
  const faults: FaultSpec[] = spec.faults.map((fault) => ({ ...fault }));
  for (const fault of faults) {
    fault.error = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: fault.method,
      pathOrDescriptor: "injected",
      description: `injected-${fault.label}`,
    });
  }

  const state = {
    capturing: false,
    calls: [] as ObsCall[],
  };
  const writeSignals = yield* Effect.acquireRelease(Queue.unbounded<void>(), Queue.shutdown);

  // Only calls on paths inside the logs dir are observed; everything (seeding, sampling, temp
  // cleanup) uses the raw `fs` and stays invisible to the trace.
  const trackedFileSystem = FileSystem.FileSystem.of({
    ...fs,
    remove: Effect.fnUntraced(function* (...args: Parameters<FileSystem.FileSystem["remove"]>) {
      const target = args[0];
      const tracked = state.capturing && dirname(target) === logsDir;
      const name = basename(target);
      const opts = args[1]?.force === true ? "force" : "noforce";
      const fault = tracked
        ? faults.find(
            (candidate) =>
              candidate.method === "remove" &&
              !candidate.hit &&
              (candidate.basename === null || candidate.basename === name),
          )
        : undefined;
      if (tracked && fault?.error !== undefined) {
        fault.hit = true;
        const call: ObsCall = {
          seq: nextSeq(),
          done: -1,
          method: "rm",
          basename: name,
          opts,
          payload: null,
          status: `err:${renderError(fault.error)}`,
        };
        call.done = nextSeq();
        state.calls.push(call);
        return yield* fault.error;
      }
      if (!tracked) return yield* fs.remove(...args);
      const call: ObsCall = {
        seq: nextSeq(),
        done: -1,
        method: "rm",
        basename: name,
        opts,
        payload: null,
        status: "ok",
      };
      const result = yield* Effect.result(fs.remove(...args));
      call.done = nextSeq();
      if (result._tag === "Failure") call.status = `err:${renderError(result.failure)}`;
      state.calls.push(call);
      if (result._tag === "Failure") return yield* result.failure;
    }),
    readDirectory: Effect.fnUntraced(function* (
      ...args: Parameters<FileSystem.FileSystem["readDirectory"]>
    ) {
      const tracked = state.capturing && args[0] === logsDir;
      const opts = args[1]?.recursive === true ? "recursive" : "flat";
      const fault = tracked
        ? faults.find((c) => c.method === "readDirectory" && !c.hit)
        : undefined;
      if (tracked && fault?.error !== undefined) {
        fault.hit = true;
        const call: ObsCall = {
          seq: nextSeq(),
          done: -1,
          method: "readdir",
          basename: "-",
          opts,
          payload: null,
          status: `err:${renderError(fault.error)}`,
        };
        call.done = nextSeq();
        state.calls.push(call);
        return yield* fault.error;
      }
      if (!tracked) return yield* fs.readDirectory(...args);
      const call: ObsCall = {
        seq: nextSeq(),
        done: -1,
        method: "readdir",
        basename: "-",
        opts,
        payload: null,
        status: "ok",
      };
      const result = yield* Effect.result(fs.readDirectory(...args));
      call.done = nextSeq();
      if (result._tag === "Success") {
        // Raw readdir order, recorded unsorted so any instability stays visible.
        call.payload = result.success.join(ENTRY_SEPARATOR);
      } else {
        call.status = `err:${renderError(result.failure)}`;
      }
      state.calls.push(call);
      if (result._tag === "Failure") return yield* result.failure;
      return result.success;
    }),
    writeFileString: Effect.fnUntraced(function* (
      ...args: Parameters<FileSystem.FileSystem["writeFileString"]>
    ) {
      const tracked = state.capturing && dirname(args[0]) === logsDir;
      if (!tracked) return yield* fs.writeFileString(...args);
      const call: ObsCall = {
        seq: nextSeq(),
        done: -1,
        method: "write",
        basename: basename(args[0]),
        opts: "-",
        payload: args[1],
        status: "ok",
      };
      yield* fs.writeFileString(...args);
      call.done = nextSeq();
      state.calls.push(call);
      yield* Queue.offer(writeSignals, undefined);
    }),
  });

  const events: ObsEvent[] = [];
  const boundaries: ObsBoundary[] = [];
  const snapshots: Array<{
    id: string;
    seq: number;
    status: string;
    history: string;
    pid: number;
  }> = [];
  const samples: ObsSample[] = [];

  const eventSignals = yield* Effect.acquireRelease(Queue.unbounded<void>(), Queue.shutdown);
  const adapter = new TracePtyAdapter();

  const manager = yield* TerminalManager.makeWithOptions({
    logsDir,
    historyLineLimit: 8,
    historyByteLimit: 1024,
    ptyAdapter: adapter,
    env: {},
    shellResolver: () => "/bin/sh",
    subprocessInspector: () =>
      Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
    processKillGraceMs: 0,
  }).pipe(Effect.provideService(FileSystem.FileSystem, trackedFileSystem));

  const unsubscribe = yield* manager.subscribe((event) =>
    Effect.gen(function* () {
      events.push({
        seq: nextSeq(),
        type: event.type,
        terminalId: event.terminalId,
        eventSeq: event.sequence ?? -1,
        valid: isTerminalEvent(event),
      });
      yield* Queue.offer(eventSignals, undefined);
    }),
  );

  const seedNow = Effect.fnUntraced(function* (entries: ReadonlyArray<SeedEntry>) {
    for (const seed of entries) {
      const full = join(logsDir, seed.basename);
      if (seed.kind === "dir") {
        yield* fs.makeDirectory(full, { recursive: true });
        yield* fs.writeFileString(join(full, seed.child), "inner\n");
      } else {
        yield* fs.writeFileString(full, seed.content);
      }
    }
  });
  yield* seedNow(spec.seeds);

  const sample = Effect.fnUntraced(function* (phase: "pre" | "post", seq: number) {
    const listing = yield* Effect.result(fs.readDirectory(logsDir, { recursive: false }));
    if (listing._tag === "Failure") {
      samples.push({ seq, phase, failed: true, entries: [] });
      return;
    }
    const entries: ObsSampleEntry[] = [];
    for (const name of listing.success) {
      const full = join(logsDir, name);
      const stat = yield* Effect.result(fs.stat(full));
      if (stat._tag === "Failure" || stat.success.type === "Directory") {
        entries.push({ basename: name, isDir: stat._tag === "Success", content: null });
        continue;
      }
      const bytes = yield* fs.readFile(full);
      entries.push({
        basename: name,
        isDir: false,
        content: Buffer.from(bytes).toString("utf8"),
      });
    }
    samples.push({ seq, phase, failed: false, entries });
  });

  let eventCursor = 0;
  const landedWrites = () => state.calls.filter((call) => call.method === "write").length;
  const awaitEvent = Effect.fnUntraced(function* (type: string) {
    while (eventCursor >= events.length) {
      yield* Queue.take(eventSignals);
    }
    NodeAssert.equal(events[eventCursor]?.type, type, `${spec.name}: expected ${type} event`);
    eventCursor += 1;
  });

  logSink = { entries: [], seq: () => globalSeq };
  state.capturing = true;
  let closeOk = false;
  let closeDone = false;
  try {
    for (const step of spec.steps) {
      switch (step.kind) {
        case "open": {
          boundaries.push({ seq: nextSeq(), phase: "issue", id: step.id, status: null });
          const result = yield* Effect.result(
            manager.open({
              threadId: spec.threadId,
              terminalId: step.terminalId,
              cwd,
              cols: 100,
              rows: 24,
            }),
          );
          NodeAssert.equal(result._tag, "Success", `${spec.name}: ${step.id} open failed`);
          boundaries.push({ seq: nextSeq(), phase: "return", id: step.id, status: "ok" });
          snapshots.push({
            id: step.id,
            seq: globalSeq,
            status: result.success.status,
            history: result.success.history,
            pid: result.success.pid ?? -1,
          });
          yield* awaitEvent("started");
          break;
        }
        case "emit": {
          boundaries.push({ seq: nextSeq(), phase: "issue", id: step.id, status: null });
          yield* Effect.sync(() => adapter.live().emitOutput(step.data));
          boundaries.push({ seq: nextSeq(), phase: "return", id: step.id, status: "ok" });
          break;
        }
        case "awaitWrites": {
          // Safe to block on: the request was enqueued while the key was idle, so the single
          // consumer must reach its write; only the duration is real time (the 40 ms debounce).
          while (landedWrites() < step.count) {
            yield* Queue.take(writeSignals);
          }
          break;
        }
        case "awaitEvent": {
          yield* awaitEvent(step.type);
          break;
        }
        case "close": {
          boundaries.push({ seq: nextSeq(), phase: "issue", id: step.id, status: null });
          const result = yield* Effect.result(
            manager.close(step.spec as Parameters<typeof manager.close>[0]),
          );
          closeOk = result._tag === "Success";
          closeDone = true;
          boundaries.push({
            seq: nextSeq(),
            phase: "return",
            id: step.id,
            status: result._tag === "Success" ? "ok" : `err:${renderError(result.failure)}`,
          });
          break;
        }
        case "seed": {
          yield* seedNow(step.entries);
          break;
        }
        case "wipeLogsDir": {
          yield* fs.remove(logsDir, { recursive: true, force: true });
          break;
        }
        case "sample": {
          const seq = nextSeq();
          yield* sample(step.phase, seq);
          break;
        }
      }
    }
  } finally {
    state.capturing = false;
  }
  NodeAssert.ok(closeDone, `${spec.name}: no close step ran`);

  const logs = logSink.entries.filter((entry) => entry.level === "Warn" || entry.level === "Error");
  logSink = null;
  unsubscribe();

  const warns: ObsWarn[] = [];
  for (const entry of logs) {
    const meta = warnMeta(entry.message);
    const errorValue = meta?.["error"] ?? meta?.["cause"];
    const injected = faults.some((fault) => fault.error === errorValue);
    warns.push({
      seq: entry.seq,
      level: entry.level,
      message: warnText(entry.message),
      keys: meta === undefined ? [] : Object.keys(meta),
      injected,
      errorTag: errorValue === undefined ? "-" : renderError(errorValue),
    });
  }

  for (const fault of faults) {
    NodeAssert.equal(
      fault.hit,
      true,
      `${spec.name}: fault ${fault.label} was declared but never reached`,
    );
  }

  return {
    name: spec.name,
    threadId: spec.threadId,
    createLogsDir: spec.createLogsDir,
    calls: state.calls,
    events,
    boundaries,
    snapshots,
    samples,
    warns,
    closeOk,
    faults: faults.map((fault) => ({
      label: fault.label,
      method: methodToken(fault.method),
      basename: fault.basename ?? "-",
      hit: fault.hit === true,
    })),
  } satisfies CaseResult;
});

// ---------------------------------------------------------------------------
// Row rendering
// ---------------------------------------------------------------------------

// One chronological stream per case: every row that carries a seq participates in the sort.
// Ranks only break same-seq ties: an S snapshot shares the seq of its O return row, and a G
// warning shares the N completion seq of the call whose failure triggered it (the logger samples
// the counter without consuming it). D/R sample blocks carry the seq the sample step consumed.
interface TimedRow {
  readonly seq: number;
  readonly rank: number;
  readonly row: Row;
}

const timedRows = (result: CaseResult): Row[] => {
  const timed: TimedRow[] = [];
  for (const boundary of result.boundaries) {
    timed.push({
      seq: boundary.seq,
      rank: 0,
      row: {
        code: "O",
        fields: [
          raw(boundary.seq),
          hexOf(boundary.phase),
          hexOf(boundary.id),
          hyphenOrHex(boundary.status),
        ],
      },
    });
  }
  for (const snapshot of result.snapshots) {
    timed.push({
      seq: snapshot.seq,
      rank: 1,
      row: {
        code: "S",
        fields: [
          raw(snapshot.id),
          hexOf(snapshot.status),
          hexOf(snapshot.history),
          raw(snapshot.pid),
        ],
      },
    });
  }
  for (const event of result.events) {
    timed.push({
      seq: event.seq,
      rank: 2,
      row: {
        code: "E",
        fields: [
          raw(event.seq),
          hexOf(event.type),
          hexOf(event.terminalId),
          raw(event.eventSeq),
          raw(event.valid ? 1 : 0),
        ],
      },
    });
  }
  for (const call of result.calls) {
    timed.push({
      seq: call.seq,
      rank: 3,
      row: {
        code: "M",
        fields: [
          raw(call.seq),
          raw(call.method),
          raw(call.basename === "-" ? "-" : "f"),
          hyphenOrHex(call.basename),
          raw(call.opts),
          hyphenOrHex(call.payload),
        ],
      },
    });
    timed.push({
      seq: call.done,
      rank: 4,
      row: {
        code: "N",
        fields: [
          raw(call.done),
          raw(call.seq),
          raw(call.method),
          raw(call.basename === "-" ? "-" : "f"),
          raw(call.status),
          ...(call.method === "readdir" ? [hyphenOrHex(call.payload)] : []),
        ],
      },
    });
  }
  for (const warn of result.warns) {
    timed.push({
      seq: warn.seq,
      rank: 5,
      row: {
        code: "G",
        fields: [
          raw(warn.seq),
          hexOf(warn.level),
          hexOf(warn.message),
          hexOf(warn.keys.join(",")),
          raw(warn.injected ? 1 : 0),
          hexOf(warn.errorTag),
        ],
      },
    });
  }
  for (const sample of result.samples) {
    for (const entry of sample.entries) {
      timed.push({
        seq: sample.seq,
        rank: 6,
        row: {
          code: "D",
          fields: [
            hexOf(sample.phase),
            hexOf(entry.basename),
            raw(entry.isDir ? "d" : "f"),
            hyphenOrHex(entry.content),
          ],
        },
      });
    }
    timed.push({
      seq: sample.seq,
      rank: 7,
      row: { code: "R", fields: [hexOf(sample.phase), raw(sample.failed ? 1 : 0)] },
    });
  }
  return timed
    .sort((left, right) => left.seq - right.seq || left.rank - right.rank)
    .map((entry) => entry.row);
};

const caseRows = (result: CaseResult): Row[] => {
  const rows: Row[] = [
    {
      code: "C",
      fields: [raw(result.name), hexOf(result.threadId), raw(result.createLogsDir ? 1 : 0)],
    },
  ];
  rows.push(...timedRows(result));
  for (const fault of result.faults) {
    rows.push({
      code: "L",
      fields: [
        hexOf(fault.label),
        raw(fault.method),
        hexOf(fault.basename),
        raw(fault.hit ? 1 : 0),
      ],
    });
  }
  rows.push(...claimRows(evaluateClaims(result)));
  rows.push({ code: "X", fields: [raw(result.name)] });
  return rows;
};

const claimRows = (claims: ReadonlyArray<[string, boolean, string]>): Row[] =>
  claims.map(([id, ok, detail]): Row => ({
    code: "A",
    fields: [hexOf(id), raw(ok ? "match" : "diff"), hexOf(detail)],
  }));

// ---------------------------------------------------------------------------
// Claims: one A row per question the trace must answer. These are measured conclusions: a
// "diff" records behavior that contradicts the expectation without aborting the run.
// ---------------------------------------------------------------------------

const removesOf = (result: CaseResult) => result.calls.filter((call) => call.method === "rm");
const writesOf = (result: CaseResult) => result.calls.filter((call) => call.method === "write");
const readdirOf = (result: CaseResult) => result.calls.filter((call) => call.method === "readdir");
const closedOf = (result: CaseResult) => result.events.filter((event) => event.type === "closed");
const postOf = (result: CaseResult, basename: string): ObsSampleEntry | undefined =>
  result.samples
    .find((sample) => sample.phase === "post")
    ?.entries.find((e) => e.basename === basename);

const summary = (calls: ReadonlyArray<ObsCall>) =>
  calls.map((call) => `${call.basename}:${call.status}@${call.seq}`).join(",");

const evaluateClaims = (result: CaseResult): Array<[string, boolean, string]> => {
  const claims: Array<[string, boolean, string]> = [];
  const add = (id: string, ok: boolean, detail: string) => claims.push([ident(id), ok, detail]);
  const closeRow = result.boundaries.find((b) => b.phase === "return" && b.id === "close-1");
  add("close-success", result.closeOk, String(closeRow?.status ?? "missing"));
  add(
    "all-events-schema-valid",
    result.events.every((event) => event.valid),
    `${result.events.length} events`,
  );
  add("zero-error-logs", !result.warns.some((warn) => warn.level === "Error"), summary([]));

  switch (result.name) {
    case "default-live-delete": {
      const rms = removesOf(result);
      const closed = closedOf(result)[0];
      const lastWriteDone = Math.max(...writesOf(result).map((w) => w.done));
      const current = currentBasename("thread-1", CURRENT);
      const legacy = legacyBasename("thread-1");
      add(
        "q1-persist-write-completes-before-closed",
        closed !== undefined && lastWriteDone < closed.seq,
        `writeDone=${lastWriteDone} closedSeq=${closed?.seq ?? -1}`,
      );
      add(
        "q1-closed-before-remove",
        closed !== undefined && rms.length > 0 && rms.every((rm) => rm.seq > closed.seq),
        `closedSeq=${closed?.seq ?? -1} removes=${summary(rms)}`,
      );
      add(
        "q1-remove-order-current-then-legacy",
        rms.map((rm) => rm.basename).join(">") === `${current}>${legacy}` &&
          rms.every((rm) => rm.status === "ok"),
        summary(rms),
      );
      add(
        "q1-both-files-absent-after-close",
        postOf(result, current) === undefined && postOf(result, legacy) === undefined,
        `${postOf(result, current)?.content ?? "gone"}/${postOf(result, legacy)?.content ?? "gone"}`,
      );
      add(
        "q1-decoys-survive",
        postOf(result, currentBasename("thread-1", "term-2"))?.content === "other-term\n" &&
          postOf(result, "unrelated.log")?.content === "keep\n" &&
          postOf(result, "notes")?.content === "keep\n" &&
          postOf(result, "somedir")?.isDir === true,
        String(result.samples.filter((s) => s.phase === "post").length),
      );
      add(
        "q1-zero-warnings",
        result.warns.length === 0,
        result.warns.map((w) => w.message).join(","),
      );
      break;
    }
    case "secondary-live-delete": {
      const rms = removesOf(result);
      const secondary = currentBasename("thread-1", "term-2");
      add(
        "q2-only-secondary-removed",
        rms.map((rm) => rm.basename).join(">") === secondary &&
          rms.every((rm) => rm.status === "ok"),
        summary(rms),
      );
      add(
        "q2-legacy-untouched",
        postOf(result, legacyBasename("thread-1"))?.content === "legacy\n",
        String(postOf(result, legacyBasename("thread-1"))?.content),
      );
      add(
        "q2-default-current-untouched",
        postOf(result, currentBasename("thread-1", CURRENT)) === undefined ||
          postOf(result, currentBasename("thread-1", CURRENT))?.content === "",
        String(postOf(result, currentBasename("thread-1", CURRENT))?.content),
      );
      break;
    }
    case "default-live-delete-false":
    case "default-live-delete-absent": {
      const rms = removesOf(result);
      add(
        "q3-no-removal-at-all",
        rms.length === 0 && readdirOf(result).length === 0,
        `${rms.length} removes, ${readdirOf(result).length} readdir`,
      );
      add(
        "q3-legacy-and-current-survive",
        postOf(result, legacyBasename("thread-1"))?.content === "legacy\n" &&
          postOf(result, currentBasename("thread-1", CURRENT)) !== undefined,
        String(postOf(result, currentBasename("thread-1", CURRENT))?.content),
      );
      break;
    }
    case "never-opened-delete": {
      const rms = removesOf(result);
      const current = currentBasename("thread-1", CURRENT);
      const legacy = legacyBasename("thread-1");
      add("q4-no-closed-event", closedOf(result).length === 0, `${closedOf(result).length} closed`);
      add(
        "q4-no-persist-write",
        writesOf(result).length === 0,
        `${writesOf(result).length} writes`,
      );
      add(
        "q4-preseeded-files-still-deleted",
        postOf(result, current) === undefined &&
          postOf(result, legacy) === undefined &&
          rms.map((rm) => rm.basename).join(">") === `${current}>${legacy}`,
        `${summary(rms)} post=${result.samples
          .find((s) => s.phase === "post")
          ?.entries.map((e) => e.basename)
          .join(",")}`,
      );
      add(
        "q4-zero-warnings",
        result.warns.length === 0,
        result.warns.map((w) => w.message).join(","),
      );
      break;
    }
    case "live-delete-missing-current": {
      const rms = removesOf(result);
      const current = currentBasename("thread-1", CURRENT);
      const legacy = legacyBasename("thread-1");
      // The close-time persist write CREATES the current file before deleteHistory removes it,
      // so the removal never actually sees a missing current file on this path.
      add(
        "q5-close-recreates-current-before-remove",
        writesOf(result).length === 1 && rms.length === 2 && rms.every((rm) => rm.status === "ok"),
        `${summary(writesOf(result))} -> ${summary(rms)}`,
      );
      add(
        "q5-missing-legacy-remove-is-silent",
        result.warns.length === 0 && rms.some((rm) => rm.basename === legacy && rm.status === "ok"),
        result.warns.map((w) => w.message).join(","),
      );
      add(
        "q5-both-absent-after-close",
        postOf(result, current) === undefined && postOf(result, legacy) === undefined,
        String(result.samples.find((s) => s.phase === "post")?.entries.length ?? -1),
      );
      break;
    }
    case "never-opened-delete-no-files": {
      const rms = removesOf(result);
      add(
        "q5-force-remove-of-absent-paths-is-silent",
        rms.length === 2 && rms.every((rm) => rm.status === "ok") && result.warns.length === 0,
        `${summary(rms)} warns=${result.warns.length}`,
      );
      break;
    }
    case "thread-sweep-multi": {
      const rms = removesOf(result);
      const readdirs = readdirOf(result);
      const closed = closedOf(result);
      const current = currentBasename(HOST, CURRENT);
      const legacy = legacyBasename(HOST);
      const sec2 = currentBasename(HOST, "term-2");
      const sec9 = currentBasename(HOST, "term-9");
      const otherCurrent = currentBasename(OTHER, CURRENT);
      const dirname = `${threadPart(HOST)}_sub`;
      const closedSeqs = closed.map((event) => event.seq);
      add(
        "q6-closed-events-precede-sweep",
        closed.map((event) => event.terminalId).join(">") === `${CURRENT}>term-2` &&
          readdirs.length === 1 &&
          closedSeqs.every((seq) => seq < readdirs[0]!.seq),
        `closed=${closedSeqs.join(",")} readdir=${readdirs.map((r) => r.seq).join(",")}`,
      );
      add(
        "q6-matched-set-exact",
        rms
          .map((rm) => rm.basename)
          .sort()
          .join(">") === [current, legacy, sec2, sec9, otherCurrent, dirname].sort().join(">"),
        summary(rms),
      );
      add(
        "q6-prefix-collision-victim-removed",
        rms.some((rm) => rm.basename === otherCurrent && rm.status === "ok") &&
          postOf(result, otherCurrent) === undefined,
        summary(rms.filter((rm) => rm.basename === otherCurrent)),
      );
      add(
        "q6-dir-matched-but-survives-eisdir",
        rms.some((rm) => rm.basename === dirname && rm.status.startsWith("err")) &&
          postOf(result, dirname)?.isDir === true,
        summary(rms.filter((rm) => rm.basename === dirname)),
      );
      add(
        "q6-survivors-exact",
        postOf(result, legacyBasename(OTHER))?.content === "other-legacy\n" &&
          postOf(result, "unrelated.log")?.content === "keep\n" &&
          postOf(result, "notes")?.content === "keep\n" &&
          postOf(result, current) === undefined &&
          postOf(result, legacy) === undefined &&
          postOf(result, sec9) === undefined,
        String(
          result.samples
            .find((s) => s.phase === "post")
            ?.entries.map((e) => e.basename)
            .join(","),
        ),
      );
      add(
        "q6-five-ok-removes-plus-one-eisdir",
        rms.length === 6 && rms.filter((rm) => rm.status === "ok").length === 5,
        summary(rms),
      );
      break;
    }
    case "thread-close-no-delete": {
      add(
        "q6-no-readdir-no-remove-without-delete-history",
        readdirOf(result).length === 0 && removesOf(result).length === 0,
        `${readdirOf(result).length}/${removesOf(result).length}`,
      );
      add(
        "q6-closed-still-published",
        closedOf(result).length === 1 && closedOf(result)[0]!.terminalId === CURRENT,
        String(closedOf(result)[0]?.terminalId),
      );
      break;
    }
    case "fault-remove-current": {
      const rms = removesOf(result);
      const legacy = legacyBasename("thread-1");
      const warn = result.warns[0];
      add(
        "q8i-current-remove-errored-legacy-still-attempted",
        rms.length === 2 &&
          rms[0]!.status.startsWith("err") &&
          rms[1]!.basename === legacy &&
          rms[1]!.status === "ok",
        summary(rms),
      );
      add(
        "q8i-warning-text-and-fields",
        result.warns.length === 1 &&
          warn!.message === "failed to delete terminal history" &&
          warn!.keys.join(",") === "threadId,terminalId,error" &&
          warn!.injected,
        `${warn?.message}|${warn?.keys.join(",")}|inj=${warn?.injected}`,
      );
      add(
        "q8i-closed-published-and-files-survive-delete-failure",
        closedOf(result).length === 1 &&
          postOf(result, currentBasename("thread-1", CURRENT)) !== undefined &&
          postOf(result, legacy) === undefined,
        String(postOf(result, currentBasename("thread-1", CURRENT))?.content),
      );
      break;
    }
    case "fault-remove-legacy": {
      const rms = removesOf(result);
      const current = currentBasename("thread-1", CURRENT);
      const warn = result.warns[0];
      add(
        "q8ii-current-removed-legacy-errored",
        rms.length === 2 &&
          rms[0]!.basename === current &&
          rms[0]!.status === "ok" &&
          rms[1]!.status.startsWith("err"),
        summary(rms),
      );
      add(
        "q8ii-warning-uses-same-single-file-message",
        result.warns.length === 1 &&
          warn!.message === "failed to delete terminal history" &&
          warn!.keys.join(",") === "threadId,terminalId,error" &&
          warn!.injected,
        `${warn?.message}|${warn?.keys.join(",")}`,
      );
      break;
    }
    case "fault-sweep-one-file": {
      const rms = removesOf(result);
      const target = currentBasename(HOST, CURRENT);
      const others = [currentBasename(HOST, "term-2"), currentBasename(HOST, "term-9")];
      const warn = result.warns[0];
      add(
        "q8iii-sweep-continues-after-failure",
        rms.length === 3 &&
          rms[0]!.basename === target &&
          rms[0]!.status.startsWith("err") &&
          rms.slice(1).every((rm) => rm.status === "ok") &&
          others.every((name) => postOf(result, name) === undefined),
        `${summary(rms)} post=${result.samples
          .find((s) => s.phase === "post")
          ?.entries.map((e) => e.basename)
          .join(",")}`,
      );
      add(
        "q8iii-sweep-warning-text-and-fields",
        result.warns.length === 1 &&
          warn!.message === "failed to delete terminal histories for thread" &&
          warn!.keys.join(",") === "threadId,error" &&
          warn!.injected,
        `${warn?.message}|${warn?.keys.join(",")}`,
      );
      add(
        "q8iii-faulty-file-survives",
        postOf(result, target)?.content === "stale-current\n",
        String(postOf(result, target)?.content),
      );
      break;
    }
    case "fault-read-directory": {
      const readdirs = readdirOf(result);
      add(
        "q8iv-readdir-failure-swallowed",
        readdirs.length === 1 &&
          readdirs[0]!.status.startsWith("err") &&
          removesOf(result).length === 0 &&
          result.warns.length === 0,
        `${readdirs[0]?.status} removes=${removesOf(result).length} warns=${result.warns.length}`,
      );
      add(
        "q8iv-all-files-survive",
        postOf(result, currentBasename(HOST, CURRENT))?.content === "stale-current\n" &&
          postOf(result, legacyBasename(HOST))?.content === "legacy\n" &&
          postOf(result, currentBasename(HOST, "term-2"))?.content === "host-term-2\n",
        String(result.samples.find((s) => s.phase === "post")?.entries.length ?? -1),
      );
      break;
    }
    case "missing-logs-dir-sweep": {
      const readdirs = readdirOf(result);
      add(
        "q8v-missing-logs-dir-readdir-fails-silently",
        readdirs.length === 1 &&
          readdirs[0]!.status.startsWith("err") &&
          removesOf(result).length === 0 &&
          result.warns.length === 0,
        readdirs[0]?.status ?? "none",
      );
      break;
    }
    case "missing-logs-dir-single": {
      const rms = removesOf(result);
      add(
        "q8v-missing-dir-force-remove-silent",
        rms.length === 2 && rms.every((rm) => rm.status === "ok") && result.warns.length === 0,
        summary(rms),
      );
      break;
    }
    case "legacy-name-sweep-collision": {
      const rms = removesOf(result);
      const shared = legacyBasename(LEGACY_B);
      const victimCurrent = currentBasename(LEGACY_B, CURRENT);
      add(
        "q9-sweep-removes-shared-legacy-name",
        rms.map((rm) => rm.basename).join(">") === shared &&
          rms.every((rm) => rm.status === "ok") &&
          postOf(result, shared) === undefined,
        summary(rms),
      );
      add(
        "q9-victim-current-survives-no-b64-prefix",
        !rms.some((rm) => rm.basename === victimCurrent) &&
          postOf(result, victimCurrent)?.content === "other-thread-current\n",
        `${summary(rms)} post=${result.samples
          .find((s) => s.phase === "post")
          ?.entries.map((e) => e.basename)
          .join(",")}`,
      );
      break;
    }
    case "legacy-name-single-close": {
      const rms = removesOf(result);
      const shared = legacyBasename(LEGACY_B);
      const victimCurrent = currentBasename(LEGACY_B, CURRENT);
      add(
        "q9-single-close-removes-other-threads-shared-legacy-file",
        rms.map((rm) => rm.basename).join(">") ===
          `${currentBasename(LEGACY_A, CURRENT)}>${shared}` &&
          postOf(result, shared) === undefined &&
          postOf(result, victimCurrent)?.content === "other-thread-current\n",
        `${summary(rms)} survivors=${result.samples
          .find((s) => s.phase === "post")
          ?.entries.map((e) => e.basename)
          .join(",")}`,
      );
      break;
    }
    default: {
      // sweep-repeat runs: per-run order is collected globally below.
      break;
    }
  }
  return claims;
};

// ---------------------------------------------------------------------------
// Sweep stability measurement (Q7)
// ---------------------------------------------------------------------------

const removalPattern = (result: CaseResult): string => {
  const rms = removesOf(result);
  const marks: Array<{ seq: number; mark: string }> = [];
  for (const rm of rms) {
    marks.push({ seq: rm.seq, mark: "i" });
    marks.push({ seq: rm.done, mark: "d" });
  }
  marks.sort((left, right) => left.seq - right.seq);
  return marks.map((mark) => mark.mark).join("");
};

const basenameOf = (value: string) => value.split("/").at(-1) ?? value;

interface SweepObservation {
  readonly name: string;
  readonly readdir: string;
  readonly order: string;
  readonly statuses: string;
  readonly pattern: string;
}

// Per-run structured observation: raw readdir order, removal order, removal statuses and the
// issue/completion interleave pattern. Nothing is sorted away.
const sweepObservation = (result: CaseResult): SweepObservation => ({
  name: result.name,
  readdir:
    readdirOf(result)[0]
      ?.payload?.split(ENTRY_SEPARATOR)
      .map((name) => basenameOf(name))
      .join(">") ?? "none",
  order: removesOf(result)
    .map((rm) => rm.basename)
    .join(">"),
  statuses: removesOf(result)
    .map((rm) => rm.status)
    .join(","),
  pattern: removalPattern(result),
});

const sweepSignature = (observation: SweepObservation) =>
  `readdir[${observation.readdir}] remove[${observation.order}] status[${observation.statuses}] pattern[${observation.pattern}]`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const run = Effect.gen(function* () {
  NodeAssert.equal(DEFAULT_TERMINAL_ID, "term-1", "default terminal identity changed");
  NodeAssert.equal(
    new Set(caseSpecs.map((spec) => spec.name)).size,
    caseSpecs.length,
    "duplicate case names",
  );

  const header: Row[] = [
    { code: "H", fields: [hexOf(DEFAULT_TERMINAL_ID)] },
    {
      code: "Q",
      fields: [
        hexOf(
          `collision-host=${HOST}->${b64(HOST)}, collision-other=${showId(OTHER)}->${b64(OTHER)} (starts with ${b64(HOST)}_)`,
        ),
      ],
    },
    {
      code: "Q",
      fields: [
        hexOf(
          `legacy-collision=${showId(LEGACY_A)} and ${showId(LEGACY_B)} both sanitize to ${legacyBasename(LEGACY_A)}`,
        ),
      ],
    },
  ];

  const rows: Row[] = [...header];
  const results = new Map<string, CaseResult>();
  const sweepRuns: CaseResult[] = [];
  let caseCount = 0;

  for (const spec of caseSpecs) {
    const repeats = spec.name === "sweep-repeat" ? SWEEP_REPEATS : 1;
    for (let runIndex = 0; runIndex < repeats; runIndex += 1) {
      const named: CaseSpec =
        repeats === 1 ? spec : { ...spec, name: `${spec.name}-${runIndex + 1}` };
      const result = yield* Effect.scoped(runCase(named));
      caseCount += 1;
      results.set(result.name, result);
      if (spec.name === "sweep-repeat") sweepRuns.push(result);
      rows.push(...caseRows(result));
    }
  }

  // Cross-case claims.
  const falseResult = results.get("default-live-delete-false");
  const absentResult = results.get("default-live-delete-absent");
  NodeAssert.ok(falseResult !== undefined && absentResult !== undefined);
  const normalize = (result: CaseResult) =>
    [
      ...result.calls.map(
        (call) => `${call.method}:${call.basename}:${call.status}:${call.payload ?? "-"}`,
      ),
      ...result.events.map((event) => `e:${event.type}:${event.terminalId}`),
    ].join("|");
  const q3Same =
    normalize(falseResult).replaceAll("delete-false", "X").replaceAll("delete-absent", "X") ===
    normalize(absentResult).replaceAll("delete-false", "X").replaceAll("delete-absent", "X");
  rows.push(
    ...claimRows([
      [
        "q3-absent-identical-to-false",
        q3Same,
        `false=[${normalize(falseResult)}] absent=[${normalize(absentResult)}]`,
      ],
    ]),
  );

  // Q7: per-run structured observations. The interleave pattern is decided from the recorded
  // issue (M) and completion (N) seqs, never from a guess: "idid..." means every removal fully
  // settles before the next is issued (sequential), "iiiddd" would mean concurrent fan-out.
  const observations = sweepRuns.map(sweepObservation);
  const signatures = observations.map(sweepSignature);
  const stable =
    signatures.length > 0 && signatures.every((signature) => signature === signatures[0]);
  const patterns = observations.map((observation) => observation.pattern);
  const pattern = patterns[0] ?? "";
  const sequential = stable && /^(id)+$/.test(pattern);
  rows.push(
    ...claimRows([
      ["q7-removal-order-stable-across-runs", stable, signatures.join(" ;; ")],
      [
        "q7-sweep-sequential",
        sequential,
        sequential
          ? `pattern ${pattern}: each removal fully settles before the next is issued => SEQUENTIAL`
          : /^i+d+$/.test(pattern)
            ? `pattern ${pattern}: all removals issued before the first completion => CONCURRENT`
            : `unstable or unreadable patterns: ${patterns.join(",")}`,
      ],
    ]),
  );

  rows.push({ code: "Z", fields: [raw(caseCount), raw(sweepRuns.length), raw("end")] });

  const encoded = rows.map(encodeRow);
  NodeAssert.ok(
    encoded.every((line) => !line.includes("\n")),
    "row contains a newline",
  );
  const decoded = rows.map((row, index) => decodeRow(row, encoded[index]!));
  // The repository lint forbids node:fs in scripts, so the output files are written through the
  // Effect FileSystem service itself.
  const fsOut = yield* FileSystem.FileSystem;
  const outPath = yield* Path.Path;
  yield* fsOut.makeDirectory(outPath.dirname(OUT_FILE), { recursive: true });
  yield* fsOut.writeFileString(OUT_FILE, `${encoded.join("\n")}\n`);
  yield* fsOut.writeFileString(DECODED_FILE, `${decoded.join("\n")}\n`);
  process.stderr.write(
    `terminal history delete trace: ${caseCount} cases (${sweepRuns.length} sweep repeats), ${rows.length} rows -> ${OUT_FILE}\n`,
  );
  process.stdout.write(`${rows.length}\n`);
});

try {
  await Effect.runPromise(
    run.pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
          Logger.layer([traceLogger], { mergeWithExisting: false }),
        ),
      ),
    ),
  );
} catch (cause) {
  process.stderr.write(
    `${cause instanceof Error ? (cause.stack ?? String(cause)) : String(cause)}\n`,
  );
  process.exitCode = 1;
}
