import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ProviderDriverKind, ProviderInstanceId, QoderSettings, ThreadId } from "@lmcstools/core";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ServerConfig } from "../../config.ts";
import type { QoderAdapterShape } from "../Services/QoderAdapter.ts";
import { makeQoderAdapter } from "./QoderAdapter.ts";

const decodeQoderSettings = Schema.decodeSync(QoderSettings);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const PROVIDER = ProviderDriverKind.make("qoder");
const INSTANCE_ID = ProviderInstanceId.make("qoder-test");
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");

const qoderAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "lmcs-qoder-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestCli = () => {
  const sessions = new Set<string>();
  const calls: Array<{ mode: string; sessionId: string }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag !== "StandardCommand") {
        throw new Error("O teste espera um comando simples do Qoder.");
      }
      const modeIndex = command.args.findIndex(
        (arg) => arg === "--session-id" || arg === "--resume",
      );
      const mode = command.args[modeIndex];
      const sessionId = command.args[modeIndex + 1];
      const prompt = command.args[command.args.indexOf("-p") + 1];
      assert.ok(mode);
      assert.ok(sessionId);
      assert.ok(prompt);
      calls.push({ mode, sessionId });

      const alreadyExists = mode === "--session-id" && sessions.has(sessionId);
      if (mode === "--resume") {
        assert.isTrue(sessions.has(sessionId));
      }
      sessions.add(sessionId);
      const stdout = alreadyExists
        ? ""
        : [
            encodeJson({
              type: "assistant",
              message: {
                content: [{ type: "text", text: `Resposta: ${prompt}` }],
              },
            }),
            encodeJson({ type: "result", subtype: "success" }),
            "",
          ].join("\n");

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(alreadyExists ? 1 : 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(stdout)),
        stderr: Stream.encodeText(
          Stream.make(alreadyExists ? `Session ${sessionId} is already in use` : ""),
        ),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, calls };
};

const makeTestAdapter = (overrides?: Partial<QoderSettings>, cli = makeTestCli()) =>
  makeQoderAdapter(
    decodeQoderSettings({
      enabled: true,
      binaryPath: "qoder",
      ...overrides,
    }),
    { instanceId: INSTANCE_ID },
  ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner), Effect.orDie);

const sendTestTurn = Effect.fnUntraced(function* (adapter: QoderAdapterShape, input: string) {
  const result = yield* adapter.sendTurn({ threadId: THREAD_A, input });
  const events = yield* adapter.streamEvents.pipe(
    Stream.filter((event) => event.turnId !== undefined),
    Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.aborted"),
    Stream.runCollect,
  );
  assert.equal(result.threadId, THREAD_A);
  assert.deepEqual(
    events.map((event) => event.type),
    ["turn.started", "content.delta", "turn.completed"],
  );
  for (const event of events) {
    assert.equal(event.threadId, THREAD_A);
    assert.equal(event.turnId, result.turnId);
    if (event.type === "content.delta") {
      assert.equal(event.payload.streamKind, "assistant_text");
      assert.equal(event.payload.delta, `Resposta: ${input}`);
    }
    if (event.type === "turn.completed") {
      assert.equal(event.payload.state, "completed");
    }
  }
  return { ...result, events };
});

