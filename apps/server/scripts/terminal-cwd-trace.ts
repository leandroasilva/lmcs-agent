// Trace generator for terminal CWD VALIDATION (`assertValidCwd`, Manager.ts:1909).
//
// It drives the shipped `TerminalManager` (real code, not a reimplementation) through the two entry
// points that validate a launch directory — `openLocked` (:2515) and `restartResolved` (:2937) — and
// records, in one chronological stream per case: the call boundary with its failure tag and the
// message a client sees, every `stat` the Manager issued on a fixture path and what it answered, the
// history file as it stands on disk after every step, every published event, every spawn attempt, and
// what each fake process was asked to do.
//
// The rule under test is an *order*. Validation runs before the session table is read, before
// `flushPersist` and before `readHistory`, so it is provable three ways at once: a refusal issues a
// `stat` and nothing else, a refusal against a live terminal kills nothing and publishes nothing, and
// a refusal against a record whose launch context changed leaves the history file untouched. The
// `M`/`F`/`K` columns are what turn "validation comes first" from a reading of the source into an
// observation.
//
// Nothing here waits on a sleep or a poll loop. Events arrive as receipts on an unbounded queue; the
// disk rows are read inside the call boundary they describe, so no claim depends on the 40 ms persist
// debounce.
//
// Read-only probe: scoped temp directories only, no live install, no dev server, no source edits.
// Symlinks and the unsearchable parent are made through the shipped `ProcessRunner`, because the
// repository lint forbids `node:fs` in scripts and the Effect `FileSystem` service has neither
// `symlink` nor `chmod`. Paths are masked to `<tmp>` before they reach a row, so the artifact is
// reproducible across runs.
//
// Run from the repository root:
//   node apps/server/scripts/terminal-cwd-trace.ts [outFile]
// Writes the trace to <outFile> and a decoded copy to the same path with `.txt` replaced by
// `-decoded.txt`.
//
// ---------------------------------------------------------------------------
// Record grammar. Tab separated, one record per line; field 1 is the record code. Data-derived
// strings (messages, paths, contents, notes) are UTF-8 hex so a tab or newline cannot corrupt a row;
// "-" means absent. `seq` is one global counter that never resets, so disk reads, events, file-system
// calls and call boundaries interleave in the order they really happened.
//   H  defaultTerminalIdHex                       harness constants, once
//   Q  noteHex                                    measurement note (explicit, never a guess)
//   C  name threadIdHex fixturesHex seedHex       case header: the labels made and the seeded text
//   B  seq kindHex idHex statusHex                Manager call boundary, "-" at issue and "ok" or
//                                                    `err:<Tag>` at return
//   R  seq idHex messageHex                       the failure's own `message` getter, only for a
//                                                    refused call, because that text is user-visible
//   S  seq idHex statusHex pid historyHex cwdTail the snapshot a call answered with, or the one an
//                                                    attach stream delivered
//   E  seq typeHex terminalIdHex eventSeq valid    a published TerminalEvent
//   M  seq windowHex methodHex labelHex statusHex detailHex
//                                                    a tracked `FileSystem` call: `stat` on a fixture
//                                                    path (label = fixture) or any history-directory
//                                                    call (label = basename), detail is the stat type
//   T  seq spawnIndexHex cols rows cwdTailHex      a spawn that reached the adapter, with the
//                                                    directory it was handed
//   K  seq ptyIndexHex kills resizes writes subscribed
//                                                    one fake process, after each call boundary
//   F  seq afterRaw exists size contentHex         the history file read straight from disk after the
//                                                    named step
//   G  seq levelHex messageHex                     a captured Warn/Error log line
//   A  claimHex match|diff detailHex               one measured answer to the task questions;
//                                                    "diff" marks an observation that contradicts the
//                                                    expectation, it never aborts the run
//   X  name                                        case terminator
//   Z  caseCount snapshotCount end                 global terminator
// ---------------------------------------------------------------------------

import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_TERMINAL_ID, TerminalEvent } from "@lmcstools/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../src/processRunner.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";
import * as PtyAdapter from "../src/terminal/PtyAdapter.ts";

const isTerminalEvent = Schema.is(TerminalEvent);

const OUT_FILE =
  process.argv[2] ?? "/Users/leandroadasilva/.cache/lmcs-port-traces/terminal-cwd-trace.txt";
const DECODED_FILE = OUT_FILE.replace(/\.txt$/, "-decoded.txt");

// Yield budget for the event barrier, never a wall-clock wait.
const SETTLE_YIELDS = 200;

const THREAD_ID = "thread-a";
const TERMINAL_ID = "term-1";
const SEED = "seed line\n";
const TYPED = "typed\n";

const caseFilter = process.env["LMCS_CWD_ONLY"]?.split(",");
const stepTrace = process.env["LMCS_CWD_STEPS"] === "1";

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
        return (() => {
          NodeAssert.ok(
            typeof field.value === "string",
            `hex field on ${row.code} is ${String(field.value)}`,
          );
          return hex(field.value);
        })();
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

const token = (input: unknown): string => {
  const value = typeof input === "string" ? input : String(input);
  NodeAssert.match(value, /^[A-Za-z0-9._-]+$/, `trace-unsafe identifier: ${value}`);
  return value;
};

const text = (input: unknown): string => (typeof input === "string" ? input : "<nonstring>");

// Snapshot and message paths live in a fresh temp directory each run, so the harness masks the root
// and keeps only the last component. A row with an absolute path would not be reproducible.
const historyFileName = (threadId: string, terminalId: string): string => {
  const encode = (part: string) =>
    Buffer.from(part, "utf8").toString("base64url").replace(/=/g, "");
  const threadPart = `terminal_${encode(threadId)}`;
  return threadId === "" || terminalId === DEFAULT_TERMINAL_ID
    ? `${threadPart}.log`
    : `${threadPart}_${encode(terminalId)}.log`;
};

