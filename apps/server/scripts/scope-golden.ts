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
//       and can its rpc encode the refusal? `authInExit` answers that against `Rpc.exitSchema`, which is
//       the schema the serializer encodes the reply with, and it is the answer that decides whether a Rust
//       server writes a typed failure or a defect. `authInError` is recorded beside it because the two
//       disagree on exactly the 24 subscriptions: `Rpc.js:164-165` folds a streaming rpc's declared error
//       into `successSchema` and sets `errorSchema` to `Schema.Never`, so looking only at the error channel
//       says nothing about a stream.
//   `wire` — a synthetic group whose handlers are wrapped by `authorizeEffect`/`authorizeStream` copied
//       from `ws.ts:600-651` and whose scope lookups are the real `requiredScopeForRpcMethod` /
//       `requiredScopeForDeviceList`. The real `WsRpcGroup` is deliberately not served here, exactly as in
//       `upgrade-golden.ts`: its handlers need the database, the providers and the orchestration services,
//       which would add failure modes to a measurement of one `if`.
//   `notes` — what a follow-up call got back on the same connection after each refusal, which is the only
//       way to tell a refusal the server survives from one that leaves the socket open and deaf.
//
// `LMCS_SCOPE_GOLDEN_RECORD=1` prints what each wire case measured instead of checking it, which is how
// every number pinned below was obtained.
//
// Run twice and compare with `cmp`: any byte that moves is a claim this file does not pin.

import * as Cause from "effect/Cause";
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
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";
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

/** The error class the gate yields, whose reachability decides the shape of the refusal. */
const AUTH_TAG = "EnvironmentAuthorizationError";

/**
 * Is this error's tag reachable from a schema?
 *
 * `Rpc.make` stores the channel as `errorSchema`, and the answer a port needs is the identifier the
 * serializer writes into the frame, which `Schema.TaggedError` stamps as an AST annotation. Walking the
 * AST objects does not find it (the tag lives in an annotation map, not in a `_tag`), so the AST is
 * stringified and the identifier is looked for as the serializer would emit it.
 */
const declares = (schema: unknown, tag: string): boolean => {
  const ast = (schema as { ast?: unknown } | undefined)?.ast;
  if (ast === undefined) return false;
  const text = JSON.stringify(ast, (_, value) => (typeof value === "function" ? "[fn]" : value));
  return text.includes(`"identifier":"${tag}"`);
};

type Declared = {
  readonly method: string;
  readonly scope: string;
  readonly handler: boolean;
  readonly stream: boolean;
  readonly authInError: boolean;
  readonly authInExit: boolean;
};

const groupRequests = (WsRpcGroup as unknown as { requests: Map<string, unknown> }).requests;

/**
 * Two answers about the error channel, because `Rpc.make` keeps one for each kind of rpc and the wire
 * behaves differently per `Rpc.js:164-165`: a streaming rpc's declared `error` is folded into
 * `successSchema` as a stream schema and its `errorSchema` becomes `Schema.Never`, so looking only at
 * `errorSchema` reports every subscription as unable to carry the refusal. What the serializer actually
 * encodes the failure against is `Rpc.exitSchema`, which unions both channels plus middleware errors —
 * that is `authInExit`, and the `wire` half proves it is the one that matters: a gated stream whose exit
 * schema lacks the tag comes back as `Die`/`"Expected never"`, and one that has it comes back as `Fail`.
 */
const declared: Array<Declared> = Object.entries(RPC_REQUIRED_SCOPES).map(([method, scope]) => {
  const rpc = groupRequests.get(method) as
    | { errorSchema?: unknown; successSchema?: unknown }
    | undefined;
  return {
    method,
    scope,
    handler: rpc !== undefined,
    stream: rpc === undefined ? false : RpcSchema.isStreamSchema(rpc.successSchema as never),
    authInError: declares(rpc?.errorSchema, AUTH_TAG),
    authInExit: rpc === undefined ? false : declares(Rpc.exitSchema(rpc as never), AUTH_TAG),
  };
});

