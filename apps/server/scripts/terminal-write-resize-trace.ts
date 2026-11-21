// Trace generator for terminal WRITE and RESIZE (Manager.ts:2869 and :2887).
//
// These are the last two of the nine `TerminalManager` service calls, and they are the only two that
// reach a process without publishing anything. Both are quiet in different directions:
//
//   - `write` refuses with `TerminalSessionLookupError` or `TerminalNotRunningError`, but **succeeds
//     silently** on an exited terminal: input typed into a dead shell is dropped without a word.
//     A process that throws is the one case that names a pid.
//   - `resize` never fails on state at all. Absent record, exited record, record without a process:
//     all three answer `ok` and do nothing, because `ResizeObserver` traffic keeps arriving after the
//     UI closed the session. Only the library call itself can fail, and it is the one step that runs
//     *before* the record is told about the new size.
//
// Neither call is observable through a snapshot: `summary` has no cols/rows and `snapshot` no size, so
// the fake pty's counters are the measurement. `W` rows carry `writes`/`resizes`/`kills` plus the last
// arguments each received, which is what makes "the record kept the old size after the resize threw" a
// fact rather than a reading of the source: the follow-up `open` at the thrown size either does or does
// not cross the viewport gate, and the counter says which.
//
// `M` rows are taken from a `subscribeMetadata` snapshot, which is the only passive read of the table —
// `attachStream` would run the open/attach gate and resize the process, so it cannot be a probe.
//
// Nothing here waits on a sleep or a poll: events arrive as receipts on an unbounded queue, and the
// `starting` window is entered by a deferred spawn the harness resolves, not by a timer. The one
// bounded loop waits on a state the forked fiber publishes deterministically and records the yields it
// took, so the wait itself is in the trace.
//
// Read-only probe: scoped temp directories only, no live install, no dev server, no source edits.
//
// Run from the repository root:
//   node apps/server/scripts/terminal-write-resize-trace.ts [outFile]
// Writes the trace to <outFile> and a decoded copy to the same path with `.txt` replaced by
// `-decoded.txt`.
//
// ---------------------------------------------------------------------------
// Record grammar. Tab separated, one record per line; field 1 is the record code. Data-derived strings
// are UTF-8 hex so a tab or newline cannot corrupt a row; "-" means absent. `seq` is one global counter
// that never resets, so rows from different sources interleave in the order they really happened.
//   H  defaultTerminalIdHex                       harness constants, once
//   I  maskedIso                                  DateTime.formatIso shape with every digit masked
//   Q  noteHex                                    measurement note (explicit, never a guess)
//   C  nameHex threadsHex                         case header
//   B  seq kindHex idHex statusHex                Manager call boundary (issue / return)
//   E  seq kindHex tagHex messageHex fieldsHex causeHex
//                                                      one refused call, as the client's error object
//                                                      reads: its tag, its `message` getter, the fields
//                                                      the wire carries, and the rendered cause
//   O  seq typeHex threadHex terminalHex eventSeqRaw stampLabel
//                                                      a published TerminalEvent
//   M  seq threadHex terminalHex statusHex pidRaw stampLabel
//                                                      one row of a metadata snapshot, in the order the
//                                                      Manager sorted it
//   W  seq ptyRaw writesRaw lastWriteHex resizesRaw lastColsRaw lastRowsRaw killsRaw subscribedRaw
//                                                      one fake pty after one step
//   T  seq spawnRaw colsRaw rowsRaw statusHex      one spawn attempt the Manager made
//   A  claimHex match|diff detailHex              one measured answer; "diff" never aborts the run
//   X  nameHex                                    case terminator
//   Z  caseCount stepCount end                    global terminator
// ---------------------------------------------------------------------------

import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_TERMINAL_ID } from "@lmcstools/core";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as ProcessRunner from "../src/processRunner.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";
import * as PtyAdapter from "../src/terminal/PtyAdapter.ts";

const OUT_FILE =
  process.argv[2] ??
  "/Users/leandroadasilva/.cache/lmcs-port-traces/terminal-write-resize-trace.txt";
const DECODED_FILE = OUT_FILE.replace(/\.txt$/, "-decoded.txt");

const caseFilter = process.env["LMCS_WRITE_ONLY"]?.split(",");
const stepTrace = process.env["LMCS_WRITE_STEPS"] === "1";

// Yield budget for the two barriers, never a wall-clock wait.
const SETTLE_YIELDS = 400;

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

// ---------------------------------------------------------------------------
// Fake PTY
// ---------------------------------------------------------------------------

class TracePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid: number;
  writes = 0;
  lastWrite = "<none>";
  resizes = 0;
  lastCols = -1;
  lastRows = -1;
  kills = 0;
  subscribed = false;
  // Set by the case, not by the adapter: `write`/`resize` on the library are the two steps whose
  // failure the manager has to name, and the only way to measure the name is to make them throw.
  throwOnWrite: Error | null = null;
  throwOnResize: Error | null = null;
  private dataCallback: ((data: string) => void) | null = null;
  private exitCallback: ((event: PtyAdapter.PtyExitEvent) => void) | null = null;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string): void {
    if (this.throwOnWrite !== null) {
      this.writes += 1;
      throw this.throwOnWrite;
    }
    this.writes += 1;
    this.lastWrite = data;
  }

  resize(cols: number, rows: number): void {
    if (this.throwOnResize !== null) {
      this.resizes += 1;
      this.lastCols = cols;
      this.lastRows = rows;
      throw this.throwOnResize;
    }
    this.resizes += 1;
    this.lastCols = cols;
    this.lastRows = rows;
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
  readonly spawns: { cols: number; rows: number }[] = [];
  failSpawn = false;
  // When set, `spawn` parks on this deferred, which is how the `starting` window — invisible from a
  // single fiber, since `open` awaits the whole start — becomes a state a call can be made against.
  hold: Deferred.Deferred<void, PtyAdapter.PtySpawnError> | null = null;
  spawnsMade = 0;
  private nextPid = 7900;

  spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    this.spawns.push({ cols: input.cols, rows: input.rows });
    this.spawnsMade += 1;
    if (this.failSpawn) {
      return Effect.fail(
        new PtyAdapter.PtySpawnError({ adapter: "trace", shell: "/bin/sh", attemptedShells: [] }),
      );
    }
    const build = Effect.sync(() => {
      const process = new TracePtyProcess(this.nextPid);
      this.nextPid += 1;
      this.processes.push(process);
      return process;
    });
    const held = this.hold;
    if (held === null) return build;
    return Deferred.await(held).pipe(Effect.andThen(build));
  }

  live(index: number): TracePtyProcess {
    const process = this.processes[index];
    NodeAssert.ok(
      process !== undefined,
      `no pty at index ${index} (spawns made: ${this.spawnsMade})`,
    );
    return process;
  }
}

