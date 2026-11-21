// Trace generator for terminal session STATE and INACTIVE-SESSION RETENTION. It drives the shipped
// `TerminalManager` (real code, not a reimplementation) and records, in one chronological stream per
// case, every published `TerminalEvent`, every snapshot the Manager returns, every call boundary, and
// every full metadata view the Manager hands to `subscribeMetadata` — which is the sessions map, so
// it is the only external observation of eviction.
//
// Nothing here waits on a sleep or a poll loop: exits are received as receipts on the event queue.
// The Manager's `updatedAt` stamps are the one input this harness cannot inject through its options,
// so it drives `Date.now` instead (see the clock block below): stamps are recorded as `t1..tn` labels
// by sorting them after the case, and `no-stamp-ties` / `clock-freeze-ties-stamps` is the claim that
// says which clock a case ran under.
//
// Read-only probe: scoped temp directories only, no live install, no dev server, no source edits.
//
// Run from the repository root:
//   node apps/server/scripts/terminal-exit-retention-trace.ts [outFile]
// Writes the trace to <outFile> and a decoded copy to the same path with `.txt` replaced by
// `-decoded.txt`.
//
// ---------------------------------------------------------------------------
// Record grammar. Tab separated, one record per line; field 1 is the record code. Data-derived
// strings (thread ids, statuses, messages) are UTF-8 hex so a tab or newline cannot corrupt a row;
// "-" means absent. `seq` is a single global counter that never resets, so rows from different
// sources interleave in real order.
//   H  defaultTerminalIdHex                         harness constants, once
//   Q  noteHex                                      measurement note (explicit, never a guess)
//   F  shapeHex                                     DateTime.formatIso shape with every digit masked
//   K  leftHex rightHex localeRaw ordinalRaw agreeRaw
//                                                      one comparator probe: sign of
//                                                      `String.prototype.localeCompare` versus sign of
//                                                      code-unit ordering, and whether they agree. The
//                                                      Manager sorts ids and stamps with localeCompare.
//   C  name cap clock threadsHex spawnFailRaw      case header
//   B  seq kind raw id raw statusHex                Manager call boundary (issue / return); status is
//                                                      "-" at issue, else "ok" or the error _tag
//   S  seq kind raw id raw statusHex pidRaw sequenceRaw exitHex signalHex historyHex
//                                                      a snapshot the Manager returned from open or
//                                                      restart, sorted directly after its B return row
//   O  seq typeHex terminalIdHex eventSeqRaw validRaw exitHex signalHex messageHex
//                                                      a published TerminalEvent
//   T  seq obsRaw indexRaw threadHex terminalIdHex statusHex pidRaw exitHex signalHex stampRaw labelHex
//                                                      one entry of one metadata view, in the order the
//                                                      Manager itself sorted it; `obs` numbers the views
//                                                      of a case and `index` the position inside a view
//   A  claim match|diff detailHex                   one measured answer to a question; "diff" marks an
//                                                      observation that contradicts the expectation, it
//                                                      never aborts the run
//   X  name                                         case terminator
//   Z  caseCount viewCount end                      global terminator
// ---------------------------------------------------------------------------

import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_TERMINAL_ID, TerminalEvent } from "@lmcstools/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../src/processRunner.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";
import * as PtyAdapter from "../src/terminal/PtyAdapter.ts";

const isTerminalEvent = Schema.is(TerminalEvent);

const OUT_FILE =
  process.argv[2] ??
  "/Users/leandroadasilva/.cache/lmcs-port-traces/terminal-exit-retention-trace.txt";
const DECODED_FILE = OUT_FILE.replace(/\.txt$/, "-decoded.txt");

// Bisect helpers for the harness itself: LMCS_RETENTION_ONLY=case-a,case-b runs a subset, and
// LMCS_RETENTION_STEPS=1 prints each step before it runs. Neither changes what is written.
const caseFilter = process.env["LMCS_RETENTION_ONLY"]?.split(",");
const stepTrace = process.env["LMCS_RETENTION_STEPS"] === "1";

// Every Manager mutation stamps `updatedAt` from the wall clock (`nowIso` at Manager.ts:104 and the
// direct `DateTime.nowUnsafe()` at :438), and retention orders inactive sessions by that stamp. With
// a real clock the stamps collide inside one millisecond, so which session survives eviction becomes
// clock luck: measured on this harness, three synchronous exits produced 3 distinct stamps over 6
// readings and the survivor changed between runs. The harness therefore owns `Date.now`: both stamp
// paths read it (`Internal.now` goes through the default Clock, which calls `Date.now()` per read),
// each call advances a fixed epoch by one millisecond so stamps are strictly ordered, and a case may
// freeze the advance to measure the tie-break rule the Manager falls back to. Ordering of events,
// sequences and file writes is untouched; the trace records stamp *order* as labels, never values.
const EPOCH = 1_770_000_000_000;
let clockMillis = EPOCH;
let clockAdvance = 1;
Date.now = () => {
  clockMillis += clockAdvance;
  return clockMillis;
};

// ---------------------------------------------------------------------------
// Record encoding
// ---------------------------------------------------------------------------

type Field =
  | { readonly kind: "raw"; readonly value: string | number }
  | { readonly kind: "hex"; readonly value: string };

const raw = (value: string | number): Field => ({ kind: "raw", value });
const hexOf = (value: string): Field => ({ kind: "hex", value });
const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");

interface Row {
  readonly code: string;
  readonly fields: ReadonlyArray<Field>;
}

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

let globalSeq = 0;
const nextSeq = () => {
  globalSeq += 1;
  return globalSeq;
};

// The Manager writes every value the trace reads as either a number, a status literal or null, so
// this renders all of them without JSON.stringify (the repository lint forbids it in scripts).
const value = (input: unknown): string => {
  if (input === null || input === undefined) return "-";
  if (typeof input === "number") return Number.isFinite(input) ? String(input) : "nonfinite";
  if (typeof input === "string") return ident(input);
  if (typeof input === "boolean") return input ? "1" : "0";
  return "opaque";
};

