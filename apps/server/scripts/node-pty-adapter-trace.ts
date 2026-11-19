// Trace generator for the node-pty adapter golden. Drives the shipped
// `apps/server/src/terminal/NodePtyAdapter.ts` through the seam it already exposes —
// `NodePtyModuleLoaderRef`, which exists precisely so a fake module can stand in for the
// native addon — and writes down what the adapter hands to `node-pty` rather than what it
// hands to the terminal manager. The manager-side half (candidate order, child env, the
// retry loop) is already measured by `terminal-shell-trace.ts`; this is the layer below it.
//
// `node apps/server/scripts/node-pty-adapter-trace.ts > /tmp/node-pty-trace.txt`
//
// Nothing here reimplements a rule. The fake module records its arguments; the adapter is
// the shipped one; the `FileSystem` is faked so the spawn-helper `chmod` never touches a
// real file (that block is node-pty packaging machinery and has no counterpart in the port,
// so it is not measured either).
//
// Trace format, same as the usage-limits golden: one `C` line per record group, then `I`
// (input) and `R` (result) as hex JSON. Values that only exist on this host are masked.

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import { HostProcessArchitecture, HostProcessPlatform } from "@lmcstools/core/hostProcess";

import * as ProcessRunner from "../src/processRunner.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";
import * as NodePtyAdapter from "../src/terminal/NodePtyAdapter.ts";
import * as PtyAdapter from "../src/terminal/PtyAdapter.ts";

const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");

const machinePaths = [process.env["HOME"] ?? "", process.env["TMPDIR"] ?? "", process.cwd()].filter(
  (value) => value.length > 0,
);

/** No record may carry a path that only exists on this host. */
function mask(text: string): string {
  let masked = text;
  for (const value of [...machinePaths].sort((left, right) => right.length - left.length)) {
    masked = masked.split(value).join("<M>");
  }
  return masked;
}

const records: string[] = [];

function record(table: string, input: unknown, result: unknown): void {
  records.push(`C node-pty-adapter ${table}`);
  records.push(`I ${hex(mask(JSON.stringify(input)))}`);
  records.push(`R ${hex(mask(JSON.stringify(result)))}`);
}

type SpawnCall = {
  file: string;
  args: string[];
  options: {
    cwd: string;
    cols: number;
    rows: number;
    name: string | undefined;
    env: Array<[string, string]>;
  };
};

/**
 * The fake `node-pty`. Every method records what it was called with, so the record is the
 * shipped adapter's own decision and not a reading of it.
 */
class FakePty {
  readonly pid = 4242;
  readonly spawnCalls: SpawnCall[] = [];
  readonly kills: unknown[] = [];
  readonly resizes: Array<[number, number]> = [];
  readonly writes: string[] = [];
  private readonly spawnThrow: unknown;
  private exitCallback: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  private dataCallback: ((data: string) => void) | undefined;

  constructor(spawnThrow: unknown) {
    this.spawnThrow = spawnThrow;
  }

