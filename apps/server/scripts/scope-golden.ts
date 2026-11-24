// Golden generator for the **scope** half of `native/protocol`: what the server writes when a request
// reaches `ws.ts:605-618`'s gate with the wrong scopes, and what the scope table covers across the real
// `WsRpcGroup`.
//
// `node apps/server/scripts/scope-golden.ts > ~/.cache/lmcs-port-traces/scope-golden.json`
//
// `auth-golden.ts` measured the table (`RPC_REQUIRED_SCOPES`) and the upgrade-time refusal. It could not
// measure the gate, because a refusal there happens before any frame exists. This file measures the other
// side: a connection that authenticated and then asked for something its scopes do not cover. The frames
// are recorded as **literal text**, because the claim is about the encoded failure (which keys, in which
// order, under which `_tag` of the envelope) and a parsed object does not carry order.
//
// Two halves, because one question is about the *code* and one about the *bytes*:
//
//   `declared` — over the real `WsRpcGroup`: does every method in `RPC_REQUIRED_SCOPES` have a handler,
//       and does its rpc carry `EnvironmentAuthorizationError` in its error channel? That second answer is
//       what decides whether a Rust server emits a typed failure or a defect, so it is measured rather
//       than assumed, and the exceptions are named.
//   `wire` — a synthetic group whose handlers are wrapped by `authorizeEffect`/`authorizeStream` copied
//       from `ws.ts:600-652` and whose scope lookups are the real `requiredScopeForRpcMethod` /
//       `requiredScopeForDeviceList`. The real `WsRpcGroup` is deliberately not served here, exactly as in
//       `upgrade-golden.ts`: its handlers need the database, the providers and the orchestration services,
//       which would add failure modes to a measurement of one `if`.
//
// `LMCS_SCOPE_GOLDEN_RECORD=1` prints what each wire case measured instead of checking it, which is how
// every number pinned below was obtained.
//
// Run twice and compare with `cmp`: any byte that moves is a claim this file does not pin.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { writeSync } from "node:fs";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import { EnvironmentAuthorizationError, WS_METHODS, WsRpcGroup } from "@lmcstools/core";
import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForDeviceList,
  requiredScopeForRpcMethod,
} from "../src/auth/RpcAuthorization.ts";

// ---------------------------------------------------------------------------
// The gate, read off `ws.ts:600-652`.
//
// Three lines of the real thing and nothing else: `currentSession.scopes.includes(requiredScope)`, which
// is Array's exact-match `includes` (no ordering, no implication between `read` and `operate`), the effect
// wrapper, and the stream wrapper. The scope *lookup* is imported, not paraphrased.
// ---------------------------------------------------------------------------

const authorizationError = (requiredScope: string) =>
  new EnvironmentAuthorizationError({
    message: `The authenticated token is missing required scope: ${requiredScope}.`,
    requiredScope: requiredScope as never,
  });

const authorizeEffect = <A, E, R>(
  scopes: ReadonlyArray<string>,
  requiredScope: string,
  effect: Effect.Effect<A, E, R>,
) => (scopes.includes(requiredScope) ? effect : Effect.fail(authorizationError(requiredScope)));

const authorizeStream = <A, E, R>(
  scopes: ReadonlyArray<string>,
  requiredScope: string,
  stream: Stream.Stream<A, E, R>,
) => (scopes.includes(requiredScope) ? stream : Stream.fail(authorizationError(requiredScope)));

// ---------------------------------------------------------------------------
// `declared` — the table against the real group, in the process
// ---------------------------------------------------------------------------

/** `SchemaAST` walk: is this tag reachable from the rpc's error schema? */
const mentions = (value: unknown, tag: string, seen = new Set<unknown>()): boolean => {
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => mentions(item, tag, seen));
  const record = value as Record<string, unknown>;
  if (typeof record._tag === "string" && record._tag === tag) return true;
  if (typeof record._tag === "string" && record._tag === "TaggedError") {
    // `Schema.TaggedError` stamps the tag into the AST annotation, and the class name is what the
    // serializer writes, so both spellings count as "this error is in the union".
    const identifier = record.identifier ?? record.tag ?? record.ast ?? undefined;
    if (typeof identifier === "string" && identifier.includes(tag)) return true;
  }
  return Object.values(record).some((item) => mentions(item, tag, seen));
};

type Declared = {
  readonly method: string;
  readonly scope: string;
  readonly handler: boolean;
  readonly authInError: boolean;
};

const groupRequests = (WsRpcGroup as unknown as { requests: Map<string, unknown> }).requests;

