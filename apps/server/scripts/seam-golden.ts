// Golden generator for the **seam** of `native/protocol`: the authenticated upgrade, i.e.
// `ws.ts:3805-3877`'s route body, measured in the order it runs.
//
// `node apps/server/scripts/seam-golden.ts > ~/.cache/lmcs-port-traces/seam-golden.json`
//
// The three generators before this one each held a piece of the seam and deliberately not the joins:
//
//   - `upgrade-golden.ts` framed a socket with **no auth in front of it**, because a ticket refusal is
//     not a framing question;
//   - `auth-golden.ts` measured the ticket, the six branches of `verifyWebSocketToken` and the byte shape
//     of the route's 401/500, but every case there stopped at the refusal — **no case ever got a
//     connection**, so nothing could say what a verified session became;
//   - `scope-golden.ts` measured the gate's answers on a connection whose scopes it *handed in*.
//
// The seam is the claim none of them can make: that the scopes on the wire came from the row the ticket
// named, that the auth step runs **before** the handshake is validated (so a bad ticket plus a bad key
// answers 401 rather than 400), and that the route's side effects (`recordClientConnection`,
// `markConnected`) happen for requests that never become a socket. Those are ordering claims, and an
// ordering claim is only measurable against the code that has the order. So this file mounts the shipped
// route — the real `EnvironmentAuth`, the real `SessionStore`, a real in-memory database, the real
// `failEnvironmentAuthInvalid` from `auth/http.ts`, in `ws.ts`'s order — and drives it over a raw socket.
//
// What is synthetic is only the rpc group, for the reason the other files give: the real `WsRpcGroup`
// needs providers, checkpoints and the orchestration engine. The handlers are wrapped by the three lines
// of `authorizeEffect` copied from `ws.ts:608-613` and the scope lookup is the real
// `requiredScopeForRpcMethod`, so a method name carries its real scope and a refusal has the real shape.
//
// **The database is read as part of the measurement.** Each case records the session's row after its
// socket is done — `last_connected_at`, `revoked_at`, the `client_surface`/`client_app_version`
// `recordClientConnection` wrote, and whether the session still counts as connected. That is the only way
// to pin three things a port otherwise gets wrong silently: which session the route used, what
// `readClientConnectionOrigin` (`ws.ts:424-440`) decided (the `clientSurface` whitelist, the
// 64-character `clientAppVersion` cap, the trim that turns `%20%20` into no value), and that
// `setClientConnectionRow`'s `COALESCE` keeps an earlier surface when a client reports only a version
// (`seam.originKeepsPrevious`).
//
// `LMCS_SEAM_GOLDEN_RECORD=1` prints what each case measured instead of checking it, which is how every
// number below was obtained: they are measurements, not guesses.
//
// Run twice and compare with `cmp`: the clock is fixed, and the mask key, the upgrade key and the signing
// secret are constants, so any byte that moves is a claim this file does not pin.

import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { writeSync } from "node:fs";
import * as net from "node:net";
import * as zlib from "node:zlib";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import {
  AuthSessionId,
  ClientSurface,
  EnvironmentAuthorizationError,
  EnvironmentId,
  WS_METHODS,
} from "@lmcstools/core";

import * as ServerConfig from "../src/config.ts";
import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as SessionStore from "../src/auth/SessionStore.ts";
import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../src/auth/http.ts";
import { requiredScopeForRpcMethod } from "../src/auth/RpcAuthorization.ts";
import * as AuthSessions from "../src/persistence/AuthSessions.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";

// The artifact is this file's stdout, and the database it mounts logs on startup (the migration list)
// through Effect's default console. Moving that console to stderr keeps the JSON parseable without
// filtering, and no measurement of this file depends on stdout.
console.log = (...args: Array<unknown>) => {
  console.error(...args);
};

// ---------------------------------------------------------------------------
// Constants the artifact depends on
// ---------------------------------------------------------------------------

/** `auth-golden.ts`'s secret, so a token means the same thing in both generators. */
const SECRET = Uint8Array.from({ length: 32 }, (unused, index) => (index * 13 + 7) & 0xff);
const NOW = 1_700_000_000_000;
const at = (milliseconds: number) => DateTime.makeUnsafe(milliseconds);

/** RFC 6455's example key, whose accept value is the constant `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`. */
const KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const MASK = Buffer.from([0x11, 0x22, 0x33, 0x44]);

/** `ws.ts:419` and `ws.ts:418`. */
const MAX_CLIENT_APP_VERSION_LENGTH = 64;
const isClientSurface = Schema.is(ClientSurface);

// ---------------------------------------------------------------------------
// The gate and the origin reader, copied from the route rather than paraphrased
// ---------------------------------------------------------------------------

const authorizationError = (requiredScope: string) =>
  new EnvironmentAuthorizationError({
    message: `The authenticated token is missing required scope: ${requiredScope}.`,
    requiredScope: requiredScope as never,
  });

/** `ws.ts:608-613`: the row's scopes, `Array.includes`, one failure class. */
const authorizeEffect = <A, E, R>(
  scopes: ReadonlyArray<string>,
  requiredScope: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
  scopes.includes(requiredScope) ? effect : Effect.fail(authorizationError(requiredScope));

/** `ws.ts:424-440` verbatim in shape, including the whitelist, the trim and the length cap. */
const readClientConnectionOrigin = (
  request: HttpServerRequest.HttpServerRequest,
): {
  readonly surface?: typeof ClientSurface.Type;
  readonly appVersion?: string;
} => {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return {};
  const surface = url.value.searchParams.get("clientSurface");
  const appVersion = url.value.searchParams.get("clientAppVersion")?.trim() ?? "";
  return {
    ...(isClientSurface(surface) ? { surface } : {}),
    ...(appVersion !== "" && appVersion.length <= MAX_CLIENT_APP_VERSION_LENGTH
      ? { appVersion }
      : {}),
  };
};

// ---------------------------------------------------------------------------
// The group: three methods, each gated the way `ws.ts` gates it
// ---------------------------------------------------------------------------

const GetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ ok: Schema.String }),
  error: EnvironmentAuthorizationError,
});
const UpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ ok: Schema.String }),
  error: EnvironmentAuthorizationError,
});
/**
 * The survivor probe: a third method, sent after a refusal, whose answer says the connection is still
 * answering. Its tag is a **declared** one (`server.getConfig`, `orchestration:read`) because that is the
 * only kind the shipped server has — every handler in `WsRpcGroup` runs its effect through
 * `observeRpcEffect`, which is where `requiredScopeForRpcMethod` is called. A method with no scope
 * declaration is not a public endpoint: it is the `vcs.deleteBranch` throw `scope-golden.ts` measured.
 */
const SurvivorRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ alive: Schema.Boolean }),
  error: EnvironmentAuthorizationError,
});

const Group = RpcGroup.make(GetSettingsRpc, UpdateSettingsRpc, SurvivorRpc);

