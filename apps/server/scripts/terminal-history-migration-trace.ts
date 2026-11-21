import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_TERMINAL_ID } from "@lmcstools/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
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

type Fault =
  | "none"
  | "exists-current"
  | "open-current"
  | "write-current"
  | "exists-legacy"
  | "open-legacy"
  | "remove-legacy";

type TraceCase = readonly [
  name: string,
  threadId: string,
  terminalId: string,
  maxLines: number,
  maxBytes: number,
  current: Uint8Array | null,
  legacy: Uint8Array | null,
  fault: Fault,
];

const empty = Buffer.from("");
const current = Buffer.from("current\ncafé\n");
const legacy = Buffer.from("legacy\ncafé\n");
const malformed = Uint8Array.of(0xff, 0x61, 0x80, 0xe2, 0x82);
const unicodeTail = Buffer.from("old\n".repeat(32) + "discard\n\u{1f600}\né\nlast\n");
const punctuationId = "AZaz09._- /\\:!?%#";
const unicodeId = "café-東京-e\u0301";
const alphabetId = "\u083e\u083f";
const defaultId = DEFAULT_TERMINAL_ID;
const isHistoryError = Schema.is(TerminalManager.TerminalHistoryError);

const cases: ReadonlyArray<TraceCase> = [
  ["missing-both", "thread-1", defaultId, 5, 64, null, null, "none"],
  ["secondary-ignores-legacy", "thread-1", "term-2", 5, 64, null, legacy, "none"],
  ["current-wins", "thread-1", defaultId, 5, 64, current, legacy, "none"],
  ["empty-current-wins", "thread-1", defaultId, 5, 64, empty, legacy, "none"],
  ["legacy-normal", "thread-1", defaultId, 5, 64, null, legacy, "none"],
  ["legacy-empty", "thread-1", defaultId, 5, 64, null, empty, "none"],
  ["legacy-bounded-unicode", "thread-1", defaultId, 2, 13, null, unicodeTail, "none"],
  ["legacy-lossy-utf8", "thread-1", defaultId, 5, 64, null, malformed, "none"],
  ["current-rewrite-lines", "thread-1", defaultId, 1, 64, current, legacy, "none"],
  ["current-rewrite-bytes", "thread-1", defaultId, 5, 13, unicodeTail, legacy, "none"],
  ["current-malformed-no-rewrite", "thread-1", defaultId, 5, 64, malformed, legacy, "none"],
  ["path-padding-1-default", "a", defaultId, 5, 64, null, legacy, "none"],
  ["path-padding-2-default", "ab", defaultId, 5, 64, null, legacy, "none"],
  ["path-padding-3-default", "abc", defaultId, 5, 64, null, legacy, "none"],
  ["path-padding-1-secondary", "a", "x", 5, 64, current, legacy, "none"],
  ["path-padding-2-secondary", "ab", "xy", 5, 64, current, legacy, "none"],
  ["path-padding-3-secondary", "abc", "xyz", 5, 64, current, legacy, "none"],
  ["path-punctuation-default", punctuationId, defaultId, 5, 64, null, legacy, "none"],
  ["path-punctuation-secondary", punctuationId, "term/\\:._- !?#", 5, 64, current, legacy, "none"],
  ["path-non-bmp-utf16", "x\u{1f600}y", defaultId, 5, 64, null, legacy, "none"],
  ["path-unicode-default", unicodeId, defaultId, 5, 64, null, legacy, "none"],
  ["path-unicode-secondary", unicodeId, "终端-é", 5, 64, current, legacy, "none"],
  ["path-base64url-default", alphabetId, defaultId, 5, 64, null, legacy, "none"],
  ["path-base64url-secondary", alphabetId, alphabetId, 5, 64, current, legacy, "none"],
  ["fault-exists-current", unicodeId, "term-2", 5, 64, current, legacy, "exists-current"],
  ["fault-open-current", "thread-1", defaultId, 5, 64, current, legacy, "open-current"],
  [
    "fault-write-current-truncate",
    unicodeId,
    "term-2",
    5,
    13,
    unicodeTail,
    legacy,
    "write-current",
  ],
  ["fault-exists-legacy", "thread-1", defaultId, 5, 64, null, legacy, "exists-legacy"],
  ["fault-open-legacy", "thread-1", defaultId, 5, 64, null, legacy, "open-legacy"],
  ["fault-write-current-migrate", "thread-1", defaultId, 5, 64, null, legacy, "write-current"],
  ["fault-remove-legacy", "thread-1", defaultId, 5, 64, null, legacy, "remove-legacy"],
];