// The group has one method the table does not: `vcs.deleteBranch`, added by `2f487071` without a scope
// entry. `RpcAuthorization.test.ts:19` fails on it today, and every call reaches the plain-`Error` throw
// below, whatever the session's scopes are. Recorded rather than fixed here, because the port's job is to
// reproduce the shipped behavior and the fix belongs to the maintainers.
const groupOnly = [...groupRequests.keys()].filter(
  (method) => !Object.hasOwn(RPC_REQUIRED_SCOPES, method),
);
const tableOnly = declared.filter((row) => !row.handler).map((row) => row.method);

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
/**
 * Two subscriptions because the real group has to be asked twice: every `stream: true` rpc in
 * `WsRpcGroup` declares **no** error at all (that is what `declared` counts, and it is 24 of the 147),
 * while every non-streaming rpc declares the authorization failure. So the gate of a subscription is
 * wired to a `Stream.fail` whose error type the response channel cannot carry.
 *
 * The names are deliberately invented rather than the real `subscribe.deviceState`: the real rpc
 * requires a real payload and yields a real projection stream, which would add failure modes to a
 * measurement of one `if`. What is *not* invented is the stream flag and the error channel, which are
 * copied from the shape `declared` measured. `subscribeAuthError` is the counterfactual — the same rpc
 * with the error declared — so the artifact says whether that declaration is what decides the shape.
 */
const StreamNoErrorRpc = Rpc.make("subscribeNoError", {
  payload: Schema.Struct({}),
  success: Schema.Struct({ i: Schema.Number }),
  stream: true,
});
const StreamAuthErrorRpc = Rpc.make("subscribeAuthError", {
  payload: Schema.Struct({}),
  success: Schema.Struct({ i: Schema.Number }),
  stream: true,
  error: EnvironmentAuthorizationError,
});
/**
 * The method the table does not cover, declared as `rpc.ts:1113` declares it — void payload, void
 * success, the authorization error in the union — and served as `ws.ts:3368-3373` serves it, through
 * the same `observeRpcEffect` shape and so through the same lookup.
 */
const DeleteBranchRpc = Rpc.make(WS_METHODS.vcsDeleteBranch, {
  error: EnvironmentAuthorizationError,
});
/** Answers on any request, so a case can say whether the connection outlived the previous answer. */
const CanaryRpc = Rpc.make("canary", {
  payload: Schema.Struct({}),
  success: Schema.Struct({ alive: Schema.Boolean }),
});

const Group = RpcGroup.make(
  ProbeRpc,
  ListRpc,
  StreamNoErrorRpc,
  StreamAuthErrorRpc,
  DeleteBranchRpc,
  CanaryRpc,
);

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
    // Two subscriptions and one gated-but-undeclared method, so the three shapes a Rust server has to
    // distinguish are all on the wire: a typed `Fail`, a defect for a stream with no error channel, and a
    // defect for a method the table does not cover.
    subscribeNoError: () =>
      authorizeStream(
        scopes,
        requiredScopeForRpcMethod(WS_METHODS.subscribeDeviceState),
        Stream.make({ i: 1 }).pipe(Stream.concat(Stream.make({ i: 2 }))),
      ),
    subscribeAuthError: () =>
      authorizeStream(
        scopes,
        requiredScopeForRpcMethod(WS_METHODS.subscribeDeviceState),
        Stream.make({ i: 1 }).pipe(Stream.concat(Stream.make({ i: 2 }))),
      ),
    // `ws.ts:3368-3373` wraps it like any other method, so the throw in the lookup is what the client
    // meets — and this rpc has the error declared, so it is the case that says whether declaring it is
    // what turns a refusal into a typed failure.
    [WS_METHODS.vcsDeleteBranch]: () =>
      authorizeEffect(
        scopes,
        requiredScopeForRpcMethod(WS_METHODS.vcsDeleteBranch),
        Effect.succeed(undefined),
      ),
    canary: () => Effect.succeed({ alive: true }),
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

/** What the client said about the always-granted follow-up call, per canary case. */
const notes: Array<string> = [];

const TRACE_ID = "__TRACE_ID__";
const SPAN_ID = "__SPAN_ID__";
const FIBER_ID = "9007199254740991";

/** What the canary's answer looks like on the wire, so survival is read off the bytes. */
const CANARY_TAG = '"alive":true';

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
      // The JSON protocol only ever writes text, which is what `observe` asserts.
      ws.send(data as string);
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
// Each case pins its frame count in **both** directions, so a case that bled into the next, a keepalive
// that landed under the wrong name, or a connection that died mid-answer is caught by the generator
// rather than by reading the artifact afterwards.
// ---------------------------------------------------------------------------