const errorTag = (cause: unknown): string => {
  if (cause !== null && typeof cause === "object" && "_tag" in cause) {
    return String((cause as { _tag: unknown })._tag);
  }
  return "unknown";
};

// The error object as the RPC layer hands it over: the tag, the message the client displays, the
// declared fields in declaration order, and the cause rendered the way a defect renders.
const errorDetail = (cause: unknown): { tag: string; message: string; fields: string } => {
  const record = (cause ?? {}) as Record<string, unknown>;
  const fields = Object.keys(record)
    .filter((key) => key !== "_tag" && key !== "cause" && key !== "stack")
    .map((key) => {
      const entry = record[key];
      return `${key}=${entry === null || entry === undefined ? "-" : String(entry)}`;
    })
    .join(",");
  return {
    tag: errorTag(cause),
    message: typeof record.message === "string" ? record.message : "<no message>",
    fields,
  };
};

const renderCause = (cause: unknown): string => {
  if (cause === null || cause === undefined) return "-";
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
};

// ---------------------------------------------------------------------------
// Case model
// ---------------------------------------------------------------------------

interface StepRow {
  readonly seq: number;
  readonly thread: string;
  readonly terminal: string;
  readonly status: string;
  readonly pid: string;
  readonly stamp: number;
}

interface CaseSpec {
  readonly name: string;
  readonly threads: ReadonlyArray<string>;
  // The spawn parks, so the case can drive a call against a session that is still starting.
  readonly holdSpawn?: boolean;
  readonly steps: ReadonlyArray<Step>;
}

type Step =
  | { kind: "open"; id: string; thread: number; term: string; cols?: number; rows?: number }
  | { kind: "write"; term: string; thread?: number; data: string; expectThrow?: "write" }
  | {
      kind: "resize";
      term: string;
      thread?: number;
      cols: number;
      rows: number;
      expectThrow?: "resize";
    }
  | { kind: "exit"; spawn: number; code: number; signal: number | null }
  | { kind: "emit"; spawn: number; data: string }
  | { kind: "view" }
  | { kind: "close"; id: string; term: string }
  | { kind: "failSpawn"; on: boolean }
  | { kind: "unthrow" }
  | { kind: "hold"; on: boolean }
  | { kind: "awaitStarting" }
  | { kind: "resizeHeld"; term: string; cols: number; rows: number }
  | { kind: "awaitOpen" }
  | { kind: "awaitResize" };

const THREAD_A = "thread-a";
const THREAD_B = "thread-b";
const T1 = "term-1";

