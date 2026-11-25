// Golden generator for the **declared group** half of `native/protocol`: what the shipped server
// writes when the answer is decided by the rpc's declaration rather than by its handler.
//
// `node scripts/group-golden.ts > ~/.cache/lmcs-port-traces/group-golden.json`
//
// The four generators before this one all served a **synthetic** group. That was the right trade for
// the envelope, the socket, the scope gate and the seam — each could name the one line of `ws.ts` it
// measured — but it left four claims unmeasured, and all four are about the real `WsRpcGroup`:
//
//   - **A tag the group does not have** answers per request, and a tag the group *has* but nobody
//     implemented answers per connection. `RpcServer.js:778-782` looks the tag up in
//     `group.requests`; `RpcServer.js:628-645` then reads `entry.context` off the handler the group was
//     given, and `RpcServer.js:267` calls `entry.handler` whether or not it is a function. A Rust
//     server migrating method by method lives in exactly that state, so the shape of the answer for an
//     unimplemented method is a protocol fact and not a detail of the shipped code.
//   - **The success schema encodes the handler's return**, so what the client sees is the declaration's
//     key order and the declaration's key set — not the object the handler built
//     (`RpcServer.js:643`, `Rpc.exitSchema`).
//   - **A stream is a shape the declaration owns**: `isStreamSchema(rpc.successSchema)` decides that the
//     values go out as `Chunk`s and that the terminal `Exit` carries `Schema.Void`
//     (`Rpc.js:1143`), whatever the element schema says.
//   - **A refusal to encode is a defect inside the request**, with the
//     `SchemaIssue.defaultFormatter` text of a *real* contract schema (`at ["reference"]["number"]`
//     rather than the synthetic `at ["name"]` the earlier artifacts could reach).
//
// So this file serves the real `WsRpcGroup` — all 148 tags, the real payload and success schemas —
// with stub handlers for the handful of tags each case names, and drives it with **raw text frames**.
// Two things follow from that combination and both are the point:
//
//   - The frames the server reads are the bytes a Rust server will have to read, and not the bytes
//     `RpcClient` happens to write: a hand-written frame can carry an unknown key, a `"1"` where the
//     contract declares an integer, keys in an order no `JSON.stringify` of the codec would produce.
//     The real client cannot send those, which is why the earlier artifacts never saw the answer.
//   - The payload a handler receives is the **decoded** one, and the only way to see a decoder's output
//     is to make the handler report it. `echo` does that: every stubbed handler answers with a typed
//     failure whose `message` is `JSON.stringify` of what it was handed, which the exit schema encodes
//     verbatim. Trim, defaults, key order and key survival are then readable off the wire.
//
// `LMCS_GROUP_GOLDEN_RECORD=1` prints what each case measured instead of checking it, which is how
// every number pinned below was obtained.
//
// Run twice and compare with `cmp`: nothing in the frames depends on the clock (`disableTracing` keeps
// trace ids out, the `fiberId` of an interrupt is masked, and the one handler that sleeps is slept past
// rather than raced — `id.reuse` waits 400ms on a 200ms handler), so a byte that moves is a claim this
// file does not pin.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { writeSync } from "node:fs";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";
import { EnvironmentAuthorizationError, WS_METHODS, WsRpcGroup } from "@lmcstools/core";

// ---------------------------------------------------------------------------
// The group, read off the shipped declaration
//
// `WsRpcGroup.requests` is the map the dispatch consults, and each entry is the `Rpc` `Rpc.make`
// built. `rpc.payloadSchema`/`rpc.successSchema`/`rpc.errorSchema` are the three codecs
// `getSchemas` wraps, and `Rpc.exitSchema` is the one it actually encodes the answer with — the two
// disagree for every streaming rpc, which is what `declared` records per tag.
// ---------------------------------------------------------------------------

interface Envelope {
  _tag: string;
  key: string;
  payloadSchema: Schema.Top;
  successSchema: Schema.Top & { success?: Schema.Top; error?: Schema.Top };
  errorSchema: Schema.Top;
}

const requests = (WsRpcGroup as unknown as { requests: Map<string, Envelope> }).requests;

/** The tag as `Rpc.make` spelled it, so a typo in this file is a crash and not a silent skip. */
const tag = (name: keyof typeof WS_METHODS): string => {
  const value = (WS_METHODS as Record<string, string>)[name];
  if (value === undefined) throw new Error(`WS_METHODS has no ${name}`);
  if (!requests.has(value)) throw new Error(`the shipped group does not register ${value}`);
  return value;
};

const PROBE = tag("serverProbe");
const GET_CONFIG = tag("serverGetConfig");
const BACKGROUND = tag("serverGetBackgroundPolicy");
const ATTACHMENTS_DELETE = tag("attachmentsDelete");
const VCS_INIT = tag("vcsInit");
const INVALIDATE = tag("pullRequestsInvalidate");
const SUBSCRIBE_REFRESHES = tag("pullRequestsSubscribeRefreshes");
const SUBSCRIBE_TERMINAL = tag("subscribeTerminalEvents");
/** Never stubbed below, so every case naming it measures a declared method with no handler. */
const UNIMPLEMENTED = tag("serverGetSettings");
/** Also never stubbed, and a `stream: true` one, so the shape mismatch has its own answer. */
const UNIMPLEMENTED_STREAM = tag("subscribeDiscoveredLocalServers");
/** A `deviceId`-shaped payload against a schema that wants a `threadId`: the decode refuses first. */
const NESTED_REFUSAL = tag("deviceClose");

