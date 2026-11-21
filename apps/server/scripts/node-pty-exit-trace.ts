// Executes the packaged UnixTerminal callback with scripted native exit, stream and clock boundaries.
import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const require = NodeModule.createRequire(import.meta.url);
const { filename, source, directory } = await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageRoot = process.argv[2]
      ? path.resolve(process.argv[2])
      : path.dirname(require.resolve("node-pty/package.json"));
    const filename = path.join(packageRoot, "lib/unixTerminal.js");
    return {
      filename,
      directory: path.dirname(filename),
      source: yield* fs.readFileString(filename),
    };
  }).pipe(Effect.provide(NodeServices.layer)),
);
const libraryRequire = NodeModule.createRequire(filename);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type Step =
  | { readonly op: "data"; readonly text: string }
  | { readonly op: "exit"; readonly code: number; readonly signal: number }
  | { readonly op: "advance"; readonly at: number }
  | { readonly op: "close" };
type Action =
  | { readonly kind: "data"; readonly text: string }
  | { readonly kind: "exit"; readonly code: number; readonly signal: number }
  | { readonly kind: "closeReader" };
type Scenario = { readonly name: string; readonly steps: ReadonlyArray<Step> };

const scenarios: Scenario[] = [
  {
    name: "eofBeforeExit",
    steps: [
      { op: "data", text: "prefix" },
      { op: "close" },
      { op: "advance", at: 1000 },
      { op: "exit", code: 7, signal: 0 },
    ],
  },
  {
    name: "exitBeforeEof",
    steps: [
      { op: "exit", code: 3, signal: 0 },
      { op: "advance", at: 199 },
      { op: "data", text: "tail" },
      { op: "close" },
      { op: "advance", at: 1000 },
    ],
  },
  {
    name: "outputDoesNotResetDeadline",
    steps: [
      { op: "data", text: "prefix" },
      { op: "exit", code: 0, signal: 0 },
      { op: "advance", at: 199 },
      { op: "data", text: "tail" },
      { op: "advance", at: 200 },
      { op: "data", text: "discarded" },
      { op: "advance", at: 900 },
      { op: "close" },
    ],
  },
  {
    name: "deadlineStartsAtObservation",
    steps: [
      { op: "advance", at: 500 },
      { op: "data", text: "before" },
      { op: "exit", code: 0, signal: 9 },
      { op: "advance", at: 699 },
      { op: "data", text: "after" },
      { op: "advance", at: 700 },
      { op: "close" },
    ],
  },
  {
    name: "repeatedClose",
    steps: [{ op: "close" }, { op: "close" }, { op: "exit", code: 0, signal: 0 }, { op: "close" }],
  },
  {
    name: "duplicateObservationWhileDraining",
    steps: [
      { op: "exit", code: 3, signal: 0 },
      { op: "advance", at: 199 },
      { op: "exit", code: 8, signal: 9 },
      { op: "advance", at: 200 },
      { op: "close" },
    ],
  },
  ...[0, 1, 199, 200, 201, 1000].map((at): Scenario => ({
    name: `boundary${at}`,
    steps: [
      { op: "exit", code: 2, signal: 0 },
      { op: "advance", at },
      { op: "close" },
      { op: "advance", at: 2000 },
    ],
  })),
];

for (const scenario of scenarios) {
  let now = 0;
  let nextTimer = 0;
  let onexit: ((code: number, signal: number) => void) | undefined;
  let actions: Action[] = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  class Socket extends NodeEvents.EventEmitter {
    readable = true;
    destroyed = false;
    setEncoding() {}
    destroy() {
      if (!this.destroyed) {
        this.destroyed = true;
        actions.push({ kind: "closeReader" });
      }
    }
  }
  const socket = new Socket();
  const exports: {
    UnixTerminal?: new (
      file: string,
      args: string[],
      options: import("node-pty").IPtyForkOptions,
    ) => import("node-pty").IPty;
  } = {};
  const scopedRequire = (id: string): unknown => {
    if (id === "tty")
      return {
        ReadStream: function () {
          return socket;
        },
      };
    if (id === "./utils") {
      return {
        assign: Object.assign,
        loadNativeModule: () => ({
          dir: ".",
          module: {
            fork: (...args: unknown[]) => {
              const callback = args.at(-1);
              NodeAssert.equal(typeof callback, "function");
              onexit = callback as typeof onexit;
              return { fd: -1, pid: 0, pty: "scripted" };
            },
          },
        }),
      };
    }
    return libraryRequire(id);
  };
  NodeVM.compileFunction(
    source,
    ["require", "exports", "__dirname", "setTimeout", "clearTimeout"],
    {
      filename,
    },
  )(
    scopedRequire,
    exports,
    directory,
    (callback: () => void, delay: number) => {
      const id = ++nextTimer;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    (id: number) => timers.delete(id),
  );
  NodeAssert.ok(exports.UnixTerminal);
  const term = new exports.UnixTerminal("sh", [], { env: {}, cwd: "/" });
  term.onData((text) => actions.push({ kind: "data", text }));
  term.onExit(({ exitCode, signal }) => {
    NodeAssert.notEqual(signal, undefined);
    actions.push({ kind: "exit", code: exitCode, signal: signal! });
  });
  const snapshots = scenario.steps.map((step) => {
    actions = [];
    switch (step.op) {
      case "data":
        if (socket.readable && !socket.destroyed) socket.emit("data", step.text);
        break;
      case "exit":
        NodeAssert.ok(onexit);
        onexit(step.code, step.signal);
        break;
      case "close":
        socket.emit("close");
        break;
      case "advance":
        NodeAssert.ok(step.at >= now);
        now = step.at;
        for (const [id, timer] of timers) {
          if (timer.at <= now) {
            timers.delete(id);
            timer.callback();
          }
        }
        break;
    }
    NodeAssert.ok(timers.size <= 1);
    return {
      actions,
      deadline: [...timers.values()][0]?.at ?? null,
      acceptsData: socket.readable && !socket.destroyed,
    };
  });
  NodeAssert.equal(timers.size, 0);
  NodeAssert.equal(
    snapshots.flatMap((snapshot) => snapshot.actions).filter((action) => action.kind === "exit")
      .length,
    1,
  );
  process.stdout.write(encode({ ...scenario, snapshots }) + "\n");
}
