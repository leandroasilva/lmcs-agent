// Trace generator for the REOPEN HISTORY RESET (Manager.ts:2587 and :2598).
//
// It drives the shipped `TerminalManager` (real code, not a reimplementation) through the branch that
// runs when `open` finds a record the table already holds: if the launch context changed, or the
// terminal already exited or errored, the Manager clears the history and persists it — and that is the
// interesting part, because it does so **without** advancing `eventSequence` and **without** publishing
// anything. No client is told the screen was wiped; only the next snapshot and the file on disk show it.
//
// So this grammar has the two columns the stream trace lacks:
//   - `S`, the snapshot a call returned, which carries the in-memory history text and the sequence, and
//   - `F`, the history file read back from disk after every step.
// `K` records what each fake pty went through, which is how "the context-change branch stopped the old
// process and the exited branch did not" becomes an observable instead of a reading of the source.
//
// The file is seeded by the harness before the first call rather than filled with emitted output,
// because output reaches disk through the debounced writer: a seeded file is restored by `readHistory`
// into memory, which makes "in memory, on disk, and cleared by this call" three separate facts.
//
// Nothing here waits on a sleep or a poll: events arrive as receipts on an unbounded queue, and
// `persistHistory` is immediate (it enqueues and drains the key before returning). The Manager's
// `updatedAt` stamps cannot be injected through options, so the harness owns `Date.now`: each read
// advances a fixed epoch by one millisecond and stamps are recorded as `t1..tn` labels.
//
// Read-only probe: scoped temp directories only, no live install, no dev server, no source edits.
//
// Run from the repository root:
//   node apps/server/scripts/terminal-reopen-reset-trace.ts [outFile]
// Writes the trace to <outFile> and a decoded copy to the same path with `.txt` replaced by
// `-decoded.txt`.
//
// ---------------------------------------------------------------------------
// Record grammar. Tab separated, one record per line; field 1 is the record code. Data-derived
// strings are UTF-8 hex so a tab or newline cannot corrupt a row; "-" means absent. `seq` is one
// global counter that never resets, so snapshots, events, disk reads and call boundaries interleave in
// the order they really happened.
//   H  defaultTerminalIdHex                       harness constants, once
//   I  maskedIso                                  DateTime.formatIso shape with every digit masked
//   Q  noteHex                                    measurement note (explicit, never a guess)
//   C  name cap threadsHex seedHex                case header: the retained config and the seed text
//   B  seq kind idRaw statusHex                   Manager call boundary (issue / return)
//   O  seq typeHex threadHex terminalHex eventSeqRaw pidRaw exitHex signalHex
//                                                      a published TerminalEvent
//   S  seq idRaw statusHex pidRaw exitHex signalHex seqRaw historyHex cwdHex wtHex
//                                                      the snapshot an open/reopen answered with
//   F  seq afterRaw existsRaw sizeRaw contentHex one read of the terminal's history file
//   K  seq ptyRaw killsRaw resizesRaw writesRaw subscribedRaw
//                                                      one fake pty's counters after a step
//   T  seq spawnRaw colsRaw rowsRaw cwdTailHex       one spawn attempt: the size and directory the
//                                                      Manager asked the adapter for (a failed start
//                                                      still attempted one, which is how a remembered
//                                                      viewport becomes visible)
//   A  claim match|diff detailHex                 one measured answer; "diff" never aborts the run
//   X  name                                       case terminator
//   Z  caseCount snapshotCount end                global terminator
// ---------------------------------------------------------------------------

import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_TERMINAL_ID } from "@lmcstools/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as ProcessRunner from "../src/processRunner.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";
import * as PtyAdapter from "../src/terminal/PtyAdapter.ts";

const OUT_FILE =
  process.argv[2] ??
  "/Users/leandroadasilva/.cache/lmcs-port-traces/terminal-reopen-reset-trace.txt";
const DECODED_FILE = OUT_FILE.replace(/\.txt$/, "-decoded.txt");

const caseFilter = process.env["LMCS_REOPEN_ONLY"]?.split(",");
const stepTrace = process.env["LMCS_REOPEN_STEPS"] === "1";

// Yield budget for the event barrier, never a wall-clock wait.
const SETTLE_YIELDS = 200;