/**
 * The declaration's own answer to the three questions the dispatch asks: which codec decodes the
 * payload, whether the success channel is the `Stream` marker, and what the exit schema can carry.
 * `voidSuccess` compares against the interned `Schema.Void` because `Rpc.make` stores the very object
 * it defaulted to, which is how the 18 omitted `success:` members and the 12 explicit ones become one
 * bucket on the wire.
 */
const declared = [...requests.values()].map((rpc) => {
  const stream = RpcSchema.isStreamSchema(rpc.successSchema);
  const exit = Rpc.exitSchema(rpc as never) as unknown as {
    ast: { _tag: string; types?: unknown[] };
  };
  return {
    tag: rpc._tag,
    key: rpc.key.slice("effect/rpc/Rpc/".length),
    stream,
    voidSuccess: stream
      ? rpc.successSchema.success === Schema.Void
      : rpc.successSchema === Schema.Void,
    voidPayload: rpc.payloadSchema === Schema.Void,
    errorIsNever: rpc.errorSchema === Schema.Never,
    exitIsUnion: exit.ast._tag === "Union",
  };
});

const facts = (name: keyof typeof WS_METHODS) => {
  const row = declared.find((entry) => entry.tag === (WS_METHODS as Record<string, string>)[name]);
  if (row === undefined) throw new Error(`${name} is not in the group`);
  return row;
};

// ---------------------------------------------------------------------------
// The stubs
//
// One handler per tag, switched by `mode`, because the question is always the same one: given this
// declaration, what does the server write for this return value? `WsRpcGroup.toHandlers` maps over
// **every** tag in the group (`RpcGroup.js:` the forEach over `self.requests`), so an unstubbed tag
// still gets an entry — with `handler: undefined` — which is the state the unimplemented cases measure.
// ---------------------------------------------------------------------------

let mode = "idle";

const authEcho = (label: string, value: unknown) =>
  Effect.fail(
    new EnvironmentAuthorizationError({
      message: `${label}:${JSON.stringify(value)}`,
      requiredScope: "orchestration:read" as never,
    }),
  );

const handlers = {
  // `payload: Schema.Struct({})`, `success: Schema.Struct({})` — the only pair in the group where both
  // channels are empty objects, so anything the wire shows for either is the declaration's doing.
  [PROBE]: (payload: unknown) =>
    mode === "echo"
      ? authEcho("payload", payload)
      : mode === "extra"
        ? Effect.succeed({ extra: 1, ...JSON.parse(JSON.stringify(payload ?? {})) })
        : mode === "sleep"
          ? Effect.sleep("200 millis").pipe(Effect.as({ late: 1 }))
          : mode === "stream"
            ? Stream.make(1, 2)
            : Effect.succeed(undefined),
  // `success: ServerConfig` — a real, deep, union-carrying contract schema.
  [GET_CONFIG]: () =>
    mode === "emptyObject"
      ? Effect.succeed({})
      : mode === "echo"
        ? authEcho("payload", {})
        : Effect.succeed({}),
  // `success: BackgroundPolicySnapshot`, whose first declared member is itself a struct and one of
  // whose fields is a `DateTimeUtc` — so the refusal path is spelled in full and the encoder has a
  // transformation to run if it gets the chance.
  [BACKGROUND]: () =>
    mode === "partial"
      ? Effect.succeed({ updatedAt: new Date(0), extra: 1 })
      : mode === "echo"
        ? authEcho("payload", {})
        : Effect.succeed({}),
  // `success` omitted, i.e. the `Rpc.make` default of `Schema.Void`.
  [ATTACHMENTS_DELETE]: (payload: unknown) =>
    mode === "echo"
      ? authEcho("payload", payload)
      : mode === "value"
        ? Effect.succeed({ deleted: true })
        : mode === "stream"
          ? Stream.make(1)
          : Effect.succeed(undefined),
  [VCS_INIT]: (payload: unknown) =>
    mode === "echo" ? authEcho("payload", payload) : Effect.succeed(undefined),
  // `success: Schema.Void` spelled out, the sibling of the defaulted one.
  [INVALIDATE]: () => (mode === "value" ? Effect.succeed({ ok: 1 }) : Effect.succeed(undefined)),
  // `stream: true` over `NonNegativeInt` — an element schema that is a scalar with a check.
  [SUBSCRIBE_REFRESHES]: () => {
    if (mode === "three") return Stream.make(1, 2, 3);
    if (mode === "negative") return Stream.make(-1);
    if (mode === "empty") return Stream.empty;
    if (mode === "later") return Stream.make(1).pipe(Stream.concat(Stream.make(2)));
    if (mode === "effect") return Effect.succeed(1);
    if (mode === "fail") return Stream.make(1).pipe(Stream.concat(Stream.fail(new Error("nope"))));
    return Stream.make(1);
  },
  // `stream: true` over the eight-member `TerminalEvent` union.
  [SUBSCRIBE_TERMINAL]: () => {
    if (mode === "scrambled") {
      return Stream.make({
        data: "hi",
        extra: true,
        threadId: "t",
        terminalId: "x",
        type: "output",
      });
    }
    if (mode === "bogusType") {
      return Stream.make({ threadId: "t", terminalId: "x", type: "nope" });
    }
    if (mode === "scalar") return Stream.make("output");
    return Stream.make({ threadId: "t", terminalId: "x", type: "output", data: "hi" });
  },
} as never;

