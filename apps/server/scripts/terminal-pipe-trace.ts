// Trace generator for the terminal transport golden (fatia 11). The adapter slices measured
// *what the PTY library is handed*; this one measures what the shipped `TerminalManager` does
// with what comes back, because that is where the read side's semantics live:
//
//   ptyProcess.onData((data) => { if (!enqueueProcessEvent(session, pid, {type:"output", data})) return;
//                                 runFork(drainProcessEvents(session, pid)); });
//
// `enqueueProcessEvent` is a single-flight gate with a liveness guard, and `drainProcessEvents`
// is one fiber walking a cursor over the pending array, awaiting each publish before taking the
// next. So the observable facts are not "data arrives": they are *which* deliveries survive, in
// what order, with what `sequence`, and what a delivery that lands while a publish is suspended
// does. None of that is visible from `NodePtyAdapter.ts`, and all of it is what a Rust reader
// thread has to reproduce.
//
// Every case is a list of steps rather than a block of code, and the whole list is printed with
// the record it produced. The Rust replay (`native/pty/tests/pipe_golden.rs`) runs the same
// steps, so neither the stimulus nor the expectation is reconstructed from a case name: a new
// step in a trace is a step the replay has to know how to interpret.
//
// The scripted process is deliberately **more** than node-pty is: `dispose()` records the call
// and keeps delivering. A library that stopped delivering after dispose would make the manager's
// pid/status guard unreachable, and the guard is the thing under test. The dispose order is
// printed anyway, so the two mechanisms stay distinguished in the record.
//
// Suspension is the other half of the harness. `publishEvent` awaits every listener, so a
// listener that awaits a latch suspends the drain *inside* a publish — which is the only way to
// enqueue an event "while the previous one is being delivered". Every case ends by waiting on a
// recorded event rather than on time, so the order in the trace is the order the manager
// produced.
//
//   node apps/server/scripts/terminal-pipe-trace.ts > ~/.cache/lmcs-port-traces/terminal-pipe-trace.txt

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { TerminalEvent } from "@lmcstools/core";

import * as ProcessRunner from "../src/processRunner.ts";
import * as PtyAdapter from "../src/terminal/PtyAdapter.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";

/** What a recorded event contributes to the trace: type, the client-visible sequence, payload. */
type Recorded = { readonly type: string; readonly sequence: number; readonly payload: string };

/**
 * One thing a case does, in the order it does it. `data`/`exit` are the library's read side
 * speaking; `hold`/`suspended`/`release` are the only way to put a delivery *inside* another
 * delivery; `count` is the receipt that says the manager reached a given record length, so a
 * step list that stalls fails loudly instead of printing a shorter trace.
 *
 * `p` picks the process by index, because two of the cases are about the *superseded* child: a
 * delivery from pid 4000 after a restart is the pid guard's entire reason for existing.
 */
type Step =
  | { readonly op: "count"; readonly n: number }
  | { readonly op: "data"; readonly p?: number; readonly s: string }
  | { readonly op: "exit"; readonly p?: number; readonly c: number | "nan"; readonly s: number }
  | { readonly op: "hold" }
  | { readonly op: "suspended" }
  | { readonly op: "release" }
  | { readonly op: "restart" }
  | { readonly op: "close" };

/** What the library delivers from inside `onData`/`onExit`, before the session fields are set. */
type Setup = {
  readonly data?: string;
  readonly exit?: { readonly exitCode: number | "nan"; readonly signal: number };
};

type Case = {
  readonly name: string;
  readonly note: string;
  readonly setup?: Setup;
  readonly steps: ReadonlyArray<Step>;
};

