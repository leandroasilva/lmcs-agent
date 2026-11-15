// Golden generator for the Rust protocol crate. It runs the shipped Effect RPC stack
// end to end — real server, real client, real `RpcSerialization.layerJson` — over a real
// WebSocket, and records the frames as **literal text**, because key order is part of what
// `native/protocol` claims to reproduce and a parsed JSON object does not carry order.
//
// `node apps/server/scripts/protocol-golden.ts > /tmp/protocol-golden.json`
//
// Two observation paths, because neither alone shows everything:
//
//   A — a real Effect `RpcClient` whose `Socket.WebSocketConstructor` wraps the platform
//       `WebSocket` and logs `send()`. Only this path produces the client-side envelopes
//       (`Request`, `Ack`, `Interrupt`) the way the shipped clients actually write them.
//   B — a raw `WebSocket` sending fabricated frames. Only this path reaches the server's
//       answers to input a correct client never produces: a `_tag` outside the union, a
//       `Request` without an `id`, a string `requestId`, keys out of order, unknown keys.
//
// `RpcTest`/`makeNoSerialization` is deliberately not used: it skips `encodePayload` and
// `encodeChunk`, so `Schema.Void` crossing as `null` and a non-object `Success.value` would
// never be observed as bytes.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";

// ---------------------------------------------------------------------------
// The synthetic group. Synthetic on purpose: the envelope is group-independent, so the
// server's own services, database and auth would only add failure modes to a measurement of
// framing. What the real `WsRpcGroup` contributes — how each payload and each success
// encodes — is the contracts golden's job, not this one.
// ---------------------------------------------------------------------------

class ProtocolGoldenError extends Schema.TaggedError()("ProtocolGoldenError", {
  why: Schema.String,
}) {}

// `Struct({})` versus an omitted `success` is the `value:{}` / `value:null` pair.
const EmptyInEmptyOutRpc = Rpc.make("emptyInEmptyOut", {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
});
const VoidSuccessRpc = Rpc.make("voidSuccess", { payload: Schema.Struct({}) });
const ScalarSuccessRpc = Rpc.make("scalarSuccess", { success: Schema.String });
const NestedRpc = Rpc.make("nested", {
  payload: Schema.Struct({ name: Schema.String, n: Schema.Number }),
  success: Schema.Struct({ ok: Schema.Boolean, items: Schema.Array(Schema.String) }),
  error: ProtocolGoldenError,
});
const TypedFailRpc = Rpc.make("typedFail", {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: ProtocolGoldenError,
});
const NoErrorRpc = Rpc.make("noError", { payload: Schema.Struct({}), success: Schema.Struct({}) });
const BatchedStreamRpc = Rpc.make("batchedStream", {
  payload: Schema.Struct({}),
  success: Schema.Struct({ i: Schema.Number }),
  stream: true,
});
const SplitStreamRpc = Rpc.make("splitStream", {
  payload: Schema.Struct({}),
  success: Schema.Struct({ i: Schema.Number }),
  stream: true,
});
const IdleRpc = Rpc.make("idle", { payload: Schema.Struct({}), success: Schema.Struct({}) });

const Group = RpcGroup.make(
  EmptyInEmptyOutRpc,
  VoidSuccessRpc,
  ScalarSuccessRpc,
  NestedRpc,
  TypedFailRpc,
  NoErrorRpc,
  BatchedStreamRpc,
  SplitStreamRpc,
  IdleRpc,
);

const handlersLayer = Group.toLayer(
  Effect.succeed({
    emptyInEmptyOut: () => Effect.succeed({}),
    voidSuccess: () => Effect.void,
    scalarSuccess: () => Effect.succeed("plain string"),
    nested: ({ name, n }: { readonly name: string; readonly n: number }) =>
      Effect.succeed({ ok: n > 1, items: [name, "x"] }),
    typedFail: () => Effect.fail(new ProtocolGoldenError({ why: "no" })),
    noError: () => Effect.die("boom"),
    batchedStream: () => Stream.make({ i: 1 }, { i: 2 }, { i: 3 }),
    splitStream: () =>
      Stream.make({ i: 1 }).pipe(
        Stream.concat(Effect.sleep("200 millis").pipe(Effect.as({ i: 2 }), Stream.fromEffect)),
      ),
    idle: () => Effect.sleep("600 millis").pipe(Effect.as({})),
  }),
);

const serverLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    yield* router.add("GET", "/ws", httpEffect);
    // `disableTracing: true` is what `apps/server/src/ws.ts:3840` ships with.
    yield* RpcServer.make(Group, { disableTracing: true }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.forkScoped,
    );
  }),
).pipe(Layer.provideMerge(handlersLayer), Layer.provide(RpcSerialization.layerJson));

const appLayer = HttpRouter.serve(serverLayer, {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
  Layer.provideMerge(NodeServices.layer),
);

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

type Frame = {
  readonly case: string;
  readonly direction: "c2s" | "s2c";
  readonly frame: string;
  readonly input?: string;
};

const frames: Frame[] = [];
const counts = new Map<string, number>();
const record = (frame: Frame) => {
  frames.push(frame);
  counts.set(frame.case, (counts.get(frame.case) ?? 0) + 1);
};

// Volatile fields are replaced by sentinels so the golden is reproducible. `mask` is total:
// a value that does not match the shape the measurement saw fails the generator rather than
// emitting a golden the Rust side cannot match.
const TRACE_ID = "__TRACE_ID__";
const SPAN_ID = "__SPAN_ID__";
const FIBER_ID = "__FIBER_ID__";

const mask = (text: string): string => {
  const out = text
    .replace(/"traceId":"[0-9a-f]{32}"/g, `"traceId":"${TRACE_ID}"`)
    .replace(/"spanId":"[0-9a-f]{16}"/g, `"spanId":"${SPAN_ID}"`)
    .replace(/"fiberId":\d+/g, `"fiberId":${FIBER_ID}`);
  if (
    /"traceId":"(?!__TRACE_ID__)[^"]*"/.test(out) ||
    /"spanId":"(?!__SPAN_ID__)[^"]*"/.test(out)
  ) {
    throw new Error(`frame carries a trace field the mask did not recognise: ${out}`);
  }
  return out;
};

// The keepalive is the one thing here driven by a timer: the client pings five seconds after
// it connects, so how many pings cross during a run depends on how long the run took. Each
// ping is byte-identical to the last, so the golden records the first of each and counts the
// rest. Everything else is recorded exactly as seen.
const PING = '{"_tag":"Ping"}';
const PONG = '{"_tag":"Pong"}';
const keepaliveSeen = new Set<string>();

let currentCase = "unset";
let currentInput: string | undefined;

const observe = (direction: "c2s" | "s2c", data: unknown): void => {
  if (typeof data !== "string") {
    throw new Error(
      `${direction} frame was not text: ${data === null ? "null" : data.constructor?.name}`,
    );
  }
  if ((direction === "c2s" && data === PING) || (direction === "s2c" && data === PONG)) {
    const key = `${direction} ${data}`;
    if (keepaliveSeen.has(key)) return;
    keepaliveSeen.add(key);
    record({ case: "keepalive", direction, frame: data });
    return;
  }
  record({
    case: currentCase,
    direction,
    frame: mask(data),
    ...(currentInput === undefined ? {} : { input: mask(currentInput) }),
  });
};

const scenario = (name: string, input?: string) => {
  currentCase = name;
  currentInput = input;
};