const handlersLayer = WsRpcGroup.toLayer(Effect.succeed(handlers) as never);

const serverLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    yield* router.add("GET", "/ws", httpEffect);
    // `disableTracing: true` is `apps/server/src/ws.ts:3826`.
    yield* RpcServer.make(WsRpcGroup, { disableTracing: true }).pipe(
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
  readonly direction: "c2s" | "s2c" | "note";
  readonly frame: string;
};

const frames: Array<Frame> = [];

const TRACE_ID = "__TRACE_ID__";
const SPAN_ID = "__SPAN_ID__";
const FIBER_ID = "9007199254740991";

/**
 * `LMCS_GROUP_GOLDEN_NOMASK=1` leaves the frames as they arrived. It exists because the mask is a claim
 * of its own: run with it and the two `Interrupt` causes in this artifact differ — a client `Interrupt`
 * that reaches a live stream fiber names that fiber by its runtime ordinal (`"fiberId":68`, which counts
 * up with the server's own concurrency and is therefore masked), while the internal interrupt the encoder
 * failure injects carries `FiberId.none`, which crosses as `"fiberId":null` and is left alone. The port
 * can reproduce the second and not the first, and two unmasked runs of this file agreed on `68` — an
 * ordinal that happens to be stable for a fixed sequence of cases and is not a protocol constant.
 */
const nomask = process.env.LMCS_GROUP_GOLDEN_NOMASK === "1";

const mask = (text: string): string =>
  nomask
    ? text
    : text
        .replace(/"traceId":"[0-9a-f]{32}"/g, `"traceId":"${TRACE_ID}"`)
        .replace(/"spanId":"[0-9a-f]{16}"/g, `"spanId":"${SPAN_ID}"`)
        .replace(/"fiberId":\d+/g, `"fiberId":${FIBER_ID}`);

/**
 * A `Request` as the client writes it: the key order of `RpcSerialization`'s literal, with `headers`
 * always present because a frame without it closes the connection (`session.rs` models that, and
 * `protocol-golden.ts` measured it).
 */
const request = (
  id: number,
  method: string,
  payload: unknown,
  extra: Record<string, unknown> = {},
) => JSON.stringify({ _tag: "Request", id, tag: method, payload, headers: [], ...extra });

const ack = (id: number) => JSON.stringify({ _tag: "Ack", requestId: id });

/**
 * What the client answers a frame with, decided by **what arrived** rather than by a script position.
 * A rule written as a reply is the only kind of rule whose frame order survives a second run: a frame
 * queued at open would race with the server's own answer and record whichever won. An array is applied
 * one entry per arrival and the last entry then holds, which is how a stream is acked once and
 * interrupted on the next batch without either write racing the server.
 */
type OnArrive = "ack" | "interrupt" | "ping";

type Rule = {
  readonly chunk?: OnArrive | ReadonlyArray<OnArrive>;
  readonly defect?: OnArrive | ReadonlyArray<OnArrive>;
  readonly exit?: OnArrive | ReadonlyArray<OnArrive>;
};

type Case = {
  readonly name: string;
  readonly mode: string;
  /** The frames the client writes on open, in order. */
  readonly send: ReadonlyArray<string>;
  /**
   * How the client answers each arriving frame. `ack` is what the real client does after processing a
   * batch (`protocol-golden.ts` measured the cadence); without it a multi-batch stream stalls, and a
   * stalled stream would record as silence rather than as backpressure.
   */
  readonly on?: Rule;
  /** Frames pinned by the recording pass, so drift in either direction is a failure here. */
  readonly c2s?: number;
  readonly s2c?: number;
  /** Text the recording had to contain, checked again in the pinned pass. */
  readonly includes?: ReadonlyArray<string>;
  /**
   * Text the recording had to **not** contain. Half the claims here are absences — no `Chunk` before a
   * refused element, no `requestId` on a broadcast defect, no `extra` key surviving a real struct — and a
   * substring of the frame that is present cannot express one.
   */
  readonly excludes?: ReadonlyArray<string>;
};