const cases: ReadonlyArray<Case> = [
  {
    name: "singleOutput",
    note: "one delivery, one sequence: the baseline every other case is counted against",
    steps: [
      { op: "count", n: 1 },
      { op: "data", s: "hello" },
      { op: "count", n: 2 },
    ],
  },
  {
    name: "burstWhileIdle",
    note:
      "three chunks pushed in one synchronous block: only the first may start a drain, and the " +
      "one fiber must publish all three in order",
    steps: [
      { op: "count", n: 1 },
      { op: "data", s: "a" },
      { op: "data", s: "b" },
      { op: "data", s: "c" },
      { op: "count", n: 4 },
    ],
  },
  {
    name: "emptyChunkIsPublished",
    note:
      '`""` is a delivery: the sequence still advances and an output event is published even ' +
      "though nothing can be appended to history",
    steps: [
      { op: "count", n: 1 },
      { op: "data", s: "" },
      { op: "count", n: 2 },
    ],
  },
  {
    name: "midDrainEnqueueThenExit",
    note:
      "B and the exit are delivered while A's publish is suspended: the queue is not a " +
      "coalescer, so the client sees A, B, exit with consecutive sequences",
    steps: [
      { op: "count", n: 1 },
      { op: "hold" },
      { op: "data", s: "held" },
      // Not a sleep: once this returns the drain is inside the publish of `held`, so the two
      // deliveries below are provably enqueued mid-drain.
      { op: "suspended" },
      { op: "data", s: "queued" },
      { op: "exit", c: 3, s: 0 },
      { op: "release" },
      { op: "count", n: 4 },
    ],
  },
  {
    name: "exitThenLateData",
    note:
      "the exit teardown nulls the pid and clears the queue, so data from the same process " +
      "afterwards is dropped even though the subscription was never honored",
    steps: [
      { op: "count", n: 1 },
      { op: "exit", p: 0, c: 0, s: 0 },
      { op: "count", n: 2 },
      { op: "data", p: 0, s: "late-after-exit" },
      { op: "restart" },
      { op: "count", n: 3 },
    ],
  },
  {
    name: "stalePidAfterRestart",
    note:
      "a delivery from the superseded process is dropped by the pid guard, and the new process's " +
      "output is delivered — the case the guard exists for",
    steps: [
      { op: "count", n: 1 },
      { op: "restart" },
      { op: "data", p: 0, s: "from-the-dead" },
      { op: "data", p: 1, s: "from-the-new" },
      { op: "count", n: 3 },
    ],
  },
  {
    name: "dataDuringSetup",
    note:
      "delivered from inside `onData`, before `session.process` and the running status are " +
      "written: the shipped guard drops it, so a shell's first bytes can be lost",
    setup: { data: "during-setup" },
    steps: [
      { op: "count", n: 1 },
      { op: "data", s: "after-setup" },
      { op: "count", n: 2 },
      { op: "restart" },
      { op: "count", n: 3 },
    ],
  },
  {
    name: "exitDuringSetup",
    note:
      "same window, exit instead of data: the drop leaves a session `running` over a child that " +
      "already finished, which is why a port has to say what it does here",
    setup: { exit: { exitCode: 7, signal: 0 } },
    steps: [
      { op: "count", n: 1 },
      { op: "data", s: "still-running" },
      { op: "count", n: 2 },
      { op: "exit", c: 9, s: 0 },
      { op: "count", n: 3 },
    ],
  },
  {
    name: "closeWhilePublishHeld",
    note:
      "close runs from another fiber while a publish is suspended: `closed` reaches the client " +
      "**before** the held output, and the resumed drain then finds itself stale",
    steps: [
      { op: "count", n: 1 },
      { op: "hold" },
      { op: "data", s: "held-against-close" },
      { op: "close" },
      { op: "count", n: 2 }, // `closed`
      { op: "suspended" }, // and the held output is still not delivered
      { op: "release" },
      { op: "count", n: 3 },
    ],
  },
  {
    name: "exitCodeNotAnInteger",
    note:
      "`Number.isInteger` decides what the snapshot carries: a non-integer code is `null`, and a " +
      "`0` signal is an integer, so it survives as 0 rather than as nothing",
    steps: [
      { op: "count", n: 1 },
      { op: "exit", c: "nan", s: 0 },
      { op: "count", n: 2 },
    ],
  },
  {
    name: "signalSurvives",
    note: "a killed child reports code 0 and the signal number, both integers",
    steps: [
      { op: "count", n: 1 },
      { op: "exit", c: 0, s: 9 },
      { op: "count", n: 2 },
    ],
  },
  {
    name: "twoOutputsThenExitWithPendingBurst",
    note:
      "four chunks and an exit enqueued during one suspended publish: order is preserved through " +
      "the cursor, and the exit is still last",
    steps: [
      { op: "count", n: 1 },
      { op: "hold" },
      { op: "data", s: "p0" },
      { op: "data", s: "p1" },
      { op: "data", s: "p2" },
      { op: "data", s: "p3" },
      { op: "exit", c: 0, s: 0 },
      { op: "suspended" },
      { op: "release" },
      { op: "count", n: 6 },
    ],
  },
];

