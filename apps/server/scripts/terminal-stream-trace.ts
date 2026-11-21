// Trace generator for terminal STREAM FAN-OUT and RESIZE. It drives the shipped `TerminalManager`
// (real code, not a reimplementation) through the two socket streams a client lives on —
// `attachStream` (one terminal) and `subscribeMetadata` (the sessions list) — and records, in one
// chronological stream per case, every published `TerminalEvent`, every frame each stream delivered,
// every row inside a `snapshot` frame, and every call boundary.
//
// Why frames rather than events: the two streams are not the event feed. `attachStream` buffers what
// its own lookup publishes, replays it behind the initial snapshot minus the duplicates, and turns a
// `started` into a `snapshot` frame; `subscribeMetadata` drops output and cleared events entirely and
// reads the sessions map again when it handles an event. Only the delivered frames are what a client
// can see, so only they are worth porting byte for byte.
//
// `resize` is measured in the same run because it is the one mutation that refreshes a session's
// `updatedAt` — the field the sessions list sorts on — without publishing anything: the row moves for
// the next snapshot and no client is told.
//
// Nothing here waits on a sleep or a poll: events and frames arrive as receipts on unbounded queues.
// The Manager's `updatedAt` stamps are the one input this harness cannot inject through options, so it
// drives `Date.now` (see the clock block): stamps are recorded as `t1..tn` labels by sorting them
// after the case.
//
// Read-only probe: scoped temp directories only, no live install, no dev server, no source edits.
//
// Run from the repository root:
//   node apps/server/scripts/terminal-stream-trace.ts [outFile]
// Writes the trace to <outFile> and a decoded copy to the same path with `.txt` replaced by
// `-decoded.txt`.
//
// ---------------------------------------------------------------------------
// Record grammar. Tab separated, one record per line; field 1 is the record code. Data-derived
// strings (thread ids, statuses, messages, stream names) are UTF-8 hex so a tab or newline cannot
// corrupt a row; "-" means absent. `seq` is one global counter that never resets, so rows from
// different sources interleave in the order they really happened.
//   H  defaultTerminalIdHex                         harness constants, once
//   I  maskedIso                                    DateTime.formatIso shape with every digit masked
//   Q  noteHex            measurement note (explicit, never a guess); after a `C` it records what an
//                            await had to cross, so a barrier never hides the real event order
//   C  name cap clock threadsHex spawnFailRaw      case header
//   B  seq kind raw id raw statusHex                Manager call boundary (issue / return)
//   O  seq typeHex threadHex terminalHex eventSeqRaw pidRaw exitHex signalHex stampLabel hasSnapRaw
//                                                      a published TerminalEvent; `hasSnap` says the
//                                                      event carried a snapshot of its own
//   R  seq streamHex frameHex threadHex terminalHex sequenceRaw stampLabel validRaw
//                                                      one frame one stream delivered
//   V  seq streamHex index threadHex terminalHex statusHex pidRaw exitHex signalHex stampLabel
//                                                      one row inside a `snapshot` frame, in the order
//                                                      the Manager sorted it
//   P  name callsRaw       how many times a fake pty was resized, per case (`pty` is the only name)
//   A  claim match|diff detailHex                   one measured answer to a question; "diff" marks an
//                                                      observation that contradicts the expectation, it
//                                                      never aborts the run
//   X  name                                         case terminator
//   Z  caseCount frameCount end                     global terminator
// ---------------------------------------------------------------------------

import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_TERMINAL_ID,
  TerminalAttachStreamEvent,
  TerminalEvent,
  TerminalMetadataStreamEvent,
} from "@lmcstools/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../src/processRunner.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";
import * as PtyAdapter from "../src/terminal/PtyAdapter.ts";

const isTerminalEvent = Schema.is(TerminalEvent);
const isAttachFrame = Schema.is(TerminalAttachStreamEvent);
const isMetadataFrame = Schema.is(TerminalMetadataStreamEvent);

const OUT_FILE =
  process.argv[2] ?? "/Users/leandroadasilva/.cache/lmcs-port-traces/terminal-stream-trace.txt";
const DECODED_FILE = OUT_FILE.replace(/\.txt$/, "-decoded.txt");

const caseFilter = process.env["LMCS_STREAM_ONLY"]?.split(",");
const stepTrace = process.env["LMCS_STREAM_STEPS"] === "1";

// How many scheduler turns a barrier waits after the last signal it consumed. See the barrier block in
// `runCase`: it is a yield budget, not a timeout, and no case in this harness needed more than a few.
const SETTLE_YIELDS = 200;

// Both stamp paths read the wall clock (`nowIso` at Manager.ts:104 and `DateTime.nowUnsafe()` inside
// `advanceEventSequence` at :438). The harness owns `Date.now`: each read advances a fixed epoch by
// one millisecond so stamps are strictly ordered, and a case may freeze the advance. The trace records
// stamp *order* as labels, never values.
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

const value = (input: unknown): string => {
  if (input === null || input === undefined) return "-";
  if (typeof input === "number") return Number.isFinite(input) ? String(input) : "nonfinite";
  if (typeof input === "string") return ident(input);
  if (typeof input === "boolean") return input ? "1" : "0";
  return "opaque";
};

const text = (input: unknown): string => (typeof input === "string" ? input : "<nonstring>");

// ---------------------------------------------------------------------------
// Fake PTY. `resizes` is the point: it separates "the Manager decided to resize" from "the call
// reached the process", which the stream records alone cannot show.
// ---------------------------------------------------------------------------

class TracePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid: number;
  resizes = 0;
  writes = 0;
  kills = 0;
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
  private nextPid = 7600;

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

  totalResizes(): number {
    return this.processes.reduce((total, process) => total + process.resizes, 0);
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
  | {
      readonly kind: "open";
      readonly id: string;
      readonly thread: number;
      readonly term: string;
      readonly cols?: number;
      readonly rows?: number;
    }
  | {
      readonly kind: "attach";
      readonly id: string;
      readonly thread: number;
      readonly term: string;
      readonly start?: boolean;
      readonly cols?: number;
      readonly rows?: number;
    }
  | { readonly kind: "metadata"; readonly id: string }
  | {
      readonly kind: "reopen";
      readonly id: string;
      readonly thread: number;
      readonly term: string;
      readonly cols?: number;
      readonly rows?: number;
    }
  | { readonly kind: "detach"; readonly id: string }
  | { readonly kind: "emit"; readonly spawn: number; readonly data: string }
  | {
      readonly kind: "exit";
      readonly spawn: number;
      readonly code: number;
      readonly signal: number | null;
    }
  | { readonly kind: "awaitEvent"; readonly type: string }
  | { readonly kind: "awaitFrames"; readonly stream: string; readonly count: number }
  | { readonly kind: "write"; readonly thread: number; readonly term: string }
  | {
      readonly kind: "resize";
      readonly thread: number;
      readonly term: string;
      readonly cols: number;
      readonly rows: number;
    }
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
  readonly clock?: "step" | "frozen";
  readonly steps: ReadonlyArray<Step>;
  readonly claims: ReadonlyArray<string>;
}