const text = (input: unknown): string => {
  if (typeof input === "string") return input;
  return "<nonstring>";
};

// ---------------------------------------------------------------------------
// Fake PTY: no real process, no timers beyond the persist debounce the write latch absorbs. The
// exit callback is stored so a case can hand the Manager an exit with any exitCode/signal it wants,
// including values node-pty itself cannot produce.
// ---------------------------------------------------------------------------

class TracePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid: number;
  private dataCallback: ((data: string) => void) | null = null;
  private exitCallback: ((event: PtyAdapter.PtyExitEvent) => void) | null = null;
  writes = 0;
  kills = 0;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(): void {
    this.writes += 1;
  }

  resize(): void {}

  kill(): void {
    this.kills += 1;
  }

  onData(callback: (data: string) => void): () => void {
    this.dataCallback = callback;
    return () => {
      this.dataCallback = null;
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitCallback = callback;
    return () => {
      this.exitCallback = null;
    };
  }

  emitOutput(data: string): void {
    NodeAssert.ok(this.dataCallback !== null, `pty ${this.pid}: output handler was unsubscribed`);
    this.dataCallback(data);
  }

  emitExit(exitCode: number, signal: number | null): void {
    NodeAssert.ok(this.exitCallback !== null, `pty ${this.pid}: exit handler was unsubscribed`);
    this.exitCallback({ exitCode, signal });
  }
}

class TracePtyAdapter {
  readonly processes: TracePtyProcess[] = [];
  failSpawn = false;
  private nextPid = 7400;

  spawn(): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    if (this.failSpawn) {
      return Effect.fail(
        new PtyAdapter.PtySpawnError({ adapter: "trace", shell: "/bin/sh", attemptedShells: [] }),
      );
    }
    const process = new TracePtyProcess(this.nextPid);
    this.nextPid += 1;
    this.processes.push(process);
    return Effect.succeed(process);
  }

  live(index: number): TracePtyProcess {
    const process = this.processes[index];
    NodeAssert.ok(process !== undefined, `no pty at spawn index ${index}`);
    return process;
  }
}

const errorTag = (cause: unknown): string => {
  if (cause !== null && typeof cause === "object" && "_tag" in cause) {
    return String((cause as { _tag: unknown })._tag);
  }
  return "unknown";
};

// ---------------------------------------------------------------------------
// Case model
// ---------------------------------------------------------------------------

type Step =
  | { readonly kind: "observe"; readonly note: string }
  | { readonly kind: "open"; readonly id: string; readonly thread: number; readonly term: string }
  | {
      readonly kind: "restart";
      readonly id: string;
      readonly thread: number;
      readonly term: string;
    }
  | { readonly kind: "emit"; readonly spawn: number; readonly data: string }
  | {
      readonly kind: "exit";
      readonly spawn: number;
      readonly code: number;
      readonly signal: number | null;
    }
  | { readonly kind: "awaitEvent"; readonly type: string }
  | { readonly kind: "write"; readonly thread: number; readonly term: string }
  | { readonly kind: "clear"; readonly id: string; readonly thread: number; readonly term: string }
  | {
      readonly kind: "close";
      readonly id: string;
      readonly thread: number;
      readonly term?: string;
      readonly del?: boolean;
    }
  | { readonly kind: "failSpawn"; readonly on: boolean };

interface CaseSpec {
  readonly name: string;
  readonly cap: number;
  readonly threads: ReadonlyArray<string>;
  readonly failSpawn: boolean;
  /** `step` advances the fake epoch per clock read; `frozen` pins every stamp to one value. */
  readonly clock?: "step" | "frozen";
  readonly steps: ReadonlyArray<Step>;
  readonly claims: ReadonlyArray<string>;
}

// Ids are chosen so that code-unit order and chronological order agree wherever a case does not
// deliberately invert them. `cap-reversed-ids` inverts them with a stepping clock, so retention must
// follow chronology, and `cap-tie-break` inverts them with every stamp pinned, so retention has to
// fall back to ids. Together the two cases separate "keeps the newest inactive sessions" from "keeps
// the lexicographically greatest".
const THREAD_A = "thread-a";
const THREAD_B = "thread-b";