/**
 * The handler layer for **one** connection.
 *
 * `ws.ts:3834` builds `makeWsRpcLayer(session, ...)` inside the request, so the gate closes over the
 * session this upgrade authenticated. Handing scopes in from outside would make this file measure a
 * different server: the claim under test is that a connection inherits the scopes of the row its own
 * ticket named.
 */
const handlersLayerFor = (scopes: ReadonlyArray<string>) =>
  Group.toLayer(
    Effect.succeed({
      [WS_METHODS.serverGetSettings]: () =>
        authorizeEffect(
          scopes,
          requiredScopeForRpcMethod(WS_METHODS.serverGetSettings),
          Effect.succeed({ ok: "read" }),
        ),
      [WS_METHODS.serverUpdateSettings]: () =>
        authorizeEffect(
          scopes,
          requiredScopeForRpcMethod(WS_METHODS.serverUpdateSettings),
          Effect.succeed({ ok: "operate" }),
        ),
      [WS_METHODS.serverGetConfig]: () =>
        authorizeEffect(
          scopes,
          requiredScopeForRpcMethod(WS_METHODS.serverGetConfig),
          Effect.succeed({ alive: true }),
        ),
    }) as never,
  );

// ---------------------------------------------------------------------------
// The route, in `ws.ts:3805-3877`'s order
// ---------------------------------------------------------------------------

const fixedSecrets = Layer.succeed(ServerSecretStore.ServerSecretStore, {
  get: () => Effect.succeed(Option.some(SECRET)),
  set: () => Effect.void,
  create: () => Effect.void,
  getOrCreateRandom: (unusedName: string, bytes: number) => Effect.succeed(SECRET.slice(0, bytes)),
  remove: () => Effect.void,
} satisfies ServerSecretStore.ServerSecretStore["Service"]);

const routeLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    yield* router.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const clientOrigin = readClientConnectionOrigin(request);
        yield* sessions.recordClientConnection(session.sessionId, clientOrigin);
        const rpcWebSocketHttpEffect = yield* Effect.gen(function* () {
          const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
          yield* RpcServer.make(Group, { disableTracing: true }).pipe(
            Effect.provideService(RpcServer.Protocol, protocol),
            Effect.provide(handlersLayerFor(session.scopes)),
            Effect.forkScoped,
          );
          return httpEffect;
          // `ws.ts:3855-3858`: the handler layer and the json serializer go in together, below the
          // `Effect.gen` that asks for the protocol.
        }).pipe(
          Effect.provide(
            handlersLayerFor(session.scopes).pipe(Layer.provideMerge(RpcSerialization.layerJson)),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(
        Effect.tapCause((cause) =>
          process.env.SEAM_DEBUG === undefined
            ? Effect.void
            : Effect.sync(() => {
                console.error("ROUTE CAUSE", Cause.pretty(cause));
              }),
        ),
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);

const rootLayer = HttpRouter.serve(routeLayer, {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provideMerge(EnvironmentAuth.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(fixedSecrets),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("seam-golden")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "lmcs-seam-golden-" })),
  Layer.provideMerge(
    // `server.ts:234-250` verbatim in the one option the seam needs: without `perMessageDeflate` the
    // server closes an RSV1 frame as a protocol error, and `seam.deflateRow` would measure a different
    // server than the one that ships.
    NodeHttpServer.layer(() => NodeHttp.createServer(), {
      host: "127.0.0.1",
      port: 0,
      websocket: { perMessageDeflate: true },
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(TestClock.layer()),
);

const runtime = ManagedRuntime.make(rootLayer);

// ---------------------------------------------------------------------------
// Framing, as the transport generators do it
// ---------------------------------------------------------------------------

const encodeFrame = (
  opcode: number,
  payload: Buffer,
  options?: { readonly fin?: boolean; readonly rsv1?: boolean },
): Buffer => {
  const fin = options?.fin ?? true;
  const rsv1 = options?.rsv1 ?? false;
  const first = (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode;
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = first;
    header[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const maskedPayload = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    maskedPayload[index] = payload[index]! ^ MASK[index % 4]!;
  }
  return Buffer.concat([header, MASK, maskedPayload]);
};

const frameLength = (bytes: Buffer): number | undefined => {
  if (bytes.length < 2) return undefined;
  const second = bytes[1]!;
  const lengthBits = second & 0x7f;
  let cut = 2;
  let size = lengthBits;
  if (lengthBits === 126) {
    if (bytes.length < 4) return undefined;
    cut = 4;
    size = bytes.readUInt16BE(2);
  } else if (lengthBits === 127) {
    if (bytes.length < 10) return undefined;
    cut = 10;
    size = Number(bytes.readBigUInt64BE(2));
  }
  if (second & 0x80) cut += 4;
  return cut + size;
};

const SYNC_MARKER = Buffer.from([0x00, 0x00, 0xff, 0xff]);

/** The plaintext of every compressed message one connection carried, in that connection's context. */
const inflateConnection = (frames: Array<Buffer>): Array<{ bytes?: Buffer; error?: string }> => {
  const results: Array<{ bytes?: Buffer; error?: string }> = [];
  const joined: Array<Buffer> = [];
  let previous = 0;
  let broken: string | undefined;
  for (const payload of frames) {
    joined.push(payload, SYNC_MARKER);
    if (broken !== undefined) {
      results.push({ error: broken });
      continue;
    }
    try {
      const all = zlib.inflateRawSync(Buffer.concat(joined), {
        finishFlush: zlib.constants.Z_SYNC_FLUSH,
      });
      results.push({ bytes: all.subarray(previous) });
      previous = all.length;
    } catch (error) {
      broken = String(error);
      results.push({ error: broken });
    }
  }
  return results;
};

const OPCODES: Record<number, string> = {
  0: "continuation",
  1: "text",
  2: "binary",
  8: "close",
  9: "ping",
  10: "pong",
};

const requestText = (id: number, tag: string) =>
  `{"_tag":"Request","id":${id},"tag":"${tag}","payload":{},"headers":[]}`;

const requestFrame = (id: number, tag: string) =>
  encodeFrame(1, Buffer.from(requestText(id, tag), "utf8"));

const closeBytes = (code?: number, reason?: string) => {
  if (code === undefined) return encodeFrame(8, Buffer.alloc(0));
  const body = Buffer.alloc(2 + Buffer.byteLength(reason ?? "", "utf8"));
  body.writeUInt16BE(code, 0);
  body.write(reason ?? "", 2, "utf8");
  return encodeFrame(8, body);
};

/** A client's request, written from an explicit header list so a case can leave one out. */
const requestLines = (target: string, lines: Array<readonly [string, string]>, method = "GET") =>
  [
    `${method} ${target} HTTP/1.1`,
    "Host: 127.0.0.1",
    ...lines.map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n");

const UPGRADE_HEADERS: Array<readonly [string, string]> = [
  ["Upgrade", "websocket"],
  ["Connection", "Upgrade"],
  ["Sec-WebSocket-Key", KEY],
  ["Sec-WebSocket-Version", "13"],
];

const withHeaders = (
  overrides: Array<readonly [string, string]>,
): Array<readonly [string, string]> => [...UPGRADE_HEADERS, ...overrides];

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

type RecordedFrame = {
  readonly case: string;
  readonly direction: "c2s" | "s2c";
  /** The rpc this probe meant, kept only for a request the scenario wrote by hand. */
  readonly label?: string | undefined;
  readonly fin: boolean;
  readonly rsv1: boolean;
  readonly opcode: number;
  readonly opcodeName: string;
  readonly masked: boolean;
  readonly headerHex: string;
  readonly lengthField: "7bit" | "16bit" | "64bit";
  readonly payloadBytes: number;
  readonly payload?: string;
  readonly payloadHex?: string;
  readonly wireHex?: string;
  readonly closeCode?: number | undefined;
  readonly closeReason?: string | undefined;
  readonly inflated?: string | undefined;
  readonly inflatedBytes?: number | undefined;
  readonly inflateError?: string | undefined;
};

type RecordedEvent = {
  readonly case: string;
  readonly event: "request" | "response" | "peer" | "row" | "write" | "seed";
  readonly request?: string;
  readonly statusLine?: string;
  readonly headers?: Array<[string, string]>;
  readonly canonical?: boolean;
  /** Everything the socket said after the head, before it went quiet: body, chunk framing, or nothing. */
  readonly tailHex?: string | undefined;
  readonly tailText?: string | undefined;
  readonly detail?: string;
  readonly row?: Record<string, unknown>;
  readonly seed?: Record<string, unknown>;
};

const frames: Array<RecordedFrame> = [];
const events: Array<RecordedEvent> = [];

const recordFrame = (
  name: string,
  direction: "c2s" | "s2c",
  bytes: Buffer,
  label?: string,
  inflated?: { bytes?: Buffer; error?: string },
): void => {
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const lengthBits = second & 0x7f;
  const masked = (second & 0x80) !== 0;
  let head = 2 + (masked ? 4 : 0);
  if (lengthBits === 126) head += 2;
  else if (lengthBits === 127) head += 8;
  const opcode = first & 0x0f;
  const body = bytes.subarray(head);
  const shown = (() => {
    if (!masked) return body;
    const out = Buffer.alloc(body.length);
    for (let index = 0; index < body.length; index += 1) {
      out[index] = body[index]! ^ MASK[index % 4]!;
    }
    return out;
  })();
  const roundTrips = Buffer.from(shown.toString("utf8"), "utf8").equals(shown);
  const base: RecordedFrame = {
    case: name,
    direction,
    label,
    fin: (first & 0x80) !== 0,
    rsv1: (first & 0x40) !== 0,
    opcode,
    opcodeName: OPCODES[opcode] ?? `unknown${opcode}`,
    masked,
    headerHex: bytes.subarray(0, head).toString("hex"),
    lengthField: lengthBits === 126 ? "16bit" : lengthBits === 127 ? "64bit" : "7bit",
    payloadBytes: shown.length,
  };
  if (opcode === 8) {
    frames.push({
      ...base,
      closeCode: shown.length >= 2 ? shown.readUInt16BE(0) : undefined,
      closeReason: shown.length > 2 ? shown.subarray(2).toString("utf8") : undefined,
      payloadHex: shown.toString("hex"),
    });
    return;
  }
  if (base.rsv1) {
    frames.push({
      ...base,
      wireHex: shown.toString("hex"),
      inflateError: inflated?.error,
      inflated: inflated?.bytes?.toString("utf8"),
      inflatedBytes: inflated?.bytes?.length,
    });
    return;
  }
  frames.push({
    ...base,
    ...(roundTrips ? { payload: shown.toString("utf8") } : { payloadHex: shown.toString("hex") }),
  });
};

/** The head as written, with `Date` replaced by the capture's placeholder. */
const parseHead = (head: string) => {
  const lines = head.split("\r\n").filter((line) => line !== "");
  const fields = lines.slice(1);
  const headers = fields.map<[string, string]>((line) => {
    const cut = line.indexOf(":");
    const name = line.slice(0, cut);
    const value = line.slice(cut + 1).trim();
    return [name, name.toLowerCase() === "date" ? "__DATE__" : value];
  });
  const canonical = fields.every((line) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+: \S/.test(line));
  return { statusLine: lines[0] ?? "", headers, canonical };
};

// ---------------------------------------------------------------------------
// The raw client
// ---------------------------------------------------------------------------

const reader = (socket: net.Socket) => {
  let buffer = Buffer.alloc(0);
  let received = 0;
  let ended = false;
  let endDetail = "still open";
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    received += chunk.length;
  });
  socket.on("end", () => {
    ended = true;
    endDetail = "FIN from peer";
  });
  socket.on("close", () => {
    if (!ended) endDetail = "closed without FIN";
    ended = true;
  });
  socket.on("error", (error: NodeJS.ErrnoException) => {
    ended = true;
    endDetail = `error ${error.code ?? error.message}`;
  });
  const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  const waitFor = async (predicate: () => boolean, deadlineMs: number) => {
    const until = Date.now() + deadlineMs;
    while (!predicate() && Date.now() < until) await pause(5);
    return predicate();
  };
  const take = (count: number) => {
    const got = buffer.subarray(0, count);
    buffer = buffer.subarray(got.length);
    return got;
  };
  const completeFrame = () => {
    const total = frameLength(buffer);
    return total !== undefined && buffer.length >= total ? total : undefined;
  };
  const readFrame = async (waitMs = 400) => {
    const ok = await waitFor(() => completeFrame() !== undefined, waitMs);
    const total = ok ? completeFrame() : undefined;
    return total === undefined ? undefined : take(total);
  };
  return {
    get ended() {
      return ended;
    },
    get endDetail() {
      return endDetail;
    },
    take,
    waitFor,
    readHead: async () => {
      const found = await waitFor(() => buffer.includes("\r\n\r\n"), 3000);
      if (!found) throw new Error("no response head arrived");
      return take(buffer.indexOf("\r\n\r\n") + 4);
    },
    /**
     * Whatever else the socket writes, until it goes quiet. Only called for a response that never
     * became a websocket, where the bytes after the head are the body and the framing.
     */
    readRest: async (quietMs = 250) => {
      const before = received;
      await waitFor(() => ended || received > before, 200);
      const settled = received;
      await waitFor(() => ended || received > settled, quietMs);
      return take(buffer.length);
    },
    readFrame,
    /** Every frame the connection sends next, stopping at a close or at quiet. */
    readFrames: async (limit = 12) => {
      const got: Array<Buffer> = [];
      while (got.length < limit) {
        const frame = await (got.length === 0 ? readFrame(1000) : readFrame(250));
        if (frame === undefined) return got;
        got.push(frame);
        if ((frame[0]! & 0x0f) === 8) return got;
      }
      return got;
    },
    settle: async (ms = 400) => {
      await waitFor(() => ended, ms);
      return ended ? "fin" : "open";
    },
  };
};

type Reader = ReturnType<typeof reader>;
type Probe = { socket: net.Socket; r: Reader; write: (data: Buffer) => Promise<void> };

const connect = async (port: number): Promise<Probe> => {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.setNoDelay(true);
  const r = reader(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    r,
    write: (data: Buffer) =>
      new Promise<void>((resolve) =>
        // A write to a socket the server already ended is a measurement, not a crash: the case is
        // recorded and the following read shows what came back (nothing).
        socket.write(data, (error) => {
          if (error) {
            events.push({
              case: current,
              event: "write",
              detail: `${(error as NodeJS.ErrnoException).code ?? error.message} after ${data.length} bytes`,
            });
          }
          resolve();
        }),
      ),
  };
};

/**
 * Write a request, record the answer.
 *
 * Returns the probe only for a `101`, because a hijacked socket is the case with a conversation left to
 * have; every other status is fully recorded here.
 */
const handshake = async (
  name: string,
  target: string,
  port: number,
  lines: Array<readonly [string, string]>,
  method = "GET",
): Promise<Probe | undefined> => {
  events.push({ case: name, event: "request", request: requestLines(target, lines, method) });
  const probe = await connect(port);
  await probe.write(Buffer.from(requestLines(target, lines, method), "latin1"));
  const head = (await probe.r.readHead()).toString("latin1");
  const parsed = parseHead(head);
  const upgraded = parsed.statusLine.includes("101");
  // Frames that arrived in the same segment as the `101` stay in the reader's buffer for `readFrames`.
  const rest = upgraded ? Buffer.alloc(0) : await probe.r.readRest();
  const text = rest.toString("utf8");
  events.push({
    case: name,
    event: "response",
    statusLine: parsed.statusLine,
    headers: parsed.headers,
    canonical: parsed.canonical,
    tailHex: rest.length > 0 ? rest.toString("hex") : undefined,
    tailText:
      !upgraded && Buffer.from(text, "utf8").equals(rest) && rest.length > 0 ? text : undefined,
  });
  return upgraded ? probe : undefined;
};

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

/** The rows, with the scopes each one is the only source of. */
const SESSIONS = {
  read: "seam_read",
  operate: "seam_operate",
  none: "seam_none",
  revoke: "seam_revoke",
  deflate: "seam_deflate",
  // One row for each case whose *columns* are the measurement, so no earlier case can be what a later
  // one reads.
  notUpgrade: "seam_nou",
  wsRefused: "seam_ws",
  origin: "seam_origin",
  toolong: "seam_toolong",
  stale: "seam_stale",
  revokedBefore: "seam_revoked",
  dev: "dev-auth-seam",
  missing: "seam_missing",
} as const;

type Scenario = {
  readonly name: string;
  /** The session the ticket names, and the row's scopes. No `scopes` means no row is created. */
  readonly session?: string;
  readonly scopes?: ReadonlyArray<string>;
  readonly expiresAt?: number;
  readonly target: (ticket: string) => string;
  readonly lines?: Array<readonly [string, string]>;
  readonly method?: string;
  /** `issued` is the honest token, `broken` one signature bit flipped, `none` no ticket at all. */
  readonly ticket?: "issued" | "broken" | "none";
  readonly ttl?: number;
  readonly revokeBefore?: boolean;
  readonly after?: (
    probe: Probe,
    run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>,
  ) => Promise<void>;
};

/**
 * The client's close, written *and* recorded.
 *
 * Every `101` case ends this way, and the close the server echoes back is the last frame the capture
 * holds; a replay that had to invent the request would be inventing the answer with it.
 */
const close = async (probe: Probe, name: string) => {
  const bytes = closeBytes(1000, "bye");
  recordFrame(name, "c2s", bytes, "close");
  await probe.write(bytes);
  await drain(probe, name);
};

/** The origin cases need no exchange: the answer is in the row, and the socket only has to close. */
const closeOnly: NonNullable<Scenario["after"]> = async (probe) => {
  await close(probe, current);
};

/** The same close on a deflated socket: the frame itself is plain, but the answers after it have to be
 * read through the connection's deflate stream. */
const closeDeflated = async (probe: Probe, name: string) => {
  const bytes = closeBytes(1000, "bye");
  recordFrame(name, "c2s", bytes, "close");
  await probe.write(bytes);
  await drainDeflated(probe, name);
};

const scenarios: Array<Scenario> = [
  // --- the auth step runs before anything `ws` checks -----------------------
  {
    name: "seam.badSignature",
    session: SESSIONS.read,
    scopes: ["orchestration:read"],
    ticket: "broken",
    target: (ticket) => `/ws?wsTicket=${ticket}`,
  },
  {
    name: "seam.badTicketBadKey",
    session: SESSIONS.read,
    scopes: ["orchestration:read"],
    ticket: "broken",
    target: (ticket) => `/ws?wsTicket=${ticket}`,
    lines: [
      ["Upgrade", "websocket"],
      ["Connection", "Upgrade"],
      ["Sec-WebSocket-Key", "not-a-real-key"],
      ["Sec-WebSocket-Version", "13"],
    ],
  },
  {
    name: "seam.badTicketNoVersion",
    session: SESSIONS.read,
    scopes: ["orchestration:read"],
    ticket: "broken",
    target: (ticket) => `/ws?wsTicket=${ticket}`,
    lines: [
      ["Upgrade", "websocket"],
      ["Connection", "Upgrade"],
      ["Sec-WebSocket-Key", KEY],
    ],
  },
  {
    name: "seam.missingRow",
    // A token for a session id the database has never heard of, so the ticket is well formed.
    session: SESSIONS.missing,
    target: (ticket) => `/ws?wsTicket=${ticket}`,
  },
  {
    name: "seam.revokedRow",
    session: SESSIONS.revokedBefore,
    scopes: ["access:write", "relay:read"],
    revokeBefore: true,
    target: (ticket) => `/ws?wsTicket=${ticket}`,
  },
  {
    name: "seam.expiredRow",
    session: SESSIONS.stale,
    scopes: ["orchestration:read"],
    expiresAt: NOW,
    target: (ticket) => `/ws?wsTicket=${ticket}`,
  },
  {
    name: "seam.pastTicket",
    session: SESSIONS.read,
    scopes: ["orchestration:read"],
    ttl: -1,
    target: (ticket) => `/ws?wsTicket=${ticket}`,
  },
  {
    name: "seam.devPrefix",
    session: SESSIONS.dev,
    scopes: ["orchestration:read"],
    target: (ticket) => `/ws?wsTicket=${ticket}`,
  },
  {
    name: "seam.noTicket",
    ticket: "none",
    target: () => "/ws",
  },
  {
    name: "seam.postWs",
    session: SESSIONS.read,
    scopes: ["orchestration:read"],
    method: "POST",
    target: (ticket) => `/ws?wsTicket=${ticket}`,
  },
  {
    name: "seam.notUpgradeAuthorized",
    session: SESSIONS.notUpgrade,
    scopes: ["orchestration:read"],
    target: (ticket) => `/ws?wsTicket=${ticket}&clientSurface=web`,
    lines: [
      ["Connection", "keep-alive"],
      ["Sec-WebSocket-Key", KEY],
      ["Sec-WebSocket-Version", "13"],
    ],
  },
  {
    name: "seam.badKeyAuthorized",
    session: SESSIONS.wsRefused,
    scopes: ["orchestration:read"],
    target: (ticket) => `/ws?wsTicket=${ticket}`,
    lines: [
      ["Upgrade", "websocket"],
      ["Connection", "Upgrade"],
      ["Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ"],
      ["Sec-WebSocket-Version", "13"],
    ],
  },
  {
    name: "seam.badExtensionsAuthorized",
    session: SESSIONS.wsRefused,
    scopes: ["orchestration:read"],
    target: (ticket) => `/ws?wsTicket=${ticket}`,
    lines: withHeaders([["Sec-WebSocket-Extensions", "permessage-deflate; unknown_param"]]),
  },
  // --- an accepted connection, gated by the row its ticket named -------------
  {
    name: "seam.readRow",
    session: SESSIONS.read,
    scopes: ["orchestration:read"],
    target: (ticket) => `/ws?wsTicket=${ticket}`,
    after: async (probe, _run) => {
      await exchange(probe, "seam.readRow", 1, WS_METHODS.serverGetSettings);
      await exchange(probe, "seam.readRow", 2, WS_METHODS.serverUpdateSettings);
      await exchange(probe, "seam.readRow", 3, WS_METHODS.serverGetConfig);
      await close(probe, "seam.readRow");
    },
  },
  {
    name: "seam.operateRow",
    session: SESSIONS.operate,
    scopes: ["orchestration:read", "orchestration:operate"],
    target: (ticket) => `/ws?wsTicket=${ticket}`,
    after: async (probe) => {
      // Byte-identical to `seam.readRow`'s second request, and a different answer: the gate came from
      // the row, not from the ticket or the request.
      await exchange(probe, "seam.operateRow", 2, WS_METHODS.serverUpdateSettings);
      await close(probe, "seam.operateRow");
    },
  },
  {
    name: "seam.noScopeRow",
    session: SESSIONS.none,
    scopes: [],
    target: (ticket) => `/ws?wsTicket=${ticket}`,
    after: async (probe) => {
      await exchange(probe, "seam.noScopeRow", 1, WS_METHODS.serverGetSettings);
      await exchange(probe, "seam.noScopeRow", 2, WS_METHODS.serverGetConfig);
      await close(probe, "seam.noScopeRow");
    },
  },
  {
    name: "seam.deflateRow",
    session: SESSIONS.deflate,
    scopes: ["orchestration:read"],
    target: (ticket) => `/ws?wsTicket=${ticket}`,
    lines: withHeaders([
      ["Sec-WebSocket-Extensions", "permessage-deflate; client_max_window_bits"],
    ]),
    after: async (probe) => {
      await exchangeDeflated(probe, "seam.deflateRow", 1, WS_METHODS.serverGetSettings);
      await exchangeDeflated(probe, "seam.deflateRow", 2, WS_METHODS.serverUpdateSettings);
      await exchangeDeflated(probe, "seam.deflateRow", 3, WS_METHODS.serverGetConfig);
      await closeDeflated(probe, "seam.deflateRow");
    },
  },
  {
    name: "seam.revokedMidFlight",
    session: SESSIONS.revoke,
    scopes: ["orchestration:read"],
    target: (ticket) => `/ws?wsTicket=${ticket}`,
    after: async (probe, run) => {
      await exchange(probe, "seam.revokedMidFlight", 1, WS_METHODS.serverGetSettings);
      // The gate holds the scopes the ticket proved, so revoking the row mid-connection is a fact about
      // the *next* connect rather than about this one.
      await run(revoke(SESSIONS.revoke));
      await exchange(probe, "seam.revokedMidFlight", 2, WS_METHODS.serverGetSettings);
      await exchange(probe, "seam.revokedMidFlight", 3, WS_METHODS.serverGetConfig);
      await close(probe, "seam.revokedMidFlight");
    },
  },
  // --- what the route recorded about the client -----------------------------
  {
    name: "seam.originWeb",
    session: SESSIONS.origin,
    scopes: ["orchestration:read"],
    target: (ticket) => `/ws?wsTicket=${ticket}&clientSurface=web&clientAppVersion=1.2.3`,
    after: closeOnly,
  },
  {
    name: "seam.originBogus",
    session: SESSIONS.origin,
    scopes: ["orchestration:read"],
    target: (ticket) => `/ws?wsTicket=${ticket}&clientSurface=tv&clientAppVersion=%20%20`,
    after: closeOnly,
  },
  {
    name: "seam.originKeepsPrevious",
    session: SESSIONS.origin,
    scopes: ["orchestration:read"],
    target: (ticket) => `/ws?wsTicket=${ticket}&clientAppVersion=2.0.0`,
    after: closeOnly,
  },
  {
    name: "seam.originTooLong",
    session: SESSIONS.toolong,
    scopes: ["orchestration:read"],
    target: (ticket) => `/ws?wsTicket=${ticket}&clientAppVersion=${"9".repeat(65)}`,
    after: closeOnly,
  },
  {
    name: "seam.originExactlyMax",
    session: SESSIONS.toolong,
    scopes: ["orchestration:read"],
    target: (ticket) => `/ws?wsTicket=${ticket}&clientAppVersion=${"9".repeat(64)}`,
    after: closeOnly,
  },
];

// ---------------------------------------------------------------------------
// One exchange: write a request frame, then read what came back
// ---------------------------------------------------------------------------

/** Per-connection deflate state, so an RSV1 answer inflates against the stream it belongs to. */
const streams = new Map<net.Socket, Array<Buffer>>();

const drain = async (probe: Probe, name: string) => {
  const label = name === "" ? current : name;
  for (const frame of await probe.r.readFrames()) recordFrame(label, "s2c", frame);
};

/** The case the current socket belongs to, which `closeOnly` cannot pass by name. */
let current = "";

const drainDeflated = async (probe: Probe, name: string) => {
  for (const frame of await probe.r.readFrames()) {
    const rsv1 = (frame[0]! & 0x40) !== 0;
    if (!rsv1) {
      recordFrame(name, "s2c", frame);
      continue;
    }
    const bits = (frame[1] ?? 0) & 0x7f;
    const headLength = bits < 126 ? 2 : bits === 126 ? 4 : 10;
    const carried = streams.get(probe.socket) ?? [];
    carried.push(Buffer.from(frame.subarray(headLength)));
    streams.set(probe.socket, carried);
    const inflated = inflateConnection(carried);
    recordFrame(name, "s2c", frame, undefined, inflated[inflated.length - 1]);
  }
};

const exchange = async (probe: Probe, name: string, id: number, tag: string) => {
  recordFrame(name, "c2s", requestFrame(id, tag), tag);
  await probe.write(requestFrame(id, tag));
  await drain(probe, name);
};

const exchangeDeflated = async (probe: Probe, name: string, id: number, tag: string) => {
  const body = zlib.deflateRawSync(Buffer.from(requestText(id, tag), "utf8"), {
    level: 9,
    memLevel: 8,
  });
  recordFrame(name, "c2s", encodeFrame(1, body, { rsv1: true }), tag);
  await probe.write(encodeFrame(1, Buffer.concat([body, SYNC_MARKER]), { rsv1: true }));
  await drainDeflated(probe, name);
};

// ---------------------------------------------------------------------------
// The database side of the measurement
// ---------------------------------------------------------------------------

const client = {
  label: "seam-golden",
  ipAddress: null,
  userAgent: null,
  deviceType: "desktop",
  os: null,
  browser: null,
} as const;

const createRow = (sessionId: string, scopes: ReadonlyArray<string>, expiresAt: number) =>
  Effect.gen(function* () {
    const repository = yield* AuthSessions.AuthSessionRepository;
    yield* repository.create({
      sessionId: AuthSessionId.make(sessionId),
      subject: "seam-golden",
      scopes: scopes as never,
      method: "browser-session-cookie" as never,
      client,
      issuedAt: at(NOW - 1000),
      expiresAt: at(expiresAt),
    });
  });

/**
 * The row as the database holds it.
 *
 * The two connection columns are read raw because `AuthSessionRecord` does not carry them — the same
 * reason `SessionStore.test.ts:716` reaches for a `SELECT`.
 */
const readRow = (sessionId: string) =>
  Effect.gen(function* () {
    const repository = yield* AuthSessions.AuthSessionRepository;
    const sessions = yield* SessionStore.SessionStore;
    const sql = yield* SqlClient;
    const found = yield* repository.getById({ sessionId: AuthSessionId.make(sessionId) });
    if (Option.isNone(found)) return { missing: true as const };
    const stored = yield* sql<{
      readonly surface: string | null;
      readonly appVersion: string | null;
    }>`
      SELECT client_surface AS "surface", client_app_version AS "appVersion"
      FROM auth_sessions
      WHERE session_id = ${sessionId}
    `;
    const active = (yield* sessions.listActive()).find(
      (session) => session.sessionId === sessionId,
    );
    return {
      missing: false as const,
      scopes: found.value.scopes,
      expiresAt: found.value.expiresAt.epochMilliseconds,
      lastConnectedAt:
        found.value.lastConnectedAt === null ? null : found.value.lastConnectedAt.epochMilliseconds,
      revokedAt: found.value.revokedAt === null ? null : found.value.revokedAt.epochMilliseconds,
      surface: stored[0]?.surface ?? null,
      appVersion: stored[0]?.appVersion ?? null,
      connected: active?.connected ?? false,
    };
  });

/**
 * The row once the route has released it.
 *
 * `markDisconnected` runs when the response's scope closes, i.e. some ticks after the FIN this client
 * observed, so reading immediately races the server — and a value that moves between two runs would make
 * the artifact a lie. The wait is bounded, so a release that never happens stays a measurement
 * (`connected: true`) rather than a hang.
 */
const readSettledRow = async (
  sessionId: string,
  run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>,
) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = await run(readRow(sessionId));
    if (!row.connected) return row;
    await new Promise<void>((done) => setTimeout(done, 10));
  }
  return run(readRow(sessionId));
};

const mint = (sessionId: string, ttl?: number) =>
  SessionStore.SessionStore.pipe(
    Effect.flatMap((sessions) =>
      sessions.issueWebSocketToken(AuthSessionId.make(sessionId), {
        ttl: Duration.millis(ttl ?? 300_000),
      }),
    ),
    Effect.map((issued) => issued.token),
  );

const revoke = (sessionId: string) =>
  SessionStore.SessionStore.pipe(
    Effect.flatMap((sessions) => sessions.revoke(AuthSessionId.make(sessionId))),
  );

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** Which session rows the oracle has already inserted, so a repeat connect sees the stored row. */
const seeded = new Set<string>();

const runCase = async (scenario: Scenario, port: number) => {
  const runEffect = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
    runtime.runPromise(effect as Effect.Effect<A, never, never>);
  current = scenario.name;

  if (scenario.session !== undefined && scenario.scopes !== undefined) {
    // Seeded once per id: the origin cases connect three times to the *same* row, and re-creating it
    // would erase the very columns whose `COALESCE` behaviour is being measured.
    if (!seeded.has(scenario.session)) {
      await runEffect(
        createRow(scenario.session, scenario.scopes, scenario.expiresAt ?? NOW + 600_000),
      );
      seeded.add(scenario.session);
    }
  }
  if (scenario.revokeBefore && scenario.session !== undefined) {
    await runEffect(revoke(scenario.session));
  }
  // The row as the **auth step** met it, which is not the row at the end of the case: `revokedMidFlight`
  // revokes after the handshake, and the origin cases rewrite the same columns three times. A replay in
  // another language starts here rather than guessing.
  events.push({
    case: scenario.name,
    event: "seed",
    seed: {
      session: scenario.session ?? null,
      scopes: [...(scenario.scopes ?? [])],
      expiresAt: scenario.expiresAt ?? NOW + 600_000,
      revoked: scenario.revokeBefore === true,
      // `seam.missingRow` mints a real token for a row that was never created.
      created: scenario.session !== undefined && scenario.scopes !== undefined,
    },
  });

  let token = "";
  if (scenario.session !== undefined && scenario.ticket !== "none") {
    token = await runEffect(mint(scenario.session, scenario.ttl));
    if (scenario.ticket === "broken") {
      // Flip one character of the signature: the payload still decodes, so this is the branch that
      // proves the server compared the HMAC rather than merely reading the JSON.
      const last = token.length - 1;
      token = `${token.slice(0, last)}${token[last] === "A" ? "B" : "A"}`;
    }
  }
  const probe = await handshake(
    scenario.name,
    scenario.target(token),
    port,
    scenario.lines ?? UPGRADE_HEADERS,
    scenario.method,
  );
  if (probe !== undefined) {
    if (scenario.after !== undefined) await scenario.after(probe, runEffect);
    events.push({
      case: scenario.name,
      event: "peer",
      detail: `after close: ${await probe.r.settle()}`,
    });
    probe.socket.destroy();
  }
  if (scenario.session !== undefined) {
    events.push({
      case: scenario.name,
      event: "row",
      row: (await readSettledRow(scenario.session, runEffect)) as never,
    });
  }
};

const startup = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const server = yield* HttpServer.HttpServer;
  return Number((server.address as { port: number }).port);
});

