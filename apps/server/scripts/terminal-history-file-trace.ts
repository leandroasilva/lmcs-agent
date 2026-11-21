import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ProcessRunner from "../src/processRunner.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";
import type * as PtyAdapter from "../src/terminal/PtyAdapter.ts";

class TracePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid = 9000;
  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(): () => void {
    return () => {};
  }
  onExit(): () => void {
    return () => {};
  }
}

class TracePtyAdapter {
  spawn(): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    return Effect.succeed(new TracePtyProcess());
  }
}

type TraceCase = readonly [name: string, maxLines: number, maxBytes: number, input: Uint8Array];

const cases: ReadonlyArray<TraceCase> = [
  ["empty", 5, 64, Buffer.from("")],
  ["bom-only", 5, 64, Buffer.from("\uFEFF")],
  ["bom-prefix", 5, 64, Buffer.from("\uFEFFhello\n")],
  ["valid-small-multiline", 5, 64, Buffer.from("first\ncafé\nlast\n")],
  ["line-cap", 2, 64, Buffer.from("first\nsecond\n\nlast\n")],
  ["zero-lines-terminated", 0, 64, Buffer.from("first\nlast\n")],
  ["zero-lines-unterminated", 0, 64, Buffer.from("first\nlast")],
  ["zero-bytes", 5, 0, Buffer.from("first\n\u{1f600}last\n")],
  ["utf8-budget-1", 5, 1, Buffer.from("aaa\u{1f600}bbb")],
  ["utf8-budget-2", 5, 2, Buffer.from("aaa\u{1f600}bbb")],
  ["utf8-budget-3", 5, 3, Buffer.from("aaa\u{1f600}bbb")],
  ["utf8-budget-4", 5, 4, Buffer.from("aaa\u{1f600}bbb")],
  ["utf8-budget-5", 5, 5, Buffer.from("aaa\u{1f600}bbb")],
  ["utf8-budget-6", 5, 6, Buffer.from("aaa\u{1f600}bbb")],
  ["utf8-budget-7", 5, 7, Buffer.from("aaa\u{1f600}bbb")],
  ["utf8-budget-8", 5, 8, Buffer.from("aaa\u{1f600}bbb")],
  ["utf8-budget-9", 5, 9, Buffer.from("aaa\u{1f600}bbb")],
  ["utf8-budget-10", 5, 10, Buffer.from("aaa\u{1f600}bbb")],
  ["oversized-unicode-tail", 5, 15, Buffer.from("old".repeat(32_768) + "\u{1f600}\uFEFFnewest\ré")],
  ["malformed-budget-64", 5, 64, Uint8Array.of(0xff, 0x61, 0x80)],
  ["malformed-budget-3", 5, 3, Uint8Array.of(0xff, 0x61, 0x80)],
  ["incomplete-utf8-eof", 5, 64, Uint8Array.of(0xe2, 0x82)],
  ["bom-after-truncated-offset", 5, 9, Buffer.from("old\uFEFFnewest")],
  [
    "ordinary-controls-restored",
    5,
    256,
    Buffer.from("nul\u0000tab\tback\bbel\u0007carriage\r\u001b[31mred\u001b[0m\n"),
  ],
];