const caseSpecs: ReadonlyArray<CaseSpec> = [
  {
    // The control for both calls on a live terminal.
    name: "running",
    threads: [THREAD_A],
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1, cols: 100, rows: 24 },
      { kind: "view" },
      { kind: "write", term: T1, data: "ls\n" },
      { kind: "view" },
      { kind: "resize", term: T1, cols: 80, rows: 20 },
      { kind: "view" },
    ],
  },
  {
    // `write` hands the bytes over untouched: an empty string, a lone carriage return and a multi-byte
    // sequence all reach the process exactly as the client named them, because no truncation, trim or
    // control-sequence handling happens at this layer.
    name: "write-passthrough",
    threads: [THREAD_A],
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "write", term: T1, data: "" },
      { kind: "write", term: T1, data: "\r" },
      { kind: "write", term: T1, data: "á\n\t" },
    ],
  },
  {
    // Two terminals, one resize: the row that was touched moves to the front of the list and nothing is
    // published, which is the reason the sessions list reorders without a client being told.
    name: "resize-reorders-quietly",
    threads: [THREAD_A],
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "open", id: "open-2", thread: 0, term: "term-2" },
      { kind: "view" },
      { kind: "resize", term: T1, cols: 90, rows: 30 },
      { kind: "view" },
    ],
  },
  {
    // No size gate on this path: a resize to the size the terminal already has still reaches the
    // library and still moves the stamp. The gate lives in `openLocked`, not here.
    name: "resize-same-size",
    threads: [THREAD_A],
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1, cols: 100, rows: 24 },
      { kind: "resize", term: T1, cols: 100, rows: 24 },
      { kind: "resize", term: T1, cols: 100, rows: 24 },
    ],
  },
  {
    // The dead terminal: input is dropped with a success, so a client typing after an exit hears
    // nothing, and a resize cannot revive the record's stamp.
    name: "exited",
    threads: [THREAD_A],
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "exit", spawn: 0, code: 0, signal: null },
      { kind: "view" },
      { kind: "write", term: T1, data: "echo\n" },
      { kind: "resize", term: T1, cols: 60, rows: 10 },
      { kind: "view" },
    ],
  },
  {
    // A failed start leaves a record with a status but no process: the write names the status, the
    // resize says nothing.
    name: "failed-start",
    threads: [THREAD_A],
    steps: [
      { kind: "failSpawn", on: true },
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "view" },
      { kind: "write", term: T1, data: "x" },
      { kind: "resize", term: T1, cols: 40, rows: 8 },
      { kind: "failSpawn", on: false },
    ],
  },
  {
    // The `starting` window, held open by a parked spawn. `write` runs **without** the thread lock, so
    // it answers immediately; `resize` takes the lock, so it returns only after the open does.
    name: "starting",
    threads: [THREAD_A],
    holdSpawn: true,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "awaitStarting" },
      { kind: "write", term: T1, data: "x" },
      { kind: "resizeHeld", term: T1, cols: 120, rows: 40 },
      { kind: "hold", on: false },
      { kind: "awaitOpen" },
      { kind: "awaitResize" },
      { kind: "view" },
    ],
  },
  {
    // Nothing under the key at all: the write is a lookup failure, the resize a success.
    name: "absent",
    threads: [THREAD_A],
    steps: [
      { kind: "write", term: T1, data: "x" },
      { kind: "resize", term: T1, cols: 80, rows: 20 },
    ],
  },
  {
    // After a close the record is gone, so the write is a lookup failure again rather than the
    // not-running one an exited-but-open terminal gets.
    name: "after-close",
    threads: [THREAD_A],
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "close", id: "close-1", term: T1 },
      { kind: "write", term: T1, data: "x" },
      { kind: "resize", term: T1, cols: 80, rows: 20 },
    ],
  },
  {
    // The library call itself fails. The write names the pid it wrote to; the record stays running and
    // no event is published, so the client is the only one who learns anything.
    name: "write-throws",
    threads: [THREAD_A],
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "write", term: T1, data: "x", expectThrow: "write" },
      { kind: "view" },
      { kind: "unthrow" },
      { kind: "write", term: T1, data: "y" },
    ],
  },
  {
    // The resize fails *before* the record is told the new size, which the follow-up open proves: at
    // the thrown size the viewport gate still sees the old one and resizes again.
    name: "resize-throws",
    threads: [THREAD_A],
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1, cols: 100, rows: 24 },
      { kind: "view" },
      { kind: "resize", term: T1, cols: 80, rows: 20, expectThrow: "resize" },
      { kind: "unthrow" },
      { kind: "open", id: "open-2", thread: 0, term: T1, cols: 80, rows: 20 },
      { kind: "resize", term: T1, cols: 90, rows: 21 },
      { kind: "open", id: "open-3", thread: 0, term: T1, cols: 90, rows: 21 },
    ],
  },
  {
    // A second thread's key is a lookup failure for both calls: nothing about one thread's sessions
    // changes the answer for another's.
    name: "other-thread",
    threads: [THREAD_A, THREAD_B],
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "write", term: T1, thread: 1, data: "x" },
      { kind: "resize", term: T1, thread: 1, cols: 80, rows: 20 },
      { kind: "view" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Case runner
// ---------------------------------------------------------------------------

interface ObsBoundary {
  readonly seq: number;
  readonly kind: string;
  readonly id: string;
  readonly status: string;
}

interface ObsError {
  readonly seq: number;
  readonly kind: string;
  readonly tag: string;
  readonly message: string;
  readonly fields: string;
  readonly cause: string;
}

interface ObsEvent {
  readonly seq: number;
  readonly type: string;
  readonly thread: string;
  readonly terminal: string;
  readonly eventSeq: string;
  readonly stamp: number;
}

interface ObsPty {
  readonly seq: number;
  readonly index: number;
  readonly writes: number;
  readonly lastWrite: string;
  readonly resizes: number;
  readonly lastCols: number;
  readonly lastRows: number;
  readonly kills: number;
  readonly subscribed: boolean;
}

const runCase = Effect.fnUntraced(function* (spec: CaseSpec) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: `lmcs-write-${spec.name}-` });
  const logsDir = path.join(baseDir, "userdata", "logs", "terminals");
  yield* fs.makeDirectory(logsDir, { recursive: true });
  const cwd = path.join(baseDir, "cwd-a");
  yield* fs.makeDirectory(cwd, { recursive: true });

  const boundaries: ObsBoundary[] = [];
  const errors: ObsError[] = [];
  const events: ObsEvent[] = [];
  const views: StepRow[][] = [];
  const ptys: ObsPty[] = [];
  const spawns: { seq: number; index: number; cols: number; rows: number; status: string }[] = [];
  const notes: string[] = [];
  const stamps: string[] = [];

  const adapter = new TracePtyAdapter();
  const hold =
    spec.holdSpawn === true ? yield* Deferred.make<void, PtyAdapter.PtySpawnError>() : null;
  adapter.hold = hold;

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
      events.push({
        seq: nextSeq(),
        type: event.type,
        thread: text(record.threadId),
        terminal: text(record.terminalId),
        eventSeq: value(record.sequence),
        stamp: carried === undefined ? -1 : stampLabel(carried.updatedAt),
      });
      return Effect.runSync(Queue.offer(eventSignals, undefined));
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeFeed()));

  const stampLabel = (input: unknown): number => {
    if (typeof input !== "string") return -1;
    const at = stamps.indexOf(input);
    if (at >= 0) return at + 1;
    stamps.push(input);
    return stamps.length;
  };

  let eventCursor = 0;
  const awaitEvents = Effect.fnUntraced(function* () {
    let idle = 0;
    while (eventCursor < events.length || idle < 24) {
      if (eventCursor < events.length) {
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
  });

  // A passive read of the table: one metadata subscription, its snapshot, and nothing else. The
  // snapshot frame is the only view `TerminalManager` exposes that does not run the open/attach gate.
  const readView = Effect.fnUntraced(function* (push: boolean) {
    const rows = yield* Effect.scoped(
      Effect.gen(function* () {
        const frames = yield* Effect.acquireRelease(Queue.unbounded<unknown>(), Queue.shutdown);
        const unsubscribe = yield* manager.subscribeMetadata((event) =>
          Effect.sync(() => {
            Effect.runSync(Queue.offer(frames, event));
          }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe()));
        let waits = 0;
        let first: unknown = null;
        while (first === null && waits < SETTLE_YIELDS) {
          const poll = yield* Queue.poll(frames);
          if (Option.isSome(poll)) {
            const event = poll.value as Record<string, unknown>;
            if (event.type === "snapshot") first = event.terminals;
            continue;
          }
          yield* Effect.yieldNow;
          waits += 1;
        }
        if (first === null) {
          notes.push(`${spec.name}: metadata snapshot never arrived`);
          return [] as StepRow[];
        }
        return (first as ReadonlyArray<Record<string, unknown>>).map((row) => ({
          seq: nextSeq(),
          thread: text(row.threadId),
          terminal: text(row.terminalId),
          status: text(row.status),
          pid: value(row.pid),
          stamp: stampLabel(row.updatedAt),
        }));
      }),
    );
    if (push) views.push(rows);
    return rows;
  });

  const recordPties = () => {
    for (const [index, process] of adapter.processes.entries()) {
      ptys.push({
        seq: nextSeq(),
        index,
        writes: process.writes,
        lastWrite: process.lastWrite,
        resizes: process.resizes,
        lastCols: process.lastCols,
        lastRows: process.lastRows,
        kills: process.kills,
        subscribed: process.subscribed,
      });
    }
  };

  const call = Effect.fnUntraced(function* (
    kind: string,
    id: string,
    body: Effect.Effect<unknown, unknown>,
  ) {
    boundaries.push({ seq: nextSeq(), kind, id, status: "-" });
    const result = yield* Effect.result(body);
    const status = result._tag === "Success" ? "ok" : `err:${errorTag(result.failure)}`;
    boundaries.push({ seq: nextSeq(), kind, id, status });
    if (result._tag === "Failure") {
      const detail = errorDetail(result.failure);
      const record = (result.failure ?? {}) as Record<string, unknown>;
      errors.push({
        seq: nextSeq(),
        kind,
        tag: detail.tag,
        message: detail.message,
        fields: detail.fields,
        cause: renderCause(record.cause),
      });
    }
    return result;
  });

  const threadOf = (index: number | undefined) => {
    const thread = spec.threads[index ?? 0];
    NodeAssert.ok(thread !== undefined, `${spec.name}: no thread at index ${index ?? 0}`);
    return thread;
  };

  let openFiber: Fiber.Fiber<unknown, unknown> | null = null;
  let resizeFiber: Fiber.Fiber<unknown, unknown> | null = null;
  let heldResize = "";

  for (const step of spec.steps as ReadonlyArray<Step>) {
    if (stepTrace) process.stderr.write(`  ${spec.name}: ${step.kind}\n`);
    switch (step.kind) {
      case "open": {
        const body = manager.open({
          threadId: threadOf(step.thread),
          terminalId: step.term,
          cwd,
          cols: step.cols ?? 100,
          rows: step.rows ?? 24,
        });
        if (hold !== null && openFiber === null) {
          openFiber = yield* Effect.forkScoped(body);
          boundaries.push({ seq: nextSeq(), kind: "open", id: ident(step.id), status: "forked" });
          break;
        }
        const result = yield* call("open", ident(step.id), body);
        if (result._tag === "Success") {
          const snapshot = result.success as Record<string, unknown>;
          stampLabel(snapshot.updatedAt);
        }
        spawns.push({
          seq: nextSeq(),
          index: adapter.spawns.length - 1,
          cols: adapter.spawns.at(-1)?.cols ?? -1,
          rows: adapter.spawns.at(-1)?.rows ?? -1,
          status: result._tag,
        });
        break;
      }
      case "write": {
        if (step.expectThrow === "write") {
          adapter.live(0).throwOnWrite = new Error("device full");
        }
        yield* call(
          "write",
          `w-${step.data.length}-${step.expectThrow ?? "ok"}`,
          manager.write({
            threadId: threadOf(step.thread),
            terminalId: step.term,
            data: step.data,
          }),
        );
        break;
      }
      case "resize": {
        if (step.expectThrow === "resize") {
          adapter.live(0).throwOnResize = new Error("ioctl failed");
        }
        yield* call(
          "resize",
          `r-${step.cols}x${step.rows}-${step.expectThrow ?? "ok"}`,
          manager.resize({
            threadId: threadOf(step.thread),
            terminalId: step.term,
            cols: step.cols,
            rows: step.rows,
          }),
        );
        break;
      }
      case "exit": {
        boundaries.push({ seq: nextSeq(), kind: "exit", id: `spawn-${step.spawn}`, status: "-" });
        adapter.live(step.spawn).emitExit(step.code, step.signal);
        yield* awaitEvents();
        break;
      }
      case "emit": {
        boundaries.push({ seq: nextSeq(), kind: "emit", id: `spawn-${step.spawn}`, status: "-" });
        adapter.live(step.spawn).emitOutput(step.data);
        yield* awaitEvents();
        break;
      }
      case "close": {
        yield* call(
          "close",
          ident(step.id),
          manager.close({ threadId: threadOf(0), terminalId: step.term }),
        );
        yield* awaitEvents();
        break;
      }
      case "failSpawn": {
        adapter.failSpawn = step.on;
        break;
      }
      case "view": {
        yield* readView(true);
        break;
      }
      // The resize is issued while the open still holds the thread lock and awaited only after that
      // lock is released, which is what turns "this call takes the lock" into a counter rather than a
      // reading of the source: unlocked, it would answer `ok` against a starting session and the fake
      // pty would never see a resize at all.
      case "resizeHeld": {
        heldResize = `r-${step.cols}x${step.rows}-held`;
        boundaries.push({ seq: nextSeq(), kind: "resize", id: heldResize, status: "-" });
        resizeFiber = yield* Effect.forkScoped(
          manager.resize({
            threadId: threadOf(0),
            terminalId: step.term,
            cols: step.cols,
            rows: step.rows,
          }),
        );
        break;
      }
      case "awaitResize": {
        if (resizeFiber === null) {
          notes.push(`${spec.name}: no held resize to await`);
          break;
        }
        const exit = yield* Fiber.await(resizeFiber);
        const failure = Exit.isFailure(exit) ? (exit.cause as unknown) : null;
        boundaries.push({
          seq: nextSeq(),
          kind: "resize",
          id: heldResize,
          status: Exit.isSuccess(exit) ? "ok" : "err",
        });
        if (failure !== null) {
          const detail = errorDetail((failure as Record<string, unknown>).error);
          errors.push({
            seq: nextSeq(),
            kind: "resize",
            tag: detail.tag,
            message: detail.message,
            fields: detail.fields,
            cause: renderCause((failure as Record<string, unknown>).cause),
          });
        }
        yield* awaitEvents();
        break;
      }
      case "unthrow": {
        for (const process of adapter.processes) {
          process.throwOnWrite = null;
          process.throwOnResize = null;
        }
        break;
      }
      case "hold": {
        adapter.hold = step.on ? hold : null;
        break;
      }
      case "awaitStarting": {
        let rows: StepRow[] = [];
        let yields = 0;
        while (yields < SETTLE_YIELDS) {
          rows = yield* readView(false);
          if (rows.some((row) => row.status === "starting")) break;
          yield* Effect.yieldNow;
          yields += 1;
        }
        notes.push(`${spec.name}: starting observed after ${yields} yields`);
        break;
      }
      case "awaitOpen": {
        if (hold !== null) yield* Deferred.succeed(hold, undefined).pipe(Effect.asVoid);
        if (openFiber !== null) {
          const exit = yield* Fiber.await(openFiber);
          boundaries.push({
            seq: nextSeq(),
            kind: "open",
            id: "open-1",
            status: Exit.isSuccess(exit) ? "ok" : "err",
          });
        }
        yield* awaitEvents();
        break;
      }
    }
    recordPties();
  }

  return {
    name: spec.name,
    threads: spec.threads,
    boundaries,
    errors,
    events,
    views,
    ptys,
    spawns,
    notes,
    stamps,
  };
});