/** One s2c frame's text, by the request id it answers. */
const answerOf = (name: string, id: number): RecordedFrame | undefined =>
  frames.find(
    (frame) =>
      frame.case === name &&
      frame.direction === "s2c" &&
      (frame.payload ?? frame.inflated ?? "").includes(`"requestId":${id}`),
  );

const responseOf = (name: string): RecordedEvent | undefined =>
  events.find((event) => event.event === "response" && event.case === name);

const rowOf = (name: string): Record<string, unknown> | undefined =>
  events.find((event) => event.event === "row" && event.case === name)?.row;

const main = async () => {
  const port = (await runtime.runPromise(startup as never)) as number;
  const only = process.env.SEAM_ONLY;
  for (const scenario of scenarios) {
    if (only !== undefined && scenario.name !== only) continue;
    await runCase(scenario, port);
  }

  const doc = {
    summary: {
      scenarios: scenarios.length,
      frames: frames.length,
      clientToServer: frames.filter((frame) => frame.direction === "c2s").length,
      serverToClient: frames.filter((frame) => frame.direction === "s2c").length,
      upgraded: events
        .filter((event) => event.event === "response" && event.statusLine?.includes("101"))
        .map((event) => event.case),
      refused: events
        .filter(
          (event) =>
            event.event === "response" && event.statusLine && !event.statusLine.includes("101"),
        )
        .map((event) => `${event.case}=${event.statusLine?.split(" ")[1]}`),
      rsv1Used: frames.filter((frame) => frame.direction === "s2c" && frame.rsv1).length,
      now: new Date(NOW).toISOString(),
      // The replay needs the signing secret to re-check the recorded tickets' signatures, and the clock in
      // the unit the port reads it in. Both are constants of this file, so recording them leaks nothing.
      nowMs: NOW,
      secret: [...SECRET].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      // No reusable dev session runs here, which is what makes `seam.devPrefix` a refusal.
      devSessionId: null,
    },
    frames,
    events,
  };

  if (process.env.LMCS_SEAM_GOLDEN_RECORD) {
    const lines: Array<string> = [];
    for (const event of events) {
      if (event.event === "response") {
        lines.push(
          `${event.case}: ${event.statusLine} [${(event.headers ?? [])
            .map(([name, value]) => `${name}: ${value}`)
            .join(" | ")}]${event.tailText === undefined ? "" : ` body=${event.tailText}`}`,
        );
      }
      if (event.event === "peer") lines.push(`  ${event.case} ${event.detail}`);
      if (event.event === "row") lines.push(`  ${event.case} row ${JSON.stringify(event.row)}`);
      if (event.event === "write") lines.push(`  ${event.case} ${event.detail}`);
    }
    for (const frame of frames) {
      lines.push(
        `${frame.case} ${frame.direction} ${frame.opcodeName}${frame.rsv1 ? "+rsv1" : ""} len=${frame.payloadBytes} :: ${frame.payload ?? frame.inflated ?? frame.payloadHex ?? ""}`,
      );
    }
    writeSync(1, `${lines.join("\n")}\n`);
    return;
  }

  writeSync(1, `${JSON.stringify(doc, null, 2)}\n`);
  const failures = check();
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.error(`seam-golden: ${scenarios.length} scenarios, ${frames.length} frames checked`);
};