const recordingConstructor = (url: string, options?: unknown) => {
  const ws = new globalThis.WebSocket(url, options as string | string[] | undefined);
  return {
    get readyState() {
      return ws.readyState;
    },
    addEventListener(
      type: "open" | "message" | "error" | "close",
      listener: (event: { readonly data: unknown }) => void,
      opts?: { readonly once?: boolean },
    ) {
      if (type === "message") {
        ws.addEventListener(
          "message",
          (event: { readonly data: unknown }) => {
            observe("s2c", event.data);
            listener(event);
          },
          opts,
        );
        return;
      }
      ws.addEventListener(type, listener, opts);
    },
    removeEventListener(
      type: "open" | "message" | "error" | "close",
      listener: (event: { readonly data: unknown }) => void,
    ) {
      ws.removeEventListener(type, listener);
    },
    close(code?: number, reason?: string) {
      ws.close(code, reason);
    },
    send(data: string | Uint8Array) {
      observe("c2s", data);
      ws.send(data);
    },
  };
};

// ---------------------------------------------------------------------------
// Path A — the real client
// ---------------------------------------------------------------------------

// The shipped default `generateRequestId` is kept: it is a module-global counter starting at
// 0 that is not reset per socket, and `check` below asserts the recorded ids are exactly that
// sequence. Injecting a counter here would hide the behaviour instead of measuring it.
const buildClient = (url: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          retryTransientErrors: false,
          retryPolicy: Schedule.recurs(0),
        }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Socket.layerWebSocket(url, { openTimeout: "5 seconds" }).pipe(
              Layer.provide(Layer.succeed(Socket.WebSocketConstructor)(recordingConstructor)),
            ),
            RpcSerialization.layerJson,
          ),
        ),
      ),
    );
    return yield* RpcClient.make(Group).pipe(Effect.provide(context));
  });

const sleep = (ms: number) => Effect.sleep(`${ms} millis`);
const ignore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.matchCause({ onFailure: () => undefined, onSuccess: () => undefined }));

// `frames` is the number of frames the scenario is expected to produce in **each**
// direction, so a scenario that bled into the next is caught rather than eyeballed.
const want: Array<[string, { c2s: number; s2c: number }]> = [];
const scenarioFrames = (name: string, counts: { c2s: number; s2c: number }) => {
  want.push([name, counts]);
};

const pathA = Effect.scoped(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    if (typeof address === "string" || !("port" in address)) {
      throw new Error(`expected a TCP address, got ${JSON.stringify(address)}`);
    }
    const url = `ws://127.0.0.1:${address.port}/ws`;
    const client = yield* buildClient(url);
    yield* sleep(150);

    scenarioFrames("a.voidPayload", { c2s: 1, s2c: 1 });
    scenario("a.voidPayload");
    yield* client.emptyInEmptyOut({}).pipe(ignore);
    yield* sleep(60);

    scenarioFrames("a.omittedPayload", { c2s: 1, s2c: 1 });
    scenario("a.omittedPayload");
    yield* client.scalarSuccess().pipe(ignore);
    yield* sleep(60);

    scenarioFrames("a.nestedPayload", { c2s: 1, s2c: 1 });
    scenario("a.nestedPayload");
    yield* client.nested({ name: "hi", n: 1.5 }).pipe(ignore);
    yield* sleep(60);

    scenarioFrames("a.withHeaders", { c2s: 1, s2c: 1 });
    scenario("a.withHeaders");
    yield* RpcClient.withHeaders({ "x-first": "1", "x-second": "2" })(
      client.emptyInEmptyOut({}),
    ).pipe(ignore);
    yield* sleep(60);

    scenarioFrames("a.voidSuccess", { c2s: 1, s2c: 1 });
    scenario("a.voidSuccess");
    yield* client.voidSuccess({}).pipe(ignore);
    yield* sleep(60);

    scenarioFrames("a.typedFail", { c2s: 1, s2c: 1 });
    scenario("a.typedFail");
    yield* client.typedFail({}).pipe(ignore);
    yield* sleep(60);

    scenarioFrames("a.handlerDieNoErrorSchema", { c2s: 1, s2c: 1 });
    scenario("a.handlerDieNoErrorSchema");
    yield* client.noError({}).pipe(ignore);
    yield* sleep(60);

    // One Chunk holding every synchronously available value, one Ack, then the terminal
    // Exit. The stream's own success is `Struct({i})` but the terminal Exit carries `Void`,
    // because `stream: true` replaces success with Void and error with Never.
    scenarioFrames("a.streamBatched", { c2s: 2, s2c: 2 });
    scenario("a.streamBatched");
    yield* client.batchedStream({}).pipe(Stream.runCollect, ignore);
    yield* sleep(60);

    scenarioFrames("a.streamSplit", { c2s: 3, s2c: 3 });
    scenario("a.streamSplit");
    yield* client.splitStream({}).pipe(Stream.runCollect, ignore);
    yield* sleep(400);

    // `take(2)` of a stream whose single Chunk already holds three values: the client Acks
    // the Chunk and then Interrupts the request, so both frames arrive before the pull
    // could have stopped the group.
    scenarioFrames("a.streamInterrupted", { c2s: 3, s2c: 2 });
    scenario("a.streamInterrupted");
    yield* client.batchedStream({}).pipe(Stream.take(2), Stream.runCollect, ignore);
    yield* sleep(300);

    // A window long enough for the five-second keepalive, so the Ping/Pong pair is captured
    // from the real client rather than asserted about it.
    yield* sleep(5400);

    // A second client on a second socket, to show routing is per client and not per process.
    const client2 = yield* buildClient(url);
    yield* sleep(150);
    scenarioFrames("a.secondSocket", { c2s: 1, s2c: 1 });
    scenario("a.secondSocket");
    yield* client2.emptyInEmptyOut({}).pipe(ignore);
    yield* sleep(60);
  }),
).pipe(Effect.provide(appLayer));