const THREAD_A = "thread-a";
const THREAD_B = "thread-b";
const T1 = "term-1";
const T2 = "term-2";

const caseSpecs: ReadonlyArray<CaseSpec> = [
  {
    // A client attached to a live terminal: what the plain event feed forwards, and what it does not.
    name: "attach-live-feed",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "attach", id: "a1", thread: 0, term: T1 },
      { kind: "awaitFrames", stream: "a1", count: 1 },
      { kind: "emit", spawn: 0, data: "hello\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "resize", thread: 0, term: T1, cols: 132, rows: 43 },
      { kind: "awaitFrames", stream: "a1", count: 2 },
      { kind: "clear", id: "clear-1", thread: 0, term: T1 },
      { kind: "exit", spawn: 0, code: 4, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "close", id: "close-1", thread: 0, term: T1 },
      { kind: "awaitFrames", stream: "a1", count: 5 },
    ],
    claims: [
      "attach-frames-in-order",
      "attach-frames-carry-event-sequences",
      "resize-added-no-frame",
      "resize-reached-the-pty",
      "closed-reached-the-attach",
    ],
  },
  {
    // The race the duplicate rule exists for: the stream subscribes, then its own lookup starts the
    // terminal, so the `started` the lookup caused is buffered and has to be dropped behind the
    // snapshot that already describes it.
    name: "attach-starts-its-own-terminal",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "attach", id: "a1", thread: 0, term: T1, start: true },
      { kind: "awaitFrames", stream: "a1", count: 1 },
      { kind: "emit", spawn: 0, data: "after\n" },
      { kind: "awaitFrames", stream: "a1", count: 2 },
    ],
    claims: [
      "buffered-start-dropped",
      "snapshot-describes-running",
      "snapshot-carries-the-start-sequence",
      "live-output-after-open",
    ],
  },
  {
    // A terminal that ran, exited and was opened again while the client stayed attached: the second
    // start is news, and it arrives as a snapshot rather than as `started`.
    name: "attach-reopen-sends-snapshot",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "attach", id: "a1", thread: 0, term: T1 },
      { kind: "awaitFrames", stream: "a1", count: 1 },
      { kind: "exit", spawn: 0, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "open", id: "open-2", thread: 0, term: T1 },
      { kind: "awaitFrames", stream: "a1", count: 3 },
    ],
    claims: ["reopen-sends-two-frames", "reopen-start-arrives-as-snapshot"],
  },
  {
    // Two clients on one terminal and one on another: the registry walks listeners in subscription
    // order, so both clients see the same interleaving and the neighbour sees nothing of it.
    name: "attach-two-clients-and-a-neighbour",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "open", id: "open-2", thread: 0, term: T2 },
      { kind: "attach", id: "a1", thread: 0, term: T1 },
      { kind: "attach", id: "a2", thread: 0, term: T1 },
      { kind: "attach", id: "a3", thread: 0, term: T2 },
      { kind: "awaitFrames", stream: "a3", count: 1 },
      { kind: "emit", spawn: 0, data: "shared\n" },
      { kind: "awaitFrames", stream: "a2", count: 2 },
      { kind: "exit", spawn: 1, code: 9, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "awaitFrames", stream: "a3", count: 2 },
    ],
    claims: [
      "two-clients-get-the-same-frames",
      "delivery-follows-subscription-order",
      "neighbour-events-stay-out",
    ],
  },
  {
    // The sessions list: which events rewrite it, what a row contains when it does, and that a close
    // removes a row the table no longer has.
    name: "metadata-lifecycle",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "metadata", id: "m1" },
      { kind: "awaitFrames", stream: "m1", count: 1 },
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "emit", spawn: 0, data: "text\n" },
      { kind: "awaitEvent", type: "output" },
      { kind: "clear", id: "clear-1", thread: 0, term: T1 },
      { kind: "exit", spawn: 0, code: 6, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "close", id: "close-1", thread: 0, term: T1, del: true },
      { kind: "awaitFrames", stream: "m1", count: 4 },
    ],
    claims: [
      "metadata-frames-in-order",
      "text-and-clear-are-not-metadata",
      "upsert-describes-the-exit",
      "metadata-frames-carry-no-sequence",
      "closed-removes-without-a-row",
    ],
  },
  {
    // A spawn that fails at ceiling zero: retention removes the record before the `error` is
    // published, so the sessions watcher has no row to write, and the attach client's own snapshot
    // already describes the failure — which is what makes the buffered `error` a duplicate.
    name: "metadata-error-after-eviction",
    cap: 0,
    threads: [THREAD_A],
    failSpawn: true,
    steps: [
      { kind: "metadata", id: "m1" },
      { kind: "attach", id: "a1", thread: 0, term: T1, start: true },
      { kind: "awaitEvent", type: "error" },
      { kind: "awaitFrames", stream: "a1", count: 1 },
      { kind: "awaitFrames", stream: "m1", count: 1 },
    ],
    claims: [
      "error-reached-the-feed",
      "buffered-error-dropped-behind-snapshot",
      "evicted-terminal-has-no-row",
      "evicted-open-still-snapshots",
    ],
  },
  {
    // `resize` is the mutation that refreshes the sort key without announcing itself, so the only way
    // a client learns is the next snapshot it is sent.
    name: "resize-moves-the-row-silently",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "open", id: "open-2", thread: 0, term: T2 },
      { kind: "resize", thread: 0, term: T1, cols: 90, rows: 30 },
      { kind: "metadata", id: "m1" },
      { kind: "awaitFrames", stream: "m1", count: 1 },
      { kind: "resize", thread: 0, term: T2, cols: 91, rows: 31 },
      { kind: "metadata", id: "m2" },
      { kind: "awaitFrames", stream: "m2", count: 1 },
    ],
    claims: [
      "resize-published-nothing",
      "resize-refreshed-the-sort-key",
      "resize-order-flips-between-snapshots",
    ],
  },
  {
    // Resize of a terminal with no process, and of one the table never had: both are silent in the
    // shipped call and neither may reach the pty.
    name: "resize-of-an-idle-terminal",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "exit", spawn: 0, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "attach", id: "a1", thread: 0, term: T1 },
      { kind: "awaitFrames", stream: "a1", count: 1 },
      { kind: "resize", thread: 0, term: T1, cols: 40, rows: 12 },
      { kind: "resize", thread: 0, term: "term-9", cols: 41, rows: 13 },
      { kind: "metadata", id: "m1" },
      { kind: "awaitFrames", stream: "m1", count: 1 },
    ],
    claims: [
      "resize-of-exited-reached-nothing",
      "resize-of-unknown-reached-nothing",
      "exited-kept-its-own-stamp",
    ],
  },
  {
    // A detach in the middle: the removed client stops hearing frames and the others are untouched,
    // which is what a closed websocket must do to its neighbours.
    name: "detach-leaves-the-others-alone",
    cap: 128,
    threads: [THREAD_A, THREAD_B],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-a1", thread: 0, term: T1 },
      { kind: "open", id: "open-b1", thread: 1, term: T1 },
      { kind: "attach", id: "a1", thread: 0, term: T1 },
      { kind: "metadata", id: "m1" },
      { kind: "attach", id: "a2", thread: 1, term: T1 },
      { kind: "awaitFrames", stream: "a2", count: 1 },
      { kind: "detach", id: "a1" },
      { kind: "exit", spawn: 1, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "awaitFrames", stream: "a2", count: 2 },
      { kind: "awaitFrames", stream: "m1", count: 2 },
      { kind: "exit", spawn: 0, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "awaitFrames", stream: "m1", count: 3 },
    ],
    claims: [
      "detached-client-stops",
      "others-keep-hearing",
      "thread-filter-is-exact",
      "metadata-listener-hears-first",
      "every-exit-restamps-its-row",
    ],
  },
  {
    // `openOrAttachForStream` only resizes when the client asks for a size the record does not already
    // hold (Manager.ts:2684), so an attach that matches the terminal neither reaches the pty nor moves
    // the sort key.
    name: "attach-of-a-running-terminal-keeps-its-size",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "attach", id: "a1", thread: 0, term: T1, cols: 100, rows: 24 },
      { kind: "awaitFrames", stream: "a1", count: 1 },
      { kind: "metadata", id: "m1" },
      { kind: "awaitFrames", stream: "m1", count: 1 },
    ],
    claims: ["attach-same-size-reached-no-pty", "attach-same-size-kept-the-open-stamp"],
  },
  {
    // The other side of the same gate: a client whose viewport differs resizes the live process and
    // restamps the record, and neither of those is announced as an event.
    name: "attach-of-a-running-terminal-takes-a-new-size",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "attach", id: "a1", thread: 0, term: T1, cols: 132, rows: 43 },
      { kind: "awaitFrames", stream: "a1", count: 1 },
      { kind: "metadata", id: "m1" },
      { kind: "awaitFrames", stream: "m1", count: 1 },
    ],
    claims: [
      "attach-new-size-reached-the-pty",
      "attach-new-size-restamped-its-snapshot",
      "attach-new-size-published-no-event",
    ],
  },
  {
    // The gate needs a live process, so a terminal that has exited keeps its size to itself: the same
    // attach that resized above reaches nothing here.
    name: "attach-of-an-exited-terminal-skips-the-size-gate",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "attach", id: "a1", thread: 0, term: T1, cols: 132, rows: 43 },
      { kind: "awaitFrames", stream: "a1", count: 1 },
      { kind: "exit", spawn: 0, code: 0, signal: null },
      { kind: "awaitEvent", type: "exited" },
      { kind: "attach", id: "a2", thread: 0, term: T1, cols: 90, rows: 20 },
      { kind: "awaitFrames", stream: "a2", count: 1 },
      { kind: "metadata", id: "m1" },
      // Only the snapshot: the exit happened before this client subscribed, so the metadata stream
      // has nothing left to hear.
      { kind: "awaitFrames", stream: "m1", count: 1 },
    ],
    claims: ["attach-after-exit-reached-no-pty", "attach-after-exit-shared-the-view-stamp"],
  },
  {
    // Re-opening a live terminal is not a start: the shipped `openLocked` answers with a snapshot of
    // the session it found, and a matching size means it changed nothing at all.
    name: "reopen-of-a-running-terminal-with-its-size",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "reopen", id: "reopen-1", thread: 0, term: T1, cols: 100, rows: 24 },
      { kind: "metadata", id: "m1" },
      { kind: "awaitFrames", stream: "m1", count: 1 },
    ],
    claims: [
      "reopen-of-running-published-no-event",
      "reopen-of-running-reached-no-pty",
      "reopen-of-running-left-the-stamp-alone",
    ],
  },
  {
    // The same call with a different viewport, which is the only way a re-open touches the process.
    name: "reopen-of-a-running-terminal-with-a-new-size",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "reopen", id: "reopen-1", thread: 0, term: T1, cols: 132, rows: 43 },
      { kind: "metadata", id: "m1" },
      { kind: "awaitFrames", stream: "m1", count: 1 },
    ],
    claims: ["reopen-new-size-reached-the-pty", "reopen-new-size-restamped-without-an-event"],
  },
  {
    // The record keeps the size it was resized to, so a second client asking for it changes nothing and
    // a third asking for the original size resizes back.
    name: "attach-sizes-are-remembered-between-clients",
    cap: 128,
    threads: [THREAD_A],
    failSpawn: false,
    steps: [
      { kind: "open", id: "open-1", thread: 0, term: T1 },
      { kind: "attach", id: "a1", thread: 0, term: T1, cols: 132, rows: 43 },
      { kind: "awaitFrames", stream: "a1", count: 1 },
      { kind: "attach", id: "a2", thread: 0, term: T1, cols: 132, rows: 43 },
      { kind: "awaitFrames", stream: "a2", count: 1 },
      { kind: "attach", id: "a3", thread: 0, term: T1, cols: 100, rows: 24 },
      { kind: "awaitFrames", stream: "a3", count: 1 },
    ],
    claims: [
      "remembered-size-resized-once",
      "second-attach-shared-the-first-stamp",
      "asking-for-the-old-size-resized-again",
    ],
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
  readonly threadId: string;
  readonly terminalId: string;
  readonly eventSeq: string;
  readonly pid: string;
  readonly exitCode: string;
  readonly exitSignal: string;
  readonly stamp: string;
  readonly hasSnapshot: boolean;
  readonly valid: boolean;
}