type Case = {
  readonly name: string;
  readonly scopes: ReadonlyArray<string>;
  readonly run: (client: Client) => Effect.Effect<unknown, unknown, never>;
  /**
   * Ask for something the table always grants, right after the case's own call. A refusal that kills the
   * connection is a different server contract than one that answers and waits, and the only way to tell
   * them apart is to speak again.
   */
  readonly canary?: boolean;
  readonly c2s: number;
  readonly s2c: number;
};

/**
 * `RpcClient.make(Group)` gives one method per rpc, keyed by the rpc's tag — which for these names
 * contains a dot, so the methods are reached by key rather than by property.
 */
type Client = Record<string, (payload: unknown) => Effect.Effect<unknown, unknown>>;

/** The client is keyed by tag, so a case naming a method the group lost is a broken case, not a call. */
const methodOf = <A>(client: Client, method: string) => {
  const call = client[method] as ((payload: unknown) => A) | undefined;
  if (call === undefined) throw new Error(`the recorded group has no ${method}`);
  return call;
};

const send = (client: Client, method: string, payload: unknown) =>
  methodOf(client, method)(payload);
/**
 * A stream rpc hands back a `Stream`; nothing is pulled until it is run, and pulling is what makes the
 * server write.
 */
const drain = (client: Client, method: string, payload: unknown) =>
  methodOf<Stream.Stream<unknown, unknown>>(client, method)(payload).pipe(Stream.runDrain);