const caseSpecs: ReadonlyArray<CaseSpec> = [
  {
    name: "exit-basic",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "observe", note: "empty" },
      { kind: "open", id: "open-1", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "emit", spawn: 0, data: "hello\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "observe", note: "running" },
      { kind: "exit", spawn: 0, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "observe", note: "after-exit" },
      { kind: "clear", id: "clear-1", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "observe", note: "after-clear" },
    ],
    claims: ["exit-keeps-session", "exit-clears-pid", "exit-advances-sequence", "clear-after-exit"],
  },
  {
    name: "exit-code-nan",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "exit", spawn: 0, code: Number.NaN, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "observe", note: "after-exit" },
    ],
    claims: ["noninteger-code-becomes-null"],
  },
  {
    name: "exit-code-fraction",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "exit", spawn: 0, code: 1.5, signal: 2.5 },
      { kind: "awaitEvent", type: "exited" },
      { kind: "observe", note: "after-exit" },
    ],
    claims: ["noninteger-signal-becomes-null"],
  },
  {
    name: "exit-signal-thirteen",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "exit", spawn: 0, code: 0, signal: 13 },
      { kind: "awaitEvent", type: "exited" },
      { kind: "observe", note: "after-exit" },
    ],
    claims: ["integer-signal-survives"],
  },
  {
    name: "write-after-exit",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "exit", spawn: 0, code: 3, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "write", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "observe", note: "after-write" },
    ],
    claims: ["write-to-exited-is-silent", "write-to-exited-reaches-pty"],
  },
  {
    name: "cap-reversed-ids",
    cap: 1,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-3", thread: 0, term: "term-3" },
      { kind: "exit", spawn: 0, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "open", id: "open-2", thread: 0, term: "term-2" },
      { kind: "exit", spawn: 1, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "observe", note: "two-exited" },
      { kind: "open", id: "open-1", thread: 0, term: "term-1" },
      { kind: "exit", spawn: 2, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "observe", note: "after-third-exit" },
      { kind: "clear", id: "clear-3", thread: 0, term: "term-3" },
      { kind: "clear", id: "clear-2", thread: 0, term: "term-2" },
      { kind: "clear", id: "clear-1", thread: 0, term: "term-1" },
      { kind: "observe", note: "final" },
    ],
    claims: ["newest-inactive-survives", "evicted-session-is-gone", "cap-one-holds"],
  },
  {
    // The same schedule with the clock pinned: every stamp is one value, so the ordering rule has to
    // fall back to threadId and terminalId. This is the case that shows what a real millisecond tie
    // does to retention, and it keeps the opposite id from the case above.
    name: "cap-tie-break",
    cap: 1,
    clock: "frozen",
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: "term-1" },
      { kind: "exit", spawn: 0, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "open", id: "open-2", thread: 0, term: "term-2" },
      { kind: "exit", spawn: 1, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "open", id: "open-3", thread: 0, term: "term-3" },
      { kind: "exit", spawn: 2, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "observe", note: "after-third-exit" },
      { kind: "clear", id: "clear-1", thread: 0, term: "term-1" },
      { kind: "clear", id: "clear-2", thread: 0, term: "term-2" },
      { kind: "clear", id: "clear-3", thread: 0, term: "term-3" },
      { kind: "observe", note: "final" },
    ],
    claims: [
      "tie-break-keeps-greatest-id",
      "tie-break-evicts-lesser-ids",
      "clock-freeze-ties-stamps",
    ],
  },
  {
    name: "cap-protects-running",
    cap: 1,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: "term-1" },
      { kind: "open", id: "open-2", thread: 0, term: "term-2" },
      { kind: "exit", spawn: 0, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "open", id: "open-3", thread: 0, term: "term-3" },
      { kind: "exit", spawn: 2, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "observe", note: "final" },
    ],
    claims: ["running-never-evicted", "newest-exited-survives"],
  },
  {
    name: "cap-zero-open",
    cap: 0,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "observe", note: "after-open" },
      { kind: "write", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "clear", id: "clear-1", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "observe", note: "final" },
    ],
    claims: [
      "starting-counts-inactive",
      "self-evicted-open-still-publishes",
      "evicted-write-fails",
    ],
  },
  {
    name: "cap-across-threads",
    cap: 2,
    threads: [THREAD_A, THREAD_B],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-a1", thread: 0, term: "term-1" },
      { kind: "open", id: "open-b1", thread: 1, term: "term-1" },
      { kind: "exit", spawn: 0, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "open", id: "open-a2", thread: 0, term: "term-2" },
      { kind: "exit", spawn: 1, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "exit", spawn: 2, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "observe", note: "final" },
    ],
    claims: ["cap-counts-across-threads", "newest-two-survive"],
  },
  {
    name: "close-after-exit",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "exit", spawn: 0, code: 7, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "open", id: "open-2", thread: 0, term: "term-2" },
      { kind: "close", id: "close-1", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "observe", note: "after-close" },
    ],
    claims: ["closed-sequence-follows-exit", "close-of-exited-keeps-other-inactive"],
  },
  {
    // Retention dropped the session before the client closed it, which is what a user closing a tab
    // of a long-dead terminal does. The Manager must treat it as done, not as a failed close.
    name: "close-after-eviction",
    cap: 1,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "exit", spawn: 0, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "open", id: "open-2", thread: 0, term: "term-2" },
      { kind: "close", id: "close-1", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "observe", note: "after-close" },
      { kind: "close", id: "close-2", thread: 0, term: "term-2" },
      { kind: "observe", note: "final" },
    ],
    claims: [
      "close-of-evicted-publishes-nothing",
      "close-of-evicted-succeeds",
      "close-of-live-publishes",
    ],
  },
  {
    name: "restart-after-exit",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "emit", spawn: 0, data: "keep-me\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "exit", spawn: 0, code: 2, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "restart", id: "restart-1", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "awaitEvent", type: "restarted" },
      { kind: "observe", note: "after-restart" },
    ],
    claims: ["restart-after-exit-runs", "restart-clears-history", "restart-keeps-sequence"],
  },
  {
    name: "spawn-fails",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: true,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "observe", note: "after-error" },
      { kind: "write", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "clear", id: "clear-1", thread: 0, term: DEFAULT_TERMINAL_ID },
      { kind: "observe", note: "final" },
    ],
    claims: ["failed-open-returns-snapshot", "error-counts-inactive", "error-status-write-fails"],
  },
];

NodeAssert.equal(
  new Set(caseSpecs.map((spec) => spec.name)).size,
  caseSpecs.length,
  "duplicate case names",
);
NodeAssert.ok(
  caseSpecs.every((spec) => spec.threads.length > 0),
  "every case needs at least one thread",
);

// ---------------------------------------------------------------------------
// Observation model
// ---------------------------------------------------------------------------

interface ObsBoundary {
  readonly seq: number;
  readonly kind: string;
  readonly id: string;
  readonly status: string;
}

interface ObsEvent {
  readonly seq: number;
  readonly type: string;
  readonly terminalId: string;
  readonly eventSeq: number;
  readonly valid: boolean;
  readonly exitCode: string;
  readonly exitSignal: string;
  readonly message: string;
}

interface ObsSnapshot {
  readonly seq: number;
  readonly kind: string;
  readonly id: string;
  readonly status: string;
  readonly pid: string;
  readonly sequence: string;
  readonly exitCode: string;
  readonly exitSignal: string;
  readonly history: string;
}