  spawn(
    file: string,
    args: readonly string[],
    options: {
      cwd: string;
      cols: number;
      rows: number;
      name?: string;
      env: Record<string, string | undefined>;
    },
  ): FakePty {
    this.spawnCalls.push({
      file,
      args: [...args],
      options: {
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
        name: options.name,
        // `undefined` is what JavaScript hands the addon for a key with no value, and it is
        // not the same thing as an empty string, so the pairs record it explicitly.
        env: Object.entries(options.env).map(
          ([key, value]) => [key, value === undefined ? null : value] as [string, string | null],
        ),
      },
    });
    if (this.spawnThrow !== undefined) {
      throw this.spawnThrow;
    }
    return this;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  kill(signal?: string): void {
    this.kills.push(signal === undefined ? null : signal);
  }

  onData(callback: (data: string) => void): { dispose: () => void } {
    this.dataCallback = callback;
    return { dispose: () => {} };
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void): {
    dispose: () => void;
  } {
    this.exitCallback = callback;
    return { dispose: () => {} };
  }

  emitData(data: string): void {
    this.dataCallback?.(data);
  }

  emitExit(event: { exitCode: number; signal?: number }): void {
    this.exitCallback?.(event);
  }
}

/** The error shapes `node-pty` is seen throwing, from its own sources and issue reports. */
const spawnFailures = {
  none: undefined,
  missingExecutable: new Error("posix_spawnp failed."),
  permissionDenied: new Error("EACCES: permission denied"),
  nested: { message: "spawn failed", cause: { message: "No such file or directory" } },
  bareString: "posix_spawnp failed.",
  noMessage: {},
} as const;

type FailureKey = keyof typeof spawnFailures;

type Case = {
  readonly name: string;
  readonly platform: NodeJS.Platform;
  readonly architecture?: string;
  readonly shell: string;
  readonly args?: string[];
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: Record<string, string | undefined>;
  readonly failure?: FailureKey;
};

const cases: ReadonlyArray<Case> = [
  {
    // The POSIX happy path. `name` is spelled by the adapter, the env is passed through
    // untouched, and a missing `args` becomes `[]`.
    name: "posixPassthrough",
    platform: "linux",
    shell: "/bin/zsh",
    cwd: "/work",
    cols: 120,
    rows: 30,
    env: { PATH: "/usr/bin:/bin", HOME: "/home/u", LANG: "C.UTF-8" },
  },
  {
    // Windows with no `TERM` at all: the backfill appends it, so it lands last.
    name: "winTermAbsent",
    platform: "win32",
    shell: "pwsh.exe",
    args: ["-NoLogo"],
    cwd: "C:\\work",
    cols: 80,
    rows: 24,
    env: { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\u" },
  },
  {
    // The gate is `=== undefined`, so an empty `TERM` is a value and is left alone. A port
    // that tests for falsiness would rewrite it.
    name: "winTermEmpty",
    platform: "win32",
    shell: "cmd.exe",
    cwd: "C:\\work",
    cols: 80,
    rows: 24,
    env: { PATH: "C:\\Windows", TERM: "" },
  },
  {
    // A `TERM` that is present but not first keeps its position: the spread only appends
    // what the object does not already have.
    name: "winTermPresentKeepsPosition",
    platform: "win32",
    shell: "pwsh.exe",
    cwd: "C:\\work",
    cols: 80,
    rows: 24,
    env: { TERM: "xterm", PATH: "C:\\Windows", COLORTERM: "truecolor" },
  },
  {
    // POSIX does not backfill even though the child's TERM comes from `name` anyway.
    name: "posixTermAbsent",
    platform: "darwin",
    shell: "/bin/bash",
    cwd: "/work",
    cols: 1,
    rows: 1,
    env: { PATH: "/bin" },
  },
  {
    // POSIX leaves an empty `TERM` alone too, because the branch is Windows-only rather
    // than because the value was judged usable.
    name: "posixTermEmpty",
    platform: "linux",
    shell: "/bin/bash",
    cwd: "/work",
    cols: 80,
    rows: 24,
    env: { PATH: "/bin", TERM: "" },
  },
  {
    // An empty `args` array is not the same object as a missing one, and both reach the
    // addon as `[]`.
    name: "posixEmptyArgs",
    platform: "linux",
    shell: "/bin/sh",
    args: [],
    cwd: "/work",
    cols: 80,
    rows: 24,
    env: { PATH: "/bin" },
  },
  {
    // Arguments with spaces and shell quoting are passed as separate strings; nothing is
    // joined for a command line.
    name: "posixArgsWithSpaces",
    platform: "linux",
    shell: "/bin/zsh",
    args: ["-o", "nopromptsp", "--login", "-c", "echo 'a b'"],
    cwd: "/work",
    cols: 80,
    rows: 24,
    env: { PATH: "/bin" },
  },
  {
    // node-pty's own missing-executable failure, which the manager has to recognize.
    name: "posixSpawnFailsMissingExecutable",
    platform: "linux",
    shell: "/bin/nope",
    cwd: "/work",
    cols: 80,
    rows: 24,
    env: { PATH: "/bin" },
    failure: "missingExecutable",
  },
  {
    // A thrown string still becomes a `PtySpawnError`: the adapter catches anything.
    name: "posixSpawnFailsWithBareString",
    platform: "linux",
    shell: "/bin/nope",
    cwd: "/work",
    cols: 80,
    rows: 24,
    env: { PATH: "/bin" },
    failure: "bareString",
  },
  {
    // An object with neither `message` nor a name is still an error the adapter reports.
    name: "posixSpawnFailsWithoutMessage",
    platform: "linux",
    shell: "/bin/nope",
    cwd: "/work",
    cols: 80,
    rows: 24,
    env: { PATH: "/bin" },
    failure: "noMessage",
  },
  {
    // A two-level chain is what the retry predicate has to walk at this layer, and it is the
    // shape node-pty's `pty.spawn` produces when the pty helper reports underneath its own.
    name: "posixSpawnFailsNested",
    platform: "linux",
    shell: "/bin/nope",
    cwd: "/work",
    cols: 80,
    rows: 24,
    env: { PATH: "/bin" },
    failure: "nested",
  },
];

/** The adapter under measurement, with the fake module and an inert filesystem. */
const adapterFor = (input: Case, fake: FakePty) =>
  NodePtyAdapter.make().pipe(
    Effect.provideService(NodePtyAdapter.NodePtyModuleLoaderRef, () =>
      Promise.resolve(fake as unknown as typeof import("node-pty")),
    ),
    Effect.provideService(HostProcessPlatform, input.platform),
    Effect.provideService(HostProcessArchitecture, (input.architecture ?? "x64") as never),
    Effect.provide(Path.layer),
    Effect.provideService(FileSystem.FileSystem, inertFileSystem),
  );

/**
 * A filesystem that reports nothing on disk. It exists so `ensureNodePtySpawnHelperExecutable`
 * finds no helper: that `chmod` would otherwise rewrite a file in the developer's store, and
 * the block it guards has no counterpart in the Rust port anyway.
 */
const inertFileSystem: FileSystem.FileSystem = {
  ...FileSystem.makeNoop({}),
  exists: () => Effect.succeed(false),
  chmod: () => Effect.die("chmod must not be reached"),
} as FileSystem.FileSystem;

const run = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const input of cases) {
    const fake = new FakePty(
      input.failure === undefined ? undefined : spawnFailures[input.failure],
    );
    const adapter = yield* adapterFor(input, fake);

    const spawned = yield* Effect.result(
      adapter.spawn({
        shell: input.shell,
        ...(input.args === undefined ? {} : { args: input.args }),
        cwd: input.cwd,
        cols: input.cols,
        rows: input.rows,
        env: input.env as PtyAdapter.PtySpawnInput["env"],
      }),
    );

    const call = fake.spawnCalls[0];
    record(
      "nodePtyAdapter.spawn",
      {
        name: input.name,
        platform: input.platform,
        shell: input.shell,
        args: input.args ?? null,
        cwd: input.cwd,
        cols: input.cols,
        rows: input.rows,
        env: Object.entries(input.env).map(
          ([key, value]) => [key, value === undefined ? null : value] as [string, string | null],
        ),
        failure: input.failure ?? null,
      },
      call === undefined
        ? { call: null, error: spawned._tag === "Failure" ? failureOf(spawned.failure) : null }
        : {
            call,
            error: spawned._tag === "Failure" ? failureOf(spawned.failure) : null,
          },
    );

    if (spawned._tag === "Failure") continue;
    const process = spawned.success;

    // The Windows branch of `kill` drops the signal before the addon sees it. The record
    // carries the call's own inputs, so the replay never has to reconstruct them from a label.
    for (const signal of ["SIGTERM", "SIGHUP", undefined] as const) {
      const before = fake.kills.length;
      process.kill(signal);
      record(
        "nodePtyAdapter.kill",
        { name: input.name, platform: input.platform, signal: signal ?? null },
        { received: fake.kills[before] ?? null },
      );
    }

    // `resize(cols, rows)` is the addon's order, which is the opposite of the ioctl's.
    process.resize(132, 43);
    record(
      "nodePtyAdapter.resize",
      { name: input.name, platform: input.platform, cols: 132, rows: 43 },
      { calls: fake.resizes },
    );

    // The exit mapping: node-pty says `0` for a clean POSIX exit and `undefined` only when
    // it has nothing to report, and the adapter turns the second into `null`.
    for (const event of [
      { exitCode: 0, signal: 0 },
      { exitCode: 1, signal: undefined },
      { exitCode: 2, signal: 9 },
    ] as const) {
      const seen: unknown[] = [];
      const unsubscribe = process.onExit((mapped) => seen.push(mapped));
      fake.emitExit({ ...event });
      unsubscribe();
      fake.emitExit({ exitCode: 7, signal: 7 });
      record(
        "nodePtyAdapter.exit",
        { name: input.name, exitCode: event.exitCode, signal: event.signal ?? null },
        { mapped: seen[0] ?? null, afterUnsubscribe: seen.length },
      );
    }

    // Data and writes are passthrough, but the unsubscribe handle is part of the contract.
    const seen: string[] = [];
    const off = process.onData((data) => seen.push(data));
    fake.emitData("a");
    off();
    fake.emitData("b");
    process.write("input\r");
    record("nodePtyAdapter.data", { name: input.name }, { seen, written: fake.writes });

    record("nodePtyAdapter.pid", { name: input.name }, { pid: process.pid });
  }

