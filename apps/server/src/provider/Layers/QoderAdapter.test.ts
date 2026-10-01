import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProviderDriverKind, ProviderInstanceId, QoderSettings, ThreadId } from "@lmcstools/core";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ServerConfig } from "../../config.ts";
import { makeQoderAdapter } from "./QoderAdapter.ts";

const decodeQoderSettings = Schema.decodeSync(QoderSettings);
const PROVIDER = ProviderDriverKind.make("qoder");
const INSTANCE_ID = ProviderInstanceId.make("qoder-test");
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");

const qoderAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "lmcs-qoder-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (overrides?: Partial<typeof QoderSettings.Type>) =>
  makeQoderAdapter(
    decodeQoderSettings({
      enabled: true,
      binaryPath: "qoder",
      ...overrides,
    }),
    { instanceId: INSTANCE_ID },
  ).pipe(Effect.orDie);

it.layer(qoderAdapterTestLayer)("QoderAdapter", (it) => {
  describe("session lifecycle", () => {
    it.effect("starts a session and tracks it", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();

        const session = yield* adapter.startSession({ threadId: THREAD_A });

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

        yield* adapter.startSession({ threadId: THREAD_A });
        yield* adapter.startSession({ threadId: THREAD_B });

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

        yield* adapter.startSession({ threadId: THREAD_A });
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

        yield* adapter.startSession({ threadId: THREAD_A });
        yield* adapter.startSession({ threadId: THREAD_B });
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
    it.effect("returns a turn id for an active session", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();
        yield* adapter.startSession({ threadId: THREAD_A });

        const result = yield* adapter.sendTurn({
          threadId: THREAD_A,
          prompt: "Hello Qoder",
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
          .sendTurn({ threadId: unknownThread, prompt: "test" })
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
        yield* adapter.startSession({ threadId: THREAD_A });

        yield* adapter.interruptTurn(THREAD_A);
      }),
    );
  });

  describe("readThread", () => {
    it.effect("returns thread items for an active session", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();
        yield* adapter.startSession({ threadId: THREAD_A });

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
        yield* adapter.startSession({ threadId: THREAD_A });

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

    it.effect("advertises in-session model switching", () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();
        assert.equal(adapter.capabilities.sessionModelSwitch, "in-session");
      }),
    );
  });
});
