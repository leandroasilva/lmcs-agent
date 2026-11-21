// Trace generator for the terminal-history persistence CALL SITES. It drives the shipped
// `TerminalManager` through the operations that are supposed to schedule a history write and
// records, in one chronological stream, the three things the Rust port needs as evidence:
//
//   1. which Manager operation caused an `FileSystem.writeFileString` on a history file,
//   2. what content that write carried (the history sampled at write time), and
//   3. whether that write had already landed when the awaited operation returned.
//
// Nothing here waits on a sleep, a wall clock or a poll loop. The only waits are receipts: a
// `Queue.take` on the intercepted write (used solely where a request was enqueued while the
// session key was idle, so the coalescing worker cannot drop it) and a `Queue.take` on the
// published-event stream. `persistHistory` ends in `flushPersist`, i.e. `drainKey`, which only
// returns once the key has no queued, pending or active work, so a write count taken after an
// awaited `close`/`clear`/`restart` returns is decisive rather than "waited and saw nothing".
// `Q` rows are instantaneous samples of the same counters, never a wait; they are labelled as
// scheduler-sensitive in the notes below.
//
// The 40 ms `DEFAULT_PERSIST_DEBOUNCE_MS` is real time under this plain runtime. Nothing asserts
// that a debounce *did* elapse. Two scenarios (`clear-before-debounce-lands`,
// `durability-at-close`) deliberately skip the write latch and so depend on the opposite: the
// awaited immediate operation must reach its `enqueue` while the debounced request is still queued
// and not yet picked up by the single consumer. That happens microseconds after the output event,
// against a 40 ms timer, and both runs of this trace recorded the same merged single write. Every
// other scenario latches the debounced write before the next history mutation, so its write count
// and content order are race-free.
//
// Read-only probe: scoped temp directories only, no live install, no dev server, no source edits.
//
// Run from the repository root:
//   node apps/server/scripts/terminal-persist-calls-trace.ts

// ---------------------------------------------------------------------------
// Record grammar. Tab separated, one record per line; field 1 is the record code.
// Every data-derived string field is UTF-8 hex, so a tab or newline cannot corrupt a row.
// Scenario names and claim ids stay raw and are asserted against /^[a-z0-9-]+$/.
//   H  lineLimit byteLimit killGraceMs defaultTerminalIdHex shellHex   harness constants, once
//   C  name threadIdHex                                     scenario header
//   T  terminalLabelHex terminalIdHex basenameHex           traced history file identity
//   O  phaseHex opHex                                       a Manager call returned, or an
//                                                           injected PTY event was issued
//   E  typeHex sequence valid                                a published TerminalEvent
//   W  index basenameHex contentHex                         intercepted history write, in the
//                                                           order the calls reached the filesystem
//   A  labelHex                                             write latch fired
//   Q  labelHex landedWrites publishedEvents                instantaneous sample, no wait
//   S  opHex statusHex historyHex pid                       snapshot returned by open/restart
//   P  spawnCount                                           pty processes spawned in the scenario
//   D  basenameHex contentHex                               disk sample after the steps
//   L  warnCount errorCount                                 swallowed-failure guard
//   V  claim verdict detailHex                              expected-vs-observed verdict
//   N  noteHex                                              measurement caveat
//   X  name                                                 scenario terminator
//   Z  caseCount end                                        global terminator
// ---------------------------------------------------------------------------

import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_TERMINAL_ID, TerminalEvent } from "@lmcstools/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../src/processRunner.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";
import type * as PtyAdapter from "../src/terminal/PtyAdapter.ts";

const isTerminalEvent = Schema.is(TerminalEvent);

// ---------------------------------------------------------------------------
// Fake PTY: the trace owns when output and exit arrive, so every persisted byte is attributable.
// ---------------------------------------------------------------------------

class TracePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid: number;
  private dataCallback: ((data: string) => void) | null = null;
  private exitCallback: ((event: PtyAdapter.PtyExitEvent) => void) | null = null;

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

  emitExit(exitCode: number): void {
    NodeAssert.ok(this.exitCallback !== null, `pty ${this.pid}: exit handler was unsubscribed`);
    this.exitCallback({ exitCode, signal: null });
  }
}

class TracePtyAdapter {
  readonly processes: TracePtyProcess[] = [];
  private nextPid = 9100;

  spawn(): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    const process = new TracePtyProcess(this.nextPid);
    this.nextPid += 1;
    this.processes.push(process);
    return Effect.succeed(process);
  }

  /** The manager re-spawns on restart and relaunch, so inject into the live process only. */
  live(): TracePtyProcess {
    const process = this.processes.at(-1);
    NodeAssert.ok(process !== undefined, "no pty has been spawned yet");
    return process;
  }
}