const BROADCAST_SENDS = [
  '{"_tag":"Request","id":9101,"tag":"idle","payload":{},"headers":[]}',
  '{"_tag":"Request","id":9102,"tag":"idle","payload":{},"headers":[]}',
  '{"_tag":"Nonsense"}',
];

// ---------------------------------------------------------------------------
// Path B — fabricated frames, so the server's decode behaviour is measured too
// ---------------------------------------------------------------------------

const pathB = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const address = server.address;
  if (typeof address === "string" || !("port" in address)) {
    throw new Error(`expected a TCP address, got ${JSON.stringify(address)}`);
  }
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const ws = new globalThis.WebSocket(url);
  const seen: Array<string> = [];
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      throw new Error(`server sent a non-text frame: ${event.data}`);
    }
    seen.push(event.data);
  });
  yield* Effect.promise(() => new Promise<void>((resolve) => ws.addEventListener("open", resolve)));

  const send = (name: string, input: string, s2c: number, settleMs: number) =>
    Effect.gen(function* () {
      const before = seen.length;
      yield* Effect.sync(() => {
        scenario(name, input);
        observe("c2s", input);
        ws.send(input);
      });
      yield* sleep(settleMs);
      const arrived = seen.slice(before);
      scenarioFrames(name, { c2s: 1, s2c: arrived.length });
      if (arrived.length !== s2c) {
        throw new Error(
          `${name}: expected ${s2c} response frame(s), got ${arrived.length}: ${JSON.stringify(arrived)}`,
        );
      }
      // Responses are recorded by the `observe` listener above, which is the same shape the
      // real client path uses; `seen` exists only to count them.
    });

  ws.addEventListener("message", (event) => {
    observe("s2c", event.data);
  });

  yield* send(
    "b.unknownTag",
    '{"_tag":"Request","id":9001,"tag":"nope","payload":{},"headers":[]}',
    1,
    80,
  );
  yield* send("b.badTagLiteral", '{"_tag":"Nonsense"}', 1, 80);
  yield* send(
    "b.missingTag",
    '{"id":9002,"tag":"emptyInEmptyOut","payload":{},"headers":[]}',
    1,
    80,
  );
  yield* send(
    "b.missingId",
    '{"_tag":"Request","tag":"emptyInEmptyOut","payload":{},"headers":[]}',
    1,
    80,
  );
  yield* send(
    "b.stringId",
    '{"_tag":"Request","id":"abc","tag":"typedFail","payload":{},"headers":[]}',
    1,
    80,
  );
  yield* send(
    "b.keysOutOfOrder",
    '{"_tag":"Request","id":9003,"headers":[],"payload":{},"tag":"emptyInEmptyOut"}',
    1,
    80,
  );
  yield* send(
    "b.unknownKeys",
    '{"_tag":"Request","id":9004,"tag":"typedFail","payload":{},"headers":[],"zzz":1}',
    1,
    80,
  );
  yield* send(
    "b.payloadWrongType",
    '{"_tag":"Request","id":9005,"tag":"nested","payload":{"name":1,"n":2},"headers":[]}',
    1,
    80,
  );
  yield* send(
    "b.payloadMissingKey",
    '{"_tag":"Request","id":9006,"tag":"nested","payload":{"name":"a"},"headers":[]}',
    1,
    80,
  );
  yield* send(
    "b.omittedPayloadRaw",
    '{"_tag":"Request","id":9007,"tag":"scalarSuccess","headers":[]}',
    1,
    80,
  );
  yield* send("b.ackUnknownRequest", '{"_tag":"Ack","requestId":9999}', 0, 150);
  yield* send("b.interruptUnknownRequest", '{"_tag":"Interrupt","requestId":9998}', 0, 150);
  yield* send("b.eofFromClient", '{"_tag":"Eof"}', 0, 150);
  yield* send("b.pongFromClient", '{"_tag":"Pong"}', 1, 80);
  yield* send("b.chunkFromClient", '{"_tag":"Chunk","requestId":1,"values":[]}', 1, 80);
  yield* send("b.exitFromClient", '{"_tag":"Exit","requestId":1,"exit":{}}', 1, 80);

  // Does a broadcast `Defect` clear requests already in flight? Two 600 ms handlers are
  // started and a garbage frame lands between them.
  const beforeBatch = seen.length;
  const beforeBatchLog = frames.length;
  yield* Effect.sync(() => {
    scenario("b.broadcastWithInFlight", '9101 + 9102, then {"_tag":"Nonsense"}');
    ws.send('{"_tag":"Request","id":9101,"tag":"idle","payload":{},"headers":[]}');
    ws.send('{"_tag":"Request","id":9102,"tag":"idle","payload":{},"headers":[]}');
    ws.send('{"_tag":"Nonsense"}');
  });
  // The three sends above bypass `observe`, so they are recorded after the fact rather than
  // claimed to have been captured live.
  frames.splice(
    beforeBatchLog,
    0,
    ...BROADCAST_SENDS.map((frame) => ({
      case: "b.broadcastWithInFlight",
      direction: "c2s" as const,
      frame,
    })),
  );
  currentInput = undefined;
  yield* sleep(1200);
  const batch = seen.slice(beforeBatch);
  scenarioFrames("b.broadcastWithInFlight", { c2s: 3, s2c: batch.length });
  if (batch.length !== 3) {
    throw new Error(
      `broadcast with in-flight requests: expected 3 frames (Defect + two Exits), got ${JSON.stringify(batch)}`,
    );
  }

  ws.close();
  yield* sleep(50);
}).pipe(Effect.provide(appLayer));