class ScriptedPtyProcess implements PtyAdapter.PtyProcess {
  readonly disposed: string[] = [];
  readonly kills: Array<string | undefined> = [];
  #data: Array<(data: string) => void> = [];
  #exit: Array<(event: PtyAdapter.PtyExitEvent) => void> = [];

  readonly pid: number;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(): void {}
  resize(): void {}
  kill(signal?: string): void {
    this.kills.push(signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.#data.push(callback);
    return () => {
      this.disposed.push("data");
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.#exit.push(callback);
    return () => {
      this.disposed.push("exit");
    };
  }

  /** Deliver as if the library's read side produced this chunk now. */
  emitData(data: string): void {
    for (const callback of this.#data) callback(data);
  }

  emitExit(exitCode: number, signal: number): void {
    const event = { exitCode, signal };
    for (const callback of this.#exit) callback(event);
  }
}

class ScriptedPtyAdapter {
  readonly processes: ScriptedPtyProcess[] = [];
  #pid = 4000;
  /**
   * Fires the given payload through the callback the manager is *currently registering*, from
   * inside `onData`/`onExit`. That is the setup window: the subscription exists, but
   * `session.process`/`status`/`pid` have not been written yet, so the guard is what decides.
   */
  readonly setup: Setup | undefined;

  constructor(setup?: Setup) {
    this.setup = setup;
  }

  spawn(): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    const process = new ScriptedPtyProcess(this.#pid++);
    this.processes.push(process);
    const setup = this.setup;
    if (!setup) return Effect.succeed(process);
    // `onData` is registered before `onExit` by the shipped manager, so the data probe runs
    // first; the exit probe runs at the moment the exit subscription exists.
    const onData = process.onData.bind(process);
    const onExit = process.onExit.bind(process);
    process.onData = (callback) => {
      const unsubscribe = onData(callback);
      if (setup.data !== undefined) callback(setup.data);
      return unsubscribe;
    };
    process.onExit = (callback) => {
      const unsubscribe = onExit(callback);
      if (setup.exit !== undefined) {
        callback({
          exitCode: setup.exit.exitCode === "nan" ? Number.NaN : setup.exit.exitCode,
          signal: setup.exit.signal,
        });
      }
      return unsubscribe;
    };
    return Effect.succeed(process);
  }
}

const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** One `hold` suspends exactly one publish, which is what makes "mid-drain" mean something. */
type Hold = {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
};

type Harness = {
  readonly recorded: () => readonly Recorded[];
  readonly process: (index: number | undefined) => ScriptedPtyProcess;
  readonly holdNextPublish: () => Effect.Effect<void>;
  readonly awaitSuspended: () => Effect.Effect<void>;
  readonly releaseNextPublish: () => Effect.Effect<void>;
  readonly awaitCount: (count: number) => Effect.Effect<void>;
  /** Awaits the restarted event, not every previously forked drain. */
  readonly restart: () => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
};

const project = (event: TerminalEvent): Recorded => {
  switch (event.type) {
    case "output":
      return { type: "output", sequence: event.sequence ?? -1, payload: hex(event.data) };
    case "exited":
      return {
        type: "exited",
        sequence: event.sequence ?? -1,
        payload: hex(`${event.exitCode}|${event.exitSignal}`),
      };
    case "started":
    case "restarted":
      return {
        type: event.type,
        sequence: event.sequence ?? -1,
        payload: hex(`${event.snapshot.status} pid=${event.snapshot.pid}`),
      };
    case "error":
      return { type: "error", sequence: event.sequence ?? -1, payload: hex(event.message) };
    default:
      return { type: event.type, sequence: event.sequence ?? -1, payload: "" };
  }
};

const runStep = (harness: Harness, step: Step): Effect.Effect<void> => {
  switch (step.op) {
    case "count":
      return harness.awaitCount(step.n);
    case "data":
      return Effect.sync(() => harness.process(step.p).emitData(step.s));
    case "exit":
      return Effect.sync(() =>
        harness.process(step.p).emitExit(step.c === "nan" ? Number.NaN : step.c, step.s),
      );
    case "hold":
      return harness.holdNextPublish();
    case "suspended":
      return harness.awaitSuspended();
    case "release":
      return harness.releaseNextPublish();
    case "restart":
      return harness.restart();
    case "close":
      return harness.close();
  }
};

const run = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const out: string[] = [];

  for (const input of cases) {
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pipe-trace-" });
    const cwd = join(baseDir, "work");
    yield* fileSystem.makeDirectory(cwd, { recursive: true });

    const recorded: Recorded[] = [];
    const latches: Array<{ readonly count: number; readonly deferred: Deferred.Deferred<void> }> =
      [];
    let hold: Hold | null = null;
    /** The hold the harness still owes a release to, after the listener consumed `hold`. */
    let armed: Hold | null = null;

    const listener = (event: TerminalEvent) =>
      Effect.gen(function* () {
        // The `started` publish must not be the one that gets suspended, or the case would
        // measure the open path instead of the read path.
        if (hold && event.type !== "started" && event.type !== "restarted") {
          const suspended = hold;
          hold = null;
          yield* Deferred.succeed(suspended.entered, undefined);
          yield* Deferred.await(suspended.release);
        }
        recorded.push(project(event));
        for (const latch of latches.splice(0)) {
          if (recorded.length >= latch.count) {
            yield* Deferred.succeed(latch.deferred, undefined);
          } else {
            latches.push(latch);
          }
        }
      });

    const adapter = new ScriptedPtyAdapter(input.setup);
    const manager = yield* TerminalManager.makeWithOptions({
      logsDir: join(baseDir, "logs"),
      ptyAdapter: adapter,
      env: { SHELL: "/bin/sh", PATH: "/usr/bin:/bin", HOME: "/home/u" },
      processKillGraceMs: 1,
    });
    yield* manager.subscribe(listener);

    const harness: Harness = {
      recorded: () => recorded,
      process: (index) =>
        index === undefined
          ? adapter.processes[adapter.processes.length - 1]!
          : adapter.processes[index]!,
      holdNextPublish: Effect.fnUntraced(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        // One holder, written once: the listener clears `hold` when it suspends, and the release
        // has to find the deferred it cleared.
        const suspended: Hold = { entered, release };
        armed = suspended;
        hold = suspended;
      }),
      awaitSuspended: Effect.fnUntraced(function* () {
        if (armed) yield* Deferred.await(armed.entered);
      }),
      releaseNextPublish: Effect.fnUntraced(function* () {
        if (armed) yield* Deferred.succeed(armed.release, undefined);
        armed = null;
      }),
      awaitCount: Effect.fnUntraced(function* (count: number) {
        if (recorded.length >= count) return;
        const deferred = yield* Deferred.make<void>();
        latches.push({ count, deferred });
        yield* Deferred.await(deferred);
      }),
      restart: Effect.fnUntraced(function* () {
        yield* Effect.orDie(
          manager.restart({
            threadId: "thread-1",
            terminalId: "term-1",
            cwd,
            cols: 80,
            rows: 24,
          }),
        );
      }),
      close: Effect.fnUntraced(function* () {
        yield* Effect.orDie(manager.close({ threadId: "thread-1", terminalId: "term-1" }));
      }),
    };

    yield* manager.open({ threadId: "thread-1", terminalId: "term-1", cwd, cols: 80, rows: 24 });
    for (const step of input.steps) {
      yield* runStep(harness, step);
    }

    out.push(`C ${input.name}`);
    out.push(`I ${hex(yield* encodeInput(input))}`);
    for (const [index, event] of recorded.entries()) {
      out.push(`O ${index} ${event.type} ${event.sequence} ${event.payload}`);
    }
    for (const [index, process] of adapter.processes.entries()) {
      out.push(`X ${index} ${process.pid} ${hex(process.disposed.join(","))}`);
    }
  }

  process.stderr.write(`trace cases: ${cases.length}\n`);
  process.stdout.write(`${out.join("\n")}\n`);
});

Effect.runPromise(
  Effect.scoped(run).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([]),
        NodeServices.layer,
        ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  ),
).then(
  () => process.exit(0),
  (cause: unknown) => {
    const error = cause as { stack?: string };
    process.stderr.write(`${error.stack ?? String(cause)}\n`);
    process.exit(1);
  },
);