interface ObsFrame {
  readonly seq: number;
  readonly stream: string;
  readonly type: string;
  readonly threadId: string;
  readonly terminalId: string;
  readonly sequence: string;
  readonly stamp: string;
  readonly valid: boolean;
  readonly rows: ReadonlyArray<ObsTerminal>;
}

interface ObsTerminal {
  readonly seq: number;
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
  readonly frames: ReadonlyArray<ObsFrame>;
  readonly notes: ReadonlyArray<string>;
  readonly stamps: ReadonlyArray<string>;
  readonly resizeCalls: number;
  readonly frameCount: number;
}

const runCase = Effect.fnUntraced(function* (spec: CaseSpec) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  clockAdvance = spec.clock === "frozen" ? 0 : 1;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: `lmcs-stream-${spec.name}-` });
  const logsDir = path.join(baseDir, "userdata", "logs", "terminals");
  const cwd = path.join(baseDir, "cwd");
  yield* fs.makeDirectory(cwd, { recursive: true });

  const boundaries: ObsBoundary[] = [];
  const events: ObsEvent[] = [];
  const frames: ObsFrame[] = [];
  const notes: string[] = [];
  const stamps: string[] = [];
  const unsubscribers = new Map<string, () => void>();

  const adapter = new TracePtyAdapter();
  adapter.failSpawn = spec.failSpawn;

  const eventSignals = yield* Effect.acquireRelease(Queue.unbounded<void>(), Queue.shutdown);
  const frameSignals = yield* Effect.acquireRelease(Queue.unbounded<void>(), Queue.shutdown);
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

  // The plain event feed, kept separate from the streams so a frame the client never saw is still
  // recorded as published.
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
        stamp: typeof carried?.updatedAt === "string" ? carried.updatedAt : "-",
        hasSnapshot: carried !== undefined,
        valid: isTerminalEvent(event),
      });
      return Effect.runSync(Queue.offer(eventSignals, undefined));
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeFeed()));

  const recordFrame = (stream: string, frame: Record<string, unknown>, attach: boolean) => {
    const type = text(frame.type);
    const seq = nextSeq();
    const inner = (frame.snapshot ?? frame.terminal) as Record<string, unknown> | undefined;
    if (inner !== undefined && typeof inner.updatedAt === "string") stamps.push(inner.updatedAt);
    const rows: ObsTerminal[] = [];
    const terminals = frame.terminals as ReadonlyArray<Record<string, unknown>> | undefined;
    if (terminals !== undefined) {
      for (const terminal of terminals) {
        const stamp = typeof terminal.updatedAt === "string" ? terminal.updatedAt : "-";
        if (stamp !== "-") stamps.push(stamp);
        rows.push({
          seq: nextSeq(),
          index: rows.length,
          threadId: text(terminal.threadId),
          terminalId: text(terminal.terminalId),
          status: text(terminal.status),
          pid: value(terminal.pid),
          exitCode: value(terminal.exitCode),
          exitSignal: value(terminal.exitSignal),
          stamp,
        });
      }
    }
    frames.push({
      seq,
      stream,
      type,
      threadId: text(inner?.threadId ?? frame.threadId),
      terminalId: text(inner?.terminalId ?? frame.terminalId),
      sequence: value(inner?.sequence ?? frame.sequence),
      stamp: typeof inner?.updatedAt === "string" ? inner.updatedAt : "-",
      valid: attach ? isAttachFrame(frame) : isMetadataFrame(frame),
      rows,
    });
    return Effect.runSync(Queue.offer(frameSignals, undefined));
  };

  // Receipt-driven barriers that can report absence instead of hanging on it.
  //
  // Every fan-out the trace measures happens inside the Manager call that publishes it, so the signals
  // are normally already queued when a step asks for them; a step therefore polls the queue and, if it
  // is empty, gives the scheduler a bounded number of yields to run a fiber that is mid-publish. The
  // bound is a yield count, never a wall-clock wait, so nothing here depends on machine speed. If the
  // observation still does not appear, the harness records a note: an absent frame is a measured
  // outcome, and aborting the case would throw away the rest of the record.
  let eventCursor = 0;
  const awaitEvent = Effect.fnUntraced(function* (type: string) {
    const crossed: string[] = [];
    let idle = 0;
    while (idle < SETTLE_YIELDS) {
      while (eventCursor < events.length) {
        const event = events[eventCursor];
        idle = 0;
        if (event?.type === type) {
          if (crossed.length > 0) {
            notes.push(`${spec.name}: ${type} waited behind ${crossed.join(",")}`);
          }
          eventCursor += 1;
          return;
        }
        crossed.push(`${event?.type}@${event?.terminalId}`);
        eventCursor += 1;
      }
      const signal = yield* Queue.poll(eventSignals);
      if (Option.isSome(signal)) {
        idle = 0;
        continue;
      }
      yield* Effect.yieldNow;
      idle += 1;
    }
    notes.push(
      `${spec.name}: no ${type} event${crossed.length === 0 ? "" : ` (crossed ${crossed.join(",")})`}`,
    );
  });

  const awaitFrames = Effect.fnUntraced(function* (stream: string, count: number) {
    const seen = () => frames.filter((frame) => frame.stream === stream).length;
    let idle = 0;
    while (seen() < count && idle < SETTLE_YIELDS) {
      const signal = yield* Queue.poll(frameSignals);
      if (Option.isSome(signal)) {
        idle = 0;
        continue;
      }
      yield* Effect.yieldNow;
      idle += 1;
    }
    if (seen() < count) {
      notes.push(`${spec.name}: ${stream} delivered ${seen()} of ${count} frames`);
    }
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
      const detail =
        step.kind === "emit" || step.kind === "exit"
          ? `spawn-${step.spawn}`
          : step.kind === "awaitEvent"
            ? step.type
            : step.kind === "awaitFrames"
              ? `${step.stream}=${step.count}`
              : step.kind === "resize"
                ? `${step.term}:${step.cols}x${step.rows}`
                : step.kind === "failSpawn"
                  ? String(step.on)
                  : step.kind === "metadata"
                    ? step.id
                    : "id" in step
                      ? step.id
                      : step.term;
      process.stderr.write(`  ${spec.name}: ${step.kind} ${detail}\n`);
    }
    switch (step.kind) {
      case "open": {
        const result = yield* call(
          "open",
          ident(step.id),
          manager.open({
            threadId: threadOf(step.thread),
            terminalId: step.term,
            cwd,
            cols: step.cols ?? 100,
            rows: step.rows ?? 24,
          }),
        );
        if (result._tag === "Success") {
          const snapshot = result.success as unknown as Record<string, unknown>;
          if (typeof snapshot.updatedAt === "string") stamps.push(snapshot.updatedAt);
        }
        yield* awaitEvent(spec.failSpawn ? "error" : "started");
        break;
      }
      case "attach": {
        const stream = ident(step.id);
        const before = frames.length;
        const thread = threadOf(step.thread);
        const result = yield* call(
          "attach",
          stream,
          manager.attachStream(
            {
              threadId: thread,
              terminalId: step.term,
              ...(step.start === true ? { cwd, restartIfNotRunning: true } : {}),
              ...(step.cols === undefined ? {} : { cols: step.cols, rows: step.rows ?? 24 }),
            },
            (event) =>
              Effect.sync(() =>
                recordFrame(stream, event as unknown as Record<string, unknown>, true),
              ),
          ),
        );
        if (result._tag === "Success") {
          const detach = result.success as () => void;
          unsubscribers.set(stream, detach);
        }
        // The stream's own lookup can start the terminal, which publishes a `started` this very stream
        // has to absorb. Waiting on the boundary rather than the frame is what keeps the window real.
        if (frames.length === before) {
          notes.push(`${spec.name}: ${stream} delivered no snapshot`);
        }
        break;
      }
      case "reopen": {
        // `open` of a terminal the table already holds: the shipped call answers with a snapshot of the
        // session it found and publishes nothing, so there is no event to wait for. The stamps the
        // record ends with are the observation, and the metadata snapshot that follows reads them off
        // the table.
        const result = yield* call(
          "reopen",
          ident(step.id),
          manager.open({
            threadId: threadOf(step.thread),
            terminalId: step.term,
            cwd,
            cols: step.cols ?? 100,
            rows: step.rows ?? 24,
          }),
        );
        if (result._tag === "Success") {
          const snapshot = result.success as unknown as Record<string, unknown>;
          if (typeof snapshot.updatedAt === "string") stamps.push(snapshot.updatedAt);
        }
        break;
      }
      case "metadata": {
        const stream = ident(step.id);
        const before = frames.length;
        const result = yield* call(
          "metadata",
          stream,
          manager.subscribeMetadata((event) =>
            Effect.sync(() =>
              recordFrame(stream, event as unknown as Record<string, unknown>, false),
            ),
          ),
        );
        if (result._tag === "Success") {
          unsubscribers.set(stream, result.success as () => void);
        }
        if (frames.length === before) {
          notes.push(`${spec.name}: ${stream} delivered no snapshot`);
        }
        break;
      }
      case "detach": {
        const stream = ident(step.id);
        const detach = unsubscribers.get(stream);
        NodeAssert.ok(detach !== undefined, `${spec.name}: ${stream} was never subscribed`);
        boundaries.push({ seq: nextSeq(), kind: "detach", id: stream, status: "-" });
        yield* Effect.sync(() => detach());
        boundaries.push({ seq: nextSeq(), kind: "detach", id: stream, status: "ok" });
        unsubscribers.delete(stream);
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
      case "awaitFrames": {
        yield* awaitFrames(ident(step.stream), step.count);
        break;
      }
      case "write": {
        yield* call(
          "write",
          `write-${ident(step.term)}`,
          manager.write({ threadId: threadOf(step.thread), terminalId: step.term, data: "x" }),
        );
        break;
      }
      case "resize": {
        yield* call(
          "resize",
          `resize-${ident(step.term)}`,
          manager.resize({
            threadId: threadOf(step.thread),
            terminalId: step.term,
            cols: step.cols,
            rows: step.rows,
          }),
        );
        break;
      }
      case "clear": {
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

  return {
    name: spec.name,
    cap: spec.cap,
    clock: spec.clock ?? "step",
    threads: spec.threads,
    failSpawn: spec.failSpawn,
    claims: spec.claims,
    boundaries,
    events,
    frames,
    notes,
    stamps,
    resizeCalls: adapter.totalResizes(),
    frameCount: frames.length,
  } satisfies CaseResult;
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const stampLabels = (result: CaseResult): Map<string, string> => {
  const distinct = [...new Set(result.stamps)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return new Map(distinct.map((stamp, index) => [stamp, `t${index + 1}`]));
};

const timedRows = (result: CaseResult): Row[] => {
  const label = stampLabels(result);
  const stamp = (value_: string) => label.get(value_) ?? "-";
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
          raw(stamp(event.stamp)),
          raw(event.hasSnapshot ? 1 : 0),
          raw(event.valid ? 1 : 0),
        ],
      },
    });
  }
  for (const frame of result.frames) {
    rows.push({
      seq: frame.seq,
      row: {
        code: "R",
        fields: [
          raw(frame.seq),
          raw(frame.stream),
          hexOf(frame.type),
          hexOf(frame.threadId),
          hexOf(frame.terminalId),
          raw(frame.sequence),
          raw(stamp(frame.stamp)),
          raw(frame.valid ? 1 : 0),
        ],
      },
    });
    for (const terminal of frame.rows) {
      rows.push({
        seq: terminal.seq,
        row: {
          code: "V",
          fields: [
            raw(terminal.seq),
            raw(frame.stream),
            raw(terminal.index),
            hexOf(terminal.threadId),
            hexOf(terminal.terminalId),
            hexOf(terminal.status),
            raw(terminal.pid),
            raw(terminal.exitCode),
            raw(terminal.exitSignal),
            raw(stamp(terminal.stamp)),
          ],
        },
      });
    }
  }
  rows.sort((left, right) => left.seq - right.seq || left.row.code.localeCompare(right.row.code));
  return rows.map((entry) => entry.row);
};