// ---------------------------------------------------------------------------

const check = Effect.sync(() => {
  const byCase = new Map<string, { c2s: number; s2c: number }>();
  for (const frame of frames) {
    const entry = byCase.get(frame.case) ?? { c2s: 0, s2c: 0 };
    entry[frame.direction] += 1;
    byCase.set(frame.case, entry);
  }
  for (const [name, expected] of want) {
    const actual = byCase.get(name) ?? { c2s: 0, s2c: 0 };
    if (actual.c2s !== expected.c2s || actual.s2c !== expected.s2c) {
      throw new Error(
        `case ${name}: expected ${expected.c2s} c2s + ${expected.s2c} s2c, got ${actual.c2s} + ${actual.s2c}`,
      );
    }
  }

  // `Eof` is in the protocol union but the WebSocket transport never writes it — only
  // `makeProtocolWithHttpEffect` does (`RpcServer.ts:1153`). `isNotification` is a
  // JSON-RPC-serializer idea (`RpcSerialization.ts:322`) and never appears under `layerJson`.
  // Asserting both turns "we did not happen to see one" into a claim about the golden.
  if (frames.some((f) => f.direction === "s2c" && f.frame.includes('"_tag":"Eof"'))) {
    throw new Error("the server wrote an Eof frame on a WebSocket, contradicting the measurement");
  }
  if (frames.some((f) => f.direction === "c2s" && f.frame.includes('"isNotification"'))) {
    throw new Error(
      "the client wrote isNotification under layerJson, contradicting the measurement",
    );
  }
  // Only path A counts: a `_tag`-less client frame is something this file fabricated on
  // purpose to reach the server's rejection path, not evidence about how a client writes.
  const badClientFrames = frames
    .filter(
      (f) =>
        f.direction === "c2s" &&
        (f.case.startsWith("a.") || f.case === "keepalive") &&
        !f.frame.startsWith('{"_tag":'),
    )
    .map((f) => `${f.case}: ${f.frame}`);
  if (badClientFrames.length > 0) {
    throw new Error(
      `client frame(s) did not begin with _tag, so key order is not what was measured: ${JSON.stringify(badClientFrames)}`,
    );
  }
  for (const sentinel of [TRACE_ID, SPAN_ID, FIBER_ID]) {
    if (!frames.some((f) => f.frame.includes(sentinel))) {
      throw new Error(`sentinel ${sentinel} never appears: the mask or the shape moved`);
    }
  }
  if (!keepaliveSeen.has("c2s " + PING) || !keepaliveSeen.has("s2c " + PONG)) {
    throw new Error("the keepalive pair was never observed on the real client");
  }

  // The ids the real client wrote must be exactly the shipped module-global counter: 0, 1, 2,
  // … across **both** sockets, not restarted per connection. That is a wire-observable fact
  // about the Rust client, so it is asserted here rather than left to be read off the file.
  const clientIds = frames
    .filter(
      (f) =>
        f.direction === "c2s" &&
        f.frame.startsWith('{"_tag":"Request","id":') &&
        f.case.startsWith("a."),
    )
    .map((f) => Number(/^\{"_tag":"Request","id":(\d+),/.exec(f.frame)?.[1]));
  const expectedIds = clientIds.map((_, index) => index);
  if (JSON.stringify(clientIds) !== JSON.stringify(expectedIds)) {
    throw new Error(
      `client request ids were ${JSON.stringify(clientIds)}, expected the 0-based sequence ${JSON.stringify(expectedIds)}`,
    );
  }
  if (clientIds.length < 9) {
    throw new Error(`only ${clientIds.length} path-A requests recorded; the id claim is thin`);
  }

  const summary = {
    methods: (Group as unknown as { requests: Map<string, unknown> }).requests.size,
    frames: frames.length,
    clientToServer: frames.filter((f) => f.direction === "c2s").length,
    serverToClient: frames.filter((f) => f.direction === "s2c").length,
    scenarios: want.length,
    sentInputs: frames.filter((f) => f.input !== undefined).length,
    opcode: "text",
    serialization: "RpcSerialization.layerJson",
  };
  process.stderr.write(`${JSON.stringify(summary)}\n`);
  process.stdout.write(`${JSON.stringify({ summary, frames }, undefined, 2)}\n`);
});

const run = Effect.gen(function* () {
  yield* pathA;
  yield* pathB;
  yield* check;
});

Effect.runPromise(run).then(
  () => process.exit(0),
  (cause) => {
    process.stderr.write(`protocol-golden failed: ${cause}\n`);
    process.exit(1);
  },
);