const bytesHex = (bytes: Uint8Array | null) =>
  bytes === null ? "-" : Buffer.from(bytes).toString("hex");

const readOptional = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, filePath: string) {
  return (yield* fs.exists(filePath)) ? yield* fs.readFile(filePath) : null;
});

type Method = "exists" | "open" | "writeFileString" | "remove";
type Observation = { method: Method; target: "current" | "legacy"; path: string };

const traceCase = Effect.fnUntraced(function* ([
  name,
  threadId,
  terminalId,
  maxLines,
  maxBytes,
  initialCurrent,
  initialLegacy,
  fault,
]: TraceCase) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: `lmcs-terminal-migration-${name}-` });
  const logsDir = path.join(baseDir, "userdata", "logs", "terminals");
  // Seed independently of Effect.Encoding and the Manager's private filename helpers.
  const threadPart = `terminal_${Buffer.from(threadId, "utf8").toString("base64url")}`;
  const currentBasename = `${threadPart}${terminalId === defaultId ? "" : `_${Buffer.from(terminalId, "utf8").toString("base64url")}`}.log`;
  // Deliberately non-u: a non-BMP character replaces two UTF-16 code units.
  const legacyBasename = `${threadId.replace(/[^a-zA-Z0-9._-]/g, "_")}.log`;
  const currentPath = path.join(logsDir, currentBasename);
  const legacyPath = path.join(logsDir, legacyBasename);
  NodeAssert.notEqual(currentPath, legacyPath, `${name}: seed paths collide`);
  yield* fs.makeDirectory(logsDir, { recursive: true });
  if (initialCurrent !== null) yield* fs.writeFile(currentPath, initialCurrent);
  if (initialLegacy !== null) yield* fs.writeFile(legacyPath, initialLegacy);

  let opening = false;
  let injectedError: PlatformError.PlatformError | undefined;
  const observations: Observation[] = [];
  const logs: Array<{ logLevel: string; message: unknown }> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (opening) logs.push({ logLevel, message });
  });
  const observe = (method: Method, candidate: string) => {
    if (!opening || path.dirname(candidate) !== logsDir) return;
    NodeAssert.ok(
      candidate === currentPath || candidate === legacyPath,
      `${name}: Manager accessed unexpected log path ${candidate}`,
    );
    const target = candidate === currentPath ? "current" : "legacy";
    observations.push({ method, target, path: candidate });
    const faultKey = `${method === "writeFileString" ? "write" : method}-${target}`;
    if (faultKey !== fault) return;
    NodeAssert.equal(injectedError, undefined, `${name}: fault injected more than once`);
    injectedError = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method,
      pathOrDescriptor: candidate,
      description: `Injected ${fault}`,
    });
    return injectedError;
  };
  const isTarget = (candidate: string) => candidate === currentPath || candidate === legacyPath;
  const trackedFileSystem = FileSystem.FileSystem.of({
    ...fs,
    exists: Effect.fnUntraced(function* (candidate: string) {
      const error = observe("exists", candidate);
      if (error) return yield* error;
      return yield* fs.exists(candidate);
    }),
    open: Effect.fnUntraced(function* (...args: Parameters<FileSystem.FileSystem["open"]>) {
      const [candidate, options] = args;
      if (opening && isTarget(candidate)) NodeAssert.equal(options?.flag, "r");
      const error = observe("open", candidate);
      if (error) return yield* error;
      return yield* fs.open(...args);
    }),
    writeFileString: Effect.fnUntraced(function* (
      ...args: Parameters<FileSystem.FileSystem["writeFileString"]>
    ) {
      const error = observe("writeFileString", args[0]);
      if (error) return yield* error;
      return yield* fs.writeFileString(...args);
    }),
    remove: Effect.fnUntraced(function* (...args: Parameters<FileSystem.FileSystem["remove"]>) {
      if (opening && isTarget(args[0])) NodeAssert.equal(args[1]?.force, true);
      const error = observe("remove", args[0]);
      if (error) return yield* error;
      return yield* fs.remove(...args);
    }),
    readFile: (candidate) =>
      opening && isTarget(candidate)
        ? Effect.die(`${name}: Manager bypassed the scoped tail reader`)
        : fs.readFile(candidate),
    readFileString: (candidate, encoding) =>
      opening && isTarget(candidate)
        ? Effect.die(`${name}: Manager bypassed the scoped tail reader`)
        : fs.readFileString(candidate, encoding),
  });

  const manager = yield* TerminalManager.makeWithOptions({
    logsDir,
    historyLineLimit: maxLines,
    historyByteLimit: maxBytes,
    ptyAdapter: new TracePtyAdapter(),
    env: {},
    shellResolver: () => "/bin/sh",
    subprocessInspector: () =>
      Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
    processKillGraceMs: 0,
  }).pipe(Effect.provideService(FileSystem.FileSystem, trackedFileSystem));

  opening = true;
  const result = yield* manager
    .open({ threadId, terminalId, cwd: baseDir, cols: 100, rows: 24 })
    .pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      // Capture typed failures only; assertions, defects and interruptions must abort the oracle.
      Effect.result,
      Effect.ensuring(
        Effect.sync(() => {
          // Also disable injections before failed-open scope cleanup or successful close.
          opening = false;
        }),
      ),
    );
  // Close writes unconditionally. Sample disk and operations before any close/finalization.
  const finalCurrent = yield* readOptional(fs, currentPath);
  const finalLegacy = yield* readOptional(fs, legacyPath);
  const observedCurrent = observations.find((entry) => entry.target === "current")?.path;
  const observedLegacy = observations.find((entry) => entry.target === "legacy")?.path;
  NodeAssert.equal(observedCurrent, currentPath, `${name}: current path not observed`);
  NodeAssert.deepEqual(observations[0], { method: "exists", target: "current", path: currentPath });
  if (observedLegacy !== undefined) NodeAssert.equal(observedLegacy, legacyPath);
  if (initialCurrent !== null || terminalId !== defaultId) {
    NodeAssert.equal(observedLegacy, undefined, `${name}: legacy must be ignored`);
  } else if (fault !== "exists-current") {
    NodeAssert.equal(observedLegacy, legacyPath, `${name}: legacy fallback not observed`);
  }

  const expectedOperation =
    fault === "none" || fault === "remove-legacy"
      ? "-"
      : fault === "exists-current" || fault === "open-current"
        ? "read"
        : fault === "write-current" && initialCurrent !== null
          ? "truncate"
          : "migrate";
  NodeAssert.equal(injectedError !== undefined, fault !== "none", `${name}: fault not reached`);
  if (injectedError !== undefined) {
    NodeAssert.ok(injectedError instanceof PlatformError.PlatformError);
    NodeAssert.equal(injectedError._tag, "PlatformError");
    NodeAssert.ok(injectedError.reason instanceof PlatformError.SystemError);
    NodeAssert.equal(injectedError.reason._tag, "PermissionDenied");
    NodeAssert.equal(injectedError.reason.module, "FileSystem");
    NodeAssert.equal(injectedError.reason.method, observations.at(-1)?.method);
    NodeAssert.equal(injectedError.reason.pathOrDescriptor, observations.at(-1)?.path);
  }

  let historyHex = "-";
  let errorOperation = "-";
  if (result._tag === "Failure") {
    const error = result.failure;
    NodeAssert.notEqual(expectedOperation, "-", `${name}: unexpected failure`);
    NodeAssert.ok(isHistoryError(error));
    NodeAssert.equal(error._tag, "TerminalHistoryError");
    NodeAssert.equal(error.operation, expectedOperation);
    NodeAssert.equal(error.threadId, threadId);
    NodeAssert.equal(error.terminalId, terminalId);
    NodeAssert.strictEqual(error.cause, injectedError, `${name}: injected cause identity lost`);
    errorOperation = error.operation;
    NodeAssert.equal(bytesHex(finalCurrent), bytesHex(initialCurrent));
    NodeAssert.equal(bytesHex(finalLegacy), bytesHex(initialLegacy));
  } else {
    NodeAssert.equal(expectedOperation, "-", `${name}: expected a typed failure`);
    const snapshot = result.success;
    NodeAssert.equal(snapshot.status, "running");
    NodeAssert.equal(snapshot.threadId, threadId);
    NodeAssert.equal(snapshot.terminalId, terminalId);
    historyHex = Buffer.from(snapshot.history, "utf8").toString("hex");
    const writes = observations.filter((entry) => entry.method === "writeFileString");
    NodeAssert.ok(writes.length <= 1, `${name}: multiple writes during open`);
    if (writes.length === 1) NodeAssert.equal(writes[0]?.path, currentPath);
    NodeAssert.equal(
      bytesHex(finalCurrent),
      writes.length === 1 ? historyHex : bytesHex(initialCurrent),
    );
    const removes = observations.filter((entry) => entry.method === "remove");
    NodeAssert.ok(removes.length <= 1, `${name}: multiple removals during open`);
    if (removes.length === 1) {
      NodeAssert.equal(removes[0]?.path, legacyPath);
      NodeAssert.equal(observations.at(-2)?.method, "writeFileString");
      NodeAssert.equal(observations.at(-1)?.method, "remove");
    }
    NodeAssert.equal(
      bytesHex(finalLegacy),
      removes.length === 1 && fault !== "remove-legacy" ? "-" : bytesHex(initialLegacy),
    );
    if (name === "current-malformed-no-rewrite") {
      NodeAssert.equal(writes.length, 0);
      NodeAssert.notEqual(historyHex, bytesHex(finalCurrent));
    }
  }

  const cleanupWarnings = logs.filter(({ logLevel }) => logLevel === "Warn");
  if (fault === "remove-legacy") {
    NodeAssert.equal(logs.length, 1, `${name}: expected only the cleanup warning`);
    NodeAssert.equal(cleanupWarnings.length, 1);
    const message = cleanupWarnings[0]?.message;
    NodeAssert.ok(Array.isArray(message));
    NodeAssert.equal(message.length, 2);
    NodeAssert.equal(message[0], "failed to remove legacy terminal history");
    const metadata: unknown = message[1];
    NodeAssert.ok(Predicate.hasProperty(metadata, "threadId"));
    NodeAssert.ok(Predicate.hasProperty(metadata, "error"));
    NodeAssert.equal(metadata.threadId, threadId);
    NodeAssert.strictEqual(metadata.error, injectedError, `${name}: warning cause identity lost`);
  } else {
    NodeAssert.deepEqual(logs, [], `${name}: unexpected open logs`);
  }

  const tokens = observations.map(({ method, path: observedPath }) => {
    const token = method === "open" ? "read" : method === "writeFileString" ? "write" : method;
    return `${token}:${path.basename(observedPath)}`;
  });
  const fields = [
    "M",
    name,
    Buffer.from(threadId, "utf8").toString("hex"),
    Buffer.from(terminalId, "utf8").toString("hex"),
    maxLines,
    maxBytes,
    bytesHex(initialCurrent),
    bytesHex(initialLegacy),
    fault,
    path.basename(observedCurrent),
    // Current-wins and secondary cases never access legacy: report its explicit seed name.
    observedLegacy === undefined ? legacyBasename : path.basename(observedLegacy),
    historyHex,
    errorOperation,
    bytesHex(finalCurrent),
    bytesHex(finalLegacy),
    tokens.join(","),
    cleanupWarnings.length,
  ];
  NodeAssert.equal(fields.length, 17);
  const row = fields.join("\t");
  NodeAssert.equal(row.split("\t").length, 17);
  if (result._tag === "Success") yield* manager.close({ threadId, terminalId });
  return row;
});

const run = Effect.gen(function* () {
  NodeAssert.equal(defaultId, "term-1", "default terminal identity changed");
  NodeAssert.equal(new Set(cases.map(([name]) => name)).size, cases.length, "duplicate case names");
  NodeAssert.equal(Buffer.from(alphabetId).toString("base64url"), "4KC-4KC_");
  const rows: string[] = [];
  for (const testCase of cases) rows.push(yield* Effect.scoped(traceCase(testCase)));
  return rows;
});

Effect.runPromise(
  run.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
        Logger.layer([], { mergeWithExisting: false }),
      ),
    ),
  ),
).then(
  (rows) => {
    process.stderr.write(`terminal history migration trace cases: ${rows.length}\n`);
    process.stdout.write(`${rows.join("\n")}\n`);
  },
  (cause) => {
    process.stderr.write(`${String(cause)}\n`);
    process.exitCode = 1;
  },
);