  // Whether the manager walks on after a real adapter failure is the manager's own rule
  // (measured in `terminal-shell-trace.ts`), but it decides on the cause *this* adapter
  // builds, so the pair is only measurable with both layers wired together.
  for (const failure of ["none", "missingExecutable", "permissionDenied", "bareString"] as const) {
    const fake = new FakePty(failure === "none" ? undefined : spawnFailures[failure]);
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "np-trace-" });
    const cwd = `${baseDir}/work`;
    yield* fileSystem.makeDirectory(cwd, { recursive: true });
    const messages: string[] = [];

    const attempts = yield* Effect.gen(function* () {
      const adapter = yield* NodePtyAdapter.make().pipe(
        Effect.provideService(NodePtyAdapter.NodePtyModuleLoaderRef, () =>
          Promise.resolve(fake as unknown as typeof import("node-pty")),
        ),
        Effect.provideService(FileSystem.FileSystem, inertFileSystem),
      );
      const manager = yield* TerminalManager.makeWithOptions({
        logsDir: `${baseDir}/logs`,
        ptyAdapter: adapter,
        env: { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
        shellResolver: () => "/bin/zsh",
        processKillGraceMs: 1,
      });
      yield* manager.subscribe((event) =>
        event.type === "error" ? Effect.sync(() => messages.push(event.message)) : Effect.void,
      );
      const opened = yield* Effect.result(
        manager.open({ threadId: "thread-1", terminalId: "term-1", cwd, cols: 80, rows: 24 }),
      );
      return {
        openTag: opened._tag,
        spawns: fake.spawnCalls.length,
        // The whole call, not just the shell: the retry loop's choice of arguments is part of
        // what a port has to reproduce, and the adapter is the one that shapes them.
        shellCalls: fake.spawnCalls.map((call) => ({ file: call.file, args: call.args })),
      };
    }).pipe(Effect.provideService(HostProcessPlatform, "linux"));

    record(
      "nodePtyAdapter.managerRetry",
      { name: failure, failure, platform: "linux" },
      {
        spawns: attempts.spawns,
        openTag: attempts.openTag,
        shellCalls: attempts.shellCalls,
        messages: messages.map((message) => message.split(baseDir).join("<M>")),
      },
    );
  }

  // A module that will not load is a defect, not a typed failure: `make` pipes `orDie`.
  for (const [name, platform, architecture] of [
    ["loadRejectsLinux", "linux", "x64"],
    ["loadRejectsWin", "win32", "arm64"],
  ] as const) {
    const made = yield* Effect.exit(
      NodePtyAdapter.make().pipe(
        Effect.provideService(NodePtyAdapter.NodePtyModuleLoaderRef, () =>
          Promise.reject(new Error("The module was compiled for another architecture")),
        ),
        Effect.provideService(HostProcessPlatform, platform as NodeJS.Platform),
        Effect.provideService(HostProcessArchitecture, architecture as never),
        Effect.provide(Path.layer),
        Effect.provideService(FileSystem.FileSystem, inertFileSystem),
      ),
    );
    record(
      "nodePtyAdapter.make",
      { name, platform, architecture },
      {
        tag: made._tag,
        cause:
          made._tag === "Failure"
            ? failureOf(made.cause)
            : made._tag === "Die"
              ? failureOf(made.defect)
              : null,
      },
    );
  }

  process.stderr.write(`records: ${records.length / 3}\n`);
  process.stdout.write(`${records.join("\n")}\n`);
});