const EPOCH = 1_770_000_000_000;
let clockMillis = EPOCH;
Date.now = () => {
  clockMillis += 1;
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

const value = (input: unknown): string => {
  if (input === null || input === undefined) return "-";
  if (typeof input === "number") return Number.isFinite(input) ? String(input) : "nonfinite";
  if (typeof input === "string") return ident(input);
  if (typeof input === "boolean") return input ? "1" : "0";
  return "opaque";
};

const text = (input: unknown): string => (typeof input === "string" ? input : "<nonstring>");

// Snapshot paths are inside a fresh temp directory each run, so only the last component identifies the
// directory the record ended up pointing at.
const dirTail = (input: unknown): string => {
  if (typeof input !== "string" || input.length === 0) return "-";
  return input.split("/").at(-1) ?? input;
};

// The Manager builds history names from base64url parts; the harness seeds and reads the same file, so
// it derives the name the same way rather than guessing a layout.
const historyFileName = (threadId: string, terminalId: string): string => {
  const encode = (part: string) =>
    Buffer.from(part, "utf8").toString("base64url").replace(/=/g, "");
  const threadPart = `terminal_${encode(threadId)}`;
  return terminalId === DEFAULT_TERMINAL_ID
    ? `${threadPart}.log`
    : `${threadPart}_${encode(terminalId)}.log`;
};

// ---------------------------------------------------------------------------
// Fake PTY
// ---------------------------------------------------------------------------

class TracePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid: number;
  resizes = 0;
  writes = 0;
  kills = 0;
  subscribed = true;
  private dataCallback: ((data: string) => void) | null = null;
  private exitCallback: ((event: PtyAdapter.PtyExitEvent) => void) | null = null;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(): void {
    this.writes += 1;
  }

  resize(): void {
    this.resizes += 1;
  }

  kill(): void {
    this.kills += 1;
  }

  onData(callback: (data: string) => void): () => void {
    this.dataCallback = callback;
    this.subscribed = true;
    return () => {
      this.dataCallback = null;
      this.subscribed = false;
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
  // One entry per spawn attempt, successful or not: the viewport and directory the Manager asked the
  // library for is the only place a remembered size shows up, since no snapshot carries cols/rows.
  readonly spawns: { cols: number; rows: number; cwd: string }[] = [];
  failSpawn = false;
  private nextPid = 7900;

  spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    this.spawns.push({ cols: input.cols, rows: input.rows, cwd: input.cwd });
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

// Environment variants, by index. `env-none` and `env-empty` exist to be compared: an empty record
// normalizes to "no environment", so switching between the two must not read as a context change.
const ENVS: ReadonlyArray<readonly [string, ReadonlyArray<[string, string]> | undefined]> = [
  ["none", undefined],
  ["empty", []],
  ["a", [["LMCS_A", "1"]]],
  ["b", [["LMCS_B", "2"]]],
  [
    "ab",
    [
      ["LMCS_A", "1"],
      ["LMCS_B", "2"],
    ],
  ],
  // Same two entries, opposite insertion order: normalization sorts by key, so this is the same
  // environment and must not reset.
  [
    "ba",
    [
      ["LMCS_B", "2"],
      ["LMCS_A", "1"],
    ],
  ],
];

const envName = (index: number): string => ENVS[index]?.[0] ?? `env${index}`;

interface Launch {
  readonly cwd: number;
  readonly cols?: number;
  readonly rows?: number;
  readonly env?: number;
  readonly worktree?: number;
}

type Step =
  | ({ kind: "open" | "reopen"; id: string; thread: number; term: string } & Launch)
  | { kind: "emit"; spawn: number; data: string }
  | { kind: "exit"; spawn: number; code: number; signal: number | null }
  | { kind: "awaitEvent"; type: string }
  | { kind: "failSpawn"; on: boolean };

interface CaseSpec {
  readonly name: string;
  readonly threads: ReadonlyArray<string>;
  readonly seed: string;
  readonly failSpawn?: boolean;
  readonly steps: ReadonlyArray<Step>;
  readonly claims: ReadonlyArray<string>;
}

const THREAD_A = "thread-a";
const T1 = "term-1";
const SEED = "seed line\n";

const caseSpecs: ReadonlyArray<CaseSpec> = [
  {
    // The control: an open that changes nothing. The history survives in memory, on disk, and in the
    // sequence, and no pty is killed.
    name: "same-context-keeps-history",
    threads: [THREAD_A],
    seed: SEED,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1, cwd: 0, cols: 100, rows: 24, env: 2 },
      { kind: "awaitEvent", type: "started" },
      { kind: "emit", spawn: 0, data: "typed\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "reopen", id: "open-2", thread: 0, term: T1, cwd: 0, cols: 100, rows: 24, env: 2 },
    ],
    claims: [
      "restore-put-the-seed-in-memory",
      "unchanged-open-keeps-history-in-memory",
      "unchanged-open-writes-nothing",
      "unchanged-open-starts-no-process",
      "unchanged-open-kills-nothing",
    ],
  },
  {
    // A different working directory is a different terminal: the process is stopped and the retained
    // screen is thrown away, with no event saying so.
    name: "cwd-change-resets-history",
    threads: [THREAD_A],
    seed: SEED,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1, cwd: 0, cols: 100, rows: 24, env: 2 },
      { kind: "awaitEvent", type: "started" },
      { kind: "emit", spawn: 0, data: "typed\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "reopen", id: "open-2", thread: 0, term: T1, cwd: 1, cols: 100, rows: 24, env: 2 },
      { kind: "awaitEvent", type: "started" },
    ],
    claims: [
      "cwd-change-clears-memory",
      "cwd-change-empties-the-file",
      "cwd-change-kills-the-old-pty",
      "cwd-change-publishes-no-cleared",
      "cwd-sequence-advances-only-by-started",
      "cwd-change-respawns",
      "cwd-change-respawns-elsewhere",
    ],
  },
  {
    // `worktreePath` is compared against what the record holds, and an absent input keeps the recorded
    // value rather than clearing it.
    name: "worktree-change-resets-history",
    threads: [THREAD_A],
    seed: SEED,
    steps: [
      {
        kind: "open",
        id: "open-1",
        thread: 0,
        term: T1,
        cwd: 0,
        cols: 100,
        rows: 24,
        env: 2,
        worktree: 0,
      },
      { kind: "awaitEvent", type: "started" },
      { kind: "reopen", id: "open-2", thread: 0, term: T1, cwd: 0, cols: 100, rows: 24, env: 2 },
      {
        kind: "reopen",
        id: "open-3",
        thread: 0,
        term: T1,
        cwd: 0,
        cols: 100,
        rows: 24,
        env: 2,
        worktree: 1,
      },
      { kind: "awaitEvent", type: "started" },
    ],
    claims: [
      "absent-worktree-keeps-the-recorded-one",
      "absent-worktree-keeps-history",
      "absent-worktree-publishes-no-started",
      "worktree-change-clears-memory",
      "worktree-change-empties-the-file",
    ],
  },
  {
    // Environment changes are compared on the normalized record, so insertion order is not a change and
    // an empty record is not a record.
    name: "environment-equality-is-content",
    threads: [THREAD_A],
    seed: SEED,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1, cwd: 0, cols: 100, rows: 24, env: 4 },
      { kind: "awaitEvent", type: "started" },
      { kind: "reopen", id: "open-2", thread: 0, term: T1, cwd: 0, cols: 100, rows: 24, env: 5 },
      { kind: "reopen", id: "open-3", thread: 0, term: T1, cwd: 0, cols: 100, rows: 24, env: 2 },
      { kind: "awaitEvent", type: "started" },
    ],
    claims: [
      "reordered-env-is-not-a-change",
      "reordered-env-keeps-history",
      "dropped-entry-is-a-change",
      "dropped-entry-empties-the-file",
    ],
  },
  {
    // No environment at all and an empty environment are the same normalized record.
    name: "absent-env-and-empty-env-are-one-record",
    threads: [THREAD_A],
    seed: SEED,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1, cwd: 0, cols: 100, rows: 24, env: 0 },
      { kind: "awaitEvent", type: "started" },
      { kind: "reopen", id: "open-2", thread: 0, term: T1, cwd: 0, cols: 100, rows: 24, env: 1 },
      { kind: "reopen", id: "open-3", thread: 0, term: T1, cwd: 0, cols: 100, rows: 24, env: 0 },
    ],
    claims: [
      "empty-env-is-not-a-change",
      "empty-env-keeps-history",
      "back-to-absent-is-not-a-change",
    ],
  },
  {
    // A terminal that already exited is reopened on the *other* branch: same context, still reset, but
    // nobody is killed because there is no process.
    name: "exited-terminal-resets-without-a-kill",
    threads: [THREAD_A],
    seed: SEED,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1, cwd: 0, cols: 100, rows: 24, env: 2 },
      { kind: "awaitEvent", type: "started" },
      { kind: "emit", spawn: 0, data: "typed\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "exit", spawn: 0, code: 3, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "reopen", id: "open-2", thread: 0, term: T1, cwd: 0, cols: 100, rows: 24, env: 2 },
      { kind: "awaitEvent", type: "started" },
    ],
    claims: [
      "exited-branch-clears-memory",
      "exited-branch-empties-the-file",
      "exited-branch-kills-nothing",
      "exited-branch-publishes-no-cleared",
      "exited-branch-forgets-the-old-pid",
    ],
  },
  {
    // An error record takes the same branch, and the viewport the failed start asked for is the size
    // the next spawn gets, because the input named none.
    name: "error-terminal-resets-and-remembers-viewport",
    threads: [THREAD_A],
    seed: SEED,
    failSpawn: true,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1, cwd: 0, cols: 132, rows: 43, env: 2 },
      { kind: "awaitEvent", type: "error" },
      { kind: "failSpawn", on: false },
      { kind: "reopen", id: "open-2", thread: 0, term: T1, cwd: 0, env: 2 },
      { kind: "awaitEvent", type: "started" },
      { kind: "reopen", id: "open-3", thread: 0, term: T1, cwd: 0, env: 2 },
    ],
    claims: [
      "error-branch-empties-the-file",
      "error-branch-clears-memory",
      "failed-start-kept-its-viewport",
      "running-terminal-after-reset-is-quiet",
    ],
  },
  {
    // The reset writes an empty file even when nothing was ever emitted, and a second context change
    // lands on a record that is already starting from zero.
    name: "two-context-changes-in-a-row",
    threads: [THREAD_A],
    seed: SEED,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1, cwd: 0, cols: 100, rows: 24, env: 2 },
      { kind: "awaitEvent", type: "started" },
      { kind: "reopen", id: "open-2", thread: 0, term: T1, cwd: 1, cols: 100, rows: 24, env: 2 },
      { kind: "awaitEvent", type: "started" },
      { kind: "emit", spawn: 1, data: "second\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "reopen", id: "open-3", thread: 0, term: T1, cwd: 0, cols: 100, rows: 24, env: 2 },
      { kind: "awaitEvent", type: "started" },
    ],
    claims: [
      "first-change-empties-the-file",
      "second-change-clears-the-new-output",
      "second-change-empties-the-file",
      "second-change-kills-the-second-pty",
    ],
  },
  {
    // A neighbour terminal on another thread is untouched by a reset, which is what proves the reset is
    // keyed by (thread, terminal) and not by directory.
    name: "reset-is-scoped-to-one-terminal",
    threads: [THREAD_A, "thread-b"],
    seed: SEED,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1, cwd: 0, cols: 100, rows: 24, env: 2 },
      { kind: "awaitEvent", type: "started" },
      { kind: "open", id: "open-2", thread: 1, term: T1, cwd: 0, cols: 100, rows: 24, env: 2 },
      { kind: "awaitEvent", type: "started" },
      { kind: "reopen", id: "open-3", thread: 0, term: T1, cwd: 1, cols: 100, rows: 24, env: 2 },
      { kind: "awaitEvent", type: "started" },
    ],
    claims: [
      "neighbour-file-untouched",
      "reset-terminal-file-emptied",
      "neighbour-history-untouched",
    ],
  },
];