const frameStream = (result: CaseResult, stream: string): ReadonlyArray<ObsFrame> =>
  result.frames.filter((frame) => frame.stream === stream);

const frameTypes = (result: CaseResult, stream: string): string =>
  frameStream(result, stream)
    .map((frame) => frame.type)
    .join(",");

const frameAt = (result: CaseResult, stream: string, index: number): ObsFrame | undefined =>
  frameStream(result, stream)[index];

const viewOf = (result: CaseResult, stream: string, index: number): string => {
  const frame = frameAt(result, stream, index);
  if (frame === undefined) return "missing";
  return frame.rows
    .map((row) => `${row.threadId}/${row.terminalId}:${row.status}:${row.stamp}`)
    .join(",");
};

// Claims see the raw stamps, not the `t1..tn` labels (labels exist only in the written rows). The `I`
// row records the shape `DateTime.formatIso` produced, and that shape is fixed-width UTC, so code-unit
// order on the strings is chronological order. An absent stamp ("-" or a non-string) never compares.
const newerStamp = (left: string, right: string): boolean =>
  /^2[0-9]{3}-/.test(left) && /^2[0-9]{3}-/.test(right) && left > right;

const claimRows = (claims: ReadonlyArray<[string, boolean, string]>): Row[] =>
  claims.map(([id, ok, detail]): Row => ({
    code: "A",
    fields: [hexOf(id), raw(ok ? "match" : "diff"), hexOf(detail)],
  }));