// ---------------------------------------------------------------------------
// Log sink. The persist worker turns a write failure into a warning, which would silently erase
// a write from the trace, so warnings are counted per scenario and asserted empty.
// ---------------------------------------------------------------------------

let logSink: Array<{ level: string; text: string }> | null = null;

const renderLogMessage = (message: unknown): string => {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.map((part) => renderLogMessage(part)).join(" ");
  return "<structured>";
};

const traceLogger = Logger.make(({ logLevel, message }) => {
  logSink?.push({ level: logLevel, text: renderLogMessage(message) });
});

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type TerminalLabel = "term-1" | "term-2";
type CwdLabel = "a" | "b";

type Step =
  | {
      readonly kind: "open";
      readonly id: string;
      readonly terminal: TerminalLabel;
      readonly cwd: CwdLabel;
      /** Asserts the call published no event, instead of draining the `started` event it owns. */
      readonly silent?: boolean;
    }
  | {
      readonly kind: "restart";
      readonly id: string;
      readonly terminal: TerminalLabel;
      readonly cwd: CwdLabel;
    }
  | { readonly kind: "clear"; readonly id: string; readonly terminal: TerminalLabel }
  | { readonly kind: "close"; readonly id: string; readonly terminal: TerminalLabel }
  | {
      readonly kind: "emit";
      readonly id: string;
      readonly terminal: TerminalLabel;
      readonly data: string;
    }
  | {
      readonly kind: "exit";
      readonly id: string;
      readonly terminal: TerminalLabel;
      readonly code: number;
    }
  | { readonly kind: "awaitEvent"; readonly type: string }
  | { readonly kind: "awaitWrites"; readonly id: string; readonly count: number }
  | { readonly kind: "sample"; readonly label: string };

interface Scenario {
  readonly name: string;
  readonly threadId: string;
  readonly terminals: ReadonlyArray<TerminalLabel>;
  readonly steps: ReadonlyArray<Step>;
  /** The source-reading claim under test; a mismatch is recorded as a DIFF verdict row. */
  readonly claim: string;
  /** Expected chronological op/event/write stream. */
  readonly expected: ReadonlyArray<string>;
  /** Expected final on-disk content per traced file; "-" means the file must be absent. */
  readonly disk: ReadonlyArray<readonly [TerminalLabel, string]>;
  readonly notes?: ReadonlyArray<string>;
}

const HISTORY_LINE_LIMIT = 5;
const HISTORY_BYTE_LIMIT = 1024;
const COLUMNS = 100;
const ROWS = 24;
const DEFAULT_SHELL = "/bin/sh";

const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");
const ident = (value: string) => {
  NodeAssert.match(value, /^[a-z0-9-]+$/, `trace-unsafe identifier: ${value}`);
  return value;
};
const row = (fields: ReadonlyArray<string | number>) => {
  const line = fields.join("\t");
  NodeAssert.equal(line.split("\t").length, fields.length, "record field contained a tab");
  return line;
};

const eventToken = (type: string) => `E:${type}`;
const writeToken = (label: TerminalLabel, content: string) => `W:${label}:${hex(content)}`;
const returnToken = (id: string) => `R:${id}`;
const issueToken = (id: string) => `I:${id}`;

const OSC_QUERY = "\u001b]11;?\u0007";
const STRIPPED_CSI = "\u001b[6n";