interface Observed {
  readonly name: string;
  readonly threads: ReadonlyArray<string>;
  readonly boundaries: ReadonlyArray<ObsBoundary>;
  readonly errors: ReadonlyArray<ObsError>;
  readonly events: ReadonlyArray<ObsEvent>;
  readonly views: ReadonlyArray<ReadonlyArray<StepRow>>;
  readonly ptys: ReadonlyArray<ObsPty>;
  readonly spawns: ReadonlyArray<{
    seq: number;
    cols: number;
    rows: number;
    status: string;
    index: number;
  }>;
  readonly notes: ReadonlyArray<string>;
  readonly stamps: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Claims: what this fatia says the shipped code does, each one measured per case
// ---------------------------------------------------------------------------

const boundaryOf = (result: Observed, kind: string, id: string, edge: "issue" | "return") =>
  result.boundaries.filter((b) => b.kind === kind && b.id === id)[edge === "issue" ? 0 : 1];

const lastPty = (result: Observed, index: number): ObsPty | undefined => {
  for (const row of [...result.ptys].reverse()) if (row.index === index) return row;
  return undefined;
};

const ptyAt = (result: Observed, index: number, seq: number): ObsPty | undefined =>
  result.ptys.find((row) => row.index === index && row.seq >= seq);

const claimsFor = (result: Observed): Array<[string, boolean, string]> => {
  const add = (
    claims: Array<[string, boolean, string]>,
    id: string,
    held: boolean,
    detail: string,
  ) => {
    claims.push([id, held, detail]);
  };
  const claims: Array<[string, boolean, string]> = [];

  const firstWrite = result.boundaries.findIndex((b) => b.kind === "write" && b.status !== "-");
  const firstResize = result.boundaries.findIndex((b) => b.kind === "resize" && b.status !== "-");

  switch (result.name) {
    case "running": {
      const write = boundaryOf(result, "write", "w-3-ok", "return");
      const resize = boundaryOf(result, "resize", "r-80x20-ok", "return");
      add(claims, "write-succeeds", write?.status === "ok", text(write?.status ?? "missing"));
      add(claims, "resize-succeeds", resize?.status === "ok", text(resize?.status ?? "missing"));
      const after = lastPty(result, 0);
      add(claims, "write-reaches-pty", after?.writes === 1, `writes=${after?.writes}`);
      add(
        claims,
        "write-payload-verbatim",
        after?.lastWrite === "ls\n",
        hex(after?.lastWrite ?? ""),
      );
      add(claims, "resize-reaches-pty", after?.resizes === 1, `resizes=${after?.resizes}`);
      add(
        claims,
        "resize-args",
        after?.lastCols === 80 && after?.lastRows === 20,
        `${after?.lastCols}x${after?.lastRows}`,
      );
      add(
        claims,
        "neither-publishes",
        result.events.length === 1,
        `${result.events.length} events`,
      );
      add(
        claims,
        "write-leaves-stamp-alone",
        result.views[0]?.[0]?.stamp === result.views[1]?.[0]?.stamp,
        `${result.views[0]?.[0]?.stamp}->${result.views[1]?.[0]?.stamp}`,
      );
      add(
        claims,
        "resize-moves-stamp",
        (result.views[2]?.[0]?.stamp ?? -1) > (result.views[1]?.[0]?.stamp ?? -1),
        `${result.views[1]?.[0]?.stamp}->${result.views[2]?.[0]?.stamp}`,
      );
      break;
    }
    case "write-passthrough": {
      const rows = result.ptys.filter((row) => row.index === 0);
      const empties = rows.filter((row) => row.writes === 1);
      const cr = rows.filter((row) => row.writes === 2);
      const multi = rows.filter((row) => row.writes === 3);
      add(
        claims,
        "empty-write-reaches-pty",
        empties.some((row) => row.lastWrite === ""),
        `rows=${empties.length}`,
      );
      add(
        claims,
        "carriage-untouched",
        cr.some((row) => row.lastWrite === "\r"),
        `rows=${cr.length}`,
      );
      add(
        claims,
        "tab-and-multibyte-untouched",
        multi.some((row) => row.lastWrite === "á\n\t"),
        `rows=${multi.length}`,
      );
      add(claims, "writes-publish-nothing", result.events.length === 1, `${result.events.length}`);
      break;
    }
    case "resize-reorders-quietly": {
      const before = result.views[0] ?? [];
      const after = result.views[1] ?? [];
      add(
        claims,
        "resized-row-moves-first",
        before[0]?.terminal === "term-2" && after[0]?.terminal === "term-1",
        `${before.map((r) => r.terminal).join(",")}|${after.map((r) => r.terminal).join(",")}`,
      );
      add(
        claims,
        "reorder-publishes-nothing",
        result.events.length === 2,
        `${result.events.length}`,
      );
      const pty0 = lastPty(result, 0);
      add(claims, "only-one-pty-resized", pty0?.resizes === 1, `resizes=${pty0?.resizes}`);
      break;
    }
    case "resize-same-size": {
      const after = lastPty(result, 0);
      add(claims, "no-size-gate-on-resize", after?.resizes === 2, `resizes=${after?.resizes}`);
      add(claims, "repeat-resize-quiet", result.events.length === 1, `${result.events.length}`);
      const moves = result.boundaries.filter(
        (b) => b.kind === "resize" && b.status === "ok",
      ).length;
      add(claims, "both-resizes-succeed", moves === 2, `ok=${moves}`);
      break;
    }
    case "exited": {
      const write = boundaryOf(result, "write", "w-5-ok", "return");
      const resize = boundaryOf(result, "resize", "r-60x10-ok", "return");
      const before = lastPty(result, 0);
      add(claims, "exited-write-is-ok", write?.status === "ok", text(write?.status ?? "missing"));
      add(claims, "exited-write-drops-input", before?.writes === 0, `writes=${before?.writes}`);
      add(
        claims,
        "exited-resize-is-ok",
        resize?.status === "ok",
        text(resize?.status ?? "missing"),
      );
      add(
        claims,
        "exited-resize-skips-library",
        before?.resizes === 0,
        `resizes=${before?.resizes}`,
      );
      add(
        claims,
        "exited-resize-leaves-stamp",
        result.views[0]?.[0]?.stamp === result.views[1]?.[0]?.stamp,
        `${result.views[0]?.[0]?.stamp}->${result.views[1]?.[0]?.stamp}`,
      );
      add(
        claims,
        "exited-status-after-calls",
        result.views[1]?.[0]?.status === "exited",
        text(result.views[1]?.[0]?.status ?? "?"),
      );
      break;
    }
    case "failed-start": {
      const write = boundaryOf(result, "write", "w-1-ok", "return");
      const resize = boundaryOf(result, "resize", "r-40x8-ok", "return");
      add(
        claims,
        "error-write-names-status",
        write?.status === "err:TerminalNotRunningError",
        text(write?.status ?? "missing"),
      );
      add(claims, "error-resize-is-ok", resize?.status === "ok", text(resize?.status ?? "missing"));
      const detail = result.errors.find((e) => e.kind === "write");
      add(
        claims,
        "not-running-fields",
        detail?.fields === `threadId=${THREAD_A},terminalId=${T1}`,
        text(detail?.fields ?? "missing"),
      );
      add(
        claims,
        "not-running-message",
        detail?.message === `Terminal is not running for thread: ${THREAD_A}, terminal: ${T1}`,
        hex(detail?.message ?? "missing"),
      );
      add(
        claims,
        "error-resize-publishes-nothing",
        result.events.length === 1,
        `${result.events.length}`,
      );
      break;
    }
    case "starting": {
      const write = result.boundaries.filter((b) => b.kind === "write")[1];
      const resize = result.boundaries.filter((b) => b.kind === "resize")[1];
      const openReturn = result.boundaries.filter(
        (b) => b.kind === "open" && (b.status === "ok" || b.status === "err"),
      );
      add(
        claims,
        "starting-write-refuses",
        write?.status === "err:TerminalNotRunningError",
        text(write?.status ?? "missing"),
      );
      add(
        claims,
        "starting-resize-waits-for-the-lock",
        resize !== undefined && openReturn[0] !== undefined && openReturn[0].seq < resize.seq,
        `open-return=${openReturn[0]?.seq ?? "?"} resize-return=${resize?.seq ?? "?"}`,
      );
      add(
        claims,
        "write-does-not-take-the-thread-lock",
        (write?.seq ?? 0) < (openReturn[0]?.seq ?? Number.POSITIVE_INFINITY),
        `write-return=${write?.seq ?? "?"} open-return=${openReturn[0]?.seq ?? "?"}`,
      );
      const after = lastPty(result, 0);
      add(
        claims,
        "starting-write-reaches-no-process",
        after?.writes === 0,
        `writes=${after?.writes}`,
      );
      // The discriminator for the lock: had `resize` skipped it, it would have returned against the
      // starting record and the library would never have been told anything.
      add(
        claims,
        "held-resize-applies-after-the-open",
        after?.resizes === 1 && after?.lastCols === 120 && after?.lastRows === 40,
        `resizes=${after?.resizes} ${after?.lastCols}x${after?.lastRows}`,
      );
      add(
        claims,
        "held-open-eventually-runs",
        result.views[0]?.[0]?.status === "running",
        text(result.views[0]?.[0]?.status ?? "?"),
      );
      break;
    }
    case "absent": {
      const write = boundaryOf(result, "write", "w-1-ok", "return");
      const resize = boundaryOf(result, "resize", "r-80x20-ok", "return");
      add(
        claims,
        "absent-write-is-a-lookup",
        write?.status === "err:TerminalSessionLookupError",
        text(write?.status ?? "missing"),
      );
      add(
        claims,
        "absent-resize-is-ok",
        resize?.status === "ok",
        text(resize?.status ?? "missing"),
      );
      const detail = result.errors.find((e) => e.kind === "write");
      add(
        claims,
        "lookup-message",
        detail?.message === `Unknown terminal thread: ${THREAD_A}, terminal: ${T1}`,
        hex(detail?.message ?? "missing"),
      );
      add(
        claims,
        "absent-publishes-nothing",
        result.events.length === 0,
        `${result.events.length}`,
      );
      add(
        claims,
        "absent-spawns-nothing",
        adapterSpawnCount(result) === 0,
        `spawns=${adapterSpawnCount(result)}`,
      );
      break;
    }
    case "after-close": {
      const write = boundaryOf(result, "write", "w-1-ok", "return");
      const resize = boundaryOf(result, "resize", "r-80x20-ok", "return");
      add(
        claims,
        "closed-write-is-a-lookup",
        write?.status === "err:TerminalSessionLookupError",
        text(write?.status ?? "missing"),
      );
      add(
        claims,
        "closed-resize-is-ok",
        resize?.status === "ok",
        text(resize?.status ?? "missing"),
      );
      const last = lastPty(result, 0);
      add(
        claims,
        "closed-process-untouched",
        last?.writes === 0 && last?.resizes === 0,
        `writes=${last?.writes} resizes=${last?.resizes}`,
      );
      break;
    }
    case "write-throws": {
      const write = result.boundaries.filter((b) => b.kind === "write")[1];
      const detail = result.errors.find((e) => e.kind === "write");
      add(
        claims,
        "throwing-write-is-named",
        write?.status === "err:TerminalWriteError",
        text(write?.status ?? "missing"),
      );
      add(
        claims,
        "write-error-names-the-pid",
        detail?.fields.startsWith(`threadId=${THREAD_A},terminalId=${T1},terminalPid=`) === true,
        hex(detail?.fields ?? "missing"),
      );
      add(
        claims,
        "write-error-message",
        detail?.message.startsWith(`Failed to write to terminal for thread: ${THREAD_A}`) === true,
        hex(detail?.message ?? "missing"),
      );
      add(
        claims,
        "write-error-renders-cause",
        detail?.cause === "Error: device full",
        text(detail?.cause ?? "missing"),
      );
      const view = result.views[0]?.[0];
      add(
        claims,
        "throwing-write-leaves-session-running",
        view?.status === "running",
        text(view?.status ?? "?"),
      );
      add(
        claims,
        "throwing-write-publishes-nothing",
        result.events.length === 1,
        `${result.events.length}`,
      );
      const next = result.boundaries.filter((b) => b.kind === "write")[3];
      add(
        claims,
        "later-write-still-works",
        next?.status === "ok",
        text(next?.status ?? "missing"),
      );
      break;
    }
    case "resize-throws": {
      const write = result.boundaries.filter((b) => b.kind === "resize")[1];
      const detail = result.errors.find((e) => e.kind === "resize");
      add(
        claims,
        "throwing-resize-is-named",
        write?.status === "err:TerminalResizeError",
        text(write?.status ?? "missing"),
      );
      add(
        claims,
        "resize-error-carries-size",
        detail?.fields === `threadId=${THREAD_A},terminalId=${T1},terminalPid=7900,cols=80,rows=20`,
        hex(detail?.fields ?? "missing"),
      );
      add(
        claims,
        "resize-error-message",
        detail?.message ===
          `Failed to resize terminal for thread: ${THREAD_A}, terminal: ${T1}, PID: 7900 to 80x20`,
        hex(detail?.message ?? "missing"),
      );
      // One process for the whole case: a failing resize neither restarts nor respawns.
      const procs = new Set(result.ptys.map((row) => row.index)).size;
      add(claims, "no-extra-spawn", procs === 1, `processes=${procs}`);
      const resizes = lastPty(result, 0);
      // 1 the throw, 2 the follow-up open crossing its gate because the record still had 100x24, 3 the
      // successful resize. Had the thrown size been remembered, the open would have matched it and the
      // count would stop at 2.
      add(
        claims,
        "thrown-size-not-remembered",
        resizes?.resizes === 3,
        `resizes=${resizes?.resizes}`,
      );
      add(
        claims,
        "kept-size-gates-the-next-open",
        resizes?.lastCols === 90 && resizes?.lastRows === 21,
        `${resizes?.lastCols}x${resizes?.lastRows}`,
      );
      add(
        claims,
        "resize-failure-publishes-nothing",
        result.events.length === 1,
        `${result.events.length}`,
      );
      break;
    }
    case "other-thread": {
      const write = boundaryOf(result, "write", "w-1-ok", "return");
      const resize = boundaryOf(result, "resize", "r-80x20-ok", "return");
      add(
        claims,
        "other-thread-write-is-a-lookup",
        write?.status === "err:TerminalSessionLookupError",
        text(write?.status ?? "missing"),
      );
      add(
        claims,
        "other-thread-resize-is-ok",
        resize?.status === "ok",
        text(resize?.status ?? "missing"),
      );
      const last = lastPty(result, 0);
      add(
        claims,
        "other-thread-calls-touch-nothing",
        last?.writes === 0 && last?.resizes === 0,
        `writes=${last?.writes} resizes=${last?.resizes}`,
      );
      const rows = result.views[0] ?? [];
      add(
        claims,
        "other-thread-creates-no-session",
        rows.length === 1 && rows.every((row) => row.thread === THREAD_A),
        rows.map((row) => row.thread).join(","),
      );
      add(
        claims,
        "other-thread-resize-stamps-nothing",
        rows[0]?.stamp === 1,
        `stamp=${rows[0]?.stamp}`,
      );
      break;
    }
    default:
      break;
  }
  return claims;
};

const adapterSpawnCount = (result: Observed): number => result.spawns.length;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const caseRows = (result: Observed): Row[] => {
  const rows: Row[] = [
    {
      code: "C",
      fields: [hexOf(result.name), hexOf(result.threads.join(","))],
    },
  ];
  for (const note of result.notes) {
    rows.push({ code: "Q", fields: [hexOf(note)] });
  }
  for (const boundary of result.boundaries) {
    rows.push({
      code: "B",
      fields: [raw(boundary.seq), hexOf(boundary.kind), hexOf(boundary.id), hexOf(boundary.status)],
    });
  }
  for (const error of result.errors) {
    rows.push({
      code: "E",
      fields: [
        raw(error.seq),
        hexOf(error.kind),
        hexOf(error.tag),
        hexOf(error.message),
        hexOf(error.fields),
        hexOf(error.cause),
      ],
    });
  }
  for (const event of result.events) {
    rows.push({
      code: "O",
      fields: [
        raw(event.seq),
        hexOf(event.type),
        hexOf(event.thread),
        hexOf(event.terminal),
        raw(event.eventSeq),
        raw(event.stamp),
      ],
    });
  }
  for (const [index, view] of result.views.entries()) {
    for (const row of view) {
      rows.push({
        code: "M",
        fields: [
          raw(index),
          raw(row.seq),
          hexOf(row.thread),
          hexOf(row.terminal),
          hexOf(row.status),
          raw(row.pid),
          raw(row.stamp),
        ],
      });
    }
  }
  for (const pty of result.ptys) {
    rows.push({
      code: "W",
      fields: [
        raw(pty.seq),
        raw(pty.index),
        raw(pty.writes),
        hexOf(pty.lastWrite),
        raw(pty.resizes),
        raw(pty.lastCols),
        raw(pty.lastRows),
        raw(pty.kills),
        raw(pty.subscribed ? 1 : 0),
      ],
    });
  }
  for (const spawn of result.spawns) {
    rows.push({
      code: "T",
      fields: [
        raw(spawn.seq),
        raw(spawn.index),
        raw(spawn.cols),
        raw(spawn.rows),
        hexOf(spawn.status),
      ],
    });
  }
  const claims = claimsFor(result);
  for (const [id, held, detail] of claims) {
    rows.push({
      code: "A",
      fields: [hexOf(id), raw(held ? "match" : "diff"), hexOf(detail)],
    });
  }
  rows.push({ code: "X", fields: [hexOf(result.name)] });
  return rows;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const run = Effect.gen(function* () {
  const masked = DateTime.formatIso(DateTime.makeUnsafe(EPOCH)).replace(/\d/g, "#");
  const header: Row[] = [
    { code: "H", fields: [hexOf(DEFAULT_TERMINAL_ID)] },
    { code: "I", fields: [hexOf(masked)] },
    {
      code: "Q",
      fields: [
        hexOf(
          "surface: `write` and `resize` are 2 of the 9 TerminalManager service calls and the only 2 " +
            "that touch a process without publishing. Neither size is visible on the wire — neither " +
            "`summary` nor `snapshot` carries cols/rows — so the fake pty's counters in the W rows are " +
            "the measurement, and a follow-up open at the thrown size is what says whether the record " +
            "remembered it. The M rows come from a `subscribeMetadata` snapshot because it is the only " +
            "passive read of the table; `attachStream` would run the open/attach gate. Measured gaps: " +
            "`write` runs without the thread lock and `resize` with it, which the `starting` case " +
            "orders by sequence; and the port's seam owns the table behind one owner, so that ordering " +
            "is a property of the shipped concurrency rather than of the decision being ported.",
        ),
      ],
    },
  ];

  const rows: Row[] = [...header];
  let caseCount = 0;
  let stepCount = 0;
  for (const spec of caseSpecs) {
    if (caseFilter !== undefined && !caseFilter.includes(spec.name)) continue;
    process.stderr.write(`case ${spec.name}\n`);
    const result = yield* Effect.scoped(runCase(spec));
    caseCount += 1;
    stepCount += spec.steps.length;
    rows.push(...caseRows(result));
  }
  rows.push({ code: "Z", fields: [raw(caseCount), raw(stepCount), raw("end")] });

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
    `terminal write/resize trace: ${caseCount} cases, ${stepCount} steps, ${rows.length} rows -> ${OUT_FILE}\n`,
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