const evaluateClaims = (result: CaseResult): Array<[string, boolean, string]> => {
  const claims: Array<[string, boolean, string]> = [];
  const add = (id: string, ok: boolean, detail: string) => claims.push([ident(id), ok, detail]);
  const wanted = new Set(result.claims);
  const eventOf = (type: string) => result.events.filter((event) => event.type === type);

  add(
    "all-events-schema-valid",
    result.events.every((event) => event.valid),
    `${result.events.length} events: ${result.events.map((event) => event.type).join(",")}`,
  );
  add(
    "all-frames-schema-valid",
    result.frames.every((frame) => frame.valid),
    `${result.frames.length} frames: ${result.frames.map((frame) => `${frame.stream}:${frame.type}`).join(",")}`,
  );
  add(
    "no-started-frame-on-the-attach-wire",
    result.frames.every((frame) => frame.type !== "started"),
    result.frames.map((frame) => frame.type).join(","),
  );

  switch (result.name) {
    case "attach-live-feed": {
      add(
        "attach-frames-in-order",
        frameTypes(result, "a1") === "snapshot,output,cleared,exited,closed",
        `frames=[${frameTypes(result, "a1")}]`,
      );
      const paired = result.frames
        .filter((frame) => frame.stream === "a1" && frame.type !== "snapshot")
        .every((frame) =>
          result.events.some(
            (event) => event.type === frame.type && event.eventSeq === frame.sequence,
          ),
        );
      add(
        "attach-frames-carry-event-sequences",
        paired && frameStream(result, "a1").length === result.events.length,
        `frames=${frameStream(result, "a1").length} events=${result.events.length} types=[${frameTypes(result, "a1")}]`,
      );
      const resize = boundary(result, "resize", "resize-term-1", "return");
      add(
        "resize-added-no-frame",
        frameStream(result, "a1").length === 5 && resize?.status === "ok",
        `frames=${frameStream(result, "a1").length} resize=${resize?.status ?? "missing"}`,
      );
      add("resize-reached-the-pty", result.resizeCalls === 1, `pty resizes=${result.resizeCalls}`);
      const closed = eventOf("closed")[0];
      add(
        "closed-reached-the-attach",
        closed !== undefined && frameStream(result, "a1").at(-1)?.type === "closed",
        `last=${frameStream(result, "a1").at(-1)?.type ?? "none"} closedSeq=${closed?.eventSeq ?? "?"}`,
      );
      break;
    }
    case "attach-starts-its-own-terminal": {
      const snapshot = frameAt(result, "a1", 0);
      const started = eventOf("started")[0];
      add(
        "buffered-start-dropped",
        started !== undefined && frameTypes(result, "a1") === "snapshot,output",
        `started=${started?.eventSeq ?? "none"} frames=[${frameTypes(result, "a1")}]`,
      );
      add(
        "snapshot-describes-running",
        snapshot?.type === "snapshot" &&
          snapshot.threadId === THREAD_A &&
          snapshot.terminalId === T1,
        `snapshot=${snapshot?.threadId}/${snapshot?.terminalId}:${snapshot?.stamp ?? "?"}`,
      );
      add(
        "snapshot-carries-the-start-sequence",
        snapshot?.sequence === started?.eventSeq,
        `snapshot=${snapshot?.sequence ?? "?"} started=${started?.eventSeq ?? "?"}`,
      );
      add(
        "live-output-after-open",
        frameAt(result, "a1", 1)?.type === "output",
        `second=${frameAt(result, "a1", 1)?.type ?? "none"}`,
      );
      break;
    }
    case "attach-reopen-sends-snapshot": {
      const frames = frameStream(result, "a1");
      add(
        "reopen-sends-two-frames",
        frames.map((frame) => frame.type).join(",") === "snapshot,exited,snapshot",
        `frames=[${frames.map((frame) => frame.type).join(",")}]`,
      );
      const reopened = eventOf("started")[1];
      add(
        "reopen-start-arrives-as-snapshot",
        reopened !== undefined &&
          frames.at(-1)?.type === "snapshot" &&
          frames.at(-1)?.sequence === reopened.eventSeq,
        `reopenSeq=${reopened?.eventSeq ?? "?"} frame=${frames.at(-1)?.sequence ?? "?"}`,
      );
      break;
    }
    case "attach-two-clients-and-a-neighbour": {
      const first = frameTypes(result, "a1");
      const second = frameTypes(result, "a2");
      add("two-clients-get-the-same-frames", first === second, `a1=[${first}] a2=[${second}]`);
      const shared = result.frames.filter((frame) => frame.type === "output");
      add(
        "delivery-follows-subscription-order",
        shared.length === 2 && shared[0]?.stream === "a1" && shared[1]?.stream === "a2",
        `outputs=${shared.map((frame) => frame.stream).join(",")}`,
      );
      add(
        "neighbour-events-stay-out",
        frameStream(result, "a3").every((frame) => frame.terminalId === T2) &&
          frameStream(result, "a3").some((frame) => frame.type === "exited"),
        `a3=[${frameTypes(result, "a3")}]`,
      );
      break;
    }
    case "metadata-lifecycle": {
      add(
        "metadata-frames-in-order",
        frameTypes(result, "m1") === "snapshot,upsert,upsert,remove",
        `frames=[${frameTypes(result, "m1")}]`,
      );
      add(
        "text-and-clear-are-not-metadata",
        eventOf("output").length === 1 &&
          eventOf("cleared").length === 1 &&
          frameStream(result, "m1").filter((frame) => frame.type === "upsert").length === 2,
        `outputs=${eventOf("output").length} cleared=${eventOf("cleared").length}`,
      );
      const exited = eventOf("exited")[0];
      const upsert = frameStream(result, "m1")
        .filter((frame) => frame.type === "upsert")
        .at(-1);
      const view = frameAt(result, "m1", 0);
      add(
        "upsert-describes-the-exit",
        exited !== undefined &&
          upsert?.type === "upsert" &&
          upsert.sequence === "-" &&
          exited.exitCode === "6",
        `exited=${exited?.exitCode ?? "?"}/${exited?.exitSignal ?? "?"} upsert=${upsert?.stamp ?? "?"} view=${view?.rows.length ?? "?"}`,
      );
      const remove = frameAt(result, "m1", 3);
      add(
        "metadata-frames-carry-no-sequence",
        frameStream(result, "m1")
          .filter((frame) => frame.type === "upsert")
          .every((frame) => frame.sequence === "-"),
        `upserts=${frameStream(result, "m1")
          .filter((frame) => frame.type === "upsert")
          .map((frame) => `${frame.terminalId}:${frame.sequence}@${frame.stamp}`)
          .join(",")}`,
      );
      add(
        "closed-removes-without-a-row",
        remove?.type === "remove" &&
          remove.terminalId === T1 &&
          remove.stamp === "-" &&
          remove.rows.length === 0,
        `remove=${remove?.threadId}/${remove?.terminalId}@${remove?.stamp ?? "?"} frames=[${frameTypes(result, "m1")}]`,
      );
      break;
    }
    case "metadata-error-after-eviction": {
      const error = eventOf("error")[0];
      const snapshot = frameAt(result, "a1", 0);
      add(
        "error-reached-the-feed",
        error !== undefined && error.hasSnapshot === false && error.eventSeq === "1",
        `error=${error?.eventSeq ?? "none"} snapshot=${error?.hasSnapshot ? 1 : 0}`,
      );
      add(
        "buffered-error-dropped-behind-snapshot",
        error !== undefined && frameTypes(result, "a1") === "snapshot",
        `error=${error?.eventSeq ?? "none"} a1=[${frameTypes(result, "a1")}]`,
      );
      add(
        "evicted-terminal-has-no-row",
        frameStream(result, "m1").every((frame) => frame.type === "snapshot"),
        `m1=[${frameTypes(result, "m1")}] cap=${result.cap}`,
      );
      add(
        "evicted-open-still-snapshots",
        snapshot?.type === "snapshot" &&
          snapshot.sequence === error?.eventSeq &&
          snapshot.stamp !== "-",
        `snapshot=${snapshot?.sequence ?? "?"}@${snapshot?.stamp ?? "?"} error=${error?.eventSeq ?? "?"}`,
      );
      break;
    }
    case "resize-moves-the-row-silently": {
      const returns = result.boundaries.filter((b) => b.kind === "resize" && b.status !== "-");
      add(
        "resize-published-nothing",
        returns.length === 2 &&
          returns.every((b) => b.status === "ok") &&
          result.events.every((event) => event.type !== "resized") &&
          result.frames.every((frame) => frame.type !== "resized"),
        `resizeReturns=${returns.map((b) => b.status).join(",")} events=${result.events.map((event) => event.type).join(",")} frames=${result.frames.map((frame) => frame.type).join(",")}`,
      );
      const first = frameAt(result, "m1", 0);
      const opens = result.events.filter((event) => event.type === "started");
      const lastOpenStamp = opens.at(-1)?.stamp ?? "-";
      add(
        "resize-refreshed-the-sort-key",
        first?.rows.length === 2 &&
          first.rows[0]?.terminalId === T1 &&
          first.rows[1]?.terminalId === T2 &&
          newerStamp(first.rows[0]?.stamp ?? "-", lastOpenStamp),
        `firstView=${viewOf(result, "m1", 0)} lastOpenStamp=${lastOpenStamp}`,
      );
      const second = frameAt(result, "m2", 0);
      add(
        "resize-order-flips-between-snapshots",
        second?.rows[0]?.terminalId === T2,
        `secondView=${viewOf(result, "m2", 0)} firstView=${viewOf(result, "m1", 0)}`,
      );
      break;
    }
    case "resize-of-an-idle-terminal": {
      const exited = eventOf("exited")[0];
      add(
        "resize-of-exited-reached-nothing",
        frameTypes(result, "a1") === "snapshot" && result.resizeCalls === 0,
        `a1=[${frameTypes(result, "a1")}] ptyResizes=${result.resizeCalls}`,
      );
      add(
        "resize-of-unknown-reached-nothing",
        boundary(result, "resize", "resize-term-9", "return")?.status === "ok" &&
          result.resizeCalls === 0,
        `unknown=${boundary(result, "resize", "resize-term-9", "return")?.status ?? "missing"}`,
      );
      const view = frameAt(result, "m1", 0);
      const attached = frameAt(result, "a1", 0);
      add(
        "exited-kept-its-own-stamp",
        view?.rows.length === 1 &&
          view.rows[0]?.status === "exited" &&
          attached?.stamp !== undefined &&
          attached.stamp !== "-" &&
          view.rows[0]?.stamp === attached.stamp &&
          exited?.stamp === "-",
        `row=${viewOf(result, "m1", 0)} attach=${attached?.stamp ?? "?"} exitEventStamp=${exited?.stamp ?? "?"}`,
      );
      break;
    }
    case "detach-leaves-the-others-alone": {
      const detach = boundary(result, "detach", "a1", "return");
      add(
        "detached-client-stops",
        detach?.status === "ok" && frameTypes(result, "a1") === "snapshot",
        `a1=[${frameTypes(result, "a1")}]`,
      );
      add(
        "others-keep-hearing",
        frameTypes(result, "a2") === "snapshot,exited" &&
          frameTypes(result, "m1") === "snapshot,upsert,upsert",
        `a2=[${frameTypes(result, "a2")}] m1=[${frameTypes(result, "m1")}]`,
      );
      const bExit = frameStream(result, "a2").at(-1);
      add(
        "thread-filter-is-exact",
        bExit?.threadId === THREAD_B && bExit?.terminalId === T1,
        `last=${bExit?.threadId}/${bExit?.terminalId}:${bExit?.type ?? "?"}`,
      );
      const upserts = frameStream(result, "m1").filter((frame) => frame.type === "upsert");
      const firstUpsert = upserts[0];
      add(
        "metadata-listener-hears-first",
        firstUpsert !== undefined &&
          bExit !== undefined &&
          firstUpsert.threadId === bExit.threadId &&
          firstUpsert.seq < bExit.seq,
        `upsert=${firstUpsert?.seq ?? "?"}@${firstUpsert?.threadId ?? "?"} attach=${bExit?.seq ?? "?"}`,
      );
      add(
        "every-exit-restamps-its-row",
        upserts.length === 2 &&
          upserts[0]?.stamp !== upserts[1]?.stamp &&
          newerStamp(upserts[0]?.stamp ?? "-", frameAt(result, "a2", 0)?.stamp ?? "-") &&
          newerStamp(upserts[1]?.stamp ?? "-", upserts[0]?.stamp ?? "-"),
        `upserts=${upserts.map((frame) => `${frame.threadId}@${frame.stamp}`).join(",")} a2Snapshot=${frameAt(result, "a2", 0)?.stamp ?? "?"}`,
      );
      break;
    }
    case "attach-of-a-running-terminal-keeps-its-size": {
      const opened = eventOf("started")[0];
      const attached = frameAt(result, "a1", 0);
      add(
        "attach-same-size-reached-no-pty",
        result.resizeCalls === 0,
        `ptyResizes=${result.resizeCalls}`,
      );
      add(
        "attach-same-size-kept-the-open-stamp",
        attached?.stamp !== undefined &&
          attached.stamp !== "-" &&
          attached.stamp === opened?.stamp &&
          frameAt(result, "m1", 0)?.rows[0]?.stamp === opened?.stamp,
        `open=${opened?.stamp ?? "?"} attach=${attached?.stamp ?? "?"} view=${viewOf(result, "m1", 0)}`,
      );
      break;
    }
    case "attach-of-a-running-terminal-takes-a-new-size": {
      const opened = eventOf("started")[0];
      const attached = frameAt(result, "a1", 0);
      add(
        "attach-new-size-reached-the-pty",
        result.resizeCalls === 1,
        `ptyResizes=${result.resizeCalls}`,
      );
      add(
        "attach-new-size-restamped-its-snapshot",
        attached?.stamp !== undefined && newerStamp(attached.stamp, opened?.stamp ?? "-"),
        `open=${opened?.stamp ?? "?"} attach=${attached?.stamp ?? "?"}`,
      );
      add(
        "attach-new-size-published-no-event",
        result.events.length === 1 &&
          result.events[0]?.type === "started" &&
          result.frames.every((frame) => frame.type !== "resized"),
        `events=${result.events.map((event) => event.type).join(",")} frames=${result.frames.map((frame) => `${frame.stream}:${frame.type}`).join(",")}`,
      );
      break;
    }
    case "attach-of-an-exited-terminal-skips-the-size-gate": {
      const attached = frameAt(result, "a1", 0);
      const afterExit = frameAt(result, "a2", 0);
      const view = frameAt(result, "m1", 0);
      add(
        "attach-after-exit-reached-no-pty",
        result.resizeCalls === 1,
        `ptyResizes=${result.resizeCalls} a1=${attached?.stamp ?? "?"}`,
      );
      add(
        "attach-after-exit-shared-the-view-stamp",
        afterExit?.stamp !== undefined &&
          view?.rows[0]?.stamp === afterExit.stamp &&
          newerStamp(afterExit.stamp, attached?.stamp ?? "-"),
        `a1=${attached?.stamp ?? "?"} a2=${afterExit?.stamp ?? "?"} view=${viewOf(result, "m1", 0)}`,
      );
      break;
    }
    case "reopen-of-a-running-terminal-with-its-size": {
      const opened = eventOf("started")[0];
      const reopens = result.boundaries.filter(
        (entry) => entry.kind === "reopen" && entry.status !== "-",
      );
      add(
        "reopen-of-running-published-no-event",
        reopens.length === 1 && reopens[0]?.status === "ok" && result.events.length === 1,
        `reopen=${reopens.map((entry) => entry.status).join(",")} events=${result.events.map((event) => event.type).join(",")}`,
      );
      add(
        "reopen-of-running-reached-no-pty",
        result.resizeCalls === 0,
        `ptyResizes=${result.resizeCalls}`,
      );
      add(
        "reopen-of-running-left-the-stamp-alone",
        frameAt(result, "m1", 0)?.rows[0]?.stamp === opened?.stamp,
        `open=${opened?.stamp ?? "?"} view=${viewOf(result, "m1", 0)}`,
      );
      break;
    }
    case "reopen-of-a-running-terminal-with-a-new-size": {
      const opened = eventOf("started")[0];
      add(
        "reopen-new-size-reached-the-pty",
        result.resizeCalls === 1,
        `ptyResizes=${result.resizeCalls}`,
      );
      add(
        "reopen-new-size-restamped-without-an-event",
        result.events.length === 1 &&
          newerStamp(frameAt(result, "m1", 0)?.rows[0]?.stamp ?? "-", opened?.stamp ?? "-"),
        `events=${result.events.map((event) => event.type).join(",")} open=${opened?.stamp ?? "?"} view=${viewOf(result, "m1", 0)}`,
      );
      break;
    }
    case "attach-sizes-are-remembered-between-clients": {
      const first = frameAt(result, "a1", 0);
      const second = frameAt(result, "a2", 0);
      const third = frameAt(result, "a3", 0);
      add(
        "remembered-size-resized-once",
        result.resizeCalls === 2 && first?.stamp === second?.stamp,
        `ptyResizes=${result.resizeCalls} a1=${first?.stamp ?? "?"} a2=${second?.stamp ?? "?"}`,
      );
      add(
        "second-attach-shared-the-first-stamp",
        second?.stamp !== undefined && second.stamp === first?.stamp,
        `a1=${first?.stamp ?? "?"} a2=${second?.stamp ?? "?"}`,
      );
      add(
        "asking-for-the-old-size-resized-again",
        third?.stamp !== undefined && newerStamp(third.stamp, second?.stamp ?? "-"),
        `a2=${second?.stamp ?? "?"} a3=${third?.stamp ?? "?"}`,
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

const boundary = (result: CaseResult, kind: string, id: string, phase: "issue" | "return") =>
  result.boundaries.filter((entry) => entry.kind === kind && entry.id === id)[
    phase === "issue" ? 0 : 1
  ];

const caseRows = (result: CaseResult): Row[] => [
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
  ...result.notes.map((note): Row => ({ code: "Q", fields: [hexOf(note)] })),
  ...timedRows(result),
  { code: "P", fields: [raw("pty"), raw(result.resizeCalls)] },
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
          `streams: a* are attachStream clients, m* are subscribeMetadata clients; an attach frame of ` +
            `type "snapshot" is the initial one and "started" never appears; a metadata snapshot lists ` +
            `sessions newest-stamp first; stamps are recorded as t1..tn by ascending order. Sizes: an ` +
            `open or attach step without cols/rows asks for 100x24, and a P row counts the resizes that ` +
            `reached the pty, so a gate that fired without the client asking shows up there. Measured gaps: ` +
            `subscribeMetadata buffers events between its subscription and its snapshot, but the Manager ` +
            `fills that window from the same fiber it subscribes on, so no step sequence from one caller ` +
            `can publish into it — the metadata buffer rules are covered by module tests, not by this replay; ` +
            `and a re-open that changes the launch context stops the process, clears the history and persists ` +
            `it without a sequence or an event (Manager.ts:2587, :2598), which this grammar cannot observe ` +
            `because it has no history column.`,
        ),
      ],
    },
  ];

  const rows: Row[] = [...header];
  let caseCount = 0;
  let frameCount = 0;
  for (const spec of caseSpecs) {
    if (caseFilter !== undefined && !caseFilter.includes(spec.name)) continue;
    process.stderr.write(`case ${spec.name}\n`);
    const result = yield* Effect.scoped(runCase(spec));
    caseCount += 1;
    frameCount += result.frameCount;
    rows.push(...caseRows(result));
  }

  rows.push({ code: "Z", fields: [raw(caseCount), raw(frameCount), raw("end")] });

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
    `terminal stream trace: ${caseCount} cases, ${frameCount} frames, ${rows.length} rows -> ${OUT_FILE}\n`,
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