// ---------------------------------------------------------------------------
// Fake PTY: no real process, no timers beyond the persist debounce the disk rows sidestep.
// ---------------------------------------------------------------------------

class TracePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid: number;
  kills = 0;
  resizes = 0;
  writes = 0;
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
  readonly spawns: { readonly pid: number; readonly cwd: string; cols: number; rows: number }[] =
    [];
  private nextPid = 9700;

  spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    const process = new TracePtyProcess(this.nextPid);
    this.spawns.push({ pid: this.nextPid, cwd: input.cwd, cols: input.cols, rows: input.rows });
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
  return errorTag(error);
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Fixture =
  | "dir" // a real directory: the only valid cwd
  | "file" // a regular file
  | "link-dir" // a symlink whose target is `dir`, which `stat` follows
  | "link-broken" // a symlink whose target does not exist
  | "locked-inner" // below a directory the process cannot search
  | "absent" // a path nothing created
  | "devnull" // /dev/null, a character device
  | "file-slash" // the file with a trailing separator
  | "dir-slash"; // the directory with a trailing separator

const FIXTURES: ReadonlyArray<Fixture> = [
  "dir",
  "file",
  "link-dir",
  "link-broken",
  "locked-inner",
  "absent",
  "devnull",
  "file-slash",
  "dir-slash",
];

// ---------------------------------------------------------------------------
// Case model
// ---------------------------------------------------------------------------

type Step =
  | { readonly kind: "open" | "restart"; readonly id: string; readonly fixture: Fixture }
  | { readonly kind: "attach"; readonly id: string; readonly fixture: Fixture | "none" }
  | { readonly kind: "emit"; readonly id: string; readonly data: string }
  | { readonly kind: "exit"; readonly id: string; readonly code: number }
  | { readonly kind: "awaitEvent"; readonly type: string }
  | { readonly kind: "sample"; readonly id: string };

interface CaseSpec {
  readonly name: string;
  readonly steps: ReadonlyArray<Step>;
  /** The fixture the case refuses on, when the case is about a refusal. */
  readonly notes: ReadonlyArray<string>;
}