// ---------------------------------------------------------------------------
// Observations
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
  readonly threadId: string;
  readonly terminalId: string;
  readonly eventSeq: string;
  readonly pid: string;
  readonly exitCode: string;
  readonly exitSignal: string;
}

interface ObsSnapshot {
  readonly seq: number;
  readonly id: string;
  readonly status: string;
  readonly pid: string;
  readonly exitCode: string;
  readonly exitSignal: string;
  readonly sequence: string;
  readonly history: string;
  readonly cwd: string;
  readonly worktree: string;
  readonly stamp: string;
}

interface ObsDisk {
  readonly seq: number;
  readonly after: string;
  readonly thread: string;
  readonly terminal: string;
  readonly exists: boolean;
  readonly size: number;
  readonly content: string;
}

interface ObsPty {
  readonly seq: number;
  readonly index: number;
  readonly kills: number;
  readonly resizes: number;
  readonly writes: number;
  readonly subscribed: boolean;
}

interface ObsSpawn {
  readonly seq: number;
  readonly index: number;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
}

interface CaseResult {
  readonly name: string;
  readonly threads: ReadonlyArray<string>;
  readonly seed: string;
  readonly boundaries: ObsBoundary[];
  readonly events: ObsEvent[];
  readonly snapshots: ObsSnapshot[];
  readonly disks: ObsDisk[];
  readonly ptys: ObsPty[];
  readonly spawns: ObsSpawn[];
  readonly notes: string[];
  readonly stamps: string[];
  readonly claims: ReadonlyArray<string>;
  readonly dirs: ReadonlyArray<string>;
  readonly logsDir: string;
}