const scenarios: ReadonlyArray<Scenario> = [
  {
    name: "output-then-close",
    threadId: "thread-a",
    terminals: ["term-1"],
    claim: "queue-persist-precedes-the-output-event-and-close-lands-before-the-closed-event",
    steps: [
      { kind: "open", id: "open-1", terminal: "term-1", cwd: "a" },
      { kind: "emit", id: "emit-alpha", terminal: "term-1", data: "alpha\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "sample", label: "at-output-event" },
      { kind: "awaitWrites", id: "debounced-1", count: 1 },
      { kind: "close", id: "close-1", terminal: "term-1" },
    ],
    expected: [
      eventToken("started"),
      returnToken("open-1"),
      issueToken("emit-alpha"),
      eventToken("output"),
      writeToken("term-1", "alpha\n"),
      writeToken("term-1", "alpha\n"),
      eventToken("closed"),
      returnToken("close-1"),
    ],
    disk: [["term-1", "alpha\n"]],
    notes: ["the-output-event-is-published-before-the-debounced-write-lands"],
  },
  {
    name: "empty-visible-osc",
    threadId: "thread-b",
    terminals: ["term-1"],
    claim: "a-terminated-osc-query-schedules-no-persist",
    steps: [
      { kind: "open", id: "open-1", terminal: "term-1", cwd: "a" },
      { kind: "emit", id: "emit-osc", terminal: "term-1", data: OSC_QUERY },
      { kind: "awaitEvent", type: "output" },
      { kind: "sample", label: "at-output-event" },
      { kind: "close", id: "close-1", terminal: "term-1" },
    ],
    // The key is idle at the output event, so a queuePersist here could not be coalesced away:
    // close's awaited drain would have had to land it. One write means only close persisted.
    expected: [
      eventToken("started"),
      returnToken("open-1"),
      issueToken("emit-osc"),
      eventToken("output"),
      writeToken("term-1", ""),
      eventToken("closed"),
      returnToken("close-1"),
    ],
    disk: [["term-1", ""]],
    notes: [
      "the-key-is-idle-at-the-output-event-so-a-stray-enqueue-could-not-hide-in-a-merge",
      "one-write-means-the-stripped-osc-query-scheduled-nothing",
    ],
  },
  {
    name: "empty-visible-csi",
    threadId: "thread-c",
    terminals: ["term-1"],
    claim: "a-stripped-csi-report-schedules-no-persist",
    steps: [
      { kind: "open", id: "open-1", terminal: "term-1", cwd: "a" },
      { kind: "emit", id: "emit-csi", terminal: "term-1", data: STRIPPED_CSI },
      { kind: "awaitEvent", type: "output" },
      { kind: "sample", label: "at-output-event" },
      { kind: "close", id: "close-1", terminal: "term-1" },
    ],
    expected: [
      eventToken("started"),
      returnToken("open-1"),
      issueToken("emit-csi"),
      eventToken("output"),
      writeToken("term-1", ""),
      eventToken("closed"),
      returnToken("close-1"),
    ],
    disk: [["term-1", ""]],
    notes: ["a-report-cursor-query-leaves-no-pending-control-sequence-behind"],
  },
  {
    name: "clear-before-debounce-lands",
    threadId: "thread-d",
    terminals: ["term-1"],
    claim: "an-immediate-persist-merges-into-the-queued-debounce-so-clear-lands-one-write",
    steps: [
      { kind: "open", id: "open-1", terminal: "term-1", cwd: "a" },
      { kind: "emit", id: "emit-gamma", terminal: "term-1", data: "gamma\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "sample", label: "before-clear" },
      { kind: "clear", id: "clear-1", terminal: "term-1" },
      { kind: "sample", label: "after-clear-returned" },
    ],
    // Deliberately no write latch between the output event and clear: this is the shape where the
    // debounced request has not been picked up yet. Measured: one write, not two. The merge keeps
    // the newer request and ORs the flag, so the merged request is immediate and the 40 ms debounce
    // never runs. It samples the history at write time, i.e. after `history.clear()`.
    expected: [
      eventToken("started"),
      returnToken("open-1"),
      issueToken("emit-gamma"),
      eventToken("output"),
      writeToken("term-1", ""),
      eventToken("cleared"),
      returnToken("clear-1"),
    ],
    disk: [["term-1", ""]],
    notes: [
      "contradicts-a-two-write-reading-of-queue-persist-then-persist-history",
      "the-merged-request-is-immediate-so-the-40ms-debounce-never-runs",
      "the-single-write-samples-the-post-clear-history",
    ],
  },
  {
    name: "output-then-clear",
    threadId: "thread-e",
    terminals: ["term-1"],
    claim: "clear-persists-the-cleared-history-before-the-cleared-event",
    steps: [
      { kind: "open", id: "open-1", terminal: "term-1", cwd: "a" },
      { kind: "emit", id: "emit-beta", terminal: "term-1", data: "beta\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "awaitWrites", id: "debounced-1", count: 1 },
      { kind: "clear", id: "clear-1", terminal: "term-1" },
    ],
    expected: [
      eventToken("started"),
      returnToken("open-1"),
      issueToken("emit-beta"),
      eventToken("output"),
      writeToken("term-1", "beta\n"),
      writeToken("term-1", ""),
      eventToken("cleared"),
      returnToken("clear-1"),
    ],
    disk: [["term-1", ""]],
  },
  {
    name: "output-then-restart",
    threadId: "thread-f",
    terminals: ["term-1"],
    claim: "restart-persists-the-cleared-history-before-the-restarted-event",
    steps: [
      { kind: "open", id: "open-1", terminal: "term-1", cwd: "a" },
      { kind: "emit", id: "emit-gamma", terminal: "term-1", data: "gamma\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "awaitWrites", id: "debounced-1", count: 1 },
      { kind: "sample", label: "before-restart" },
      { kind: "restart", id: "restart-1", terminal: "term-1", cwd: "a" },
    ],
    expected: [
      eventToken("started"),
      returnToken("open-1"),
      issueToken("emit-gamma"),
      eventToken("output"),
      writeToken("term-1", "gamma\n"),
      writeToken("term-1", ""),
      eventToken("restarted"),
      returnToken("restart-1"),
    ],
    disk: [["term-1", ""]],
    notes: ["restart-runs-stop-process-which-adds-no-write"],
  },
  {
    name: "exit-then-close",
    threadId: "thread-g",
    terminals: ["term-1"],
    claim: "the-exit-action-persists-nothing-while-close-still-persists-without-a-live-process",
    steps: [
      { kind: "open", id: "open-1", terminal: "term-1", cwd: "a" },
      { kind: "emit", id: "emit-delta", terminal: "term-1", data: "delta\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "awaitWrites", id: "debounced-1", count: 1 },
      { kind: "sample", label: "before-exit" },
      { kind: "exit", id: "exit-1", terminal: "term-1", code: 0 },
      { kind: "awaitEvent", type: "exited" },
      { kind: "sample", label: "after-exited-event" },
      { kind: "close", id: "close-1", terminal: "term-1" },
    ],
    expected: [
      eventToken("started"),
      returnToken("open-1"),
      issueToken("emit-delta"),
      eventToken("output"),
      writeToken("term-1", "delta\n"),
      issueToken("exit-1"),
      eventToken("exited"),
      writeToken("term-1", "delta\n"),
      eventToken("closed"),
      returnToken("close-1"),
    ],
    disk: [["term-1", "delta\n"]],
  },
  {
    name: "durability-at-close",
    threadId: "thread-h",
    terminals: ["term-1"],
    claim: "close-lands-the-still-pending-debounced-write-before-it-returns",
    steps: [
      { kind: "open", id: "open-1", terminal: "term-1", cwd: "a" },
      { kind: "emit", id: "emit-epsilon", terminal: "term-1", data: "epsilon\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "sample", label: "at-output-event" },
      { kind: "close", id: "close-1", terminal: "term-1" },
      { kind: "sample", label: "after-close-returned" },
    ],
    // No write latch on purpose. The output event is published with nothing written yet, and by the
    // time close returns the disk already equals the final history. Measured as a single write: the
    // immediate request merges into the queued debounced one, so no second write is issued.
    expected: [
      eventToken("started"),
      returnToken("open-1"),
      issueToken("emit-epsilon"),
      eventToken("output"),
      writeToken("term-1", "epsilon\n"),
      eventToken("closed"),
      returnToken("close-1"),
    ],
    disk: [["term-1", "epsilon\n"]],
    notes: [
      "at-the-output-event-no-write-had-landed-yet",
      "on-close-return-the-file-equals-the-final-history",
      "write-count-is-one-because-the-queued-debounce-merges-with-the-immediate-request",
    ],
  },
  {
    name: "secondary-terminal",
    threadId: "thread-i",
    terminals: ["term-1", "term-2"],
    claim: "writes-target-the-terminal-scoped-file-and-a-fresh-open-writes-nothing",
    steps: [
      { kind: "open", id: "open-default", terminal: "term-1", cwd: "a" },
      { kind: "open", id: "open-secondary", terminal: "term-2", cwd: "a" },
      { kind: "emit", id: "emit-zeta", terminal: "term-2", data: "zeta\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "awaitWrites", id: "debounced-1", count: 1 },
      { kind: "close", id: "close-secondary", terminal: "term-2" },
    ],
    expected: [
      eventToken("started"),
      returnToken("open-default"),
      eventToken("started"),
      returnToken("open-secondary"),
      issueToken("emit-zeta"),
      eventToken("output"),
      writeToken("term-2", "zeta\n"),
      writeToken("term-2", "zeta\n"),
      eventToken("closed"),
      returnToken("close-secondary"),
    ],
    disk: [
      ["term-1", "-"],
      ["term-2", "zeta\n"],
    ],
    notes: ["open-flushes-the-key-but-a-drain-of-an-idle-key-creates-no-write"],
  },
  {
    name: "relaunch-context-changed",
    threadId: "thread-j",
    terminals: ["term-1"],
    claim: "open-with-a-changed-launch-context-clears-and-persists-before-the-started-event",
    steps: [
      { kind: "open", id: "open-a", terminal: "term-1", cwd: "a" },
      { kind: "emit", id: "emit-eta", terminal: "term-1", data: "eta\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "awaitWrites", id: "debounced-1", count: 1 },
      { kind: "open", id: "open-b", terminal: "term-1", cwd: "b" },
    ],
    expected: [
      eventToken("started"),
      returnToken("open-a"),
      issueToken("emit-eta"),
      eventToken("output"),
      writeToken("term-1", "eta\n"),
      writeToken("term-1", ""),
      eventToken("started"),
      returnToken("open-b"),
    ],
    disk: [["term-1", ""]],
  },
  {
    name: "reopen-after-exit",
    threadId: "thread-k",
    terminals: ["term-1"],
    claim: "open-on-an-exited-session-clears-and-persists-before-the-started-event",
    steps: [
      { kind: "open", id: "open-1", terminal: "term-1", cwd: "a" },
      { kind: "emit", id: "emit-theta", terminal: "term-1", data: "theta\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "awaitWrites", id: "debounced-1", count: 1 },
      { kind: "exit", id: "exit-1", terminal: "term-1", code: 1 },
      { kind: "awaitEvent", type: "exited" },
      { kind: "open", id: "open-2", terminal: "term-1", cwd: "a" },
    ],
    expected: [
      eventToken("started"),
      returnToken("open-1"),
      issueToken("emit-theta"),
      eventToken("output"),
      writeToken("term-1", "theta\n"),
      issueToken("exit-1"),
      eventToken("exited"),
      writeToken("term-1", ""),
      eventToken("started"),
      returnToken("open-2"),
    ],
    disk: [["term-1", ""]],
  },
  {
    name: "second-open-unchanged",
    threadId: "thread-l",
    terminals: ["term-1"],
    claim: "open-on-a-live-unchanged-session-schedules-no-persist",
    steps: [
      { kind: "open", id: "open-1", terminal: "term-1", cwd: "a" },
      { kind: "emit", id: "emit-iota", terminal: "term-1", data: "iota\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "awaitWrites", id: "debounced-1", count: 1 },
      { kind: "open", id: "open-2", terminal: "term-1", cwd: "a", silent: true },
      { kind: "sample", label: "after-unchanged-open" },
      { kind: "close", id: "close-1", terminal: "term-1" },
    ],
    expected: [
      eventToken("started"),
      returnToken("open-1"),
      issueToken("emit-iota"),
      eventToken("output"),
      writeToken("term-1", "iota\n"),
      returnToken("open-2"),
      writeToken("term-1", "iota\n"),
      eventToken("closed"),
      returnToken("close-1"),
    ],
    disk: [["term-1", "iota\n"]],
  },
  {
    name: "close-without-output",
    threadId: "thread-m",
    terminals: ["term-1"],
    claim: "close-with-a-live-session-but-no-output-still-writes-once",
    steps: [
      { kind: "open", id: "open-1", terminal: "term-1", cwd: "a" },
      { kind: "sample", label: "after-open" },
      { kind: "close", id: "close-1", terminal: "term-1" },
    ],
    expected: [
      eventToken("started"),
      returnToken("open-1"),
      writeToken("term-1", ""),
      eventToken("closed"),
      returnToken("close-1"),
    ],
    disk: [["term-1", ""]],
  },
];

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

type TimelineEntry =
  | { readonly kind: "W"; readonly label: TerminalLabel; readonly content: string }
  | {
      readonly kind: "E";
      readonly type: string;
      readonly sequence: number;
      readonly valid: boolean;
    }
  | { readonly kind: "O"; readonly phase: "issue" | "return"; readonly id: string }
  | { readonly kind: "A"; readonly label: string }
  | { readonly kind: "Q"; readonly label: string; readonly writes: number; readonly events: number }
  | {
      readonly kind: "S";
      readonly label: string;
      readonly status: string;
      readonly history: string;
      readonly pid: number;
    };

interface TracedTerminal {
  readonly label: TerminalLabel;
  readonly terminalId: string;
  readonly basename: string;
  readonly filePath: string;
}

const timelineToken = (entry: TimelineEntry): string | null => {
  switch (entry.kind) {
    case "W":
      return writeToken(entry.label, entry.content);
    case "E":
      return eventToken(entry.type);
    case "O":
      return entry.phase === "return" ? returnToken(entry.id) : issueToken(entry.id);
    default:
      return null;
  }
};

const runScenario = Effect.fnUntraced(function* (scenario: Scenario) {
  ident(scenario.name);
  ident(scenario.threadId);
  ident(scenario.claim);
  NodeAssert.equal(
    new Set(scenario.terminals).size,
    scenario.terminals.length,
    `${scenario.name}: duplicate terminal label`,
  );
  for (const step of scenario.steps) {
    if (step.kind !== "awaitEvent" && step.kind !== "sample") ident(step.id);
  }

  const fs = yield* FileSystem.FileSystem;
  const { join, basename, dirname } = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({
    prefix: `lmcs-persist-calls-${scenario.name}-`,
  });
  const logsDir = join(baseDir, "userdata", "logs", "terminals");
  yield* fs.makeDirectory(logsDir, { recursive: true });
  const cwds: Record<CwdLabel, string> = {
    a: join(baseDir, "cwd-a"),
    b: join(baseDir, "cwd-b"),
  };
  yield* fs.makeDirectory(cwds.a, { recursive: true });
  yield* fs.makeDirectory(cwds.b, { recursive: true });

  // Filenames are rebuilt here, independently of the manager's private helpers, so an
  // unexpected write target fails the run instead of going untracked.
  const threadPart = `terminal_${Buffer.from(scenario.threadId, "utf8").toString("base64url")}`;
  const terminals: TracedTerminal[] = scenario.terminals.map((label) => {
    const terminalId = label;
    const fileName =
      terminalId === DEFAULT_TERMINAL_ID
        ? `${threadPart}.log`
        : `${threadPart}_${Buffer.from(terminalId, "utf8").toString("base64url")}.log`;
    return { label, terminalId, basename: fileName, filePath: join(logsDir, fileName) };
  });
  const byPath = new Map(terminals.map((terminal) => [terminal.filePath, terminal]));
  NodeAssert.equal(byPath.size, terminals.length, `${scenario.name}: traced paths collide`);

  const timeline: TimelineEntry[] = [];
  const rows: string[] = [];
  const writeSignals = yield* Effect.acquireRelease(Queue.unbounded<void>(), Queue.shutdown);
  const eventSignals = yield* Effect.acquireRelease(Queue.unbounded<void>(), Queue.shutdown);
  const adapter = new TracePtyAdapter();

  const landedWrites = () => timeline.filter((entry) => entry.kind === "W").length;
  const publishedEvents = () => timeline.filter((entry) => entry.kind === "E").length;

  const trackedFileSystem = FileSystem.FileSystem.of({
    ...fs,
    writeFileString: Effect.fnUntraced(function* (
      ...args: Parameters<FileSystem.FileSystem["writeFileString"]>
    ) {
      const [candidate, content] = args;
      NodeAssert.equal(
        dirname(candidate),
        logsDir,
        `${scenario.name}: write outside the traced log directory`,
      );
      const terminal = byPath.get(candidate);
      NodeAssert.ok(
        terminal !== undefined,
        `${scenario.name}: write to untracked history file ${basename(candidate)}`,
      );
      timeline.push({ kind: "W", label: terminal.label, content });
      yield* Queue.offer(writeSignals, undefined);
      yield* fs.writeFileString(...args);
    }),
  });

  const manager = yield* TerminalManager.makeWithOptions({
    logsDir,
    historyLineLimit: HISTORY_LINE_LIMIT,
    historyByteLimit: HISTORY_BYTE_LIMIT,
    ptyAdapter: adapter,
    env: {},
    shellResolver: () => DEFAULT_SHELL,
    subprocessInspector: () =>
      Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
    processKillGraceMs: 0,
  }).pipe(Effect.provideService(FileSystem.FileSystem, trackedFileSystem));

  let eventCursor = 0;
  const unsubscribe = yield* manager.subscribe((event: TerminalEvent) =>
    Effect.gen(function* () {
      // publishEvent ignores listener failures, so nothing asserts here; validate on the main fiber.
      timeline.push({
        kind: "E",
        type: event.type,
        sequence: event.sequence ?? -1,
        valid: isTerminalEvent(event),
      });
      yield* Queue.offer(eventSignals, undefined);
    }),
  );

  const terminalFor = (label: TerminalLabel) => {
    const terminal = terminals.find((candidate) => candidate.label === label);
    NodeAssert.ok(terminal !== undefined, `${scenario.name}: untraced terminal ${label}`);
    return terminal;
  };

  const awaitEvent = Effect.fnUntraced(function* (type: string) {
    while (eventCursor >= publishedEvents()) {
      yield* Queue.take(eventSignals);
    }
    const seen = timeline.filter(
      (entry): entry is Extract<TimelineEntry, { kind: "E" }> => entry.kind === "E",
    );
    const entry = seen[eventCursor];
    eventCursor += 1;
    NodeAssert.ok(entry !== undefined, `${scenario.name}: lost event record`);
    NodeAssert.equal(entry.valid, true, `${scenario.name}: published payload breaks TerminalEvent`);
    NodeAssert.ok(entry.sequence >= 0, `${scenario.name}: published event has no sequence`);
    NodeAssert.equal(
      entry.type,
      type,
      `${scenario.name}: expected the ${type} event, observed ${entry.type}`,
    );
  });

  const awaitWrites = Effect.fnUntraced(function* (id: string, count: number) {
    // Safe to block on: the request was enqueued while the key was idle, so the single consumer
    // must reach its write; only the duration is real time.
    while (landedWrites() < count) {
      yield* Queue.take(writeSignals);
    }
    timeline.push({ kind: "A", label: id });
  });

  // Each manager call publishes its own event before it returns, because `publishEvent` is
  // awaited inside the call. Draining that event here keeps the cursor aligned with the recorded
  // stream, and `undefined` asserts the call published nothing at all.
  const drainOwnedEvent = Effect.fnUntraced(function* (id: string, type: string | undefined) {
    if (type === undefined) {
      NodeAssert.equal(
        publishedEvents(),
        eventCursor,
        `${scenario.name}: ${id} published an event the trace did not expect`,
      );
      return;
    }
    yield* awaitEvent(type);
  });

  logSink = [];
  for (const step of scenario.steps) {
    switch (step.kind) {
      case "open": {
        const terminal = terminalFor(step.terminal);
        const result = yield* Effect.result(
          manager.open({
            threadId: scenario.threadId,
            terminalId: terminal.terminalId,
            cwd: cwds[step.cwd],
            cols: COLUMNS,
            rows: ROWS,
          }),
        );
        NodeAssert.equal(result._tag, "Success", `${scenario.name}: ${step.id} failed`);
        timeline.push({
          kind: "S",
          label: step.id,
          status: result.success.status,
          history: result.success.history,
          pid: result.success.pid ?? -1,
        });
        timeline.push({ kind: "O", phase: "return", id: step.id });
        yield* drainOwnedEvent(step.id, step.silent === true ? undefined : "started");
        break;
      }
      case "restart": {
        const terminal = terminalFor(step.terminal);
        const result = yield* Effect.result(
          manager.restart({
            threadId: scenario.threadId,
            terminalId: terminal.terminalId,
            cwd: cwds[step.cwd],
            cols: COLUMNS,
            rows: ROWS,
          }),
        );
        NodeAssert.equal(result._tag, "Success", `${scenario.name}: ${step.id} failed`);
        timeline.push({
          kind: "S",
          label: step.id,
          status: result.success.status,
          history: result.success.history,
          pid: result.success.pid ?? -1,
        });
        timeline.push({ kind: "O", phase: "return", id: step.id });
        yield* drainOwnedEvent(step.id, "restarted");
        break;
      }
      case "clear": {
        yield* manager.clear({
          threadId: scenario.threadId,
          terminalId: terminalFor(step.terminal).terminalId,
        });
        timeline.push({ kind: "O", phase: "return", id: step.id });
        yield* drainOwnedEvent(step.id, "cleared");
        break;
      }
      case "close": {
        yield* manager.close({
          threadId: scenario.threadId,
          terminalId: terminalFor(step.terminal).terminalId,
        });
        timeline.push({ kind: "O", phase: "return", id: step.id });
        yield* drainOwnedEvent(step.id, "closed");
        break;
      }
      case "emit": {
        timeline.push({ kind: "O", phase: "issue", id: step.id });
        yield* Effect.sync(() => adapter.live().emitOutput(step.data));
        break;
      }
      case "exit": {
        timeline.push({ kind: "O", phase: "issue", id: step.id });
        yield* Effect.sync(() => adapter.live().emitExit(step.code));
        break;
      }
      case "awaitEvent": {
        yield* awaitEvent(step.type);
        break;
      }
      case "awaitWrites": {
        yield* awaitWrites(step.id, step.count);
        break;
      }
      case "sample": {
        timeline.push({
          kind: "Q",
          label: step.label,
          writes: landedWrites(),
          events: publishedEvents(),
        });
        break;
      }
    }
  }

  NodeAssert.equal(publishedEvents(), eventCursor, `${scenario.name}: unconsumed published event`);
  NodeAssert.ok(
    adapter.processes.length >= 1 && adapter.processes.length <= scenario.steps.length,
    `${scenario.name}: implausible pty spawn count`,
  );
  unsubscribe();

  const logs = logSink;
  logSink = null;
  const warns = logs.filter((entry) => entry.level === "Warn");
  const errors = logs.filter((entry) => entry.level === "Error");
  NodeAssert.equal(
    warns.length,
    0,
    `${scenario.name}: swallowed persistence warning: ${warns[0]?.text ?? ""}`,
  );
  NodeAssert.equal(
    errors.length,
    0,
    `${scenario.name}: unexpected error log: ${errors[0]?.text ?? ""}`,
  );

  rows.push(row(["C", scenario.name, hex(scenario.threadId)]));
  for (const terminal of terminals) {
    rows.push(row(["T", hex(terminal.label), hex(terminal.terminalId), hex(terminal.basename)]));
  }

  let writeIndex = 0;
  for (const entry of timeline) {
    switch (entry.kind) {
      case "O": {
        rows.push(row(["O", hex(entry.phase), hex(entry.id)]));
        break;
      }
      case "E": {
        rows.push(row(["E", hex(entry.type), entry.sequence, entry.valid ? 1 : 0]));
        break;
      }
      case "W": {
        rows.push(
          row(["W", writeIndex, hex(terminalFor(entry.label).basename), hex(entry.content)]),
        );
        writeIndex += 1;
        break;
      }
      case "A": {
        rows.push(row(["A", hex(entry.label)]));
        break;
      }
      case "Q": {
        rows.push(row(["Q", hex(entry.label), entry.writes, entry.events]));
        break;
      }
      case "S": {
        rows.push(row(["S", hex(entry.label), hex(entry.status), hex(entry.history), entry.pid]));
        break;
      }
    }
  }
  NodeAssert.equal(writeIndex, landedWrites(), `${scenario.name}: write records disagree`);

  for (const [label, expectedContent] of scenario.disk) {
    const terminal = terminalFor(label);
    const exists = yield* fs.exists(terminal.filePath);
    NodeAssert.equal(
      exists,
      expectedContent !== "-",
      `${scenario.name}: ${label} file presence disagrees with the expectation`,
    );
    const disk = exists ? Buffer.from(yield* fs.readFile(terminal.filePath)).toString("utf8") : "-";
    rows.push(row(["D", hex(terminal.basename), hex(disk)]));
    NodeAssert.equal(
      disk,
      expectedContent,
      `${scenario.name}: ${label} disk content disagrees with the expectation`,
    );
  }

  rows.push(row(["P", adapter.processes.length]));
  rows.push(row(["L", warns.length, errors.length]));

  const observed = timeline.map(timelineToken).filter((token) => token !== null);
  const matches =
    observed.length === scenario.expected.length &&
    observed.every((token, index) => token === scenario.expected[index]);
  rows.push(
    row([
      "V",
      scenario.claim,
      matches ? "match" : "diff",
      matches ? "-" : hex(`observed=${observed.join(",")} expected=${scenario.expected.join(",")}`),
    ]),
  );
  for (const note of scenario.notes ?? []) {
    NodeAssert.ok(!note.includes("\t") && !note.includes("\n"), "note must be single line");
    rows.push(row(["N", hex(note)]));
  }
  rows.push(row(["X", scenario.name]));
  return rows;
});

const run = Effect.gen(function* () {
  NodeAssert.equal(DEFAULT_TERMINAL_ID, "term-1", "default terminal identity changed");
  NodeAssert.equal(
    new Set(scenarios.map((scenario) => scenario.name)).size,
    scenarios.length,
    "duplicate scenario names",
  );
  NodeAssert.equal(
    new Set(scenarios.map((scenario) => scenario.threadId)).size,
    scenarios.length,
    "scenario thread ids must be unique",
  );
  const rows: string[] = [
    row([
      "H",
      HISTORY_LINE_LIMIT,
      HISTORY_BYTE_LIMIT,
      0,
      hex(DEFAULT_TERMINAL_ID),
      hex(DEFAULT_SHELL),
    ]),
  ];
  for (const scenario of scenarios) rows.push(...(yield* Effect.scoped(runScenario(scenario))));
  rows.push(row(["Z", scenarios.length, "end"]));
  return rows;
});

// Top-level await also makes an unresolved receipt a failed Node run, not silent success.
try {
  const rows = await Effect.runPromise(
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
  process.stderr.write(
    `terminal persist calls trace: ${scenarios.length} cases, ${rows.length} rows\n`,
  );
  process.stdout.write(`${rows.join("\n")}\n`);
} catch (cause) {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
}