interface ObsTerminal {
  readonly seq: number;
  readonly obs: number;
  readonly index: number;
  readonly threadId: string;
  readonly terminalId: string;
  readonly status: string;
  readonly pid: string;
  readonly exitCode: string;
  readonly exitSignal: string;
  readonly stamp: string;
}

interface CaseResult {
  readonly name: string;
  readonly cap: number;
  readonly clock: "step" | "frozen";
  readonly threads: ReadonlyArray<string>;
  readonly failSpawn: boolean;
  readonly claims: ReadonlyArray<string>;
  readonly boundaries: ReadonlyArray<ObsBoundary>;
  readonly events: ReadonlyArray<ObsEvent>;
  readonly snapshots: ReadonlyArray<ObsSnapshot>;
  readonly terminals: ReadonlyArray<ObsTerminal>;
  readonly stamps: ReadonlyArray<string>;
  readonly mutationStamps: ReadonlyArray<string>;
  readonly writeCount: number;
  readonly killCount: number;
}

const runCase = Effect.fnUntraced(function* (spec: CaseSpec) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  clockAdvance = spec.clock === "frozen" ? 0 : 1;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: `lmcs-retention-${spec.name}-` });
  const logsDir = path.join(baseDir, "userdata", "logs", "terminals");
  const cwd = path.join(baseDir, "cwd");
  yield* fs.makeDirectory(cwd, { recursive: true });

  const boundaries: ObsBoundary[] = [];
  const events: ObsEvent[] = [];
  const snapshots: ObsSnapshot[] = [];
  const terminals: ObsTerminal[] = [];
  const stamps: string[] = [];
  const mutationStamps: string[] = [];
  let observations = 0;

  const adapter = new TracePtyAdapter();
  adapter.failSpawn = spec.failSpawn;

  const eventSignals = yield* Effect.acquireRelease(Queue.unbounded<void>(), Queue.shutdown);
  const manager = yield* TerminalManager.makeWithOptions({
    logsDir,
    historyLineLimit: 8,
    historyByteLimit: 1024,
    ptyAdapter: adapter as unknown as PtyAdapter.PtyAdapter["Service"],
    env: {},
    shellResolver: () => "/bin/sh",
    subprocessInspector: () =>
      Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
    processKillGraceMs: 0,
    maxRetainedInactiveSessions: spec.cap,
  });

  const unsubscribe = yield* manager.subscribe((event) =>
    Effect.gen(function* () {
      const record = event as unknown as Record<string, unknown>;
      // `started`, `exited` and `restarted` carry the snapshot the Manager just stamped, so this is one
      // reading per mutation instead of one per observation of a session.
      const carried = record.snapshot as Record<string, unknown> | undefined;
      if (carried !== undefined && typeof carried.updatedAt === "string") {
        mutationStamps.push(carried.updatedAt);
      }
      events.push({
        seq: nextSeq(),
        type: event.type,
        terminalId: text(record.terminalId),
        eventSeq: typeof record.sequence === "number" ? record.sequence : -1,
        valid: isTerminalEvent(event),
        exitCode: value(record.exitCode),
        exitSignal: value(record.exitSignal),
        message: typeof record.message === "string" ? record.message : "-",
      });
      yield* Queue.offer(eventSignals, undefined);
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe()));

  let eventCursor = 0;
  const awaitEvent = Effect.fnUntraced(function* (type: string) {
    while (eventCursor >= events.length) {
      yield* Queue.take(eventSignals);
    }
    NodeAssert.equal(events[eventCursor]?.type, type, `${spec.name}: expected ${type} event`);
    eventCursor += 1;
  });

  const recordSnapshot = (kind: string, id: string, snapshot: Record<string, unknown>) => {
    const stamp = typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : "-";
    if (stamp !== "-") stamps.push(stamp);
    snapshots.push({
      seq: nextSeq(),
      kind,
      id,
      status: text(snapshot.status),
      pid: value(snapshot.pid),
      sequence: value(snapshot.sequence),
      exitCode: value(snapshot.exitCode),
      exitSignal: value(snapshot.exitSignal),
      history: text(snapshot.history),
    });
  };

  // The metadata view is the sessions map, in the order the Manager sorts it for the UI. Reading it
  // is what makes eviction observable from outside the module.
  const observe = Effect.fnUntraced(function* (note: string) {
    observations += 1;
    const obs = observations;
    const collected: Array<Record<string, unknown>> = [];
    const detach = yield* manager.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type !== "snapshot") return;
        for (const terminal of event.terminals as ReadonlyArray<Record<string, unknown>>) {
          collected.push(terminal);
        }
      }),
    );
    detach();
    // The boundary row is issued first so the view count sorts ahead of the entries it counts.
    const viewSeq = nextSeq();
    collected.forEach((terminal) => {
      const stamp = typeof terminal.updatedAt === "string" ? terminal.updatedAt : "-";
      if (stamp !== "-") stamps.push(stamp);
      terminals.push({
        seq: nextSeq(),
        obs,
        index: terminals.filter((entry) => entry.obs === obs).length,
        threadId: text(terminal.threadId),
        terminalId: text(terminal.terminalId),
        status: text(terminal.status),
        pid: value(terminal.pid),
        exitCode: value(terminal.exitCode),
        exitSignal: value(terminal.exitSignal),
        stamp,
      });
    });
    boundaries.push({
      seq: viewSeq,
      kind: "observe",
      id: ident(note),
      status: value(collected.length),
    });
  });

  const call = Effect.fnUntraced(function* (
    kind: string,
    id: string,
    body: Effect.Effect<unknown, unknown>,
  ) {
    boundaries.push({ seq: nextSeq(), kind, id, status: "-" });
    const result = yield* Effect.result(body);
    boundaries.push({
      seq: nextSeq(),
      kind,
      id,
      status: result._tag === "Success" ? "ok" : `err:${errorTag(result.failure)}`,
    });
    return result;
  });

  const threadOf = (index: number) => {
    const thread = spec.threads[index];
    NodeAssert.ok(thread !== undefined, `${spec.name}: no thread at index ${index}`);
    return thread;
  };

  for (const step of spec.steps) {
    if (stepTrace) {
      // The repository lint forbids JSON.stringify, so the step is described by hand.
      const detail =
        step.kind === "observe"
          ? step.note
          : step.kind === "emit" || step.kind === "exit"
            ? `spawn-${step.spawn}`
            : "id" in step
              ? step.id
              : step.term;
      process.stderr.write(`  ${spec.name}: ${step.kind} ${detail}\n`);
    }
    switch (step.kind) {
      case "observe": {
        yield* observe(step.note);
        break;
      }
      case "open": {
        const result = yield* call(
          "open",
          ident(step.id),
          manager.open({
            threadId: threadOf(step.thread),
            terminalId: step.term,
            cwd,
            cols: 100,
            rows: 24,
          }),
        );
        if (result._tag === "Success") {
          recordSnapshot(
            "open",
            ident(step.id),
            result.success as unknown as Record<string, unknown>,
          );
        }
        yield* awaitEvent(spec.failSpawn ? "error" : "started");
        break;
      }
      case "restart": {
        const result = yield* call(
          "restart",
          ident(step.id),
          manager.restart({
            threadId: threadOf(step.thread),
            terminalId: step.term,
            cwd,
            cols: 120,
            rows: 30,
          }),
        );
        if (result._tag === "Success") {
          recordSnapshot(
            "restart",
            ident(step.id),
            result.success as unknown as Record<string, unknown>,
          );
        }
        break;
      }
      case "emit": {
        boundaries.push({ seq: nextSeq(), kind: "emit", id: raw0(step.spawn), status: "-" });
        adapter.live(step.spawn).emitOutput(step.data);
        break;
      }
      case "exit": {
        boundaries.push({ seq: nextSeq(), kind: "exit", id: raw0(step.spawn), status: "-" });
        adapter.live(step.spawn).emitExit(step.code, step.signal);
        break;
      }
      case "awaitEvent": {
        yield* awaitEvent(step.type);
        break;
      }
      case "write": {
        yield* call(
          "write",
          writeId(step.term),
          manager.write({ threadId: threadOf(step.thread), terminalId: step.term, data: "x" }),
        );
        break;
      }
      case "clear": {
        // clear publishes inside the awaited call, so no event receipt is needed here, and one
        // would hang for an evicted session, which publishes nothing.
        yield* call(
          "clear",
          ident(step.id),
          manager.clear({ threadId: threadOf(step.thread), terminalId: step.term }),
        );
        break;
      }
      case "close": {
        yield* call(
          "close",
          ident(step.id),
          manager.close({
            threadId: threadOf(step.thread),
            ...(step.term === undefined ? {} : { terminalId: step.term }),
            ...(step.del === undefined ? {} : { deleteHistory: step.del }),
          }),
        );
        break;
      }
      case "failSpawn": {
        adapter.failSpawn = step.on;
        break;
      }
    }
  }

  const processes = adapter.processes;
  return {
    name: spec.name,
    cap: spec.cap,
    clock: spec.clock ?? "step",
    threads: spec.threads,
    failSpawn: spec.failSpawn,
    claims: spec.claims,
    boundaries,
    events,
    snapshots,
    terminals,
    stamps,
    mutationStamps,
    writeCount: processes.reduce((total, process) => total + process.writes, 0),
    killCount: processes.reduce((total, process) => total + process.kills, 0),
  } satisfies CaseResult;
});