const runCase = Effect.fnUntraced(function* (spec: CaseSpec) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: `lmcs-reopen-${spec.name}-` });
  const logsDir = path.join(baseDir, "userdata", "logs", "terminals");
  yield* fs.makeDirectory(logsDir, { recursive: true });
  const dirs: string[] = [];
  for (const label of ["a", "b"]) {
    const dir = path.join(baseDir, `cwd-${label}`);
    yield* fs.makeDirectory(dir, { recursive: true });
    dirs.push(dir);
  }

  const boundaries: ObsBoundary[] = [];
  const events: ObsEvent[] = [];
  const snapshots: ObsSnapshot[] = [];
  const disks: ObsDisk[] = [];
  const ptys: ObsPty[] = [];
  const spawns: ObsSpawn[] = [];
  const notes: string[] = [];
  const stamps: string[] = [];

  const adapter = new TracePtyAdapter();
  adapter.failSpawn = spec.failSpawn === true;

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
    maxRetainedInactiveSessions: 128,
  });

  const unsubscribeFeed = yield* manager.subscribe((event) =>
    Effect.sync(() => {
      const record = event as unknown as Record<string, unknown>;
      const carried = record.snapshot as Record<string, unknown> | undefined;
      if (carried !== undefined && typeof carried.updatedAt === "string") {
        stamps.push(carried.updatedAt);
      }
      events.push({
        seq: nextSeq(),
        type: event.type,
        threadId: text(record.threadId),
        terminalId: text(record.terminalId),
        eventSeq: value(record.sequence),
        pid: value(carried?.pid),
        exitCode: value(record.exitCode),
        exitSignal: value(record.exitSignal),
      });
      return Effect.runSync(Queue.offer(eventSignals, undefined));
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeFeed()));

  // The seed is written before any call so the first `open` restores it through `readHistory`.
  if (spec.seed.length > 0) {
    const seedPath = path.join(logsDir, historyFileName(spec.threads[0] ?? THREAD_A, T1));
    yield* fs.writeFileString(seedPath, spec.seed);
  }
  // The neighbour thread gets its own seeded file.
  if (spec.seed.length > 0 && spec.threads.length > 1) {
    const neighbour = spec.threads[1];
    NodeAssert.ok(neighbour !== undefined, "no neighbour thread");
    yield* fs.writeFileString(
      path.join(logsDir, historyFileName(neighbour, T1)),
      `${spec.seed}neighbour\n`,
    );
  }

  let eventCursor = 0;
  const awaitEvent = Effect.fnUntraced(function* (type: string) {
    let idle = 0;
    while (eventCursor < events.length || idle < SETTLE_YIELDS) {
      const event = events[eventCursor];
      if (event !== undefined) {
        if (event.type === type) {
          eventCursor += 1;
          return;
        }
        eventCursor += 1;
        idle = 0;
        continue;
      }
      const signal = yield* Queue.poll(eventSignals);
      if (Option.isSome(signal)) {
        idle = 0;
        continue;
      }
      yield* Effect.yieldNow;
      idle += 1;
    }
    notes.push(`${spec.name}: no ${type} event`);
  });

  const readDisk = Effect.fnUntraced(function* (after: string, threadIndex: number, term: string) {
    const thread = spec.threads[threadIndex];
    NodeAssert.ok(thread !== undefined, `${spec.name}: no thread at index ${threadIndex}`);
    const file = path.join(logsDir, historyFileName(thread, term));
    const exists = yield* fs.exists(file);
    if (!exists) {
      disks.push({
        seq: nextSeq(),
        after: ident(after),
        thread: ident(thread),
        terminal: ident(term),
        exists: false,
        size: 0,
        content: "",
      });
      return;
    }
    const bytes = yield* fs.readFile(file);
    disks.push({
      seq: nextSeq(),
      after: ident(after),
      thread: ident(thread),
      terminal: ident(term),
      exists: true,
      size: bytes.length,
      content: Buffer.from(bytes).toString("utf8"),
    });
  });

  const recordPties = (label: string) => {
    for (const [index, process] of adapter.processes.entries()) {
      ptys.push({
        seq: nextSeq(),
        index,
        kills: process.kills,
        resizes: process.resizes,
        writes: process.writes,
        subscribed: process.subscribed,
      });
    }
    // Only the attempts this call caused: the recorded cwd is the directory basename so a temp path
    // never enters the trace.
    for (const attempt of adapter.spawns.slice(spawns.length)) {
      spawns.push({
        seq: nextSeq(),
        index: spawns.length,
        cols: attempt.cols,
        rows: attempt.rows,
        cwd: attempt.cwd.split("/").at(-1) ?? attempt.cwd,
      });
    }
    if (stepTrace)
      process.stderr.write(`  ${spec.name}: ${label} ptys=${adapter.processes.length}\n`);
  };

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

  const openStep = Effect.fnUntraced(function* (
    kind: "open" | "reopen",
    id: string,
    threadIndex: number,
    term: string,
    launch: Launch,
  ) {
    const envIndex = launch.env;
    const env = envIndex === undefined ? undefined : Object.fromEntries(ENVS[envIndex]?.[1] ?? []);
    const worktree = launch.worktree;
    const result = yield* call(
      kind,
      ident(id),
      manager.open({
        threadId: threadOf(threadIndex),
        terminalId: term,
        cwd: dirs[launch.cwd] ?? dirs[0] ?? "",
        ...(launch.cols === undefined ? {} : { cols: launch.cols }),
        ...(launch.rows === undefined ? {} : { rows: launch.rows }),
        ...(env === undefined ? {} : { env }),
        ...(worktree === undefined ? {} : { worktreePath: dirs[worktree] ?? dirs[0] ?? "" }),
      }),
    );
    if (result._tag === "Success") {
      const snapshot = result.success as unknown as Record<string, unknown>;
      const stamp = typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : "-";
      if (stamp !== "-") stamps.push(stamp);
      snapshots.push({
        seq: nextSeq(),
        id: ident(id),
        status: text(snapshot.status),
        pid: value(snapshot.pid),
        exitCode: value(snapshot.exitCode),
        exitSignal: value(snapshot.exitSignal),
        sequence: value(snapshot.sequence),
        history: text(snapshot.history),
        cwd: dirTail(snapshot.cwd),
        worktree: dirTail(snapshot.worktreePath),
        stamp,
      });
    }
    recordPties(id);
    yield* readDisk(id, threadIndex, term);
  });

  for (const step of spec.steps) {
    if (stepTrace) {
      const detail =
        step.kind === "emit" || step.kind === "exit"
          ? `spawn-${step.spawn}`
          : step.kind === "awaitEvent"
            ? step.type
            : step.kind === "failSpawn"
              ? String(step.on)
              : step.id;
      process.stderr.write(`  ${spec.name}: ${step.kind} ${detail}\n`);
    }
    switch (step.kind) {
      case "open":
      case "reopen": {
        yield* openStep(step.kind, step.id, step.thread, step.term, {
          cwd: step.cwd,
          ...(step.cols === undefined ? {} : { cols: step.cols }),
          ...(step.rows === undefined ? {} : { rows: step.rows }),
          ...(step.env === undefined ? {} : { env: step.env }),
          ...(step.worktree === undefined ? {} : { worktree: step.worktree }),
        });
        break;
      }
      case "emit": {
        boundaries.push({ seq: nextSeq(), kind: "emit", id: `spawn-${step.spawn}`, status: "-" });
        adapter.live(step.spawn).emitOutput(step.data);
        break;
      }
      case "exit": {
        boundaries.push({ seq: nextSeq(), kind: "exit", id: `spawn-${step.spawn}`, status: "-" });
        adapter.live(step.spawn).emitExit(step.code, step.signal);
        break;
      }
      case "awaitEvent": {
        yield* awaitEvent(step.type);
        break;
      }
      case "failSpawn": {
        adapter.failSpawn = step.on;
        break;
      }
    }
  }

  // The neighbour's file is read once, at the end, so a reset of another terminal cannot be claimed as
  // scoped when it actually rewrote every file in the directory.
  if (spec.threads.length > 1) {
    const neighbour = spec.threads[1];
    NodeAssert.ok(neighbour !== undefined, "no neighbour thread");
    yield* readDisk("final", 1, T1);
  }

  return {
    name: spec.name,
    threads: spec.threads,
    seed: spec.seed,
    boundaries,
    events,
    snapshots,
    disks,
    ptys,
    spawns,
    notes,
    stamps,
    claims: spec.claims,
    dirs,
    logsDir,
  } satisfies CaseResult;
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const stampLabels = (result: CaseResult): Map<string, string> => {
  const unique = [...new Set(result.stamps)].sort();
  return new Map(unique.map((stamp, index) => [stamp, `t${index + 1}`]));
};

const label = (labels: Map<string, string>, stamp: string): string => labels.get(stamp) ?? "none";

const diskOf = (result: CaseResult, after: string, thread?: string): ObsDisk | undefined =>
  result.disks.find(
    (disk) => disk.after === after && (thread === undefined || disk.thread === thread),
  );

const snapshotOf = (result: CaseResult, id: string): ObsSnapshot | undefined =>
  result.snapshots.find((snapshot) => snapshot.id === id);

const lastEventSeq = (result: CaseResult, type: string): number | undefined => {
  for (let index = result.events.length - 1; index >= 0; index -= 1) {
    const event = result.events[index];
    if (event?.type === type && typeof event.eventSeq === "string" && event.eventSeq !== "-") {
      return Number(event.eventSeq);
    }
  }
  return undefined;
};

const ptyKills = (result: CaseResult, index: number): number => {
  const seen = result.ptys.filter((pty) => pty.index === index);
  return seen.at(-1)?.kills ?? -1;
};

const ptySubscribed = (result: CaseResult, index: number): boolean => {
  const seen = result.ptys.filter((pty) => pty.index === index);
  return seen.at(-1)?.subscribed ?? false;
};

const eventCount = (result: CaseResult, type: string, terminal?: string): number =>
  result.events.filter(
    (event) => event.type === type && (terminal === undefined || event.terminalId === terminal),
  ).length;

const spawnOf = (result: CaseResult, index: number): ObsSpawn | undefined =>
  result.spawns.find((attempt) => attempt.index === index);

const evaluateClaims = (result: CaseResult): Array<[string, boolean, string]> => {
  const claims: Array<[string, boolean, string]> = [];
  const add = (id: string, held: boolean, detail: string) => claims.push([id, held, detail]);
  const wanted = new Set(result.claims);
  const seed = result.seed;

  const first = snapshotOf(result, "open-1");
  const second = snapshotOf(result, "open-2");
  const third = snapshotOf(result, "open-3");
  const disk2 = diskOf(result, "open-2");
  const disk3 = diskOf(result, "open-3");

  switch (result.name) {
    case "same-context-keeps-history": {
      add(
        "restore-put-the-seed-in-memory",
        first?.history.startsWith(seed) === true,
        `history=${JSON.stringify(first?.history ?? "")}`,
      );
      add(
        "unchanged-open-keeps-history-in-memory",
        second?.history === `${seed}typed\n`,
        `open1=${JSON.stringify(first?.history ?? "")} open2=${JSON.stringify(second?.history ?? "")}`,
      );
      add(
        "unchanged-open-writes-nothing",
        disk2?.content === seed,
        `size=${disk2?.size ?? "?"} content=${JSON.stringify(disk2?.content ?? "")}`,
      );
      add(
        "unchanged-open-starts-no-process",
        second?.pid === first?.pid,
        `open1=${first?.pid ?? "?"} open2=${second?.pid ?? "?"}`,
      );
      add(
        "unchanged-open-kills-nothing",
        ptyKills(result, 0) === 0 && ptySubscribed(result, 0),
        `kills=${ptyKills(result, 0)} subscribed=${ptySubscribed(result, 0)}`,
      );
      break;
    }
    case "cwd-change-resets-history": {
      const started = lastEventSeq(result, "started");
      add(
        "cwd-change-clears-memory",
        second?.history === "",
        `history=${JSON.stringify(second?.history ?? "<none>")}`,
      );
      add(
        "cwd-change-empties-the-file",
        disk2?.exists === true && disk2.content === "" && disk2.size === 0,
        `exists=${disk2?.exists ?? "?"} size=${disk2?.size ?? "?"}`,
      );
      add(
        "cwd-change-kills-the-old-pty",
        ptyKills(result, 0) >= 1 && !ptySubscribed(result, 0),
        `kills=${ptyKills(result, 0)} subscribed=${ptySubscribed(result, 0)}`,
      );
      add(
        "cwd-change-publishes-no-cleared",
        eventCount(result, "cleared") === 0,
        `cleared=${eventCount(result, "cleared")}`,
      );
      add(
        "cwd-sequence-advances-only-by-started",
        first !== undefined &&
          second !== undefined &&
          started !== undefined &&
          Number(second.sequence) === started,
        `open1=${first?.sequence ?? "?"} open2=${second?.sequence ?? "?"} started=${started ?? "?"}`,
      );
      add(
        "cwd-change-respawns",
        second?.pid !== first?.pid && second?.status === "running",
        `open1=${first?.pid ?? "?"}/${first?.status ?? "?"} open2=${second?.pid ?? "?"}/${second?.status ?? "?"}`,
      );
      add(
        "cwd-change-respawns-elsewhere",
        spawnOf(result, 1)?.cwd === "cwd-b",
        `spawn1=${spawnOf(result, 1)?.cwd ?? "?"}`,
      );
      break;
    }
    case "worktree-change-resets-history": {
      add(
        "absent-worktree-keeps-the-recorded-one",
        second?.worktree === first?.worktree && second?.worktree !== "-",
        `open1=${first?.worktree ?? "?"} open2=${second?.worktree ?? "?"}`,
      );
      add(
        "absent-worktree-keeps-history",
        second?.history === seed && disk2?.content === seed,
        `memory=${JSON.stringify(second?.history ?? "")} file=${disk2?.size ?? "?"}`,
      );
      add(
        "absent-worktree-publishes-no-started",
        eventCount(result, "started") === 2,
        `started=${eventCount(result, "started")}`,
      );
      add(
        "worktree-change-clears-memory",
        third?.history === "",
        `history=${JSON.stringify(third?.history ?? "<none>")}`,
      );
      add(
        "worktree-change-empties-the-file",
        disk3?.exists === true && disk3.content === "",
        `exists=${disk3?.exists ?? "?"} size=${disk3?.size ?? "?"}`,
      );
      break;
    }
    case "environment-equality-is-content": {
      add(
        "reordered-env-is-not-a-change",
        second?.pid === first?.pid,
        `open1=${first?.pid ?? "?"} open2=${second?.pid ?? "?"}`,
      );
      add(
        "reordered-env-keeps-history",
        second?.history === seed && disk2?.content === seed,
        `memory=${JSON.stringify(second?.history ?? "")} file=${disk2?.size ?? "?"}`,
      );
      add(
        "dropped-entry-is-a-change",
        third?.pid !== second?.pid,
        `open2=${second?.pid ?? "?"} open3=${third?.pid ?? "?"}`,
      );
      add(
        "dropped-entry-empties-the-file",
        disk3?.exists === true && disk3.content === "",
        `exists=${disk3?.exists ?? "?"} size=${disk3?.size ?? "?"}`,
      );
      break;
    }
    case "absent-env-and-empty-env-are-one-record": {
      add(
        "empty-env-is-not-a-change",
        second?.pid === first?.pid,
        `open1=${first?.pid ?? "?"} open2=${second?.pid ?? "?"}`,
      );
      add(
        "empty-env-keeps-history",
        second?.history === seed && disk2?.content === seed,
        `memory=${JSON.stringify(second?.history ?? "")} file=${disk2?.size ?? "?"}`,
      );
      add(
        "back-to-absent-is-not-a-change",
        third?.pid === second?.pid && third?.history === seed,
        `open3=${third?.pid ?? "?"}/${JSON.stringify(third?.history ?? "")}`,
      );
      break;
    }
    case "exited-terminal-resets-without-a-kill": {
      add(
        "exited-branch-clears-memory",
        second?.history === "",
        `history=${JSON.stringify(second?.history ?? "<none>")}`,
      );
      add(
        "exited-branch-empties-the-file",
        disk2?.exists === true && disk2.content === "",
        `exists=${disk2?.exists ?? "?"} size=${disk2?.size ?? "?"}`,
      );
      add("exited-branch-kills-nothing", ptyKills(result, 0) === 0, `kills=${ptyKills(result, 0)}`);
      add(
        "exited-branch-publishes-no-cleared",
        eventCount(result, "cleared") === 0,
        `cleared=${eventCount(result, "cleared")}`,
      );
      add(
        "exited-branch-forgets-the-old-pid",
        first?.pid !== undefined && second?.pid !== first.pid,
        `open1=${first?.pid ?? "?"} open2=${second?.pid ?? "?"}`,
      );
      break;
    }
    case "error-terminal-resets-and-remembers-viewport": {
      const secondSpawn = spawnOf(result, 1);
      add(
        "error-branch-empties-the-file",
        disk2?.exists === true && disk2.content === "",
        `exists=${disk2?.exists ?? "?"} size=${disk2?.size ?? "?"}`,
      );
      add(
        "error-branch-clears-memory",
        second?.history === "",
        `history=${JSON.stringify(second?.history ?? "<none>")}`,
      );
      add(
        "failed-start-kept-its-viewport",
        secondSpawn?.cols === 132 && secondSpawn.rows === 43 && result.spawns[0]?.cols === 132,
        `failed=${result.spawns[0]?.cols ?? "?"}x${result.spawns[0]?.rows ?? "?"} next=${
          secondSpawn?.cols ?? "?"
        }x${secondSpawn?.rows ?? "?"}`,
      );
      add(
        "running-terminal-after-reset-is-quiet",
        eventCount(result, "cleared") === 0 && eventCount(result, "restarted") === 0,
        `cleared=${eventCount(result, "cleared")} restarted=${eventCount(result, "restarted")}`,
      );
      break;
    }
    case "two-context-changes-in-a-row": {
      add(
        "first-change-empties-the-file",
        disk2?.exists === true && disk2.content === "",
        `size=${disk2?.size ?? "?"}`,
      );
      add(
        "second-change-clears-the-new-output",
        third?.history === "",
        `history=${JSON.stringify(third?.history ?? "<none>")}`,
      );
      add(
        "second-change-empties-the-file",
        disk3?.exists === true && disk3.content === "",
        `size=${disk3?.size ?? "?"}`,
      );
      add(
        "second-change-kills-the-second-pty",
        ptyKills(result, 1) >= 1,
        `kills=${ptyKills(result, 1)}`,
      );
      break;
    }
    case "reset-is-scoped-to-one-terminal": {
      const own = diskOf(result, "open-3");
      const neighbour = diskOf(result, "final", ident(result.threads[1] ?? ""));
      add(
        "neighbour-file-untouched",
        neighbour?.content === `${seed}neighbour\n`,
        `size=${neighbour?.size ?? "?"} content=${JSON.stringify(neighbour?.content ?? "")}`,
      );
      add(
        "reset-terminal-file-emptied",
        own?.exists === true && own.content === "",
        `size=${own?.size ?? "?"}`,
      );
      add(
        "neighbour-history-untouched",
        eventCount(result, "cleared", ident(T1)) === 0,
        `cleared=${eventCount(result, "cleared", ident(T1))}`,
      );
      break;
    }
  }

  const answered = new Set(claims.map(([id]) => id));
  add(
    "all-claims-answered",
    [...wanted].every((claim) => answered.has(claim)),
    [...wanted].filter((claim) => !answered.has(claim)).join(",") || "none",
  );
  return claims;
};

const claimRows = (claims: ReadonlyArray<[string, boolean, string]>): Row[] =>
  claims.map(([id, held, detail]): Row => ({
    code: "A",
    fields: [raw(id), held ? raw("match") : raw("diff"), hexOf(detail)],
  }));

const timedRows = (result: CaseResult): Row[] => {
  const labels = stampLabels(result);
  interface Tagged {
    readonly seq: number;
    readonly row: Row;
  }
  const rows: Tagged[] = [];
  for (const boundary of result.boundaries) {
    rows.push({
      seq: boundary.seq,
      row: {
        code: "B",
        fields: [raw(boundary.seq), raw(boundary.kind), raw(boundary.id), hexOf(boundary.status)],
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
          hexOf(event.threadId),
          hexOf(event.terminalId),
          raw(event.eventSeq),
          raw(event.pid),
          raw(event.exitCode),
          raw(event.exitSignal),
        ],
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
          raw(snapshot.id),
          hexOf(snapshot.status),
          raw(snapshot.pid),
          raw(snapshot.exitCode),
          raw(snapshot.exitSignal),
          raw(snapshot.sequence),
          hexOf(snapshot.history),
          hexOf(snapshot.cwd),
          hexOf(snapshot.worktree),
          raw(label(labels, snapshot.stamp)),
        ],
      },
    });
  }
  for (const disk of result.disks) {
    rows.push({
      seq: disk.seq,
      row: {
        code: "F",
        fields: [
          raw(disk.seq),
          raw(disk.after),
          raw(disk.thread),
          raw(disk.terminal),
          raw(disk.exists ? 1 : 0),
          raw(disk.size),
          hexOf(disk.content),
        ],
      },
    });
  }
  for (const attempt of result.spawns) {
    rows.push({
      seq: attempt.seq,
      row: {
        code: "T",
        fields: [
          raw(attempt.seq),
          raw(attempt.index),
          raw(attempt.cols),
          raw(attempt.rows),
          hexOf(attempt.cwd),
        ],
      },
    });
  }
  for (const pty of result.ptys) {
    rows.push({
      seq: pty.seq,
      row: {
        code: "K",
        fields: [
          raw(pty.seq),
          raw(pty.index),
          raw(pty.kills),
          raw(pty.resizes),
          raw(pty.writes),
          raw(pty.subscribed ? 1 : 0),
        ],
      },
    });
  }
  return rows.sort((left, right) => left.seq - right.seq).map((entry) => entry.row);
};