const cases: ReadonlyArray<Case> = [
  // 1-4. The lookup, and the three strings it can answer with. A tag the group lacks is a defect **inside**
  // the request; a tag the group has but nobody implemented is a **connection-level** `Defect` with no
  // `requestId` at all; and `Object.hasOwn(request, "tag")` means a frame with no `tag` looks up `""`,
  // which is the same text the spelled-empty tag produces by a different route.
  {
    name: "lookup.unknownTag",
    mode: "idle",
    send: [request(1, "server.nope", {})],
    on: { exit: "ping" },
    c2s: 2,
    s2c: 2,
    includes: ['{"_tag":"Die","defect":"Unknown request tag: server.nope"}'],
  },
  {
    name: "lookup.missingTag",
    mode: "idle",
    send: [JSON.stringify({ _tag: "Request", id: 2, payload: {}, headers: [] })],
    on: { exit: "ping" },
    c2s: 2,
    s2c: 2,
    includes: ['{"_tag":"Die","defect":"Unknown request tag: "}'],
  },
  {
    name: "lookup.emptyTag",
    mode: "idle",
    send: [request(41, "", {})],
    on: { exit: "ping" },
    c2s: 2,
    s2c: 2,
    includes: ['{"_tag":"Die","defect":"Unknown request tag: "}'],
  },
  // 5-8. The unimplemented tag: `WsRpcGroup.toLayer` maps over **every** registered tag, so the entry
  // exists and its `handler` is `undefined`, and the throw happens where a `Defect` is written instead of
  // an answer. Two on one connection shows it is per request and not a one-time latch, and a `Ping`
  // answered afterwards shows the loop survived it.
  {
    name: "lookup.unimplemented",
    mode: "idle",
    send: [request(3, UNIMPLEMENTED, {})],
    on: { defect: "ping" },
    c2s: 2,
    s2c: 2,
    includes: [
      '{"_tag":"Defect","defect":{"name":"TypeError","message":"entry.handler is not a function"}',
    ],
    excludes: ["requestId"],
  },
  {
    name: "lookup.unimplementedTwice",
    mode: "idle",
    send: [request(4, UNIMPLEMENTED, {}), request(5, UNIMPLEMENTED, {})],
    c2s: 2,
    s2c: 2,
    includes: [
      '"message":"entry.handler is not a function"}',
      '{"_tag":"Defect","defect":{"name":"TypeError","message":"entry.handler is not a function"}}',
    ],
  },
  {
    name: "lookup.unimplementedBadPayload",
    mode: "idle",
    send: [request(6, UNIMPLEMENTED, { nope: 1 })],
    c2s: 1,
    s2c: 1,
    includes: ['"message":"entry.handler is not a function"'],
  },
  // 9. The order the two failures are reached. `server.getSettings` is unimplemented **and** this payload
  // is one no schema can read, so whichever of the two throws first is visible in the answer's shape: an
  // `Exit` naming the request means the decode ran and refused, and the `Defect` case above is the one
  // where the decode passed.
  {
    name: "lookup.unimplementedUndecodable",
    mode: "idle",
    send: [request(40, UNIMPLEMENTED, null)],
    on: { exit: "ping", defect: "ping" },
    c2s: 2,
    s2c: 2,
    includes: ['"requestId":40', '{"_tag":"Die","defect":"Expected object | array"}'],
    excludes: ["entry.handler"],
  },
  {
    name: "lookup.unimplementedStream",
    mode: "idle",
    send: [request(7, UNIMPLEMENTED_STREAM, {})],
    on: { defect: "ping" },
    c2s: 2,
    s2c: 2,
    includes: ['"message":"entry.handler is not a function"'],
  },
  // 10. A `deviceId`-shaped payload against a schema that wants a `threadId`: the refusal names the key
  // the declaration asked for, not the one the client sent.
  {
    name: "decode.nestedKey",
    mode: "idle",
    send: [request(8, NESTED_REFUSAL, { deviceId: "d" })],
    on: { exit: "ping" },
    c2s: 2,
    s2c: 2,
    includes: ['Missing key\\n  at [\\"threadId\\"]'],
  },
  // 11. Two requests on one connection, one of them still sleeping when the second is written, and the
  // second **reusing the first's id** (`session.rs` keys its pending map the same way). Nothing comes
  // back for either: the wait here outlasts the handler's 200ms by 200ms, so the silence is an answer
  // and not a truncation, and both frames are written in the same tick of the same `open` callback.
  {
    name: "id.reuse",
    mode: "sleep",
    send: [request(10, PROBE, {}), request(10, PROBE, {})],
    c2s: 2,
    s2c: 0,
  },
  // 12-16. `Schema.Struct({})` on both channels: what the decoder hands the handler, what an unknown key
  // does to it, what the success encoder does with keys the declaration never mentioned, and what a
  // payload that is not an object is refused with. The last two spell the same refusal by two routes —
  // `payload: null` written, and `payload` absent — because the decoder reads the property, not the key.
  {
    name: "empty.echo",
    mode: "echo",
    send: [request(11, PROBE, {})],
    c2s: 1,
    s2c: 1,
    includes: ['"message":"payload:{}"'],
  },
  {
    name: "empty.unknownKey",
    mode: "echo",
    send: [request(12, PROBE, { unexpected: 1 })],
    c2s: 1,
    s2c: 1,
    includes: ['"message":"payload:{\\"unexpected\\":1}"'],
  },
  {
    name: "empty.extraSuccess",
    mode: "extra",
    send: [request(13, PROBE, { unexpected: 1 })],
    c2s: 1,
    s2c: 1,
    includes: ['"exit":{"_tag":"Success","value":{"extra":1,"unexpected":1}}'],
  },
  {
    name: "empty.payloadNull",
    mode: "echo",
    send: [request(14, PROBE, null)],
    c2s: 1,
    s2c: 1,
    includes: ['{"_tag":"Die","defect":"Expected object | array"}'],
  },
  {
    name: "empty.payloadAbsent",
    mode: "echo",
    send: [JSON.stringify({ _tag: "Request", id: 15, tag: PROBE, headers: [] })],
    on: { exit: "ping" },
    c2s: 2,
    s2c: 2,
    includes: ['"requestId":15', '{"_tag":"Die","defect":"Expected object | array"}'],
  },
  // 17-20. A real string field with a real transform and a real check. The trim is the decoder's and
  // reaches the handler; the two refusals are the `defaultFormatter` of a contract schema, with the
  // path the field sits at.
  {
    name: "delete.echo",
    mode: "echo",
    send: [request(16, ATTACHMENTS_DELETE, { attachmentId: "a" })],
    c2s: 1,
    s2c: 1,
    includes: ['"message":"payload:{\\"attachmentId\\":\\"a\\"}"'],
  },
  {
    name: "delete.trimmed",
    mode: "echo",
    send: [request(17, ATTACHMENTS_DELETE, { attachmentId: "  padded  " })],
    c2s: 1,
    s2c: 1,
    includes: ['"message":"payload:{\\"attachmentId\\":\\"padded\\"}"'],
  },
  {
    name: "delete.blank",
    mode: "echo",
    send: [request(18, ATTACHMENTS_DELETE, { attachmentId: "   " })],
    c2s: 1,
    s2c: 1,
    includes: ['Expected a value with a length of at least 1\\n  at [\\"attachmentId\\"]'],
  },
  {
    name: "delete.missingKey",
    mode: "echo",
    send: [request(19, ATTACHMENTS_DELETE, {})],
    c2s: 1,
    s2c: 1,
    includes: ['Missing key\\n  at [\\"attachmentId\\"]'],
  },
  // 21-24. `Schema.Void` spelled and defaulted, and the handler's value against each. All four write
  // `"value":null`: the declaration overwrites an answer rather than refusing it, which is the difference
  // between a void method and one whose success is `{}` (see `empty.extraSuccess`).
  {
    name: "void.explicitSuccess",
    mode: "idle",
    send: [request(20, INVALIDATE, {})],
    c2s: 1,
    s2c: 1,
    includes: ['"exit":{"_tag":"Success","value":null}'],
  },
  {
    name: "void.defaultValue",
    mode: "idle",
    send: [request(21, ATTACHMENTS_DELETE, { attachmentId: "a" })],
    c2s: 1,
    s2c: 1,
    includes: ['"exit":{"_tag":"Success","value":null}'],
  },
  {
    name: "void.explicitReturnsValue",
    mode: "value",
    send: [request(22, INVALIDATE, {})],
    c2s: 1,
    s2c: 1,
    includes: ['"exit":{"_tag":"Success","value":null}'],
  },
  {
    name: "void.defaultReturnsValue",
    mode: "value",
    send: [request(23, ATTACHMENTS_DELETE, { attachmentId: "a" })],
    c2s: 1,
    s2c: 1,
    includes: ['"exit":{"_tag":"Success","value":null}'],
  },
  // 25-26. An optional member that is absent, and an enum member spelled wrong: no default is injected
  // into what the handler receives, and a real `Literal` union names its members in the refusal.
  {
    name: "optional.cwdOnly",
    mode: "echo",
    send: [request(24, VCS_INIT, { cwd: "/tmp" })],
    c2s: 1,
    s2c: 1,
    includes: ['"message":"payload:{\\"cwd\\":\\"/tmp\\"}"'],
    excludes: ['\\"kind\\"'],
  },
  {
    name: "optional.kindBogus",
    mode: "echo",
    send: [request(25, VCS_INIT, { cwd: "/tmp", kind: "mercurial" })],
    c2s: 1,
    s2c: 1,
    includes: ['Expected \\"git\\" | \\"unknown\\"\\n  at [\\"kind\\"]'],
  },
  // 27-29. Deep success schemas refused. The path starts at `value`, because the codec is the **exit**
  // schema, not the success one. Two refusals on one connection is what says a per-request die leaves the
  // loop alive to answer the next request.
  {
    name: "deep.missingKeys",
    mode: "emptyObject",
    send: [request(26, GET_CONFIG, {})],
    c2s: 1,
    s2c: 1,
    includes: ['Missing key\\n  at [\\"value\\"][\\"environment\\"]'],
  },
  {
    name: "deep.secondThought",
    mode: "emptyObject",
    send: [request(27, GET_CONFIG, {}), request(28, GET_CONFIG, {})],
    c2s: 2,
    s2c: 2,
    includes: ['"requestId":27', '"requestId":28'],
  },
  {
    name: "deep.partial",
    mode: "partial",
    send: [request(29, BACKGROUND, {})],
    c2s: 1,
    s2c: 1,
    includes: ['Missing key\\n  at [\\"value\\"][\\"hostPower\\"]'],
  },
  // 30-35. The stream, from the declaration's side: the whole finite stream arrives as **one** batch,
  // an empty stream answers with the terminal exit alone, an invalid element refuses **before** any
  // `Chunk` is written, a handler of the wrong shape is a connection-level `Defect`, an undeclared stream
  // failure dies inside the request, and an `Interrupt` arriving between two batches ends the stream.
  {
    name: "stream.three",
    mode: "three",
    send: [request(30, SUBSCRIBE_REFRESHES, {})],
    on: { chunk: "ack" },
    c2s: 2,
    s2c: 2,
    includes: [
      '{"_tag":"Chunk","requestId":30,"values":[1,2,3]}',
      '"exit":{"_tag":"Success","value":null}',
    ],
  },
  {
    name: "stream.empty",
    mode: "empty",
    send: [request(31, SUBSCRIBE_REFRESHES, {})],
    c2s: 1,
    s2c: 1,
    includes: ['"exit":{"_tag":"Success","value":null}'],
    excludes: ["Chunk"],
  },
  {
    name: "stream.negativeElement",
    mode: "negative",
    send: [request(32, SUBSCRIBE_REFRESHES, {})],
    on: { chunk: "ack" },
    c2s: 1,
    s2c: 1,
    includes: ["Expected a value greater than or equal to 0\\n  at [0]"],
    excludes: ["Chunk"],
  },
  {
    name: "stream.effectHandler",
    mode: "effect",
    send: [request(33, SUBSCRIBE_REFRESHES, {})],
    on: { chunk: "ack", defect: "ping" },
    c2s: 2,
    s2c: 2,
    includes: [
      '{"_tag":"Defect","defect":{"name":"TypeError","message":"Cannot read properties of undefined (reading \'_tag\')"}}',
    ],
    excludes: ["requestId"],
  },
  {
    name: "stream.failedStream",
    mode: "fail",
    send: [request(34, SUBSCRIBE_REFRESHES, {})],
    on: { chunk: "ack", exit: "ping" },
    c2s: 3,
    s2c: 3,
    includes: [
      '{"_tag":"Chunk","requestId":34,"values":[1]}',
      'Expected never | EnvironmentAuthorizationError\\n  at [\\"cause\\"][\\"failures\\"][0][\\"error\\"]',
    ],
  },
  {
    name: "stream.interrupted",
    mode: "later",
    send: [request(35, SUBSCRIBE_REFRESHES, {})],
    // The first batch is acked and the second is interrupted, so the interrupt is a reply to a chunk and
    // not a frame queued against the clock.
    on: { chunk: ["ack", "interrupt"] },
    c2s: 3,
    s2c: 3,
    includes: [
      '{"_tag":"Chunk","requestId":35,"values":[1]}',
      '{"_tag":"Interrupt","requestId":35}',
    ],
  },
  // 36-39. A stream whose elements are a real eight-member union of structs. The encoder writes the
  // declaration's key order and drops the key it never mentioned — the exact opposite of the
  // `Struct({})` in `empty.extraSuccess` — and an element that matches no member refuses inside the
  // request with the union spelled out in full.
  {
    name: "union.element",
    mode: "idle",
    send: [request(36, SUBSCRIBE_TERMINAL, {})],
    on: { chunk: "ack" },
    c2s: 2,
    s2c: 2,
    includes: ['"values":[{"threadId":"t","terminalId":"x","type":"output","data":"hi"}]'],
  },
  {
    name: "union.scrambled",
    mode: "scrambled",
    send: [request(37, SUBSCRIBE_TERMINAL, {})],
    on: { chunk: "ack" },
    c2s: 2,
    s2c: 2,
    includes: ['"values":[{"threadId":"t","terminalId":"x","type":"output","data":"hi"}]'],
    excludes: ["extra"],
  },
  {
    name: "union.bogusType",
    mode: "bogusType",
    send: [request(38, SUBSCRIBE_TERMINAL, {})],
    c2s: 1,
    s2c: 1,
    includes: [
      'Expected { readonly \\"type\\": \\"started\\", ... } | { readonly \\"type\\": \\"output\\", ... }',
    ],
  },
  {
    name: "union.scalarElement",
    mode: "scalar",
    send: [request(39, SUBSCRIBE_TERMINAL, {})],
    on: { chunk: "ack", defect: "ping" },
    c2s: 1,
    s2c: 1,
    includes: ["\\n  at [0]"],
    excludes: ["Chunk"],
  },
  // 40-41. The shape mismatch the other way round: a `Stream` handler on a unary declaration and on a
  // `Schema.Void` one. Neither writes a `Chunk`; both answer with an `Interrupt` cause whose `fiberId` is
  // `null`, which is the internal interrupt the failed encode injects (`FiberId.none`, crossing as
  // `null` rather than as the ordinal a client `Interrupt` produces in `stream.interrupted`).
  {
    name: "shape.streamOnUnary",
    mode: "stream",
    send: [request(42, PROBE, {})],
    on: { chunk: "ack", defect: "ping", exit: "ping" },
    c2s: 2,
    s2c: 2,
    includes: ['{"_tag":"Failure","cause":[{"_tag":"Interrupt","fiberId":null}]}'],
    excludes: ["Chunk"],
  },
  {
    name: "shape.streamOnVoid",
    mode: "stream",
    send: [request(43, ATTACHMENTS_DELETE, { attachmentId: "a" })],
    on: { chunk: "ack", defect: "ping", exit: "ping" },
    c2s: 2,
    s2c: 2,
    includes: ['"requestId":43', '{"_tag":"Interrupt","fiberId":null}'],
    excludes: ["Chunk"],
  },
];

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/** Silence, then a hard cap: no case's answer depends on the clock, so this only bounds the wait. */
const IDLE_MS = 400;
const MAX_MS = 4_000;