/** The rendered error, the way the manager would see it, plus the raw cause chain. */
function failureOf(error: unknown): unknown {
  const unwrapped = unwrapCause(error);
  if (unwrapped instanceof PtyAdapter.PtySpawnError) {
    return {
      _tag: unwrapped._tag,
      message: unwrapped.message,
      shell: unwrapped.shell ?? null,
      // Not a re-implementation of the retry predicate: this is the shape it walks, written
      // down. The predicate itself is measured through the manager, in its own section.
      chain: chainOf(unwrapped.cause),
    };
  }
  if (unwrapped instanceof Error) return { message: unwrapped.message };
  return { text: String(unwrapped) };
}

/** One level per `cause`, `{tag}` for anything that is neither a string nor an object. */
function chainOf(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return { null: true };
  if (typeof value === "string") return { text: value };
  const object = value as { message?: unknown; cause?: unknown };
  if (typeof object.message === "string") {
    return { message: object.message, cause: chainOf(object.cause) };
  }
  if (object.cause !== undefined) return { message: null, cause: chainOf(object.cause) };
  return { tag: Object.prototype.toString.call(value) };
}

/** A `Cause` is a wrapper, and a composite one hides the defect under `failures`. */
function unwrapCause(error: unknown): unknown {
  let current = error as Record<string, unknown> | undefined;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    const tag = current["_tag"];
    if (tag === "Die") {
      current = current["defect"] as Record<string, unknown>;
      return current;
    }
    if (tag === "Fail") {
      current = current["error"] as Record<string, unknown>;
      continue;
    }
    if (Array.isArray(current["failures"])) {
      current = (current["failures"] as Record<string, unknown>[])[0];
      continue;
    }
    return current;
  }
  return current;
}

Effect.runPromise(
  Effect.scoped(run).pipe(
    // A failed spawn logs at ERROR, which would land on the same stream as the trace.
    Effect.provide(Logger.layer([])),
    Effect.provide(
      Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
  ),
).then(
  () => process.exit(0),
  (cause) => {
    process.stderr.write(`${String(cause)}\n`);
    process.exit(1);
  },
);