const caseRows = (result: CaseResult): Row[] => [
  {
    code: "C",
    fields: [
      raw(result.name),
      raw(result.threads.length),
      hexOf(result.threads.join(",")),
      hexOf(result.seed),
    ],
  },
  ...result.notes.map((note): Row => ({ code: "Q", fields: [hexOf(note)] })),
  ...timedRows(result),
  ...claimRows(evaluateClaims(result)),
  { code: "X", fields: [raw(result.name)] },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const run = Effect.gen(function* () {
  const isoSample = DateTime.formatIso(DateTime.nowUnsafe());
  const masked = isoSample.replace(/[0-9]/g, "#");
  NodeAssert.ok(!/[0-9]/.test(masked), "masked iso kept a digit");

  const header: Row[] = [
    { code: "H", fields: [hexOf(DEFAULT_TERMINAL_ID)] },
    { code: "I", fields: [hexOf(masked)] },
    {
      code: "Q",
      fields: [
        hexOf(
          `reopen reset: the launch context is (cwd, worktreePath, normalizedRuntimeEnv); a change on ` +
            `any of them stops the process and clears the history, and a record whose status is exited or ` +
            `error clears it without stopping anything. The clear is silent: no sequence, no event, so ` +
            `only the snapshot history and the file show it. An absent input keeps the recorded value, ` +
            `an empty env record is no record, and env equality is by content because normalization sorts ` +
            `by key. Sizes are asked for on every step so the reset branch is not confounded with the ` +
            `viewport gate.`,
        ),
      ],
    },
  ];

  const rows: Row[] = [...header];
  let caseCount = 0;
  let snapshotCount = 0;
  for (const spec of caseSpecs) {
    if (caseFilter !== undefined && !caseFilter.includes(spec.name)) continue;
    process.stderr.write(`case ${spec.name}\n`);
    const result = yield* Effect.scoped(runCase(spec));
    caseCount += 1;
    snapshotCount += result.snapshots.length;
    rows.push(...caseRows(result));
  }

  rows.push({ code: "Z", fields: [raw(caseCount), raw(snapshotCount), raw("end")] });

  const encoded = rows.map(encodeRow);
  NodeAssert.ok(
    encoded.every((line) => !line.includes("\n")),
    "row contains a newline",
  );
  const decoded = rows.map((row, index) => decodeRow(row, encoded[index]!));
  const fsOut = yield* FileSystem.FileSystem;
  const outPath = yield* Path.Path;
  yield* fsOut.makeDirectory(outPath.dirname(OUT_FILE), { recursive: true });
  yield* fsOut.writeFileString(OUT_FILE, `${encoded.join("\n")}\n`);
  yield* fsOut.writeFileString(DECODED_FILE, `${decoded.join("\n")}\n`);
  process.stderr.write(
    `reopen reset trace: ${caseCount} cases, ${snapshotCount} snapshots, ${rows.length} rows -> ${OUT_FILE}\n`,
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