const interrupt = (requestId: number) => JSON.stringify({ _tag: "Interrupt", requestId });
const ping = () => JSON.stringify({ _tag: "Ping" });

/** The reply a rule asks for, with the arriving frame's own `requestId` type preserved. */
const reply = (kind: OnArrive, requestId: unknown) => {
  if (kind === "ping") return ping();
  if (kind === "interrupt") return interrupt(requestId as number);
  return ack(requestId as number);
};

/**
 * The frame's `requestId`, or `undefined`. A `Defect` is broadcast and carries none, which is exactly why
 * a rule may answer one with a `Ping`: the id is only needed by the `Interrupt` reply.
 */
const readField = (text: string, field: string): unknown => {
  const match = new RegExp(`"${field}":("[^"]*"|-?\\d+|true|false|null)`).exec(text);
  if (match === null) return undefined;
  return JSON.parse(match[1]);
};

const runCase = (url: string, item: Case) =>
  Effect.gen(function* () {
    mode = item.mode;
    const socket = new globalThis.WebSocket(url);
    const notes: Array<string> = [];
    let lastAt = 0;
    let open = false;
    let received = 0;
    let finished = false;
    /** Arrivals per rule key, so an array rule advances without depending on any other rule's count. */
    const arrived: Record<string, number> = {};

    const write = (text: string) => {
      socket.send(text);
      frames.push({ case: item.name, direction: "c2s", frame: mask(text) });
      lastAt = Date.now();
    };

    const observe = (event: { data: unknown }) => {
      if (typeof event.data !== "string") {
        throw new Error(
          `${item.name} received a non-text frame: ${Object.prototype.toString.call(event.data)}`,
        );
      }
      const text = mask(event.data);
      frames.push({ case: item.name, direction: "s2c", frame: text });
      received += 1;
      lastAt = Date.now();
      const key = text.includes('"_tag":"Chunk"')
        ? "chunk"
        : text.includes('"_tag":"Defect"')
          ? "defect"
          : text.includes('"_tag":"Exit"')
            ? "exit"
            : undefined;
      if (key === undefined) return;
      const rule = item.on?.[key];
      if (rule === undefined) return;
      const kinds = Array.isArray(rule) ? rule : [rule];
      const count = (arrived[key] ?? 0) + 1;
      arrived[key] = count;
      write(reply(kinds[Math.min(count - 1, kinds.length - 1)], readField(text, "requestId")));
    };

    // `event.data` is not on the declared `Event`, and this project's `lib` names no `EventListener`.
    type Listener = Parameters<(typeof globalThis.WebSocket.prototype)["addEventListener"]>[1];
    const on = (type: string, listener: (event: never) => void) =>
      socket.addEventListener(type, listener as unknown as Listener);

    on("open", (() => {
      open = true;
      lastAt = Date.now();
      for (const text of item.send) write(text);
    }) as never);
    on("message", observe as never);
    on("error", (() => {
      notes.push("error");
      finished = true;
    }) as never);
    on("close", ((event: { code: number; reason: string; wasClean: boolean }) => {
      notes.push(
        `close code=${event.code} reason=${JSON.stringify(event.reason)} wasClean=${event.wasClean}`,
      );
      finished = true;
    }) as never);

    const started = Date.now();
    while (!finished) {
      yield* Effect.sleep("5 millis");
      const now = Date.now();
      // A case with no rule to answer with settles on silence; one that keeps the socket busy settles on
      // the same silence after its last reply, which is why `lastAt` moves on writes as well as reads.
      if ((open && now - lastAt > IDLE_MS) || now - started > MAX_MS) finished = true;
    }
    socket.close();
    yield* Effect.sleep("20 millis");
    for (const note of notes) frames.push({ case: item.name, direction: "note", frame: note });
    return received;
  });