const declared: Array<Declared> = Object.entries(RPC_REQUIRED_SCOPES).map(([method, scope]) => {
  const rpc = groupRequests.get(method);
  const error = (rpc as { error?: unknown } | undefined)?.error;
  return {
    method,
    scope,
    handler: rpc !== undefined,
    authInError: error === undefined ? false : mentions(error, "EnvironmentAuthorizationError"),
  };
});

const withoutAuth = declared.filter((row) => !row.authInError).map((row) => row.method);
const withoutHandler = declared.filter((row) => !row.handler).map((row) => row.method);

// ---------------------------------------------------------------------------
// The group the wire is read from
// ---------------------------------------------------------------------------

// Names are the real methods so the lookups below go through the real table. `probe` takes a method name
// as payload, which is how one rpc reaches every lookup the table answers: declared, undeclared, inherited.
const ProbeRpc = Rpc.make(WS_METHODS.deviceDetail, {
  payload: Schema.Struct({ method: Schema.String }),
  success: Schema.Struct({ scope: Schema.String }),
  error: EnvironmentAuthorizationError,
});
const ListRpc = Rpc.make(WS_METHODS.deviceList, {
  payload: Schema.Struct({
    inspectOnly: Schema.optional(Schema.Boolean),
    retryHostId: Schema.optional(Schema.String),
    updateTool: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ ran: Schema.String }),
  error: EnvironmentAuthorizationError,
});
const SubscribeRpc = Rpc.make(WS_METHODS.subscribeDeviceState, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ i: Schema.Number }),
  stream: true,
  error: EnvironmentAuthorizationError,
});

const Group = RpcGroup.make(ProbeRpc, ListRpc, SubscribeRpc);

/** The scopes of the session this connection authenticated as, per scenario. */
let scopes: ReadonlyArray<string> = [];

const handlersLayer = Group.toLayer(
  Effect.succeed({
    // `ws.ts:3542` for detail: one lookup, then the gate.
    [WS_METHODS.deviceDetail]: ({ method }: { readonly method: string }) =>
      authorizeEffect(scopes, requiredScopeForRpcMethod(method), Effect.succeed({ scope: method })),
    // `ws.ts:3513-3529` verbatim in shape, including the `inspectOnly` branch that skips the gate.
    [WS_METHODS.deviceList]: (input: {
      readonly inspectOnly?: boolean;
      readonly retryHostId?: string;
      readonly updateTool?: string;
    }) =>
      input.inspectOnly && !input.updateTool
        ? Effect.succeed({ ran: "inspect" })
        : authorizeEffect(
            scopes,
            requiredScopeForDeviceList(input as never),
            Effect.succeed({
              ran: input.updateTool ? "updateTool" : input.retryHostId ? "retryHost" : "list",
            }),
          ),
    [WS_METHODS.subscribeDeviceState]: () =>
      authorizeStream(
        scopes,
        requiredScopeForRpcMethod(WS_METHODS.subscribeDeviceState),
        Stream.make({ i: 1 }).pipe(Stream.concat(Stream.make({ i: 2 }))),
      ),
  }) as never,
);

const serverLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    yield* router.add("GET", "/ws", httpEffect);
    // `disableTracing: true` is `apps/server/src/ws.ts:3826`, and it is what keeps trace ids out of the
    // recorded bytes.
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
  Layer.provideMerge(
    NodeHttpServer.layer(() => NodeHttp.createServer(), { host: "127.0.0.1", port: 0 }),
  ),
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

const frames: Array<Frame> = [];
const record = (frame: Frame) => frames.push(frame);

const TRACE_ID = "__TRACE_ID__";
const SPAN_ID = "__SPAN_ID__";
const FIBER_ID = "9007199254740991";

const mask = (text: string): string => {
  const out = text
    .replace(/"traceId":"[0-9a-f]{32}"/g, `"traceId":"${TRACE_ID}"`)
    .replace(/"spanId":"[0-9a-f]{16}"/g, `"spanId":"${SPAN_ID}"`)
    .replace(/"fiberId":\d+/g, `"fiberId":${FIBER_ID}`);
  if (
    /"traceId":"(?!__TRACE_ID__)[^"]*"/.test(out) ||
    /"spanId":"(?!__SPAN_ID__)[^"]*"/.test(out) ||
    /"fiberId":(?!9007199254740991)/.test(out)
  ) {
    throw new Error(`frame carries a trace field the mask did not recognise: ${out}`);
  }
  return out;
};

let currentCase = "unset";
let currentInput: string | undefined;

const observe = (direction: "c2s" | "s2c", data: unknown): void => {
  if (typeof data !== "string") {
    throw new Error(`${direction} frame was not text: ${Object.prototype.toString.call(data)}`);
  }
  record({
    case: currentCase,
    direction,
    frame: mask(data),
    ...(currentInput === undefined ? {} : { input: mask(currentInput) }),
  });
};