/**
 * The claims, as measurements. Each one is checked against the records this file just made, so drift in
 * the shipped route fails the run instead of entering the artifact unnoticed.
 */
const check = (): Array<string> => {
  const failures: Array<string> = [];

  // Every credential refusal is the route's own 401, whatever else was wrong with the request. That is
  // the ordering claim, and the reason the seam is not a composition of the other three generators.
  for (const name of [
    "seam.badSignature",
    "seam.badTicketBadKey",
    "seam.badTicketNoVersion",
    "seam.missingRow",
    "seam.revokedRow",
    "seam.expiredRow",
    "seam.pastTicket",
    "seam.devPrefix",
  ]) {
    const event = responseOf(name);
    if (event?.statusLine !== "HTTP/1.1 401 Unauthorized") {
      failures.push(`${name}: expected 401, got ${event?.statusLine ?? "nothing"}`);
    }
    if (!(event?.tailText ?? "").includes('"reason":"invalid_credential"')) {
      failures.push(`${name}: 401 without invalid_credential: ${event?.tailText}`);
    }
    if (
      !(event?.headers ?? []).some(
        ([header, value]) =>
          header.toLowerCase() === "content-type" && value === "application/json",
      )
    ) {
      failures.push(`${name}: the refusal was not answered as JSON`);
    }
    // Auth runs before the record, so the row never learns the connection was attempted. A row that is
    // gone entirely is the same claim from the other side.
    const record = rowOf(name);
    if (record?.missing !== true && record?.lastConnectedAt !== null) {
      failures.push(`${name}: a refused ticket still recorded a connection`);
    }
  }
  // No ticket at all is the missing-credential shape, re-confirmed through the route rather than by
  // calling the failure helper the way `auth-golden.ts` does.
  if (!(responseOf("seam.noTicket")?.tailText ?? "").includes('"reason":"missing_credential"')) {
    failures.push(
      `seam.noTicket: expected missing_credential, got ${responseOf("seam.noTicket")?.tailText}`,
    );
  }
  // A method the router does not have never reaches auth, so the row stays untouched.
  const posted = responseOf("seam.postWs");
  if (posted?.statusLine !== "HTTP/1.1 404 Not Found") {
    failures.push(`seam.postWs: expected 404, got ${posted?.statusLine}`);
  }
  if (rowOf("seam.postWs")?.lastConnectedAt !== null) {
    failures.push(`seam.postWs: the router answered, yet the row says it connected`);
  }
  // A valid ticket buys the rest of the route even when the request is not an upgrade: the 400 comes
  // from the response pipeline refusing to answer a websocket request, chunked and with a Date, and it
  // is written after `recordClientConnectionOrigin` and `markConnected` have already run.
  const notUpgrade = responseOf("seam.notUpgradeAuthorized");
  if (notUpgrade?.statusLine !== "HTTP/1.1 400 Bad Request") {
    failures.push(`seam.notUpgradeAuthorized: expected 400, got ${notUpgrade?.statusLine}`);
  }
  if (!(notUpgrade?.headers ?? []).some(([name]) => name.toLowerCase() === "transfer-encoding")) {
    failures.push(`seam.notUpgradeAuthorized: the platform's 400 is not chunked`);
  }
  {
    const record = rowOf("seam.notUpgradeAuthorized");
    if (record?.lastConnectedAt === null) {
      failures.push(`seam.notUpgradeAuthorized: the 400 was written before the row was recorded`);
    }
    if (record?.surface !== "web") {
      failures.push(
        `seam.notUpgradeAuthorized: the origin was not read (${JSON.stringify(record)})`,
      );
    }
    if (record?.connected !== false) {
      failures.push(`seam.notUpgradeAuthorized: the response pipeline never released the row`);
    }
  }
  // The other 400 is `ws`'s own: no Date, a close it cannot negotiate away, and a body of exactly the
  // sentence. It lands after the bracket started, and the release never happens because the handler's
  // use never returns to it.
  const badKey = responseOf("seam.badKeyAuthorized");
  if ((badKey?.headers ?? []).some(([name]) => name.toLowerCase() === "date")) {
    failures.push(`seam.badKeyAuthorized: a ws refusal arrived through the response pipeline`);
  }
  if (!(badKey?.tailText ?? "").includes("Missing or invalid Sec-WebSocket-Key header")) {
    failures.push(`seam.badKeyAuthorized: expected the key sentence, got ${badKey?.tailText}`);
  }
  if (
    !(badKey?.headers ?? []).some(
      ([name, value]) => name.toLowerCase() === "content-length" && value === "43",
    )
  ) {
    failures.push(
      `seam.badKeyAuthorized: expected the 43-byte sentence, got ${JSON.stringify(badKey?.headers)}`,
    );
  }
  const badExtensions = responseOf("seam.badExtensionsAuthorized");
  if (
    !(badExtensions?.headers ?? []).some(
      ([name, value]) => name.toLowerCase() === "content-length" && value === "55",
    )
  ) {
    failures.push(`seam.badExtensionsAuthorized: expected the 55-byte sentence`);
  }
  if (!(badExtensions?.tailText ?? "").includes("Sec-WebSocket-Extensions")) {
    failures.push(`seam.badExtensionsAuthorized: expected the extension sentence`);
  }
  for (const name of ["seam.badKeyAuthorized", "seam.badExtensionsAuthorized"]) {
    const record = rowOf(name);
    if (record?.lastConnectedAt === null || record?.connected !== true) {
      failures.push(
        `${name}: a refused handshake did not hold the row connected (${JSON.stringify(record)})`,
      );
    }
  }
  // The row's scopes decide the answer for byte-identical requests.
  if (!(answerOf("seam.readRow", 2)?.payload ?? "").includes("EnvironmentAuthorizationError")) {
    failures.push(`seam.readRow: the operate method was not refused as a typed failure`);
  }
  if (!(answerOf("seam.operateRow", 2)?.payload ?? "").includes('"ok":"operate"')) {
    failures.push(`seam.operateRow: the same request on a row with the scope was not answered`);
  }
  if (!(answerOf("seam.readRow", 1)?.payload ?? "").includes('"ok":"read"')) {
    failures.push(`seam.readRow: the read method was not answered`);
  }
  if (!(answerOf("seam.readRow", 3)?.payload ?? "").includes('"alive":true')) {
    failures.push(`seam.readRow: the connection did not outlive the refusal`);
  }
  // A scopeless row is refused on every method the table declares, and the *second* refusal is the point:
  // the connection is still answering. There is no ungated endpoint to fall back to — `ws.ts` runs every
  // handler's effect through `observeRpcEffect`, which is where the scope lookup lives.
  if (!(answerOf("seam.noScopeRow", 2)?.payload ?? "").includes("EnvironmentAuthorizationError")) {
    failures.push(
      `seam.noScopeRow: the request after a refusal was not answered as a typed failure`,
    );
  }
  if (!(answerOf("seam.noScopeRow", 1)?.payload ?? "").includes("orchestration:read")) {
    failures.push(`seam.noScopeRow: the refusal did not name the scope`);
  }
  // Revoking the row after the handshake does not revoke the connection: the gate is the auth snapshot.
  if (!(answerOf("seam.revokedMidFlight", 1)?.payload ?? "").includes('"ok":"read"')) {
    failures.push(`seam.revokedMidFlight: the first request was not answered`);
  }
  if (!(answerOf("seam.revokedMidFlight", 2)?.payload ?? "").includes('"ok":"read"')) {
    failures.push(`seam.revokedMidFlight: a revoked row cut the live connection`);
  }
  if (rowOf("seam.revokedMidFlight")?.revokedAt === null) {
    failures.push(`seam.revokedMidFlight: the row was never revoked`);
  }
  // A negotiated connection answers with RSV1 set, and the recorded text inflates back.
  const deflated = answerOf("seam.deflateRow", 1);
  if (deflated?.rsv1 !== true || !(deflated.inflated ?? "").includes('"ok":"read"')) {
    failures.push(`seam.deflateRow: the answer was not deflated text`);
  }
  const deflatedRefusal = answerOf("seam.deflateRow", 2);
  if (
    deflatedRefusal?.rsv1 !== true ||
    !(deflatedRefusal.inflated ?? "").includes("EnvironmentAuthorizationError")
  ) {
    failures.push(`seam.deflateRow: the refusal was not deflated`);
  }
  if (answerOf("seam.deflateRow", 3)?.rsv1 !== true) {
    failures.push(`seam.deflateRow: the survivor probe was not deflated`);
  }
  // `readClientConnectionOrigin`, measured through what the database kept.
  const web = rowOf("seam.originWeb");
  if (web?.surface !== "web" || web.appVersion !== "1.2.3") {
    failures.push(`seam.originWeb: the origin was not recorded (${JSON.stringify(web)})`);
  }
  const bogus = rowOf("seam.originBogus");
  if (bogus?.surface === "tv" || bogus?.appVersion === "  " || bogus?.appVersion === "") {
    failures.push(`seam.originBogus: an invalid surface or a blank version was recorded`);
  }
  const kept = rowOf("seam.originKeepsPrevious");
  if (kept?.surface !== "web" || kept.appVersion !== "2.0.0") {
    failures.push(
      `seam.originKeepsPrevious: COALESCE did not keep the earlier surface (${JSON.stringify(kept)})`,
    );
  }
  if (typeof rowOf("seam.originTooLong")?.appVersion === "string") {
    failures.push(`seam.originTooLong: a 65-character version was recorded`);
  }
  const exactly = rowOf("seam.originExactlyMax");
  if (typeof exactly?.appVersion !== "string" || exactly.appVersion.length !== 64) {
    failures.push(
      `seam.originExactlyMax: the 64-character boundary moved (${exactly?.appVersion})`,
    );
  }
  // The route brackets a negotiated connection, and closing it releases the row. The refused
  // handshakes above are the same bracket with the release missing.
  for (const name of [
    "seam.readRow",
    "seam.operateRow",
    "seam.noScopeRow",
    "seam.deflateRow",
    "seam.revokedMidFlight",
  ]) {
    const record = rowOf(name);
    if (record?.lastConnectedAt === null || record?.connected !== false) {
      failures.push(`${name}: the row did not record, or did not release, the connection`);
    }
  }
  return failures;
};

await main();
// The artifact is written with `writeSync`, so exiting here cannot truncate it, and `process.exitCode`
// keeps a violation's failure. `runtime.dispose()` is not used: it waits for the server to drain, and a
// handshake the library refused leaves a socket it never closes, so the run would hang on its own exit.
process.exit(process.exitCode);