const main = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const address = server.address;
  if (typeof address === "string" || !("port" in address)) {
    throw new Error(`expected a TCP address, got ${JSON.stringify(address)}`);
  }
  const url = `ws://127.0.0.1:${address.port}/ws`;
  for (const item of cases) {
    // One connection per case: a defect that ends a socket would otherwise be recorded against whichever
    // case ran next, and a request id is only comparable inside one connection.
    yield* runCase(url, item).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          frames.push({
            case: item.name,
            direction: "note",
            frame: `driver-cause ${String(cause).slice(0, 200)}`,
          });
        }),
      ),
    );
  }

  const counts: Record<string, { c2s: number; s2c: number; closed: boolean }> = {};
  for (const item of cases) {
    const seen = frames.filter((frame) => frame.case === item.name);
    counts[item.name] = {
      c2s: seen.filter((frame) => frame.direction === "c2s").length,
      s2c: seen.filter((frame) => frame.direction === "s2c").length,
      // Did the socket end on its own? A case whose only close note carries a server code is a case the
      // server tore down, which no frame count can tell apart from the client closing.
      closed: seen.some((frame) => frame.direction === "note" && frame.frame.startsWith("close")),
    };
  }

  const artifact = {
    summary: {
      groupRequests: requests.size,
      stubbed: Object.keys(handlers as object).length,
      streamed: declared.filter((row) => row.stream).length,
      voidSuccess: declared.filter((row) => row.voidSuccess).length,
      voidPayload: declared.filter((row) => row.voidPayload).length,
      neverError: declared.filter((row) => row.errorIsNever).length,
      exitIsUnion: declared.filter((row) => row.exitIsUnion).length,
      cases: cases.length,
      c2s: frames.filter((frame) => frame.direction === "c2s").length,
      s2c: frames.filter((frame) => frame.direction === "s2c").length,
      closed: Object.entries(counts)
        .filter(([, seen]) => seen.closed)
        .map(([name]) => name),
    },
    measured: {
      probe: facts("serverProbe"),
      getConfig: facts("serverGetConfig"),
      getBackgroundPolicy: facts("serverGetBackgroundPolicy"),
      getSettings: facts("serverGetSettings"),
      attachmentsDelete: facts("attachmentsDelete"),
      vcsInit: facts("vcsInit"),
      invalidate: facts("pullRequestsInvalidate"),
      subscribeRefreshes: facts("pullRequestsSubscribeRefreshes"),
      subscribeTerminalEvents: facts("subscribeTerminalEvents"),
      subscribeDiscoveredLocalServers: facts("subscribeDiscoveredLocalServers"),
      deviceClose: facts("deviceClose"),
    },
    cases,
    counts,
    wire: frames,
  };

  if (process.env.LMCS_GROUP_GOLDEN_RECORD === "1") {
    for (const frame of frames) {
      writeSync(1, `${frame.case} ${frame.direction} ${frame.frame}\n`);
    }
    writeSync(1, `${JSON.stringify(counts, null, 2)}\n`);
    writeSync(1, `${JSON.stringify(artifact.summary, null, 2)}\n`);
    writeSync(1, `${JSON.stringify(artifact.measured, null, 2)}\n`);
    return;
  }

  const problems: Array<string> = [];
  for (const item of cases) {
    const seen = counts[item.name];
    if (item.c2s !== undefined && seen.c2s !== item.c2s) {
      problems.push(`${item.name} wrote ${seen.c2s} frames, pinned ${item.c2s}`);
    }
    if (item.s2c !== undefined && seen.s2c !== item.s2c) {
      problems.push(`${item.name} received ${seen.s2c} frames, pinned ${item.s2c}`);
    }
    for (const text of item.includes ?? []) {
      const hit = frames.some((frame) => frame.case === item.name && frame.frame.includes(text));
      if (!hit) problems.push(`${item.name} has no frame containing ${JSON.stringify(text)}`);
    }
    for (const text of item.excludes ?? []) {
      const hit = frames.find((frame) => frame.case === item.name && frame.frame.includes(text));
      if (hit !== undefined)
        problems.push(`${item.name} excludes ${JSON.stringify(text)}: ${hit.frame}`);
    }
  }
  if (artifact.summary.groupRequests !== 148) {
    problems.push(
      `the shipped group registers ${artifact.summary.groupRequests} tags, expected 148`,
    );
  }
  // The two buckets this crate's tables claim, recomputed here rather than read back from the artifact.
  if (artifact.summary.streamed !== 24) {
    problems.push(`${artifact.summary.streamed} streamed tags, expected 24`);
  }
  if (artifact.summary.voidSuccess !== 30) {
    problems.push(`${artifact.summary.voidSuccess} void-success tags, expected 30`);
  }
  if (artifact.summary.neverError !== 24) {
    problems.push(`${artifact.summary.neverError} never-error tags, expected 24`);
  }
  if (problems.length > 0) {
    writeSync(2, `${problems.join("\n")}\n`);
    process.exit(1);
  }

  writeSync(
    2,
    `group_golden: ${cases.length} cases, ${artifact.summary.c2s} c2s, ${artifact.summary.s2c} s2c, ` +
      `${artifact.summary.streamed} streamed, ${artifact.summary.voidSuccess} void-success\n`,
  );
  writeSync(1, `${JSON.stringify(artifact, null, 2)}\n`);
}).pipe(Effect.scoped, Effect.provide(appLayer), Effect.orDie);

void Effect.runPromise(main).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