const scenario = (name: string, forScopes: ReadonlyArray<string>, input?: string) => {
  currentCase = name;
  currentInput = input;
  scopes = forScopes;
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

const ignore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.matchCause({ onFailure: () => undefined, onSuccess: () => undefined }));

// ---------------------------------------------------------------------------
// The cases
//
// `want` pins the frame count of each case in **both** directions, so a case that bled into the next is
// caught by the generator rather than by reading the artifact afterwards.
// ---------------------------------------------------------------------------

type Case = {
  readonly name: string;
  readonly scopes: ReadonlyArray<string>;
  readonly run: (client: Client) => Effect.Effect<unknown, unknown, never>;
  readonly c2s: number;
  readonly s2c: number;
};

/**
 * `RpcClient.make(Group)` gives one method per rpc, keyed by the rpc's tag — which for these names
 * contains a dot, so the methods are reached by key rather than by property.
 */
type Client = Record<string, (payload: unknown) => Effect.Effect<unknown, unknown>>;

const send = (client: Client, method: string, payload: unknown) => client[method](payload);
/**
 * A stream rpc hands back a `Stream`; nothing is pulled until it is run, and pulling is what makes the
 * server write.
 */
const drain = (client: Client, method: string, payload: unknown) =>
  (client[method] as unknown as (input: unknown) => Stream.Stream<unknown, unknown>)(payload).pipe(
    Stream.runDrain,
  );

const cases: Array<Case> = [
  // 1-2. The gate's two answers for one declared method.
  {
    name: "probe.granted",
    scopes: ["orchestration:read"],
    run: (client) => send(client, WS_METHODS.deviceDetail, { method: WS_METHODS.deviceDetail }),
    c2s: 1,
    s2c: 1,
  },
  {
    name: "probe.denied",
    scopes: [],
    run: (client) => send(client, WS_METHODS.deviceDetail, { method: WS_METHODS.deviceDetail }),
    c2s: 1,
    s2c: 1,
  },
  // 3-4. Read does not imply operate, and an exact-name miss (case, trailing space) does not match either.
  {
    name: "probe.operateWithRead",
    scopes: ["orchestration:read"],
    run: (client) => send(client, WS_METHODS.deviceDetail, { method: WS_METHODS.deviceOpen }),
    c2s: 1,
    s2c: 1,
  },
  {
    name: "probe.nearMiss",
    scopes: ["Orchestration:Read ", "orchestration:readx"],
    run: (client) => send(client, WS_METHODS.deviceDetail, { method: WS_METHODS.deviceDetail }),
    c2s: 1,
    s2c: 1,
  },
  // 5. `includes` is an array scan, so duplicates and an unrelated neighbour are harmless.
  {
    name: "probe.duplicate",
    scopes: ["relay:write", "orchestration:read", "orchestration:read"],
    run: (client) => send(client, WS_METHODS.deviceDetail, { method: WS_METHODS.deviceDetail }),
    c2s: 1,
    s2c: 1,
  },
  // 6-9. `device.list`, the one method whose scope comes from its payload, including the branch that
  // never reaches the gate at all.
  {
    name: "list.inspectOnly",
    scopes: [],
    run: (client) => send(client, WS_METHODS.deviceList, { inspectOnly: true }),
    c2s: 1,
    s2c: 1,
  },
  {
    name: "list.plainDenied",
    scopes: [],
    run: (client) => send(client, WS_METHODS.deviceList, {}),
    c2s: 1,
    s2c: 1,
  },
  {
    name: "list.retryNeedsOperate",
    scopes: ["orchestration:read"],
    run: (client) => send(client, WS_METHODS.deviceList, { retryHostId: "host-1" }),
    c2s: 1,
    s2c: 1,
  },
  {
    name: "list.emptyStringsAreAbsent",
    scopes: ["orchestration:read"],
    run: (client) => send(client, WS_METHODS.deviceList, { retryHostId: "", updateTool: "" }),
    c2s: 1,
    s2c: 1,
  },
  // 10-11. The stream gate: `Stream.fail` before the first chunk, so what the client reads is the whole
  // question.
  {
    name: "stream.denied",
    scopes: [],
    run: (client) => drain(client, WS_METHODS.subscribeDeviceState, {}),
    c2s: 1,
    s2c: 2,
  },
  {
    name: "stream.granted",
    scopes: ["orchestration:read"],
    run: (client) => drain(client, WS_METHODS.subscribeDeviceState, {}),
    c2s: 2,
    s2c: 2,
  },
  // 12-14. The lookup itself, through the gate's argument: an undeclared name is a plain `Error`, and an
  // inherited one is not a method. Both are defects; what the wire does with them is the measurement.
  {
    name: "probe.undeclared",
    scopes: ["orchestration:read"],
    run: (client) => send(client, WS_METHODS.deviceDetail, { method: "no.such.method" }),
    c2s: 1,
    s2c: 1,
  },
  {
    name: "probe.inherited",
    scopes: ["orchestration:read"],
    run: (client) => send(client, WS_METHODS.deviceDetail, { method: "toString" }),
    c2s: 1,
    s2c: 1,
  },
  {
    name: "probe.emptyMethod",
    scopes: ["orchestration:read"],
    run: (client) => send(client, WS_METHODS.deviceDetail, { method: "" }),
    c2s: 1,
    s2c: 1,
  },
];