const cases: Array<Case> = [
  // 1-3. The gate's two answers for one declared method, and whether the second answer is survivable.
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
  {
    name: "probe.deniedThenCanary",
    scopes: [],
    run: (client) => send(client, WS_METHODS.deviceDetail, { method: WS_METHODS.deviceDetail }),
    canary: true,
    c2s: 2,
    s2c: 2,
  },
  // 4-5. Read does not imply operate, and an exact-name miss (case, trailing space, extra character)
  // does not match either.
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
  // 6. `includes` is an array scan, so duplicates and an unrelated neighbour are harmless.
  {
    name: "probe.duplicate",
    scopes: ["relay:write", "orchestration:read", "orchestration:read"],
    run: (client) => send(client, WS_METHODS.deviceDetail, { method: WS_METHODS.deviceDetail }),
    c2s: 1,
    s2c: 1,
  },
  // 7-12. `device.list`, the one method whose scope comes from its payload, including the branch that
  // never reaches the gate at all, the one where `updateTool` outranks `inspectOnly`, and the one where
  // `inspectOnly` outranks `retryHostId`.
  {
    name: "list.inspectOnly",
    scopes: [],
    run: (client) => send(client, WS_METHODS.deviceList, { inspectOnly: true }),
    c2s: 1,
    s2c: 1,
  },
  {
    name: "list.inspectOnlyWithUpdateTool",
    scopes: ["orchestration:read"],
    run: (client) =>
      send(client, WS_METHODS.deviceList, { inspectOnly: true, updateTool: "codex" }),
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
    // `input.inspectOnly && !input.updateTool` is tested *before* the payload decides the scope, so an
    // inspection that also names a host to retry never reaches `requiredScopeForDeviceList`. On an empty
    // credential this frame is the difference between that order and the reverse one.
    name: "list.inspectOnlyOutranksRetry",
    scopes: [],
    run: (client) =>
      send(client, WS_METHODS.deviceList, { inspectOnly: true, retryHostId: "host-1" }),
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
  // 13-16. The stream gate. `subscribeNoError` is what the real group looks like (no error channel);
  // `subscribeAuthError` is the counterfactual that says whether the channel is what decides the shape.
  {
    name: "streamNoError.denied",
    scopes: [],
    run: (client) => drain(client, "subscribeNoError", {}),
    c2s: 1,
    s2c: 1,
  },
  {
    name: "streamNoError.deniedThenCanary",
    scopes: [],
    run: (client) => drain(client, "subscribeNoError", {}),
    canary: true,
    c2s: 2,
    s2c: 2,
  },
  {
    name: "streamNoError.granted",
    scopes: ["orchestration:read"],
    run: (client) => drain(client, "subscribeNoError", {}),
    c2s: 3,
    s2c: 3,
  },
  {
    name: "streamAuthError.denied",
    scopes: [],
    run: (client) => drain(client, "subscribeAuthError", {}),
    c2s: 1,
    s2c: 1,
  },
  // 17-18. The method the table does not cover, served with its error channel declared.
  {
    name: "deleteBranch.undeclaredInTable",
    scopes: ["orchestration:read", "orchestration:operate", "auth:read"],
    run: (client) => send(client, WS_METHODS.vcsDeleteBranch, undefined),
    c2s: 1,
    s2c: 1,
  },
  {
    name: "deleteBranch.thenCanary",
    scopes: ["orchestration:read"],
    run: (client) => send(client, WS_METHODS.vcsDeleteBranch, undefined),
    // The follow-up is written and never answered: the throw left the connection-level `Defect` and the
    // dispatch fiber with it, so the socket is open and deaf. `s2c: 1` is that measurement.
    canary: true,
    c2s: 2,
    s2c: 1,
  },
  // 19-22. The lookup itself, through the gate's argument: an undeclared name is a plain `Error`, and an
  // inherited one is not a method. Both are defects; what the wire does with them is the measurement.
  {
    name: "probe.undeclared",
    scopes: ["orchestration:read"],
    run: (client) => send(client, WS_METHODS.deviceDetail, { method: "no.such.method" }),
    c2s: 1,
    s2c: 1,
  },
  {
    name: "probe.undeclaredThenCanary",
    scopes: ["orchestration:read"],
    run: (client) => send(client, WS_METHODS.deviceDetail, { method: "no.such.method" }),
    canary: true,
    c2s: 2,
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
    // One connection per case, so the socket of a case is closed before the next one starts naming
    // frames. The five-second keepalive would otherwise land under whichever case was running, and a
    // request id is only comparable inside one client.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* buildClient(url);
        scenario(item.name, item.scopes);
        yield* ignore(item.run(client as unknown as Client));
        if (item.canary === true) {
          // What the follow-up call came back as, in words. A case whose follow-up was *answered* proves
          // the connection survived the refusal; one whose follow-up resolved with the previous request's
          // message proves the opposite: the frame carried no id, so the client could only guess, and the
          // server never wrote again.
          const outcome = yield* send(client as unknown as Client, "canary", {}).pipe(
            Effect.matchCause({
              onFailure: (cause) => `failed: ${Cause.pretty(cause).split("\n")[0]}`,
              onSuccess: () => "answered",
            }),
          );
          notes.push(`${item.name} ${outcome}`);
        }
      }),
    );
  }

  type Seen = {
    readonly c2s: number;
    readonly s2c: number;
    readonly answered: boolean;
    /** Recorded so the replay drives itself off the artifact instead of restating the table above. */
    readonly scopes: ReadonlyArray<string>;
    readonly canary: boolean;
  };
  const counts: Record<string, Seen> = {};
  for (const item of cases) {
    const seen = frames.filter((frame) => frame.case === item.name);
    counts[item.name] = {
      c2s: seen.filter((frame) => frame.direction === "c2s").length,
      s2c: seen.filter((frame) => frame.direction === "s2c").length,
      // Did the always-granted follow-up get **its own** answer frame? That is the survival question, and
      // it is decided by the recording rather than by a claim in this file.
      answered: seen.some((frame) => frame.direction === "s2c" && frame.frame.includes(CANARY_TAG)),
      scopes: item.scopes,
      canary: item.canary === true,
    };
  }

  const withoutError = declared.filter((row) => !row.authInError);
  const withoutExit = declared.filter((row) => !row.authInExit);
  const artifact = {
    summary: {
      tableEntries: declared.length,
      groupRequests: groupRequests.size,
      handlers: declared.filter((row) => row.handler).length,
      // The two channel answers differ exactly on the subscriptions: `errorSchema` never carries the tag
      // for a streaming rpc (`Rpc.js:165` sets it to `Schema.Never`), while `exitSchema` carries it
      // whenever the declared stream error union does. `authInExit` is the one the wire obeys.
      authInError: declared.filter((row) => row.authInError).length,
      streamMethods: declared.filter((row) => row.stream).length,
      streamsWithoutError: withoutError.filter((row) => row.stream).length,
      nonStreamsWithoutError: withoutError.filter((row) => !row.stream).map((row) => row.method),
      authInExit: declared.filter((row) => row.authInExit).length,
      methodsWithoutExit: withoutExit.map((row) => row.method),
      withoutHandler: tableOnly,
      groupOnly,
      distinct: [...new Set(declared.map((row) => row.scope))].sort(),
      cases: cases.length,
      c2s: frames.filter((frame) => frame.direction === "c2s").length,
      s2c: frames.filter((frame) => frame.direction === "s2c").length,
      survived: Object.entries(counts)
        .filter(
          ([name, seen]) =>
            cases.find((item) => item.name === name)?.canary === true && seen.answered,
        )
        .map(([name]) => name),
    },
    declared,
    wire: frames,
    counts,
    notes,
  };

  if (process.env.LMCS_SCOPE_GOLDEN_RECORD === "1") {
    for (const frame of frames) {
      writeSync(1, `${frame.case} ${frame.direction} ${frame.frame}\n`);
    }
    for (const note of notes) {
      writeSync(1, `note ${note}\n`);
    }
    writeSync(1, `${JSON.stringify(counts, null, 2)}\n`);
    writeSync(1, `${JSON.stringify(artifact.summary, null, 2)}\n`);
    return;
  }

  // The check recomputes the answer for every denied case from the imported table rather than reading it
  // back off the recording, which is what makes a mutated port fail here instead of printing a diff.
  const problems: Array<string> = [];

  /**
   * The id the answer must carry, which is the request frame's `id` — the response renames the field.
   * Read off the case's own request rather than pinned, because the id is the client's counter and
   * pinning it would make this file check its own arithmetic instead of the server's pairing.
   */
  const requestIdOf = (name: string): string => {
    const asked = frames.find((frame) => frame.case === name && frame.direction === "c2s");
    const matched = asked === undefined ? null : /"id":(\d+)/.exec(asked.frame);
    if (matched?.[1] === undefined) {
      problems.push(`${name}: no request id in ${asked?.frame ?? "no recorded request"}`);
      return "0";
    }
    return matched[1];
  };

  const firstAnswer = (name: string): string | undefined =>
    frames.find((frame) => frame.case === name && frame.direction === "s2c")?.frame;

  /** The typed refusal: `Exit`/`Failure`/`Fail`, carrying the error the gate yields. */
  const deny = (name: string, required: string) => {
    const body = `{"_tag":"Exit","requestId":${requestIdOf(name)},"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"EnvironmentAuthorizationError","message":"The authenticated token is missing required scope: ${required}.","requiredScope":"${required}"}}]}}`;
    const row = firstAnswer(name);
    if (row === undefined) problems.push(`${name}: no answer recorded`);
    else if (mask(row) !== body) problems.push(`${name}: ${row}`);
  };

  /**
   * The refusal of a stream whose exit schema cannot encode the error: the failure is not dropped and not
   * turned into a `Fail`, it is re-raised server-side as the *encoding* defect, and the client reads a
   * `Die` whose message names the schema path that rejected. This is the shape a Rust server has to
   * reproduce for any subscription whose declared stream errors exclude the authorization failure.
   */
  const refuseAsDie = (name: string) => {
    const body = `{"_tag":"Exit","requestId":${requestIdOf(name)},"exit":{"_tag":"Failure","cause":[{"_tag":"Die","defect":"Expected never\\n  at [\\"cause\\"][\\"failures\\"][0][\\"error\\"]"}]}}`;
    const row = firstAnswer(name);
    if (row === undefined) problems.push(`${name}: no answer recorded`);
    else if (mask(row) !== body) problems.push(`${name}: ${row}`);
  };

  /** The untyped one: a handler that threw, which the serializer writes as a `Defect` and not as an `Exit`. */
  const defect = (name: string, method: string) => {
    const body = `{"_tag":"Defect","defect":{"name":"Error","message":"RPC method ${method} has no declared authorization scope."}}`;
    const row = firstAnswer(name);
    if (row === undefined) problems.push(`${name}: no answer recorded`);
    else if (mask(row) !== body) problems.push(`${name}: ${row}`);
  };

  const succeed = (name: string, value: string) => {
    const row = firstAnswer(name);
    const body = `{"_tag":"Exit","requestId":${requestIdOf(name)},"exit":{"_tag":"Success","value":${value}}}`;
    if (row === undefined) problems.push(`${name}: no answer recorded`);
    else if (mask(row) !== body) problems.push(`${name}: ${row}`);
  };

  deny("probe.denied", requiredScopeForRpcMethod(WS_METHODS.deviceDetail));
  deny("probe.deniedThenCanary", requiredScopeForRpcMethod(WS_METHODS.deviceDetail));
  deny("probe.operateWithRead", requiredScopeForRpcMethod(WS_METHODS.deviceOpen));
  deny("probe.nearMiss", requiredScopeForRpcMethod(WS_METHODS.deviceDetail));
  deny("list.plainDenied", requiredScopeForDeviceList({} as never));
  deny("list.retryNeedsOperate", requiredScopeForDeviceList({ retryHostId: "host-1" } as never));
  deny(
    "list.inspectOnlyWithUpdateTool",
    requiredScopeForDeviceList({ inspectOnly: true, updateTool: "codex" } as never),
  );
  // The two stream refusals and the two throws are what this file exists to learn. `subscribeNoError`
  // shows the shape the real group's subscriptions would show if their declared stream errors lacked the
  // failure; `subscribeAuthError` shows the shape the effect path shows. Which one the real group is,
  // `summary.authInExit` answers per method.
  refuseAsDie("streamNoError.denied");
  refuseAsDie("streamNoError.deniedThenCanary");
  deny("streamAuthError.denied", requiredScopeForRpcMethod(WS_METHODS.subscribeDeviceState));
  defect("deleteBranch.undeclaredInTable", WS_METHODS.vcsDeleteBranch);
  defect("deleteBranch.thenCanary", WS_METHODS.vcsDeleteBranch);
  defect("probe.undeclared", "no.such.method");
  defect("probe.undeclaredThenCanary", "no.such.method");
  defect("probe.inherited", "toString");
  defect("probe.emptyMethod", "");
  // `inspectOnly` with no `updateTool` is the one grant the gate never sees, so its frame is the proof
  // that the branch short-circuits rather than that the empty scope list happened to pass.
  succeed("list.inspectOnly", '{"ran":"inspect"}');
  // And the same grant with a second member in the payload: the frame proves the short-circuit reads the
  // two flags, not the shape of the object.
  succeed("list.inspectOnlyOutranksRetry", '{"ran":"inspect"}');
  succeed("probe.granted", `{"scope":"${WS_METHODS.deviceDetail}"}`);
  succeed("probe.duplicate", `{"scope":"${WS_METHODS.deviceDetail}"}`);
  succeed("list.emptyStringsAreAbsent", '{"ran":"list"}');

  // Survival, in both directions. A typed refusal leaves the connection able to answer; a throw in the
  // dispatch path does not, and the only way to see that is to ask again.
  const answered = (name: string, want: boolean) => {
    if (counts[name]?.answered !== want)
      problems.push(`${name}: answered=${counts[name]?.answered}`);
  };
  answered("probe.deniedThenCanary", true);
  answered("streamNoError.deniedThenCanary", true);
  answered("deleteBranch.thenCanary", false);
  answered("probe.undeclaredThenCanary", false);

  // And the claim the port is built on, recomputed from the imported declarations rather than read back
  // off the recording: every method the table covers can encode the refusal in its exit schema, and the
  // only methods whose *plain* error channel lacks it are the streaming ones, because `Rpc.make` moves a
  // streaming rpc's declared error into the stream schema. If a maintainer ever drops the error from a
  // subscription, this fails here instead of the client discovering it.
  if (withoutExit.length > 0) {
    problems.push(
      `methods whose exit schema cannot carry the refusal: ${withoutExit.map((row) => row.method)}`,
    );
  }
  if (withoutError.some((row) => !row.stream)) {
    problems.push("a non-streaming method lost its declared authorization error");
  }
  if (withoutError.length !== declared.filter((row) => row.stream).length) {
    problems.push("the methods missing the error channel are not exactly the streams");
  }

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