const raw0 = (value: number) => `spawn-${value}`;
const writeId = (terminalId: string) => `write-${ident(terminalId)}`;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

// Stamps are sorted after the case and mapped to t1..tn, so the trace records the Manager's ordering
// without recording wall-clock text that would differ on every run.
const stampLabels = (result: CaseResult): Map<string, string> => {
  const distinct = [...new Set(result.stamps)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return new Map(distinct.map((stamp, index) => [stamp, `t${index + 1}`]));
};

const timedRows = (result: CaseResult): Row[] => {
  const label = stampLabels(result);
  const rows: Array<{ seq: number; row: Row }> = [];
  for (const boundary of result.boundaries) {
    rows.push({
      seq: boundary.seq,
      row: {
        code: "B",
        fields: [raw(boundary.seq), raw(boundary.kind), raw(boundary.id), hexOf(boundary.status)],
      },
    });
  }
  for (const snapshot of result.snapshots) {
    rows.push({
      seq: snapshot.seq,
      row: {
        code: "S",
        fields: [
          raw(snapshot.seq),
          raw(snapshot.kind),
          raw(snapshot.id),
          hexOf(snapshot.status),
          raw(snapshot.pid),
          raw(snapshot.sequence),
          raw(snapshot.exitCode),
          raw(snapshot.exitSignal),
          hexOf(snapshot.history),
        ],
      },
    });
  }
  for (const event of result.events) {
    rows.push({
      seq: event.seq,
      row: {
        code: "O",
        fields: [
          raw(event.seq),
          hexOf(event.type),
          hexOf(event.terminalId),
          raw(event.eventSeq),
          raw(event.valid ? 1 : 0),
          raw(event.exitCode),
          raw(event.exitSignal),
          hexOf(event.message),
        ],
      },
    });
  }
  for (const terminal of result.terminals) {
    rows.push({
      seq: terminal.seq,
      row: {
        code: "T",
        fields: [
          raw(terminal.seq),
          raw(terminal.obs),
          raw(terminal.index),
          hexOf(terminal.threadId),
          hexOf(terminal.terminalId),
          hexOf(terminal.status),
          raw(terminal.pid),
          raw(terminal.exitCode),
          raw(terminal.exitSignal),
          raw(label.get(terminal.stamp) ?? "-"),
        ],
      },
    });
  }
  rows.sort(
    (left, right) =>
      left.seq - right.seq ||
      (left.kind === "observe" ? -1 : 1) - (right.kind === "observe" ? -1 : 1) ||
      left.row.code.localeCompare(right.row.code),
  );
  return rows.map((entry) => entry.row);
};

const claimRows = (claims: ReadonlyArray<[string, boolean, string]>): Row[] =>
  claims.map(([id, ok, detail]): Row => ({
    code: "A",
    fields: [hexOf(id), raw(ok ? "match" : "diff"), hexOf(detail)],
  }));

const showTerminals = (result: CaseResult, obs: number): string => {
  const label = stampLabels(result);
  return result.terminals
    .filter((terminal) => terminal.obs === obs)
    .map(
      (terminal) =>
        `${terminal.threadId}/${terminal.terminalId}:${terminal.status}:${terminal.pid}:${terminal.exitCode}/${terminal.exitSignal}:${label.get(terminal.stamp) ?? "-"}`,
    )
    .join(",");
};

const lastObs = (result: CaseResult): number =>
  result.terminals.reduce((max, terminal) => Math.max(max, terminal.obs), 0);

const viewCount = (result: CaseResult, obs: number): number =>
  result.terminals.filter((terminal) => terminal.obs === obs).length;

const viewOf = (result: CaseResult, obs: number): ReadonlyArray<ObsTerminal> =>
  result.terminals.filter((terminal) => terminal.obs === obs);

const boundary = (result: CaseResult, kind: string, id: string, phase: "issue" | "return") =>
  result.boundaries.filter((entry) => entry.kind === kind && entry.id === id)[
    phase === "issue" ? 0 : 1
  ];

const eventOf = (result: CaseResult, type: string) =>
  result.events.filter((event) => event.type === type);

const snapshotOf = (result: CaseResult, id: string) =>
  result.snapshots.find((snapshot) => snapshot.id === id);

const evaluateClaims = (result: CaseResult): Array<[string, boolean, string]> => {
  const claims: Array<[string, boolean, string]> = [];
  const add = (id: string, ok: boolean, detail: string) => claims.push([ident(id), ok, detail]);
  const wanted = new Set(result.claims);
  const final = lastObs(result);

  add(
    "all-events-schema-valid",
    result.events.every((event) => event.valid),
    `${result.events.length} events: ${result.events.map((event) => event.type).join(",")}`,
  );
  // A session reappears in several views, so `stamps` counts the same mutation many times. The claim
  // is about the clock: every mutation must get its own, later, stamp.
  const mutations = result.mutationStamps;
  const distinctMutations = new Set(mutations).size;
  const increasing = mutations.every(
    (stamp, index) => index === 0 || mutations[index - 1]! < stamp,
  );
  if (result.clock === "frozen") {
    add(
      "clock-freeze-ties-stamps",
      distinctMutations === 1,
      `${distinctMutations} distinct of ${mutations.length} mutations`,
    );
  } else {
    add(
      "stamps-advance-per-mutation",
      distinctMutations === mutations.length && increasing,
      `${distinctMutations} distinct of ${mutations.length} mutations`,
    );
  }

  switch (result.name) {
    case "exit-basic": {
      const exited = eventOf(result, "exited")[0];
      const output = eventOf(result, "output")[0];
      const view = viewOf(result, 3);
      add(
        "exit-keeps-session",
        view.length === 1 && view[0]?.status === "exited",
        showTerminals(result, 3),
      );
      add("exit-clears-pid", view[0]?.pid === "-", `pid ${view[0]?.pid ?? "missing"}`);
      add(
        "exit-advances-sequence",
        output !== undefined && exited !== undefined && exited.eventSeq === output.eventSeq + 1,
        `output ${output?.eventSeq ?? "?"} exit ${exited?.eventSeq ?? "?"}`,
      );
      const clearReturn = boundary(result, "clear", "clear-1", "return");
      add(
        "clear-after-exit",
        clearReturn?.status === "ok",
        `${clearReturn?.status ?? "missing"} cleared=${eventOf(result, "cleared").length}`,
      );
      break;
    }
    case "exit-code-nan": {
      const exited = eventOf(result, "exited")[0];
      const view = viewOf(result, 1)[0];
      add(
        "noninteger-code-becomes-null",
        exited?.exitCode === "-" && view?.exitCode === "-",
        `event=${exited?.exitCode ?? "?"} view=${view?.exitCode ?? "-"}`,
      );
      break;
    }
    case "exit-code-fraction": {
      const exited = eventOf(result, "exited")[0];
      const view = viewOf(result, 1)[0];
      add(
        "noninteger-signal-becomes-null",
        exited?.exitCode === "-" &&
          exited?.exitSignal === "-" &&
          view?.exitCode === "-" &&
          view?.exitSignal === "-",
        `event=${exited?.exitCode ?? "?"}/${exited?.exitSignal ?? "?"} view=${view?.exitCode ?? "-"}/${view?.exitSignal ?? "-"}`,
      );
      break;
    }
    case "exit-signal-thirteen": {
      const exited = eventOf(result, "exited")[0];
      const view = viewOf(result, 1)[0];
      add(
        "integer-signal-survives",
        exited?.exitSignal === "13" && exited?.exitCode === "0" && view?.exitSignal === "13",
        `event=${exited?.exitCode ?? "?"}/${exited?.exitSignal ?? "?"} view=${view?.exitCode ?? "-"}/${view?.exitSignal ?? "-"}`,
      );
      break;
    }
    case "write-after-exit": {
      const writeReturn = boundary(result, "write", writeId(DEFAULT_TERMINAL_ID), "return");
      add(
        "write-to-exited-is-silent",
        writeReturn?.status === "ok" && eventOf(result, "output").length === 0,
        `write=${writeReturn?.status ?? "missing"} outputs=${eventOf(result, "output").length}`,
      );
      add(
        "write-to-exited-reaches-pty",
        result.writeCount === 0,
        `pty writes=${result.writeCount}`,
      );
      break;
    }
    case "cap-reversed-ids": {
      const survivors = viewOf(result, final).map((terminal) => terminal.terminalId);
      add(
        "newest-inactive-survives",
        survivors.length === 1 && survivors[0] === "term-1",
        `survivors=[${survivors.join(",")}] cap=${result.cap}`,
      );
      const gone = boundary(result, "clear", "clear-3", "return");
      const held = boundary(result, "clear", "clear-1", "return");
      add(
        "evicted-session-is-gone",
        gone?.status === "err:TerminalSessionLookupError" && held?.status === "ok",
        `term-3=${gone?.status ?? "missing"} term-1=${held?.status ?? "missing"}`,
      );
      add(
        "cap-one-holds",
        viewCount(result, 1) === 1 && viewCount(result, 2) === 1,
        `two-exited=${viewCount(result, 1)} after-third=${viewCount(result, 2)}`,
      );
      break;
    }
    case "cap-tie-break": {
      const survivors = viewOf(result, final).map((terminal) => terminal.terminalId);
      add(
        "tie-break-keeps-greatest-id",
        survivors.length === 1 && survivors[0] === "term-3",
        `survivors=[${survivors.join(",")}] cap=${result.cap} clock=${result.clock}`,
      );
      const first = boundary(result, "clear", "clear-1", "return");
      const second = boundary(result, "clear", "clear-2", "return");
      const third = boundary(result, "clear", "clear-3", "return");
      add(
        "tie-break-evicts-lesser-ids",
        first?.status === "err:TerminalSessionLookupError" &&
          second?.status === "err:TerminalSessionLookupError" &&
          third?.status === "ok",
        `term-1=${first?.status ?? "missing"} term-2=${second?.status ?? "missing"} term-3=${third?.status ?? "missing"}`,
      );
      break;
    }
    case "cap-protects-running": {
      const rows = viewOf(result, final);
      const running = rows.filter((terminal) => terminal.status === "running");
      const exited = rows.filter((terminal) => terminal.status === "exited");
      add(
        "running-never-evicted",
        running.length === 1 && running[0]?.terminalId === "term-2",
        `running=[${running.map((terminal) => terminal.terminalId).join(",")}] rows=${showTerminals(result, final)}`,
      );
      add(
        "newest-exited-survives",
        exited.length === 1 && exited[0]?.terminalId === "term-3",
        `exited=[${exited.map((terminal) => terminal.terminalId).join(",")}]`,
      );
      break;
    }
    case "cap-zero-open": {
      const started = eventOf(result, "started")[0];
      const openReturn = boundary(result, "open", "open-1", "return");
      add(
        "starting-counts-inactive",
        viewCount(result, 1) === 0,
        `after-open=${viewCount(result, 1)} startedEvents=${started ? 1 : 0}`,
      );
      add(
        "self-evicted-open-still-publishes",
        started !== undefined && openReturn?.status === "ok",
        `open=${openReturn?.status ?? "missing"} startedSeq=${started?.eventSeq ?? "?"}`,
      );
      const writeReturn = boundary(result, "write", writeId(DEFAULT_TERMINAL_ID), "return");
      add(
        "evicted-write-fails",
        writeReturn?.status === "err:TerminalSessionLookupError",
        `write=${writeReturn?.status ?? "missing"}`,
      );
      break;
    }
    case "cap-across-threads": {
      const rows = viewOf(result, final);
      add("cap-counts-across-threads", rows.length === 2, `view=${showTerminals(result, final)}`);
      add(
        "newest-two-survive",
        rows.map((terminal) => `${terminal.threadId}/${terminal.terminalId}`).join(",") ===
          `${THREAD_A}/term-2,${THREAD_B}/term-1`,
        `order=${rows.map((terminal) => `${terminal.threadId}/${terminal.terminalId}@${terminal.stamp}`).join(",")}`,
      );
      break;
    }
    case "close-after-exit": {
      const exited = eventOf(result, "exited")[0];
      const closed = eventOf(result, "closed")[0];
      add(
        "closed-sequence-follows-exit",
        exited !== undefined && closed !== undefined && closed.eventSeq === exited.eventSeq + 1,
        `exited=${exited?.eventSeq ?? "?"} closed=${closed?.eventSeq ?? "?"}`,
      );
      const rows = viewOf(result, final);
      add(
        "close-of-exited-keeps-other-inactive",
        rows.length === 1 && rows[0]?.terminalId === "term-2",
        `view=${showTerminals(result, final)} kills=${result.killCount}`,
      );
      break;
    }
    case "close-after-eviction": {
      const closed = eventOf(result, "closed");
      add(
        "close-of-evicted-publishes-nothing",
        closed.length === 1 && closed[0]?.terminalId === "term-2",
        `closed=${closed.map((event) => event.terminalId).join(",") || "none"}`,
      );
      const evicted = boundary(result, "close", "close-1", "return");
      add(
        "close-of-evicted-succeeds",
        evicted?.status === "ok",
        `close-1=${evicted?.status ?? "missing"} view=${showTerminals(result, final)}`,
      );
      const live = boundary(result, "close", "close-2", "return");
      add(
        "close-of-live-publishes",
        live?.status === "ok" && closed.length === 1 && viewCount(result, 2) === 0,
        `close-2=${live?.status ?? "missing"} finalView=${viewCount(result, 2)}`,
      );
      break;
    }
    case "restart-after-exit": {
      const rows = viewOf(result, final);
      const restarted = eventOf(result, "restarted")[0];
      const openSnapshot = snapshotOf(result, "open-1");
      const restartSnapshot = snapshotOf(result, "restart-1");
      add(
        "restart-after-exit-runs",
        rows.length === 1 && rows[0]?.status === "running" && rows[0]?.pid !== "-",
        `view=${showTerminals(result, final)}`,
      );
      add(
        "restart-clears-history",
        restartSnapshot?.history === "" && openSnapshot?.history === "",
        `open="${openSnapshot?.history ?? "?"}" restart="${restartSnapshot?.history ?? "?"}"`,
      );
      add(
        "restart-keeps-sequence",
        restarted !== undefined && restarted.eventSeq > 2,
        `restartedSeq=${restarted?.eventSeq ?? "?"} outputs=${eventOf(result, "output").length}`,
      );
      break;
    }
    case "spawn-fails": {
      const openReturn = boundary(result, "open", "open-1", "return");
      const openSnapshot = snapshotOf(result, "open-1");
      add(
        "failed-open-returns-snapshot",
        openReturn?.status === "ok" && openSnapshot?.status === "error",
        `open=${openReturn?.status ?? "missing"} status=${openSnapshot?.status ?? "?"}`,
      );
      add(
        "error-counts-inactive",
        viewCount(result, 1) === 1 && viewOf(result, 1)[0]?.status === "error",
        `view=${showTerminals(result, 1)}`,
      );
      const writeReturn = boundary(result, "write", writeId(DEFAULT_TERMINAL_ID), "return");
      add(
        "error-status-write-fails",
        writeReturn?.status === "err:TerminalNotRunningError",
        `write=${writeReturn?.status ?? "missing"}`,
      );
      break;
    }
  }

  // Every claim the case asked for must have been answered, so a renamed case cannot silently stop
  // measuring anything.
  const answered = new Set(claims.map(([id]) => id));
  add(
    "all-claims-answered",
    [...wanted].every((claim) => answered.has(claim)),
    [...wanted].filter((claim) => !answered.has(claim)).join(",") || "none",
  );
  return claims;
};

const caseRows = (result: CaseResult): Row[] => {
  const rows: Row[] = [
    {
      code: "C",
      fields: [
        raw(result.name),
        raw(result.cap),
        raw(result.clock),
        hexOf(result.threads.join(",")),
        raw(result.failSpawn ? 1 : 0),
      ],
    },
    ...timedRows(result),
    ...claimRows(evaluateClaims(result)),
    { code: "X", fields: [raw(result.name)] },
  ];
  return rows;
};

// ---------------------------------------------------------------------------
// Comparator probes. The Manager sorts by `updatedAt.localeCompare` then `threadId.localeCompare`
// then `terminalId.localeCompare`; the port can only offer code-unit ordering. These rows measure
// where the two disagree, for exactly the shapes of id and timestamp that reach that sort.
// ---------------------------------------------------------------------------

const comparatorPairs: ReadonlyArray<[string, string]> = [
  ["term-1", "term-2"],
  ["term-1", "term-10"],
  ["term-2", "term-10"],
  ["a", "B"],
  ["A", "a"],
  ["-", "_"],
  ["thread-a", "thread-b"],
  ["x/y", "x:y"],
  ["cafe", "café"],
  ["2026-11-21T10:00:00.000Z", "2026-11-21T10:00:00.001Z"],
  ["2026-11-21T10:00:00.000Z", "2026-11-21T10:00:00.000Z"],
  ["2026-11-21T09:59:59.999Z", "2026-11-21T10:00:00.000Z"],
];

const sign = (value: number): number => (value < 0 ? -1 : value > 0 ? 1 : 0);

const comparatorRows = (): Row[] => {
  const rows: Row[] = [
    {
      code: "Q",
      fields: [
        hexOf(
          `localeCompare is locale-sensitive; Node ran it with LANG=${process.env["LANG"] ?? "unset"} ` +
            `LC_ALL=${process.env["LC_ALL"] ?? "unset"}`,
        ),
      ],
    },
  ];
  for (const [left, right] of comparatorPairs) {
    const locale = sign(left.localeCompare(right));
    const ordinal = sign(left < right ? -1 : left > right ? 1 : 0);
    rows.push({
      code: "K",
      fields: [
        hexOf(left),
        hexOf(right),
        raw(locale),
        raw(ordinal),
        raw(locale === ordinal ? 1 : 0),
      ],
    });
  }
  return rows;
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const run = Effect.gen(function* () {
  const isoSample = DateTime.formatIso(DateTime.nowUnsafe());
  const masked = isoSample.replace(/[0-9]/g, "#");
  NodeAssert.ok(!/[0-9]/.test(masked), "masked iso kept a digit");

  const header: Row[] = [
    { code: "H", fields: [hexOf(DEFAULT_TERMINAL_ID)] },
    { code: "F", fields: [hexOf(masked)] },
    {
      code: "Q",
      fields: [
        hexOf(
          `threads: 0=${THREAD_A} 1=${THREAD_B}; a metadata view is the sessions map sorted by updatedAt ` +
            `descending then threadId then terminalId; stamps are recorded as t1..tn by ascending order`,
        ),
      ],
    },
    ...comparatorRows(),
  ];

  const rows: Row[] = [...header];
  let caseCount = 0;
  let views = 0;
  for (const spec of caseSpecs) {
    if (caseFilter !== undefined && !caseFilter.includes(spec.name)) continue;
    process.stderr.write(`case ${spec.name}\n`);
    const result = yield* Effect.scoped(runCase(spec));
    caseCount += 1;
    views += lastObs(result);
    rows.push(...caseRows(result));
  }

  rows.push({ code: "Z", fields: [raw(caseCount), raw(views), raw("end")] });

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
    `terminal exit/retention trace: ${caseCount} cases, ${views} metadata views, ${rows.length} rows -> ${OUT_FILE}\n`,
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