const traceCase = Effect.fnUntraced(function* ([name, maxLines, maxBytes, input]: TraceCase) {
  NodeAssert.ok(
    Number.isSafeInteger(maxBytes) && maxBytes >= 0,
    `${name}: finite byte budget required`,
  );
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: `lmcs-terminal-history-${name}-` });
  const logsDir = join(baseDir, "userdata", "logs", "terminals");
  const currentPath = join(logsDir, "terminal_dGhyZWFkLTE.log");
  yield* fs.makeDirectory(logsDir, { recursive: true });
  yield* fs.writeFile(currentPath, input);

  let opening = false;
  let openedCount = 0;
  let closedCount = 0;
  let writeCount = 0;
  let seekOffset: bigint | undefined;
  const readRequests: number[] = [];
  const trackedFileSystem = FileSystem.FileSystem.of({
    ...fs,
    readFileString: (candidate, encoding) =>
      candidate === currentPath
        ? Effect.die(`${name}: restoration must not read the whole source via readFileString`)
        : fs.readFileString(candidate, encoding),
    readFile: (candidate) =>
      candidate === currentPath
        ? Effect.die(`${name}: restoration must not read the whole source via readFile`)
        : fs.readFile(candidate),
    open: Effect.fnUntraced(function* (...args: Parameters<FileSystem.FileSystem["open"]>) {
      const [candidate, options] = args;
      if (candidate !== currentPath) return yield* fs.open(candidate, options);
      NodeAssert.ok(opening, `${name}: source opened outside manager.open`);
      NodeAssert.equal(options?.flag, "r", `${name}: source must be read-only`);
      openedCount += 1;
      NodeAssert.equal(openedCount, 1, `${name}: source opened more than once`);
      // Register first so LIFO finalization acknowledges the underlying file close, not just scope exit.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closedCount += 1;
        }),
      );
      const file = yield* fs.open(candidate, options);
      return new Proxy(file, {
        get(target, key) {
          if (key === "read") {
            return Effect.fnUntraced(function* (buffer: Uint8Array) {
              NodeAssert.equal(closedCount, 0, `${name}: read after source scope closed`);
              NodeAssert.ok(
                buffer.byteLength > 0 && buffer.byteLength <= maxBytes,
                `${name}: read request exceeds byte budget`,
              );
              readRequests.push(buffer.byteLength);
              return yield* target.read(buffer.subarray(0, 5));
            });
          }
          if (key === "seek") {
            return Effect.fnUntraced(function* (...args: Parameters<FileSystem.File["seek"]>) {
              const [offset, from] = args;
              NodeAssert.equal(seekOffset, undefined, `${name}: source sought more than once`);
              NodeAssert.equal(from, "start", `${name}: source seek must be absolute`);
              seekOffset = offset;
              return yield* target.seek(offset, from);
            });
          }
          return Reflect.get(target, key, target);
        },
      });
    }),
    writeFileString: Effect.fnUntraced(function* (
      ...args: Parameters<FileSystem.FileSystem["writeFileString"]>
    ) {
      if (args[0] === currentPath && opening) {
        NodeAssert.equal(openedCount, 1, `${name}: rewrite before reading source`);
        NodeAssert.equal(closedCount, 1, `${name}: rewrite before source read scope closed`);
        writeCount += 1;
        NodeAssert.ok(writeCount <= 1, `${name}: more than one rewrite during open`);
      }
      yield* fs.writeFileString(...args);
    }),
  });

  const manager = yield* TerminalManager.makeWithOptions({
    logsDir,
    historyLineLimit: maxLines,
    historyByteLimit: maxBytes,
    ptyAdapter: new TracePtyAdapter(),
    subprocessInspector: () =>
      Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
    processKillGraceMs: 1,
  }).pipe(Effect.provideService(FileSystem.FileSystem, trackedFileSystem));

  opening = true;
  const snapshot = yield* manager.open({
    threadId: "thread-1",
    terminalId: "term-1",
    cwd: baseDir,
    cols: 100,
    rows: 24,
  });
  opening = false;
  // Close persists history unconditionally, hiding whether restoration itself rewrote the file.
  const disk = Buffer.from(yield* fs.readFile(currentPath));
  const history = Buffer.from(snapshot.history, "utf8");
  NodeAssert.equal(snapshot.status, "running", `${name}: fake terminal failed to open`);
  NodeAssert.equal(openedCount, 1, `${name}: source was not opened`);
  NodeAssert.equal(closedCount, 1, `${name}: source read scope still open`);
  NodeAssert.notEqual(seekOffset, undefined, `${name}: source was not sought`);
  NodeAssert.deepEqual(
    disk,
    writeCount === 0 ? Buffer.from(input) : history,
    `${name}: disk does not match observed rewrite behavior`,
  );

  const row = [
    "R",
    name,
    maxLines,
    maxBytes,
    Buffer.from(input).toString("hex"),
    history.toString("hex"),
    writeCount,
    disk.toString("hex"),
    seekOffset,
    readRequests.join(","),
    closedCount,
  ].join("\t");
  yield* manager.close({ threadId: "thread-1" });
  return row;
});

const run = Effect.gen(function* () {
  NodeAssert.equal(new Set(cases.map(([name]) => name)).size, cases.length, "duplicate case names");
  const rows: string[] = [];
  for (const testCase of cases) {
    rows.push(yield* Effect.scoped(traceCase(testCase)));
  }
  return rows;
});

Effect.runPromise(
  run.pipe(
    Effect.provide(
      Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
  ),
).then(
  (rows) => {
    process.stderr.write(`terminal history file trace cases: ${rows.length}\n`);
    process.stdout.write(`${rows.join("\n")}\n`);
  },
  (cause) => {
    process.stderr.write(`${String(cause)}\n`);
    process.exitCode = 1;
  },
);