const main = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const address = server.address;
  if (typeof address === "string" || !("port" in address)) {
    throw new Error(`expected a TCP address, got ${JSON.stringify(address)}`);
  }
  const url = `ws://127.0.0.1:${address.port}/ws`;
  for (const item of cases) {
    // One scope per case, so the socket of a case is closed before the next one starts naming frames.
    // The five-second keepalive would otherwise land under whichever case happened to be running.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* buildClient(url);
        scenario(item.name, item.scopes);
        yield* ignore(item.run(client as unknown as Client));
        // The stream cases need the chunks to have crossed before the connection is dropped.
        yield* Effect.sleep("250 millis");
      }),
    );
  }

  const counts: Record<string, { c2s: number; s2c: number }> = {};
  for (const item of cases) {
    const seen = frames.filter((frame) => frame.case === item.name);
    counts[item.name] = {
      c2s: seen.filter((frame) => frame.direction === "c2s").length,
      s2c: seen.filter((frame) => frame.direction === "s2c").length,
    };
  }

  const artifact = {
    summary: {
      tableEntries: declared.length,
      groupRequests: groupRequests.size,
      handlers: declared.filter((row) => row.handler).length,
      authInError: declared.filter((row) => row.authInError).length,
      withoutAuth,
      withoutHandler,
      distinct: [...new Set(declared.map((row) => row.scope))].sort(),
      cases: cases.length,
      c2s: frames.filter((frame) => frame.direction === "c2s").length,
      s2c: frames.filter((frame) => frame.direction === "s2c").length,
    },
    declared,
    wire: frames,
    counts,
  };

  if (process.env.LMCS_SCOPE_GOLDEN_RECORD === "1") {
    for (const frame of frames) {
      writeSync(1, `${frame.case} ${frame.direction} ${frame.frame}\n`);
    }
    writeSync(1, `${JSON.stringify(artifact.summary, null, 2)}\n`);
    return;
  }

  // The check recomputes the answer for every denied case from the imported table rather than reading it
  // back off the recording, which is what makes a mutated port fail here instead of printing a diff.
  const problems: Array<string> = [];
  const deny = (name: string, required: string) => {
    const row = frames.find((frame) => frame.case === name && frame.direction === "s2c");
    const body = `{"_tag":"Exit","requestId":0,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"EnvironmentAuthorizationError","message":"The authenticated token is missing required scope: ${required}.","requiredScope":"${required}"}}]}}`;
    if (row === undefined) problems.push(`${name}: no answer recorded`);
    else if (mask(row.frame) !== body) problems.push(`${name}: ${row.frame}`);
  };
  deny("probe.denied", requiredScopeForRpcMethod(WS_METHODS.deviceDetail));
  deny("probe.operateWithRead", requiredScopeForRpcMethod(WS_METHODS.deviceOpen));
  deny("probe.nearMiss", requiredScopeForRpcMethod(WS_METHODS.deviceDetail));
  deny("list.plainDenied", requiredScopeForDeviceList({} as never));
  deny("list.retryNeedsOperate", requiredScopeForDeviceList({ retryHostId: "host-1" } as never));
  deny("stream.denied", requiredScopeForRpcMethod(WS_METHODS.subscribeDeviceState));
  for (const [name, seen] of Object.entries(counts)) {
    const want = cases.find((item) => item.name === name);
    if (want === undefined || want.c2s !== seen.c2s || want.s2c !== seen.s2c) {
      problems.push(`${name}: frames ${JSON.stringify(seen)}`);
    }
  }
  if (problems.length > 0) {
    writeSync(2, `${problems.join("\n")}\n`);
    process.exit(1);
  }

  writeSync(1, `${JSON.stringify(artifact, null, 2)}\n`);
}).pipe(Effect.scoped, Effect.provide(appLayer), Effect.orDie);

void Effect.runPromise(main);