it.layer(qoderAdapterTestLayer)("QoderAdapter", (it) => {
  describe("session lifecycle", () => {
    it.effect("starts a session and tracks it", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();

        const session = yield* adapter.startSession({
          threadId: THREAD_A,
          runtimeMode: "full-access",
        });

        assert.equal(session.threadId, THREAD_A);
        assert.equal(session.status, "ready");
        assert.equal(session.provider, PROVIDER);

        const hasSession = yield* adapter.hasSession(THREAD_A);
        assert.isTrue(hasSession);

        yield* adapter.stopAll();
      }),
    );

    it.effect("lists active sessions", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();

        yield* adapter.startSession({
          threadId: THREAD_A,
          runtimeMode: "full-access",
        });
        yield* adapter.startSession({
          threadId: THREAD_B,
          runtimeMode: "full-access",
        });

        const sessions = yield* adapter.listSessions();
        assert.equal(sessions.length, 2);
        assert.isTrue(sessions.some((s: { threadId: ThreadId }) => s.threadId === THREAD_A));
        assert.isTrue(sessions.some((s: { threadId: ThreadId }) => s.threadId === THREAD_B));

        yield* adapter.stopAll();
      }),
    );

    it.effect("stops a session and removes it from the map", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();

        yield* adapter.startSession({
          threadId: THREAD_A,
          runtimeMode: "full-access",
        });
        assert.isTrue(yield* adapter.hasSession(THREAD_A));

        yield* adapter.stopSession(THREAD_A);
        assert.isFalse(yield* adapter.hasSession(THREAD_A));

        const sessions = yield* adapter.listSessions();
        assert.equal(sessions.length, 0);
      }),
    );

    it.effect("stopAll clears every active session", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();

        yield* adapter.startSession({
          threadId: THREAD_A,
          runtimeMode: "full-access",
        });
        yield* adapter.startSession({
          threadId: THREAD_B,
          runtimeMode: "full-access",
        });
        assert.equal((yield* adapter.listSessions()).length, 2);

        yield* adapter.stopAll();
        assert.equal((yield* adapter.listSessions()).length, 0);
        assert.isFalse(yield* adapter.hasSession(THREAD_A));
        assert.isFalse(yield* adapter.hasSession(THREAD_B));
      }),
    );

    it.effect("stopSession is a no-op for unknown thread ids", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();
        const unknownThread = ThreadId.make("unknown");

        yield* adapter.stopSession(unknownThread);
        assert.isFalse(yield* adapter.hasSession(unknownThread));
      }),
    );
  });

  describe("sendTurn", () => {
    for (const scenario of [
      { name: "turnos consecutivos", reset: "none" },
      { name: "recriação da sessão", reset: "session" },
      { name: "reinício do adaptador", reset: "adapter" },
      { name: "remoção de turnos do histórico em memória", reset: "rollback" },
    ] as const) {
      it.effect(`mantém respostas e IDs distintos após ${scenario.name}`, () =>
        Effect.gen(function* () {
          const cli = makeTestCli();
          let adapter = yield* makeTestAdapter(undefined, cli);
          yield* adapter.startSession({
            threadId: THREAD_A,
            runtimeMode: "full-access",
          });
          const first = yield* sendTestTurn(adapter, "Primeira solicitação");

          if (scenario.reset === "session" || scenario.reset === "adapter") {
            yield* adapter.stopAll();
            if (scenario.reset === "adapter") {
              adapter = yield* makeTestAdapter(undefined, cli);
            }
            yield* adapter.startSession({
              threadId: THREAD_A,
              runtimeMode: "full-access",
            });
          } else if (scenario.reset === "rollback") {
            yield* adapter.rollbackThread(THREAD_A, 1);
          }
          const second = yield* sendTestTurn(adapter, "Segunda solicitação");

          assert.notEqual(first.turnId, second.turnId);
          const eventIds = [...first.events, ...second.events].map((event) => event.eventId);
          assert.equal(new Set(eventIds).size, eventIds.length);
          assert.equal(new Set(cli.calls.map((call) => call.sessionId)).size, 1);
          assert.deepEqual(
            cli.calls.map((call) => call.mode),
            scenario.reset === "session" || scenario.reset === "adapter"
              ? ["--session-id", "--session-id", "--resume"]
              : ["--session-id", "--resume"],
          );
          yield* adapter.stopAll();
        }),
      );
    }

    it.effect("returns a turn id for an active session", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();
        yield* adapter.startSession({
          threadId: THREAD_A,
          runtimeMode: "full-access",
        });

        const result = yield* adapter.sendTurn({
          threadId: THREAD_A,
          input: "Hello Qoder",
        });

        assert.equal(result.threadId, THREAD_A);
        assert.ok(result.turnId);

        yield* adapter.stopAll();
      }),
    );

    it.effect("fails with ProviderAdapterSessionNotFoundError for unknown threads", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();
        const unknownThread = ThreadId.make("ghost");

        const error = yield* adapter
          .sendTurn({ threadId: unknownThread, input: "test" })
          .pipe(Effect.flip);

        assert.equal(error._tag, "ProviderAdapterSessionNotFoundError");
      }),
    );
  });

  describe("interruptTurn", () => {
    it.effect("fails with ProviderAdapterSessionNotFoundError for unknown threads", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();
        const unknownThread = ThreadId.make("ghost");

        const error = yield* adapter.interruptTurn(unknownThread).pipe(Effect.flip);

        assert.equal(error._tag, "ProviderAdapterSessionNotFoundError");
      }),
    );

    it.effect("succeeds for an active session", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();
        yield* adapter.startSession({
          threadId: THREAD_A,
          runtimeMode: "full-access",
        });

        yield* adapter.interruptTurn(THREAD_A);
      }),
    );
  });

  describe("readThread", () => {
    it.effect("returns thread items for an active session", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();
        yield* adapter.startSession({
          threadId: THREAD_A,
          runtimeMode: "full-access",
        });

        const thread = yield* adapter.readThread(THREAD_A);
        assert.equal(thread.threadId, THREAD_A);
        assert.isArray(thread.turns);
      }),
    );

    it.effect("fails for unknown threads", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();
        const unknownThread = ThreadId.make("ghost");

        const error = yield* adapter.readThread(unknownThread).pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterSessionNotFoundError");
      }),
    );
  });

  describe("rollbackThread", () => {
    it.effect("fails with ProviderAdapterSessionNotFoundError for unknown threads", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();
        const unknownThread = ThreadId.make("ghost");

        const error = yield* adapter.rollbackThread(unknownThread, 1).pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterSessionNotFoundError");
      }),
    );

    it.effect("succeeds for an active session", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();
        yield* adapter.startSession({
          threadId: THREAD_A,
          runtimeMode: "full-access",
        });

        yield* adapter.rollbackThread(THREAD_A, 1);
      }),
    );
  });

  describe("metadata", () => {
    it.effect("exposes the qoder provider slug", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();
        assert.equal(adapter.provider, PROVIDER);
      }),
    );

    it.effect("advertises CLI-mode capabilities", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();
        assert.equal(adapter.capabilities.sessionModelSwitch, "unsupported");
        assert.equal(adapter.capabilities.supportsConversationRollback, false);
      }),
    );
  });
});