const CASES: ReadonlyArray<CaseSpec> = [
  {
    name: "missing-cwd-refuses-before-any-history-io",
    notes: [],
    steps: [{ kind: "open", id: "open-1", fixture: "absent" }],
  },
  {
    name: "file-cwd-refuses-not-directory",
    notes: [],
    steps: [{ kind: "open", id: "open-1", fixture: "file" }],
  },
  {
    name: "character-device-cwd-refuses-not-directory",
    notes: [],
    steps: [{ kind: "open", id: "open-1", fixture: "devnull" }],
  },
  {
    // `stat` follows the link, so the gate sees the valid target while the directory handed to the
    // shell stays the link path the caller named.
    name: "symlink-to-directory-opens-and-keeps-the-link-path",
    notes: [],
    steps: [
      { kind: "open", id: "open-1", fixture: "link-dir" },
      { kind: "awaitEvent", type: "started" },
    ],
  },
  {
    name: "broken-symlink-refuses-not-found",
    notes: [],
    steps: [{ kind: "open", id: "open-1", fixture: "link-broken" }],
  },
  {
    name: "unsearchable-parent-refuses-stat-error",
    notes: [],
    steps: [{ kind: "open", id: "open-1", fixture: "locked-inner" }],
  },
  {
    name: "trailing-slash-on-file-refuses",
    notes: [],
    steps: [{ kind: "open", id: "open-1", fixture: "file-slash" }],
  },
  {
    name: "trailing-slash-on-directory-opens",
    notes: [],
    steps: [
      { kind: "open", id: "open-1", fixture: "dir-slash" },
      { kind: "awaitEvent", type: "started" },
    ],
  },
  {
    // The refusal must be invisible to the live terminal: the reset gate of `openLocked` runs after
    // validation, so a bad directory cannot kill, clear, renumber or rewrite anything.
    name: "refused-open-leaves-a-live-terminal-alone",
    notes: [],
    steps: [
      { kind: "open", id: "open-1", fixture: "dir" },
      { kind: "awaitEvent", type: "started" },
      { kind: "emit", id: "emit-1", data: TYPED },
      { kind: "awaitEvent", type: "output" },
      { kind: "sample", id: "before-2" },
      { kind: "open", id: "open-2", fixture: "file" },
      { kind: "open", id: "open-3", fixture: "absent" },
      // The screen is read back through a stream attach: the debounced writer has not touched the
      // file by the time the refusals return, so "the live terminal kept what it printed" is a
      // memory fact, and an attach is the call that answers with memory.
      { kind: "attach", id: "attach-1", fixture: "none" },
    ],
  },
  {
    name: "refused-restart-leaves-a-live-terminal-alone",
    notes: [],
    steps: [
      { kind: "open", id: "open-1", fixture: "dir" },
      { kind: "awaitEvent", type: "started" },
      { kind: "emit", id: "emit-1", data: TYPED },
      { kind: "awaitEvent", type: "output" },
      { kind: "restart", id: "restart-1", fixture: "absent" },
      { kind: "restart", id: "restart-2", fixture: "dir" },
      { kind: "awaitEvent", type: "restarted" },
    ],
  },
  {
    // The asymmetry the two entry points leave: attaching to a record the table already holds never
    // validates the directory the caller named, because that branch answers with the snapshot instead
    // of going through `openLocked`.
    name: "attach-on-a-live-record-never-validates",
    notes: [],
    steps: [
      { kind: "open", id: "open-1", fixture: "dir" },
      { kind: "awaitEvent", type: "started" },
      { kind: "emit", id: "emit-1", data: TYPED },
      { kind: "awaitEvent", type: "output" },
      { kind: "attach", id: "attach-1", fixture: "absent" },
      { kind: "attach", id: "attach-2", fixture: "none" },
    ],
  },
  {
    name: "attach-on-an-absent-record-validates-the-cwd",
    notes: [],
    steps: [
      { kind: "attach", id: "attach-1", fixture: "file" },
      { kind: "attach", id: "attach-2", fixture: "dir" },
      { kind: "sample", id: "after-2" },
    ],
  },
  {
    // A record the table never had stays absent, so the next valid open still behaves like a first
    // one: it restores the seeded screen instead of resetting.
    name: "refused-first-open-leaves-no-record",
    notes: [],
    steps: [
      { kind: "open", id: "open-1", fixture: "absent" },
      { kind: "open", id: "open-2", fixture: "dir" },
      { kind: "awaitEvent", type: "started" },
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

interface ObsCall {
  readonly seq: number;
  readonly window: string;
  readonly method: string;
  readonly label: string;
  readonly status: string;
  readonly detail: string;
}

interface ObsEvent {
  readonly seq: number;
  readonly type: string;
  readonly terminalId: string;
  readonly eventSeq: string;
  readonly valid: boolean;
}

interface ObsSnapshot {
  readonly seq: number;
  readonly id: string;
  readonly status: string;
  readonly pid: string;
  readonly history: string;
  readonly cwd: string;
}

interface ObsDisk {
  readonly seq: number;
  readonly after: string;
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

interface ObsMessage {
  readonly seq: number;
  readonly id: string;
  readonly message: string;
}

interface ObsLog {
  readonly seq: number;
  readonly level: string;
  readonly message: string;
}

interface CaseResult {
  readonly name: string;
  readonly boundaries: ObsBoundary[];
  readonly calls: ObsCall[];
  readonly events: ObsEvent[];
  readonly snapshots: ObsSnapshot[];
  readonly disks: ObsDisk[];
  readonly ptys: ObsPty[];
  readonly spawns: ObsSpawn[];
  readonly messages: ObsMessage[];
  readonly logs: ObsLog[];
  readonly notes: string[];
}

// ---------------------------------------------------------------------------
// Log sink. A refusal is expected to log nothing, so an unexplained Warn/Error line has to show up in
// the artifact rather than in the process output.
// ---------------------------------------------------------------------------

let logSink: { readonly entries: ObsLog[]; readonly seq: () => number } | null = null;

const traceLogger = Logger.make(({ logLevel, message }) => {
  if (logSink === null) return;
  logSink.entries.push({
    seq: logSink.seq(),
    level: String(logLevel),
    message: warnText(message),
  });
});

const warnText = (message: unknown): string => {
  if (typeof message === "string") return message;
  if (Array.isArray(message) && typeof message[0] === "string") return message[0];
  return "<structured>";
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let globalSeq = 0;
const nextSeq = () => {
  globalSeq += 1;
  return globalSeq;
};

const runCase = Effect.fnUntraced(function* (spec: CaseSpec) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: `lmcs-cwd-${spec.name}-` });
  const mask = (value: string) => value.split(baseDir).join("<tmp>");

  const lockedDir = path.join(baseDir, "locked");
  const fixtures: Record<Fixture, string> = {
    dir: path.join(baseDir, "dir"),
    file: path.join(baseDir, "plain.txt"),
    "link-dir": path.join(baseDir, "link-dir"),
    "link-broken": path.join(baseDir, "link-broken"),
    "locked-inner": path.join(lockedDir, "inner"),
    absent: path.join(baseDir, "nope"),
    devnull: "/dev/null",
    "file-slash": `${path.join(baseDir, "plain.txt")}/`,
    "dir-slash": `${path.join(baseDir, "dir")}/`,
  };

  const logsDir = path.join(baseDir, "userdata", "logs", "terminals");
  const historyPath = path.join(logsDir, historyFileName(THREAD_ID, TERMINAL_ID));
  yield* fs.makeDirectory(logsDir, { recursive: true });
  yield* fs.makeDirectory(fixtures.dir, { recursive: true });
  yield* fs.writeFileString(fixtures.file, "plain\n");
  // The seed is written before any call so the first valid `open` restores it through `readHistory`,
  // which is what makes "the refusal left the record absent" observable.
  yield* fs.writeFileString(historyPath, SEED);
  yield* processRunner.run({
    command: "ln",
    args: ["-s", "dir", fixtures["link-dir"]],
    spawnCwd: baseDir,
  });
  yield* processRunner.run({
    command: "ln",
    args: ["-s", "gone", fixtures["link-broken"]],
    spawnCwd: baseDir,
  });
  yield* fs.makeDirectory(fixtures["locked-inner"], { recursive: true });
  // The modes are restored by a finalizer because the scoped temp cleanup cannot descend into a
  // directory the process cannot search.
  yield* processRunner.run({ command: "chmod", args: ["000", lockedDir] });
  yield* Effect.addFinalizer(() =>
    processRunner.run({ command: "chmod", args: ["755", lockedDir] }).pipe(Effect.ignore),
  );

  const boundaries: ObsBoundary[] = [];
  const calls: ObsCall[] = [];
  const events: ObsEvent[] = [];
  const snapshots: ObsSnapshot[] = [];
  const disks: ObsDisk[] = [];
  const ptys: ObsPty[] = [];
  const spawns: ObsSpawn[] = [];
  const messages: ObsMessage[] = [];
  const notes: string[] = [...spec.notes];

  const labelOf = (target: string): string | null => {
    for (const fixture of FIXTURES) {
      if (fixtures[fixture] === target) return fixture;
    }
    return null;
  };

  const state = { capturing: false, window: "setup" };
  const trackedPaths = new Set<string>(FIXTURES.map((fixture) => fixtures[fixture]));

  // Only a fixture `stat` and any call inside the logs directory are observed; seeding, sampling and
  // temp cleanup use the raw `fs` and stay invisible to the trace.
  const trackedFileSystem = FileSystem.FileSystem.of({
    ...fs,
    stat: Effect.fnUntraced(function* (target: string) {
      if (!state.capturing || !trackedPaths.has(target)) return yield* fs.stat(target);
      const result = yield* Effect.result(fs.stat(target));
      calls.push({
        seq: nextSeq(),
        window: state.window,
        method: "stat",
        label: labelOf(target) ?? "other",
        status: result._tag === "Failure" ? `err:${renderError(result.failure)}` : "ok",
        detail: result._tag === "Success" ? result.success.type : "-",
      });
      if (result._tag === "Failure") return yield* result.failure;
      return result.success;
    }),
    readDirectory: Effect.fnUntraced(function* (
      ...args: Parameters<FileSystem.FileSystem["readDirectory"]>
    ) {
      if (!state.capturing || args[0] !== logsDir) return yield* fs.readDirectory(...args);
      const result = yield* Effect.result(fs.readDirectory(...args));
      calls.push({
        seq: nextSeq(),
        window: state.window,
        method: "readdir",
        label: "-",
        status: result._tag === "Failure" ? `err:${renderError(result.failure)}` : "ok",
        detail: result._tag === "Success" ? result.success.join(",") : "-",
      });
      if (result._tag === "Failure") return yield* result.failure;
      return result.success;
    }),
    writeFileString: Effect.fnUntraced(function* (
      ...args: Parameters<FileSystem.FileSystem["writeFileString"]>
    ) {
      if (!state.capturing || path.dirname(args[0]) !== logsDir) {
        return yield* fs.writeFileString(...args);
      }
      yield* fs.writeFileString(...args);
      calls.push({
        seq: nextSeq(),
        window: state.window,
        method: "write",
        label: path.basename(args[0]),
        status: "ok",
        detail: mask(args[1]),
      });
    }),
    remove: Effect.fnUntraced(function* (...args: Parameters<FileSystem.FileSystem["remove"]>) {
      if (!state.capturing || path.dirname(args[0]) !== logsDir) return yield* fs.remove(...args);
      const result = yield* Effect.result(fs.remove(...args));
      calls.push({
        seq: nextSeq(),
        window: state.window,
        method: "rm",
        label: path.basename(args[0]),
        status: result._tag === "Failure" ? `err:${renderError(result.failure)}` : "ok",
        detail: args[1]?.force === true ? "force" : "noforce",
      });
      if (result._tag === "Failure") return yield* result.failure;
    }),
  });

  const adapter = new TracePtyAdapter();
  const eventSignals = yield* Effect.acquireRelease(Queue.unbounded<void>(), Queue.shutdown);
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
    maxRetainedInactiveSessions: 128,
  }).pipe(Effect.provideService(FileSystem.FileSystem, trackedFileSystem));

  const unsubscribeFeed = yield* manager.subscribe((event) =>
    Effect.sync(() => {
      const record = event as unknown as Record<string, unknown>;
      events.push({
        seq: nextSeq(),
        type: event.type,
        terminalId: text(record.terminalId),
        eventSeq: typeof record.sequence === "number" ? String(record.sequence) : "none",
        valid: isTerminalEvent(event),
      });
      return Effect.runSync(Queue.offer(eventSignals, undefined));
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeFeed()));

  const recordPties = (): void => {
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
    // Only the attempts this call caused; the recorded cwd is a basename so a temp path never enters
    // the trace.
    for (const attempt of adapter.spawns.slice(spawns.length)) {
      spawns.push({
        seq: nextSeq(),
        index: spawns.length,
        cols: attempt.cols,
        rows: attempt.rows,
        cwd: dirTail(attempt.cwd),
      });
    }
  };

  const readDisk = Effect.fnUntraced(function* (after: string) {
    const label = token(after);
    const exists = yield* fs.exists(historyPath);
    if (!exists) {
      disks.push({ seq: nextSeq(), after: label, exists: false, size: 0, content: "" });
      return;
    }
    const bytes = yield* fs.readFile(historyPath);
    disks.push({
      seq: nextSeq(),
      after: label,
      exists: true,
      size: bytes.length,
      content: Buffer.from(bytes).toString("utf8"),
    });
  });

  const snapshotRow = (id: string, snapshot: unknown): void => {
    const record = snapshot as Record<string, unknown>;
    snapshots.push({
      seq: nextSeq(),
      id: token(id),
      status: text(record.status),
      pid: typeof record.pid === "number" ? String(record.pid) : "none",
      history: text(record.history),
      cwd: dirTail(record.cwd),
    });
  };

  const call = Effect.fnUntraced(function* (
    kind: string,
    id: string,
    body: Effect.Effect<unknown, unknown>,
  ) {
    boundaries.push({ seq: nextSeq(), kind, id: token(id), status: "-" });
    state.capturing = true;
    state.window = token(id);
    const result = yield* Effect.result(body);
    const refused = result._tag === "Failure";
    boundaries.push({
      seq: nextSeq(),
      kind,
      id: token(id),
      status: refused ? `err:${errorTag(result.failure)}` : "ok",
    });
    if (refused) {
      const failure = result.failure as { message?: unknown };
      const message = typeof failure?.message === "string" ? failure.message : "";
      messages.push({ seq: nextSeq(), id: token(id), message: mask(message) });
    }
    recordPties();
    yield* readDisk(id);
    state.capturing = false;
    state.window = "setup";
    return result;
  });

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

  logSink = { entries: [], seq: () => nextSeq() };
  const logs: ObsLog[] = logSink.entries;
  try {
    for (const step of spec.steps) {
      if (stepTrace) {
        process.stderr.write(
          `  ${spec.name}: ${step.kind} ${"id" in step ? step.id : step.type}\n`,
        );
      }
      switch (step.kind) {
        case "open": {
          const result = yield* call(
            "open",
            step.id,
            manager.open({
              threadId: THREAD_ID,
              terminalId: TERMINAL_ID,
              cwd: fixtures[step.fixture],
              cols: 100,
              rows: 24,
            }),
          );
          if (result._tag === "Success") snapshotRow(step.id, result.success);
          break;
        }
        case "restart": {
          const result = yield* call(
            "restart",
            step.id,
            manager.restart({
              threadId: THREAD_ID,
              terminalId: TERMINAL_ID,
              cwd: fixtures[step.fixture],
              cols: 100,
              rows: 24,
            }),
          );
          if (result._tag === "Success") snapshotRow(step.id, result.success);
          break;
        }
        case "attach": {
          const delivered: unknown[] = [];
          const result = yield* call(
            "attach",
            step.id,
            manager
              .attachStream(
                {
                  threadId: THREAD_ID,
                  terminalId: TERMINAL_ID,
                  ...(step.fixture === "none" ? {} : { cwd: fixtures[step.fixture as Fixture] }),
                  cols: 100,
                  rows: 24,
                },
                (event) =>
                  Effect.sync(() => {
                    if (event.type === "snapshot") delivered.push(event.snapshot);
                  }),
              )
              .pipe(Effect.map((unsubscribe) => unsubscribe())),
          );
          const snapshot = delivered[0];
          if (snapshot !== undefined) snapshotRow(step.id, snapshot);
          if (result._tag === "Failure") notes.push(`${spec.name}: ${step.id} refused`);
          break;
        }
        case "emit": {
          boundaries.push({ seq: nextSeq(), kind: "emit", id: step.id, status: "-" });
          adapter.live(0).emitOutput(step.data);
          yield* readDisk(step.id);
          break;
        }
        case "exit": {
          boundaries.push({ seq: nextSeq(), kind: "exit", id: step.id, status: "-" });
          adapter.live(0).emitExit(step.code, null);
          yield* readDisk(step.id);
          break;
        }
        case "awaitEvent": {
          yield* awaitEvent(step.type);
          break;
        }
        case "sample": {
          yield* readDisk(step.id);
          break;
        }
      }
    }
  } finally {
    state.capturing = false;
    state.window = "setup";
  }

  for (const entry of logs.filter((log) => log.level === "Warn" || log.level === "Error")) {
    notes.push(`${spec.name}: unexpected ${entry.level} log ${JSON.stringify(entry.message)}`);
  }
  logSink = null;

  return {
    name: spec.name,
    boundaries,
    calls,
    events,
    snapshots,
    disks,
    ptys,
    spawns,
    messages,
    logs,
    notes,
  } satisfies CaseResult;
});

// Snapshot paths are inside a fresh temp directory each run, so only the last component identifies
// the directory the record ended up pointing at.
const dirTail = (input: unknown): string => {
  if (typeof input !== "string" || input.length === 0) return "-";
  const parts = input.replace(/\/+$/, "").split("/");
  return parts.at(-1) ?? input;
};

// ---------------------------------------------------------------------------
// Claims: one measured answer per question the fatia asks.
// ---------------------------------------------------------------------------

const boundaryOf = (result: CaseResult, id: string): ObsBoundary | undefined =>
  result.boundaries.filter((boundary) => boundary.id === id && boundary.status !== "-").at(-1);

const statusOf = (result: CaseResult, id: string): string =>
  boundaryOf(result, id)?.status ?? "none";

const messageOf = (result: CaseResult, id: string): ObsMessage | undefined =>
  result.messages.find((message) => message.id === id);

const snapshotOf = (result: CaseResult, id: string): ObsSnapshot | undefined =>
  result.snapshots.find((snapshot) => snapshot.id === id);

const diskOf = (result: CaseResult, after: string): ObsDisk | undefined =>
  result.disks.find((disk) => disk.after === token(after));

const statOf = (result: CaseResult, label: string): ObsCall | undefined =>
  result.calls.find((call) => call.label === label);

const windowCalls = (result: CaseResult, id: string): ObsCall[] =>
  result.calls.filter((call) => call.window === token(id));

const seqOf = (result: CaseResult, id: string): number => boundaryOf(result, id)?.seq ?? -1;

const eventsUpTo = (result: CaseResult, seq: number): ObsEvent[] =>
  result.events.filter((event) => event.seq <= seq);

const killsOf = (result: CaseResult, index: number, seq: number): number => {
  const seen = result.ptys.filter((pty) => pty.index === index && pty.seq <= seq);
  return seen.at(-1)?.kills ?? -1;
};

const evaluateClaims = (result: CaseResult): Array<[string, boolean, string]> => {
  const claims: Array<[string, boolean, string]> = [];
  const add = (id: string, held: boolean, detail: string) => claims.push([id, held, detail]);
  const seed = SEED;

  switch (result.name) {
    case "missing-cwd-refuses-before-any-history-io": {
      const calls = windowCalls(result, "open-1");
      add(
        "refuses-with-not-found",
        statusOf(result, "open-1") === "err:TerminalCwdNotFoundError",
        `status=${statusOf(result, "open-1")}`,
      );
      add(
        "message-is-the-tagged-sentence",
        messageOf(result, "open-1")?.message.startsWith(
          "Terminal cwd does not exist: <tmp>/nope",
        ) === true,
        `message=${JSON.stringify(messageOf(result, "open-1")?.message ?? "")}`,
      );
      add(
        "issued-exactly-one-stat",
        calls.length === 1 && calls[0]?.method === "stat" && calls[0]?.label === "absent",
        `calls=${calls.map((call) => call.method).join("+") || "none"}`,
      );
      add(
        "stat-reported-not-found",
        statOf(result, "absent")?.status === "err:PlatformError/NotFound/stat",
        `status=${statOf(result, "absent")?.status ?? "none"}`,
      );
      add(
        "touched-no-history-directory-path",
        calls.every((call) => call.method === "stat"),
        `non-stat=${calls.filter((call) => call.method !== "stat").length}`,
      );
      add("started-no-process", result.spawns.length === 0, `spawns=${result.spawns.length}`);
      add(
        "published-no-event",
        result.events.length === 0,
        `events=${result.events.map((event) => event.type).join("+") || "none"}`,
      );
      add(
        "left-the-file-seeded",
        diskOf(result, "open-1")?.content === seed,
        `exists=${diskOf(result, "open-1")?.exists ?? "?"} size=${diskOf(result, "open-1")?.size ?? "?"}`,
      );
      add("logged-nothing", result.logs.length === 0, `logs=${result.logs.length}`);
      break;
    }
    case "file-cwd-refuses-not-directory": {
      add(
        "refuses-with-not-directory",
        statusOf(result, "open-1") === "err:TerminalCwdNotDirectoryError",
        `status=${statusOf(result, "open-1")}`,
      );
      add(
        "message-names-a-directory",
        messageOf(result, "open-1")?.message.startsWith(
          "Terminal cwd is not a directory: <tmp>/plain.txt",
        ) === true,
        `message=${JSON.stringify(messageOf(result, "open-1")?.message ?? "")}`,
      );
      add(
        "stat-said-file",
        statOf(result, "file")?.detail === "File",
        `type=${statOf(result, "file")?.detail ?? "none"}`,
      );
      add("started-no-process", result.spawns.length === 0, `spawns=${result.spawns.length}`);
      add(
        "left-the-file-seeded",
        diskOf(result, "open-1")?.content === seed,
        `size=${diskOf(result, "open-1")?.size ?? "?"}`,
      );
      break;
    }
    case "character-device-cwd-refuses-not-directory": {
      const stat = statOf(result, "devnull");
      add(
        "refuses-with-not-directory",
        statusOf(result, "open-1") === "err:TerminalCwdNotDirectoryError",
        `status=${statusOf(result, "open-1")}`,
      );
      add(
        "stat-said-something-other-than-a-directory",
        stat !== undefined && stat.status === "ok" && stat.detail !== "Directory",
        `status=${stat?.status ?? "none"} type=${stat?.detail ?? "none"}`,
      );
      add("started-no-process", result.spawns.length === 0, `spawns=${result.spawns.length}`);
      break;
    }
    case "symlink-to-directory-opens-and-keeps-the-link-path": {
      const first = snapshotOf(result, "open-1");
      add(
        "accepts-the-link",
        statusOf(result, "open-1") === "ok",
        `status=${statusOf(result, "open-1")}`,
      );
      add(
        "stat-followed-the-link",
        statOf(result, "link-dir")?.detail === "Directory",
        `type=${statOf(result, "link-dir")?.detail ?? "none"}`,
      );
      add(
        "spawned-the-link-path",
        result.spawns[0]?.cwd === "link-dir",
        `cwd=${result.spawns[0]?.cwd ?? "none"}`,
      );
      add("record-keeps-the-link-path", first?.cwd === "link-dir", `cwd=${first?.cwd ?? "none"}`);
      add(
        "restored-the-seed",
        first?.history.startsWith(seed) === true,
        `history=${JSON.stringify(first?.history ?? "")}`,
      );
      break;
    }
    case "broken-symlink-refuses-not-found": {
      add(
        "refuses-with-not-found",
        statusOf(result, "open-1") === "err:TerminalCwdNotFoundError",
        `status=${statusOf(result, "open-1")}`,
      );
      add(
        "stat-reported-not-found",
        statOf(result, "link-broken")?.status === "err:PlatformError/NotFound/stat",
        `status=${statOf(result, "link-broken")?.status ?? "none"}`,
      );
      add("started-no-process", result.spawns.length === 0, `spawns=${result.spawns.length}`);
      break;
    }
    case "unsearchable-parent-refuses-stat-error": {
      const stat = statOf(result, "locked-inner");
      add(
        "refuses-with-stat-error",
        statusOf(result, "open-1") === "err:TerminalCwdStatError",
        `status=${statusOf(result, "open-1")}`,
      );
      add(
        "message-says-access",
        messageOf(result, "open-1")?.message.startsWith(
          "Failed to access terminal cwd: <tmp>/locked/inner",
        ) === true,
        `message=${JSON.stringify(messageOf(result, "open-1")?.message ?? "")}`,
      );
      add(
        "stat-failed-with-permission-denied",
        stat?.status === "err:PlatformError/PermissionDenied/stat",
        `status=${stat?.status ?? "none"}`,
      );
      add("started-no-process", result.spawns.length === 0, `spawns=${result.spawns.length}`);
      add(
        "left-the-file-seeded",
        diskOf(result, "open-1")?.content === seed,
        `size=${diskOf(result, "open-1")?.size ?? "?"}`,
      );
      break;
    }
    case "trailing-slash-on-file-refuses": {
      const stat = statOf(result, "file-slash");
      add(
        "refuses-instead-of-opening",
        statusOf(result, "open-1").startsWith("err:"),
        `status=${statusOf(result, "open-1")}`,
      );
      add(
        "the-refusal-comes-from-the-stat",
        stat !== undefined && stat.status.startsWith("err:"),
        `status=${stat?.status ?? "none"} type=${stat?.detail ?? "none"}`,
      );
      add("started-no-process", result.spawns.length === 0, `spawns=${result.spawns.length}`);
      break;
    }
    case "trailing-slash-on-directory-opens": {
      const first = snapshotOf(result, "open-1");
      add(
        "accepts-the-trailing-separator",
        statusOf(result, "open-1") === "ok",
        `status=${statusOf(result, "open-1")}`,
      );
      add(
        "stat-said-directory",
        statOf(result, "dir-slash")?.detail === "Directory",
        `type=${statOf(result, "dir-slash")?.detail ?? "none"}`,
      );
      add(
        "spawned-one-process",
        result.spawns.length === 1 && result.spawns[0]?.cwd === "dir",
        `spawns=${result.spawns.length} cwd=${result.spawns[0]?.cwd ?? "none"}`,
      );
      add("record-keeps-the-path-as-named", first?.cwd === "dir", `cwd=${first?.cwd ?? "none"}`);
      break;
    }
    case "refused-open-leaves-a-live-terminal-alone": {
      const refusal = seqOf(result, "open-2");
      const openedAt = seqOf(result, "open-1");
      const first = snapshotOf(result, "open-1");
      add(
        "refusal-tag-is-not-found",
        statusOf(result, "open-3") === "err:TerminalCwdNotFoundError",
        `status=${statusOf(result, "open-3")}`,
      );
      add(
        "refusal-issued-no-kill",
        killsOf(result, 0, refusal) === 0,
        `kills=${killsOf(result, 0, refusal)}`,
      );
      add(
        "refusal-published-no-reset-event",
        // A queued `output` from the emit can land inside the window, so the claim is about the
        // events only a reset or a stop could produce.
        result.events
          .filter((event) => event.seq > openedAt && event.seq <= refusal)
          .every((event) => event.type === "output") &&
          eventsUpTo(result, refusal).filter((event) => event.type === "cleared").length === 0,
        `events=${
          result.events
            .filter((event) => event.seq > openedAt && event.seq <= refusal)
            .map((event) => event.type)
            .join("+") || "none"
        }`,
      );
      add(
        "refusal-wrote-no-file",
        diskOf(result, "before-2")?.content === diskOf(result, "open-2")?.content,
        `before=${diskOf(result, "before-2")?.size ?? "?"} after=${diskOf(result, "open-2")?.size ?? "?"}`,
      );
      add(
        "refusal-started-no-new-process",
        result.spawns.length === 1,
        `spawns=${result.spawns.length}`,
      );
      add(
        "the-live-screen-kept-the-typed-line",
        snapshotOf(result, "attach-1")?.history.includes(TYPED) === true &&
          snapshotOf(result, "attach-1")?.pid === first?.pid,
        `history=${JSON.stringify(snapshotOf(result, "attach-1")?.history ?? "")} pid=${
          snapshotOf(result, "attach-1")?.pid ?? "none"
        }/${first?.pid ?? "none"}`,
      );
      break;
    }
    case "refused-restart-leaves-a-live-terminal-alone": {
      const refusal = seqOf(result, "restart-1");
      const second = snapshotOf(result, "restart-2");
      add(
        "refused-restart-tag",
        statusOf(result, "restart-1") === "err:TerminalCwdNotFoundError",
        `status=${statusOf(result, "restart-1")}`,
      );
      add(
        "refused-restart-killed-nothing",
        killsOf(result, 0, refusal) === 0,
        `kills=${killsOf(result, 0, refusal)}`,
      );
      add(
        "refused-restart-published-nothing",
        eventsUpTo(result, refusal).filter((event) => event.type === "restarted").length === 0,
        `restarted=${
          eventsUpTo(result, refusal).filter((event) => event.type === "restarted").length
        }`,
      );
      add(
        "refused-restart-spawned-nothing",
        result.spawns.filter((spawn) => spawn.seq <= refusal).length === 1,
        `spawns=${result.spawns.filter((spawn) => spawn.seq <= refusal).length}`,
      );
      add(
        "accepted-restart-killed-the-live-pty",
        killsOf(result, 0, Number.MAX_SAFE_INTEGER) >= 1,
        `kills=${killsOf(result, 0, Number.MAX_SAFE_INTEGER)}`,
      );
      add(
        "accepted-restart-cleared-the-screen",
        second?.history === "",
        `history=${JSON.stringify(second?.history ?? "")}`,
      );
      break;
    }
    case "attach-on-a-live-record-never-validates": {
      const attachSeq = seqOf(result, "attach-1");
      add(
        "attach-with-a-bad-cwd-is-accepted",
        statusOf(result, "attach-1") === "ok",
        `status=${statusOf(result, "attach-1")}`,
      );
      add(
        "attach-without-a-cwd-is-accepted",
        statusOf(result, "attach-2") === "ok",
        `status=${statusOf(result, "attach-2")}`,
      );
      add(
        "attach-issued-no-stat",
        windowCalls(result, "attach-1").length === 0 &&
          windowCalls(result, "attach-2").length === 0,
        `calls=${
          [...windowCalls(result, "attach-1"), ...windowCalls(result, "attach-2")]
            .map((call) => `${call.method}:${call.label}`)
            .join("+") || "none"
        }`,
      );
      add(
        "attach-started-no-new-process",
        result.spawns.length === 1 && result.spawns.every((spawn) => spawn.seq <= attachSeq),
        `spawns=${result.spawns.length}`,
      );
      add(
        "attach-answered-with-the-live-screen",
        snapshotOf(result, "attach-1")?.history.includes(TYPED) === true,
        `history=${JSON.stringify(snapshotOf(result, "attach-1")?.history ?? "")}`,
      );
      break;
    }
    case "attach-on-an-absent-record-validates-the-cwd": {
      add(
        "attach-refuses-a-file-cwd",
        statusOf(result, "attach-1") === "err:TerminalCwdNotDirectoryError",
        `status=${statusOf(result, "attach-1")}`,
      );
      add(
        "attach-accepts-a-directory-cwd",
        statusOf(result, "attach-2") === "ok",
        `status=${statusOf(result, "attach-2")}`,
      );
      add(
        "the-refusal-left-the-file-seeded",
        diskOf(result, "attach-2")?.content.includes(seed) === true,
        `size=${diskOf(result, "attach-2")?.size ?? "?"} content=${JSON.stringify(
          diskOf(result, "attach-2")?.content ?? "",
        )}`,
      );
      add(
        "only-the-valid-attach-spawned",
        result.spawns.length === 1,
        `spawns=${result.spawns.length}`,
      );
      break;
    }
    case "refused-first-open-leaves-no-record": {
      const second = snapshotOf(result, "open-2");
      add(
        "first-open-refused",
        statusOf(result, "open-1") === "err:TerminalCwdNotFoundError",
        `status=${statusOf(result, "open-1")}`,
      );
      add(
        "later-open-restored-the-seed",
        second?.history.startsWith(seed) === true,
        `history=${JSON.stringify(second?.history ?? "")}`,
      );
      add("only-one-process-ever", result.spawns.length === 1, `spawns=${result.spawns.length}`);
      add(
        "no-event-from-the-refusal",
        result.events.filter((event) => event.type === "exited").length === 0,
        `exited=${result.events.filter((event) => event.type === "exited").length}`,
      );
      break;
    }
    default: {
      add("unknown-case", false, `case=${result.name}`);
    }
  }

  return claims;
};

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const claimRows = (
  claims: ReadonlyArray<readonly [string, boolean, string]>,
): Array<{ seq: number; row: Row }> =>
  claims.map(([id, held, detail], index) => ({
    seq: index,
    row: {
      code: "A",
      fields: [
        hexOf(id),
        raw(held ? "match" : "diff"),
        hexOf(held ? detail : `measured ${detail}; expected the claim to hold`),
      ],
    },
  }));

const timedRows = (result: CaseResult): Row[] => {
  const rows: Array<{ seq: number; row: Row }> = [];
  for (const boundary of result.boundaries) {
    rows.push({
      seq: boundary.seq,
      row: {
        code: "B",
        fields: [
          raw(boundary.seq),
          hexOf(boundary.kind),
          hexOf(boundary.id),
          hexOf(boundary.status),
        ],
      },
    });
  }
  for (const message of result.messages) {
    rows.push({
      seq: message.seq,
      row: { code: "R", fields: [raw(message.seq), hexOf(message.id), hexOf(message.message)] },
    });
  }
  for (const call of result.calls) {
    rows.push({
      seq: call.seq,
      row: {
        code: "M",
        fields: [
          raw(call.seq),
          hexOf(call.window),
          hexOf(call.method),
          hexOf(call.label),
          hexOf(call.status),
          hexOf(call.detail),
        ],
      },
    });
  }
  for (const event of result.events) {
    rows.push({
      seq: event.seq,
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
  for (const snapshot of result.snapshots) {
    rows.push({
      seq: snapshot.seq,
      row: {
        code: "S",
        fields: [
          raw(snapshot.seq),
          hexOf(snapshot.id),
          hexOf(snapshot.status),
          raw(snapshot.pid),
          hexOf(snapshot.history),
          hexOf(snapshot.cwd),
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
  for (const log of result.logs) {
    rows.push({
      seq: log.seq,
      row: { code: "G", fields: [raw(log.seq), hexOf(log.level), hexOf(log.message)] },
    });
  }
  return rows.sort((left, right) => left.seq - right.seq).map((entry) => entry.row);
};

const caseRows = (result: CaseResult): Row[] => [
  {
    code: "C",
    fields: [raw(token(result.name)), hexOf(THREAD_ID), hexOf(FIXTURES.join(",")), hexOf(SEED)],
  },
  ...result.notes.map((note): Row => ({ code: "Q", fields: [hexOf(note)] })),
  ...timedRows(result),
  ...claimRows(evaluateClaims(result)).map((entry) => entry.row),
  { code: "X", fields: [raw(token(result.name))] },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const run = Effect.gen(function* () {
  const header: Row[] = [
    { code: "H", fields: [hexOf(DEFAULT_TERMINAL_ID)] },
    {
      code: "Q",
      fields: [
        hexOf(
          "assertValidCwd (Manager.ts:1909) is one fileSystem.stat: a PlatformError whose reason tag is NotFound becomes TerminalCwdNotFoundError, any other PlatformError becomes TerminalCwdStatError carrying the cause as a Defect, and a stats.type other than Directory becomes TerminalCwdNotDirectoryError. It runs from openLocked (:2515) and restartResolved (:2937) before the session table is read, so a refusal is silent on every other channel.",
        ),
      ],
    },
    {
      code: "Q",
      fields: [
        hexOf(
          "The contract trims and rejects an empty cwd (TrimmedNonEmptyStringSchema on TerminalOpenInput/TerminalRestartInput), so the Manager never sees an empty string and this trace does not probe it.",
        ),
      ],
    },
    {
      code: "Q",
      fields: [
        hexOf(
          "attachStream validates only when it has to reach openLocked: a record the table already holds is answered with the snapshot, whatever directory the caller named. attach-on-an-absent-record covers the other branch.",
        ),
      ],
    },
    {
      code: "Q",
      fields: [
        hexOf(
          "restartResolved increments terminalRestartsTotal (:2935) before it validates, so a refused restart still counts. The counter is an Effect metric with no reader in this harness, so the fact is read from the source and deliberately not measured.",
        ),
      ],
    },
    {
      code: "Q",
      fields: [
        hexOf(
          "fixtures: dir is a directory, file a regular file, link-dir a symlink to dir, link-broken a dangling symlink, locked-inner a directory under a chmod-000 parent, absent a path nothing created, devnull /dev/null, file-slash and dir-slash those two paths with a trailing separator. Paths are masked to <tmp> so the artifact is reproducible.",
        ),
      ],
    },
  ];

  const rows: Row[] = [...header];
  let caseCount = 0;
  let snapshotCount = 0;
  for (const spec of CASES) {
    if (caseFilter !== undefined && !caseFilter.includes(spec.name)) continue;
    process.stderr.write(`case ${spec.name}\n`);
    const result = yield* Effect.scoped(runCase(spec));
    caseCount += 1;
    snapshotCount += result.snapshots.length;
    rows.push(...caseRows(result));
  }

  rows.push({ code: "Z", fields: [raw(caseCount), raw(snapshotCount), raw("end")] });

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.code, (counts.get(row.code) ?? 0) + 1);
  const diffs = rows.filter(
    (row) => row.code === "A" && (row.fields[1] as { value: string }).value === "diff",
  );

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
    `terminal cwd trace: ${caseCount} cases, ${snapshotCount} snapshots, ${rows.length} rows, ${diffs.length} diffs -> ${OUT_FILE}\n`,
  );
  for (const [code, count] of [...counts].sort()) process.stderr.write(`  ${code} ${count}\n`);
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
