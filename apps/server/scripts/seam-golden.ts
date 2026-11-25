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
// Run twice and compare with `cmp`: the clock is fixed, and the mask key, the upgrade key, the signing
// secret and the state directory (which the session cookie name hashes) are constants, so any byte that
// moves is a claim this file does not pin.

import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as NodeCrypto from "node:crypto";
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
import { computeDpopAccessTokenHash, computeDpopJwkThumbprint } from "@lmcstools/core/dpop";
import * as PlatformError from "effect/PlatformError";

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

/**
 * The secret store the route writes through.
 *
 * `get` still hands out the signing secret, but `create` is no longer a no-op: a DPoP proof is spent by
 * *creating* `dpop-proof-<digest>` (`auth/dpop.ts:97-121`), and the refusal this file has to measure —
 * `replay` — only exists if a duplicate create fails the way the filesystem does it. The shape matters:
 * `isSecretAlreadyExistsError` (`ServerSecretStore.ts:135-136`) looks through `SecretStorePersistError`
 * at a `PlatformError` whose reason is `AlreadyExists`, so a plain `Effect.die` would map to the 500
 * branch instead of the 401. Every accepted name is recorded, which is the replay's second axis: the
 * port has to compute the same digest over the same `thumbprint:jti`.
 */
const acceptedProofs = new Set<string>();

const fixedSecrets = Layer.succeed(ServerSecretStore.ServerSecretStore, {
  get: () => Effect.succeed(Option.some(SECRET)),
  set: () => Effect.void,
  create: (name: string, value: Uint8Array) => {
    // Recorded for the duplicate attempt too: the replay's claim is that the *name* is the same digest,
    // which is only visible if the refused write is logged as well as the accepted one.
    events.push({
      case: current,
      event: "secret",
      detail: name,
      bytes: value.length,
      value: Buffer.from(value).toString("utf8"),
    });
    if (acceptedProofs.has(name)) {
      // A typed failure, not a throw: `auth/dpop.ts:110` catches `isSecretStoreError`, and a defect
      // raised inside `Effect.sync` walks past it and answers 500 instead of the 401 `replay`.
      return Effect.fail(
        new ServerSecretStore.SecretStorePersistError({
          resource: `secret ${name}`,
          cause: PlatformError.systemError({
            _tag: "AlreadyExists",
            module: "FileSystem",
            method: "open",
            pathOrDescriptor: `${name}.bin`,
          }),
        }),
      );
    }
    acceptedProofs.add(name);
    return Effect.void;
  },
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
  // The state directory is an input to the session cookie name (`resolveSessionCookieName` hashes the
  // instance key), so a temp directory per run would make every recorded `Cookie:` header move. The
  // database is in memory anyway; this path only has to be the same twice.
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), `${process.env.HOME}/.cache/lmcs-port-traces/seam-state`),
  ),
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
  readonly event: "request" | "response" | "peer" | "row" | "write" | "seed" | "secret";
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
  /** Only for `secret`: the bytes the spent proof stored, which is what a replay must reproduce. */
  readonly bytes?: number;
  /** Only for `secret`: the stored text, deterministic because the clock is fixed. */
  readonly value?: string;
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
  // The credential cases (`seam.cookie*`, `seam.bearer*`, `seam.bound*`) need rows whose *only* purpose
  // is to be the row a cookie names, so none of them reuses a ticket case's row: `recordClientConnection`
  // writes the surface columns, and a shared row would make an earlier case a precondition of a later one.
  cookieRead: "seam_c_read",
  cookieOperate: "seam_c_operate",
  cookieWide: "seam_c_wide",
  cookieDev: "dev-auth-seam-session",
  cookieMissing: "seam_c_missing",
  cookieExpired: "seam_c_expired",
  cookieRevoked: "seam_c_revoked",
  // One row for the whole DPoP block, bound to `DPOP_THUMBPRINT.a`. The cases share it because the
  // measurement is *the same row answered differently by the proof alone*, and because `last_connected_at`
  // is fixed at `NOW` for every accepted case, so no ordering between them can move a column.
  dpop: "seam_dpop",
  // `seam.dpopWrongKey` alone gets a row nothing else has connected: it is the case that proves a refused
  // proof never reaches `recordClientConnection`, which the shared row below could not show once any
  // accepted case had run.
  dpopFresh: "seam_dpop_fresh",
} as const;

type Scenario = {
  readonly name: string;
  /** The session the ticket names, and the row's scopes. No `scopes` means no row is created. */
  readonly session?: string;
  readonly scopes?: ReadonlyArray<string>;
  readonly expiresAt?: number;
  readonly target: (ticket: string, tokens: Record<string, string>) => string;
  readonly lines?: Array<readonly [string, string]>;
  readonly method?: string;
  /** `issued` is the honest token, `broken` one signature bit flipped, `none` no ticket at all. */
  readonly ticket?: "issued" | "broken" | "none";
  readonly ttl?: number;
  readonly revokeBefore?: boolean;
  /**
   * The HTTP credential this case presents instead of (or alongside) a ticket: extra rows to seed,
   * session tokens to mint, and the headers that carry them.
   *
   * `names` is read from the running server because the cookie name is not a constant —
   * `resolveSessionCookieName` (`auth/utils.ts:25-54`) mixes in the port and a hash of the state
   * directory, so a case that typed `t3_session` would be measuring a name the server never asked for.
   */
  readonly cred?: {
    readonly rows?: ReadonlyArray<
      readonly [string, ReadonlyArray<string>] | readonly [string, ReadonlyArray<string>, number]
    >;
    readonly tokens?: Record<string, SessionToken>;
    readonly headers: (
      tokens: Record<string, string>,
      names: CookieNames,
    ) => ReadonlyArray<readonly [string, string]>;
  };
  readonly after?: (
    probe: Probe,
    run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>,
  ) => Promise<void>;
};

/** What `SessionStore` hands the route to look a cookie up by. */
type CookieNames = {
  readonly cookie: string;
  readonly legacy: string | null;
};

/**
 * A session token, minted here rather than issued.
 *
 * `SessionStore.issue` mints only for a session id it generated itself (`:651-655`, a uuid), so the only
 * way to name the claims the route reads — a `jkt` with no key behind it, scopes the row does not have, a
 * `kind` of `websocket` in a cookie — is to sign them the way the store does: HMAC-SHA256 over the
 * base64url payload with the same secret, base64url again, joined with a dot (`auth/utils.ts:92-94`). The
 * key order mirrors `SessionClaims` (`SessionStore.ts:660-670`) so a minted token is not distinguishable
 * from an issued one except by the claims this file chose.
 */
type SessionToken = {
  readonly sid: string;
  readonly scopes?: ReadonlyArray<string>;
  readonly kind?: string;
  readonly method?: string;
  readonly iat?: number;
  readonly exp?: number;
  readonly jkt?: string;
  /**
   * `head` and `tail` corrupt one character of the signature, `strip` removes it and the dot.
   *
   * They are two cases because they are two branches: a 32-byte digest is 43 base64url characters, so the
   * last one carries two bits no byte holds, and `timingSafeEqualBase64Url` compares the *decoded* buffers
   * (`auth/utils.ts:96-103`) — corrupting the tail therefore authenticates.
   */
  readonly signature?: "head" | "tail" | "strip";
  /** Written verbatim instead of minted: a token this file cannot produce, such as a websocket ticket. */
  readonly raw?: string;
};

const mintSessionToken = (token: SessionToken): string => {
  if (token.raw !== undefined) return token.raw;
  const claims = {
    v: 1,
    kind: token.kind ?? "session",
    sid: token.sid,
    sub: "seam-golden",
    scopes: [...(token.scopes ?? [])],
    method: token.method ?? "browser-session-cookie",
    ...(token.jkt === undefined ? {} : { jkt: token.jkt }),
    iat: token.iat ?? NOW,
    exp: token.exp ?? NOW + 600_000,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  let signature = NodeCrypto.createHmac("sha256", Buffer.from(SECRET))
    .update(payload)
    .digest("base64url");
  if (token.signature === "tail") {
    signature = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
  } else if (token.signature === "head") {
    signature = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
  }
  return token.signature === "strip" ? payload : `${payload}.${signature}`;
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

// ---------------------------------------------------------------------------
// DPoP: a P-256 key, and a signer that needs no entropy
// ---------------------------------------------------------------------------

/**
 * ECDSA over P-256, written out rather than imported, because the artifact has to be the same twice.
 *
 * `NodeCrypto.sign` draws a fresh nonce per call, so a proof minted here would carry a different
 * signature on the next run and `cmp` would report a change that is nothing but OpenSSL's random `k`.
 * RFC 6979 derives the nonce from the key and the message instead, so one case mints one proof, always.
 * The proof of *this* code is the route itself: `seam.dpopValid` is a `101` or the arithmetic is wrong,
 * because the verifier on the other side is the shipped one (`packages/core/src/shared/dpop.ts`, noble's
 * `p256.verify`, compact r‖s over `sha256("<header>.<payload>")`).
 *
 * Affine `bigint` coordinates, ~256 doublings per scalar, a few dozen scalars per artifact, in a script
 * nobody ships.
 */
const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const P256_GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

const pmod = (value: bigint, modulus: bigint) => ((value % modulus) + modulus) % modulus;

/** Extended Euclid over `bigint`; only ever called on non-zero residues of a prime field or of `n`. */
const inverse = (value: bigint, modulus: bigint): bigint => {
  let oldRest = pmod(value, modulus);
  let rest = modulus;
  // `coefficient` tracks Bézout's multiplier of `value`, so it is the one returned when `rest` hits 0.
  let coefficient = 1n;
  let previous = 0n;
  while (rest !== 0n) {
    const quotient = oldRest / rest;
    [oldRest, rest] = [rest, oldRest - quotient * rest];
    [coefficient, previous] = [previous, coefficient - quotient * previous];
  }
  return pmod(coefficient, modulus);
};

/** A point, or `null` for the identity — the only case the addition chain has to name. */
type Point = readonly [x: bigint, y: bigint] | null;

const addPoints = (left: Point, right: Point): Point => {
  if (left === null) return right;
  if (right === null) return left;
  const [x1, y1] = left;
  const [x2, y2] = right;
  if (x1 === x2) return pmod(y1 + y2, P256_P) === 0n ? null : doublePoint(left);
  const slope = pmod((y2 - y1) * inverse(x2 - x1, P256_P), P256_P);
  const x = pmod(slope * slope - x1 - x2, P256_P);
  return [x, pmod(slope * (x1 - x) - y1, P256_P)];
};

const doublePoint = (point: NonNullable<Point>): NonNullable<Point> => {
  const [x, y] = point;
  if (y === 0n) return null;
  // `a = -3`, so the tangent's slope is `(3x² - 3) / 2y`.
  const slope = pmod((3n * x * x - 3n) * inverse(2n * y, P256_P), P256_P);
  const x2 = pmod(slope * slope - 2n * x, P256_P);
  return [x2, pmod(slope * (x - x2) - y, P256_P)];
};

const multiply = (scalar: bigint, point: Point): Point => {
  let result: Point = null;
  let addend = point;
  let remaining = pmod(scalar, P256_N);
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) result = addPoints(result, addend);
    addend = addPoints(addend, addend)!;
    remaining >>= 1n;
  }
  return result;
};

const toBytes32 = (value: bigint) => {
  const hex = value.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
};

const hmac = (key: Uint8Array, ...parts: Array<Uint8Array>) => {
  const mac = NodeCrypto.createHmac("sha256", Buffer.from(key));
  for (const part of parts) mac.update(Buffer.from(part));
  return new Uint8Array(mac.digest());
};

/**
 * RFC 6979's deterministic nonce, including the loop that draws another when the candidate is out of
 * range — unreachable for a sha256-sized draw over P-256 in practice, and cheap to carry correctly.
 */
const rfc6979Nonce = (messageHash: Uint8Array, privateKey: bigint): bigint => {
  const x = toBytes32(privateKey);
  const h = toBytes32(pmod(bytesToBig(messageHash), P256_N));
  let v = new Uint8Array(32).fill(1);
  let k = new Uint8Array(32);
  k = hmac(k, v, new Uint8Array([0x00]), x, h);
  v = hmac(k, v);
  k = hmac(k, v, new Uint8Array([0x01]), x, h);
  v = hmac(k, v);
  for (;;) {
    v = hmac(k, v);
    const candidate = bytesToBig(v);
    if (candidate >= 1n && candidate < P256_N) return candidate;
    k = hmac(k, v, new Uint8Array([0x00]));
    v = hmac(k, v);
  }
};

const bytesToBig = (bytes: Uint8Array) =>
  bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);

/** The 64-byte compact signature the verifier reads, with `s` normalized low so it is unique. */
const signP256 = (privateKey: bigint, message: Uint8Array): Uint8Array => {
  const hash = new Uint8Array(
    NodeCrypto.createHash("sha256").update(Buffer.from(message)).digest(),
  );
  const digest = pmod(bytesToBig(hash), P256_N);
  for (;;) {
    const nonce = rfc6979Nonce(hash, privateKey);
    const point = multiply(nonce, [P256_GX, P256_GY]);
    if (point === null) continue;
    const r = pmod(point[0], P256_N);
    if (r === 0n) continue;
    let s = pmod(inverse(nonce, P256_N) * (digest + r * privateKey), P256_N);
    if (s === 0n) continue;
    if (s > P256_N / 2n) s = P256_N - s;
    return Buffer.concat([toBytes32(r), toBytes32(s)]);
  }
};

/** DER's `SEQUENCE { INTEGER r, INTEGER s }`, which is the shape `dsaEncoding: "der"` writes. */
const derEncode = (signature: Uint8Array) => {
  const integer = (value: Uint8Array) => {
    const bytes =
      value[0]! & 0x80
        ? Buffer.concat([Buffer.from([0x00]), Buffer.from(value)])
        : Buffer.from(value);
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const body = Buffer.concat([
    integer(signature.subarray(0, 32)),
    integer(signature.subarray(32, 64)),
  ]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
};

// Two fixed scalars, both below `n`, so every run authenticates the same public keys and therefore the
// same `jkt`. `b` exists only to be the wrong one.
const DPOP_D = {
  a: 0x00c063ed046d120e0f1e2e5cf7c8a3d94b576a2b1c3d4e5f60718293a4b5c6d7n,
  b: 0x00b17d0e1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5n,
} as const;

const jwkOf = (privateKey: bigint) => {
  const point = multiply(privateKey, [P256_GX, P256_GY]);
  if (point === null) throw new Error("a fixed P-256 key that lands on the identity");
  return {
    kty: "EC" as const,
    crv: "P-256" as const,
    x: toBytes32(point[0]).toString("base64url"),
    y: toBytes32(point[1]).toString("base64url"),
  };
};

const DPOP_JWK = { a: jwkOf(DPOP_D.a), b: jwkOf(DPOP_D.b) };
const DPOP_THUMBPRINT = {
  a: computeDpopJwkThumbprint(DPOP_JWK.a),
  b: computeDpopJwkThumbprint(DPOP_JWK.b),
};

/**
 * Two public keys that decode as text and die as arithmetic: `x` three bytes short, and the point (1,1),
 * which is not on the curve. Both are reached only because the thumbprint guard reads the *strings*, so a
 * token can be bound to a key the verifier cannot load.
 */
const DPOP_BAD_JWK = {
  shortX: {
    kty: "EC" as const,
    crv: "P-256" as const,
    x: Buffer.alloc(31, 7).toString("base64url"),
    y: DPOP_JWK.a.y,
  },
  offCurve: { kty: "EC" as const, crv: "P-256" as const, x: "AQ", y: "AQ" },
};
const DPOP_BAD_THUMBPRINT = {
  shortX: computeDpopJwkThumbprint(DPOP_BAD_JWK.shortX),
  offCurve: computeDpopJwkThumbprint(DPOP_BAD_JWK.offCurve),
};

/**
 * One proof, with the parts a case needs to get wrong spelled out.
 *
 * `ath` defaults to the hash of the token the credential carries (`EnvironmentAuth.ts:671` passes
 * `expectedAccessToken`), `htu` to the origin-only URL the route's own `toURL` normalizes to, and `iat`
 * to the fixed clock in **seconds**, since the verifier compares `DateTime.now / 1000`.
 */
const dpopProof = (input: {
  readonly key: keyof typeof DPOP_D;
  readonly token: string;
  readonly htm?: string;
  readonly htu?: string;
  readonly jti?: string;
  readonly iat?: number;
  /** `null` omits the claim, which is the `access_token_hash_mismatch` branch, not a missing-proof one. */
  readonly ath?: string | null;
  readonly typ?: string;
  readonly alg?: string;
  /** Replaces the first segment wholesale, signed as-is, so only its decodability is wrong. */
  readonly headerOverride?: string;
  /** A public key that decodes as text and fails as arithmetic, signed by `key` anyway. */
  readonly jwkOverride?: { kty: "EC"; crv: "P-256"; x: string; y: string };
  /**
   * One member the shipped struct does not declare, added to the header's JWK and to the payload. Whether
   * `Schema.Struct` strips an unknown key or refuses it decides the proof's fate, and it is not guessable.
   */
  readonly extra?: "jwkKid" | "payloadNonce";
  readonly privateJwk?: boolean;
  /**
   * `der` re-encodes the *same* r and s, so the octets are still a signature the key made: whether the
   * route accepts it measures how strictly `format: "compact"` is read.
   */
  readonly signature?: "flip" | "highS" | "der" | "truncated" | "zeroR" | "zeroS";
}): string => {
  const jwk = input.jwkOverride
    ? input.jwkOverride
    : input.privateJwk
      ? { ...DPOP_JWK[input.key], d: toBytes32(DPOP_D[input.key]).toString("base64url") }
      : DPOP_JWK[input.key];
  const header =
    input.headerOverride ??
    Buffer.from(
      JSON.stringify({
        typ: input.typ ?? "dpop+jwt",
        alg: input.alg ?? "ES256",
        jwk: input.extra === "jwkKid" ? { ...jwk, kid: "seam-kid" } : jwk,
      }),
    ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.htm ?? "GET",
      htu: input.htu ?? "http://127.0.0.1/ws",
      jti: input.jti ?? "seam-proof",
      iat: input.iat ?? Math.floor(NOW / 1000),
      ...(input.extra === "payloadNonce" ? { nonce: "seam-nonce" } : {}),
      ...(input.ath === null ? {} : { ath: input.ath ?? computeDpopAccessTokenHash(input.token) }),
    }),
  ).toString("base64url");
  let signature = signP256(DPOP_D[input.key], Buffer.from(`${header}.${payload}`, "utf8"));
  if (input.signature === "flip") {
    signature = Buffer.from(signature);
    signature[0] ^= 0x01;
  } else if (input.signature === "highS") {
    const low = bytesToBig(signature.subarray(32, 64));
    signature = Buffer.concat([Buffer.from(signature.subarray(0, 32)), toBytes32(P256_N - low)]);
  } else if (input.signature === "zeroR") {
    signature = Buffer.concat([Buffer.alloc(32), Buffer.from(signature.subarray(32, 64))]);
  } else if (input.signature === "zeroS") {
    signature = Buffer.concat([Buffer.from(signature.subarray(0, 32)), Buffer.alloc(32)]);
  } else if (input.signature === "truncated") {
    signature = Buffer.from(signature.subarray(0, 63));
  }
  const encoded =
    input.signature === "der"
      ? Buffer.from(derEncode(signature)).toString("base64url")
      : Buffer.from(signature).toString("base64url");
  return `${header}.${payload}.${encoded}`;
};

/**
 * The credential every DPoP case presents: a session token whose `jkt` names key `a`, carried in
 * `Authorization: DPoP ` because `:660` requires the proof-bound token to be that exact string.
 */
const boundCredential = (
  sid: string = SESSIONS.dpop,
  thumbprint: string = DPOP_THUMBPRINT.a,
): Record<string, SessionToken> => ({
  b: { sid, scopes: ["orchestration:read"], jkt: thumbprint },
});

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
  // --- the credential the route reads when there is no ticket ----------------
  // `EnvironmentAuth.ts:1094`: no ticket falls through to `authenticateRequest`, and that order
  // (`selectRequestCredential`, `:572-598`) is the whole web surface — `packages/client` connects to
  // `/ws` with no headers and no ticket at all, so a port that stops at the ticket cannot serve it.
  {
    name: "seam.cookieRead",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"] } },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.c}`]],
    },
    after: async (probe) => {
      await exchange(probe, "seam.cookieRead", 1, WS_METHODS.serverGetSettings);
      await exchange(probe, "seam.cookieRead", 2, WS_METHODS.serverUpdateSettings);
      await exchange(probe, "seam.cookieRead", 3, WS_METHODS.serverGetConfig);
      await close(probe, "seam.cookieRead");
    },
  },
  {
    // The cookie is checked before the `authorization` header, so the row it names wins the gate.
    name: "seam.cookieBeatsBearer",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      rows: [[SESSIONS.cookieOperate, ["orchestration:read", "orchestration:operate"]]],
      tokens: {
        c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"] },
        o: {
          sid: SESSIONS.cookieOperate,
          scopes: ["orchestration:read", "orchestration:operate"],
        },
      },
      headers: (tok, names) => [
        ["Cookie", `${names.cookie}=${tok.c}`],
        ["Authorization", `Bearer ${tok.o}`],
      ],
    },
    after: async (probe) => {
      await exchange(probe, "seam.cookieBeatsBearer", 2, WS_METHODS.serverUpdateSettings);
      await close(probe, "seam.cookieBeatsBearer");
    },
  },
  {
    name: "seam.bearerOnly",
    session: SESSIONS.cookieOperate,
    scopes: ["orchestration:read", "orchestration:operate"],
    target: () => "/ws",
    cred: {
      tokens: {
        o: { sid: SESSIONS.cookieOperate, scopes: ["orchestration:read", "orchestration:operate"] },
      },
      headers: (tok) => [["Authorization", `Bearer ${tok.o}`]],
    },
    after: async (probe) => {
      await exchange(probe, "seam.bearerOnly", 2, WS_METHODS.serverUpdateSettings);
      await close(probe, "seam.bearerOnly");
    },
  },
  {
    // `parseBearerToken` slices a fixed prefix and trims, so padding the token is harmless.
    name: "seam.bearerPadded",
    session: SESSIONS.cookieOperate,
    scopes: ["orchestration:read", "orchestration:operate"],
    target: () => "/ws",
    cred: {
      tokens: {
        o: { sid: SESSIONS.cookieOperate, scopes: ["orchestration:read", "orchestration:operate"] },
      },
      headers: (tok) => [["Authorization", `Bearer   ${tok.o}  `]],
    },
    after: async (probe) => {
      await exchange(probe, "seam.bearerPadded", 2, WS_METHODS.serverUpdateSettings);
      await close(probe, "seam.bearerPadded");
    },
  },
  {
    // The prefix comparison is `startsWith("Bearer ")`, so a lowercase scheme names no credential at all —
    // and the header's presence is measured separately by `seam.basicAuthorization`.
    name: "seam.bearerLowercase",
    session: SESSIONS.cookieOperate,
    scopes: ["orchestration:read", "orchestration:operate"],
    target: () => "/ws",
    cred: {
      tokens: { o: { sid: SESSIONS.cookieOperate, scopes: ["orchestration:read"] } },
      headers: (tok) => [["Authorization", `bearer ${tok.o}`]],
    },
  },
  {
    name: "seam.basicAuthorization",
    session: SESSIONS.cookieOperate,
    scopes: ["orchestration:read", "orchestration:operate"],
    target: () => "/ws",
    cred: {
      tokens: { o: { sid: SESSIONS.cookieOperate, scopes: ["orchestration:read"] } },
      headers: (tok) => [["Authorization", `Basic ${tok.o}`]],
    },
  },
  {
    // A scheme with nothing after it parses to no token (`:560`, `:569`), so the request is missing a
    // credential rather than carrying a bad one.
    name: "seam.bearerEmptyScheme",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"] } },
      headers: () => [["Authorization", "Bearer"]],
    },
  },
  {
    name: "seam.dpopEmptyScheme",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"] } },
      headers: () => [["Authorization", "DPoP "]],
    },
  },
  {
    // Node folds repeated headers into one comma-joined value before `parseHeader` ever sees them, so a
    // second `Cookie` line corrupts the first's token rather than adding a candidate.
    name: "seam.duplicateCookieHeaders",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"] } },
      headers: (tok, names) => [
        ["Cookie", `${names.cookie}=${tok.c}`],
        ["Cookie", "seam_other=x"],
      ],
    },
    after: closeOnly,
  },
  {
    // An empty cookie *is* a cookie: `selectRequestCredential` returns `{token: ""}` because it tests
    // `!== undefined`, and `authenticateRequest` then fails on `!credential?.token` without ever
    // looking at the bearer token beside it.
    name: "seam.emptyCookieBeatsBearer",
    session: SESSIONS.cookieOperate,
    scopes: ["orchestration:read", "orchestration:operate"],
    target: () => "/ws",
    cred: {
      tokens: { o: { sid: SESSIONS.cookieOperate, scopes: ["orchestration:read"] } },
      headers: (tok, names) => [
        ["Cookie", `${names.cookie}=;`],
        ["Authorization", `Bearer ${tok.o}`],
      ],
    },
  },
  {
    // `Cookies.parseHeader` keeps the first of a repeated name (`Effect`'s `Object.hasOwn` guard).
    name: "seam.duplicateCookie",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"] } },
      headers: (tok, names) => [["Cookie", `${names.cookie}=junk; ${names.cookie}=${tok.c}`]],
    },
  },
  {
    // A quoted cookie value has its quotes removed before use.
    name: "seam.quotedCookie",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"] } },
      headers: (tok, names) => [["Cookie", `${names.cookie}="${tok.c}"`]],
    },
    after: closeOnly,
  },
  {
    // `%` anywhere in the value makes the parser `decodeURIComponent` it, which is how the `.` between
    // payload and signature survives a cookie round trip.
    name: "seam.percentCookie",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"] } },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.c.replace(".", "%2E")}`]],
    },
    after: closeOnly,
  },
  {
    // The legacy name (`t3_session`, no suffix) is only consulted when the server is a remote web
    // deployment, so a bare `t3_session` cookie here names no credential at all.
    name: "seam.legacyCookieIgnored",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"] } },
      headers: (tok) => [["Cookie", `t3_session=${tok.c}`]],
    },
  },
  {
    name: "seam.wrongPortCookie",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"] } },
      headers: (tok) => [["Cookie", `t3_session_1_deadbeefcafe=${tok.c}`]],
    },
  },
  {
    // `websocketTicket.trim().length > 0` (`:1080`), so a ticket that is only whitespace is no ticket.
    name: "seam.blankTicketFallsBackToCookie",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws?wsTicket=%20%20",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"] } },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.c}`]],
    },
    after: closeOnly,
  },
  {
    name: "seam.emptyTicketFallsBackToCookie",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws?wsTicket=",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"] } },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.c}`]],
    },
    after: closeOnly,
  },
  {
    // A real ticket wins without consulting the cookie: the gate is the ticket's row, and the cookie
    // names a row with strictly fewer scopes, so the answer distinguishes the two.
    name: "seam.ticketBeatsCookie",
    session: SESSIONS.cookieOperate,
    scopes: ["orchestration:read", "orchestration:operate"],
    target: (ticket) => `/ws?wsTicket=${ticket}`,
    cred: {
      rows: [[SESSIONS.cookieRead, ["orchestration:read"]]],
      tokens: { c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"] } },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.c}`]],
    },
    after: async (probe) => {
      await exchange(probe, "seam.ticketBeatsCookie", 2, WS_METHODS.serverUpdateSettings);
      await close(probe, "seam.ticketBeatsCookie");
    },
  },
  {
    // The two token kinds are not interchangeable: a session token in `wsTicket` fails the
    // `kind: "websocket"` literal.
    name: "seam.sessionTokenAsTicket",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: (unused, tok) => `/ws?wsTicket=${tok.s}`,
    cred: {
      tokens: { s: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"] } },
      headers: () => [],
    },
  },
  {
    // ...and the same holds the other way, which is the case a client hits when it replays a ticket it
    // was handed as a cookie.
    name: "seam.ticketAsCookie",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: {
        t: { sid: SESSIONS.cookieRead, kind: "websocket", scopes: ["orchestration:read"] },
      },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.t}`]],
    },
  },
  // --- the DPoP guards that need no key -------------------------------------
  {
    // A token carrying `jkt` is only accepted in an `Authorization: DPoP ` header that repeats it
    // verbatim (`:659-667`); as a bearer token it is refused before any proof is looked at.
    name: "seam.boundBearer",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: {
        b: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"], jkt: "thumbprint-seam" },
      },
      headers: (tok) => [["Authorization", `Bearer ${tok.b}`]],
    },
  },
  {
    name: "seam.boundCookie",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: {
        b: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"], jkt: "thumbprint-seam" },
      },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.b}`]],
    },
  },
  {
    // The mirror guard: `DPoP ` authorization with a token that is not proof-bound.
    name: "seam.unboundDpopHeader",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"] } },
      headers: (tok) => [["Authorization", `DPoP ${tok.c}`]],
    },
  },
  {
    // Past both guards the route verifies the proof, which lives in its own `DPoP` header
    // (`auth/dpop.ts:59`): absent is `missing_proof`, garbage is `malformed_proof`, and both map to the
    // same `invalid_proof` reason on the wire.
    name: "seam.boundDpopNoProof",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: {
        b: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"], jkt: "thumbprint-seam" },
      },
      headers: (tok) => [["Authorization", `DPoP ${tok.b}`]],
    },
  },
  {
    name: "seam.boundDpopMalformedProof",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: {
        b: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"], jkt: "thumbprint-seam" },
      },
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        ["DPoP", "not-a-compact-jwt"],
      ],
    },
  },
  // --- the DPoP proof, verified by the shipped verifier over a real socket ---
  {
    // `EnvironmentAuth.ts:668` hands the proof to `verifyRequestDpopProof` with the row's `jkt` as
    // `expectedThumbprint` and the credential itself as `expectedAccessToken`; a proof that satisfies both
    // is what a `101` costs. The exchange is the other half of the claim: the connection is live **and**
    // gated by the bound token's own claims.
    name: "seam.dpopValid",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        ["DPoP", dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-valid" })],
      ],
    },
    after: async (probe) => {
      await exchange(probe, "seam.dpopValid", 1, WS_METHODS.serverGetSettings);
      await exchange(probe, "seam.dpopValid", 2, WS_METHODS.serverUpdateSettings);
      await close(probe, "seam.dpopValid");
    },
  },
  {
    // The replay guard is `ServerSecretStore.create` of `dpop-proof-<digest>` (`auth/dpop.ts:97-108`) —
    // it is a filesystem `wx`, and the already-exists failure maps to the one reason none of the
    // verifier's own codes produces. Same key, same token, same `jti`, so the only thing that changed is
    // that the store has seen it.
    name: "seam.dpopReplayedJti",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        ["DPoP", dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-valid" })],
      ],
    },
  },
  {
    // The thumbprint is the first guard after the two decoders (`dpop.ts:141-144`), so a proof signed by
    // another key answers `key_mismatch` even though its claims are also wrong.
    name: "seam.dpopWrongKey",
    session: SESSIONS.dpopFresh,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(SESSIONS.dpopFresh),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        ["DPoP", dpopProof({ key: "b", token: tok.b!, jti: "seam-dpop-wrong-key" })],
      ],
    },
  },
  {
    // Two guards out of order would be invisible in the status and visible in the reason: a proof signed
    // by the wrong key *and* carrying the wrong method is `key_mismatch`, never `request_mismatch`.
    name: "seam.dpopKeyOutranksMethod",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({
            key: "b",
            token: tok.b!,
            jti: "seam-dpop-key-order",
            htm: "POST",
            htu: "http://127.0.0.1/wrong",
          }),
        ],
      ],
    },
  },
  {
    name: "seam.dpopMethodMismatch",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        ["DPoP", dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-htm", htm: "POST" })],
      ],
    },
  },
  {
    name: "seam.dpopUrlMismatch",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({
            key: "a",
            token: tok.b!,
            jti: "seam-dpop-htu",
            htu: "http://127.0.0.1/wsx",
          }),
        ],
      ],
    },
  },
  {
    // `normalizeDpopHtu` runs on the **server's** URL only (`dpop.ts:148-149` compares the claim to it
    // verbatim), so a client that signs the URL it asked for is refused: the query it carried survives in
    // the claim and no longer exists in the normalized target.
    name: "seam.dpopUrlNormalized",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws?surface=web",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({
            key: "a",
            token: tok.b!,
            jti: "seam-dpop-htu-normalized",
            htu: "http://127.0.0.1/ws?surface=web#frag",
          }),
        ],
      ],
    },
  },
  {
    // The same request, signed the way the comparison allows: the stripped URL, while the wire target
    // still carries the query. This is the case that says which side of the equality is normalized.
    name: "seam.dpopUrlSignedStripped",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws?surface=web",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        ["DPoP", dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-htu-stripped" })],
      ],
    },
    after: closeOnly,
  },
  {
    // `ath` is required by the route because it passes `expectedAccessToken`: absent and wrong are the
    // same `access_token_hash_mismatch`, and both are the guard that runs before the signature.
    name: "seam.dpopMissingAth",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        ["DPoP", dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-no-ath", ath: null })],
      ],
    },
  },
  {
    name: "seam.dpopAthOfAnotherToken",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({
            key: "a",
            token: tok.b!,
            jti: "seam-dpop-wrong-ath",
            ath: computeDpopAccessTokenHash("some-other-token"),
          }),
        ],
      ],
    },
  },
  {
    // Both window edges, and both are on the *accepted* side: `dpop.ts:180` allows five seconds of skew
    // into the future and `DEFAULT_MAX_AGE_SECONDS` of age behind it.
    name: "seam.dpopFutureEdge",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({
            key: "a",
            token: tok.b!,
            jti: "seam-dpop-future-edge",
            iat: Math.floor(NOW / 1000) + 5,
          }),
        ],
      ],
    },
    after: closeOnly,
  },
  {
    name: "seam.dpopTooFuture",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({
            key: "a",
            token: tok.b!,
            jti: "seam-dpop-too-future",
            iat: Math.floor(NOW / 1000) + 6,
          }),
        ],
      ],
    },
  },
  {
    name: "seam.dpopStaleEdge",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({
            key: "a",
            token: tok.b!,
            jti: "seam-dpop-stale-edge",
            iat: Math.floor(NOW / 1000) - 300,
          }),
        ],
      ],
    },
    after: closeOnly,
  },
  {
    name: "seam.dpopTooStale",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({
            key: "a",
            token: tok.b!,
            jti: "seam-dpop-too-stale",
            iat: Math.floor(NOW / 1000) - 301,
          }),
        ],
      ],
    },
  },
  {
    // The window is checked **after** the signature (`dpop.ts:163-188`), so a proof that is both forged
    // and stale answers `invalid_proof`: a port that reordered these two would report `time_window`.
    name: "seam.dpopSignatureOutranksTime",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({
            key: "a",
            token: tok.b!,
            jti: "seam-dpop-sig-order",
            iat: Math.floor(NOW / 1000) - 900,
            signature: "flip",
          }),
        ],
      ],
    },
  },
  {
    name: "seam.dpopFlippedSignature",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-flipped", signature: "flip" }),
        ],
      ],
    },
  },
  {
    // `n - s` is the same signature as far as the group law goes. Whether the verifier takes it is a
    // claim about noble's `strict` default, not about DPoP, and it is the one a hand-rolled verifier is
    // most likely to get backwards.
    name: "seam.dpopHighS",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-high-s", signature: "highS" }),
        ],
      ],
    },
  },
  {
    name: "seam.dpopDerSignature",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        ["DPoP", dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-der", signature: "der" })],
      ],
    },
  },
  {
    name: "seam.dpopTruncatedSignature",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({
            key: "a",
            token: tok.b!,
            jti: "seam-dpop-truncated",
            signature: "truncated",
          }),
        ],
      ],
    },
  },
  {
    // Three header shapes, all dying in the same decoder: `typ`/`alg` are literals
    // (`dpop.ts:38-44`) and a `d` member is `Schema.optionalKey(Schema.Never)` (`:33-36`), which is how
    // a client that pasted its private JWK gets refused.
    name: "seam.dpopWrongAlg",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        ["DPoP", dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-alg", alg: "RS256" })],
      ],
    },
  },
  {
    name: "seam.dpopPrivateJwk",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-private", privateJwk: true }),
        ],
      ],
    },
  },
  {
    name: "seam.dpopWrongTyp",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        ["DPoP", dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-typ", typ: "at+jwt" })],
      ],
    },
  },
  {
    // The payload's three non-empty string checks and its `Schema.Int` (`dpop.ts:47-56`) are the other
    // half of the decoder: an absent-or-empty `jti`, and an `iat` with a fraction.
    name: "seam.dpopEmptyJti",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        ["DPoP", dpopProof({ key: "a", token: tok.b!, jti: "" })],
      ],
    },
  },
  {
    name: "seam.dpopFractionalIat",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-fraction", iat: NOW / 1000 + 0.5 }),
        ],
      ],
    },
  },
  {
    // A first segment that is not base64url at all dies in `Result.getOrThrow` rather than in the schema
    // decoder (`dpop.ts:75-76`), which is the difference between `malformed_proof` and the thrown
    // `invalid_proof` — invisible on the wire, and the reason the port needs both paths.
    name: "seam.dpopHeaderNotBase64",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({
            key: "a",
            token: tok.b!,
            jti: "seam-dpop-bad-header",
            headerOverride: "not!base64",
          }),
        ],
      ],
    },
  },
  {
    // Two signatures the arithmetic forbids, both over the real message: noble may throw instead of
    // answering false, and a port that panics here is a dropped connection rather than a 401.
    name: "seam.dpopZeroR",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-zero-r", signature: "zeroR" }),
        ],
      ],
    },
  },
  {
    name: "seam.dpopZeroS",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-zero-s", signature: "zeroS" }),
        ],
      ],
    },
  },
  {
    // The thumbprint is computed from the JWK's *text*, so a key that passes the binding guard can still
    // be one the verifier cannot load: `x` short of 32 bytes (`dpop.ts:103-105` throws) and a point off
    // the curve (noble's `Point.fromHex` answers `false`). Both are the same 150 bytes on the wire, and
    // both are a crash waiting to happen in a port that reaches for the field arithmetic first.
    name: "seam.dpopShortX",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(SESSIONS.dpop, DPOP_BAD_THUMBPRINT.shortX),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({
            key: "a",
            token: tok.b!,
            jti: "seam-dpop-short-x",
            jwkOverride: DPOP_BAD_JWK.shortX,
          }),
        ],
      ],
    },
  },
  {
    name: "seam.dpopOffCurveKey",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(SESSIONS.dpop, DPOP_BAD_THUMBPRINT.offCurve),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({
            key: "a",
            token: tok.b!,
            jti: "seam-dpop-off-curve",
            jwkOverride: DPOP_BAD_JWK.offCurve,
          }),
        ],
      ],
    },
  },
  {
    // `Schema.Struct`'s excess-property stance, measured rather than assumed: an undeclared `kid` inside
    // the JWK, and an undeclared `nonce` inside the payload. A refused `kid` would break every client that
    // labels its key, and the thumbprint cannot see it either way (`dpop.ts:83-90` reads four fields).
    name: "seam.dpopJwkHasKid",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        ["DPoP", dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-kid", extra: "jwkKid" })],
      ],
    },
    after: closeOnly,
  },
  {
    name: "seam.dpopPayloadHasNonce",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        [
          "DPoP",
          dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-nonce", extra: "payloadNonce" }),
        ],
      ],
    },
    after: closeOnly,
  },
  {
    // Both sides of the method test are upper-cased (`dpop.ts:145`), so a client that wrote `get` is not
    // the `request_mismatch` a case-sensitive port would answer.
    name: "seam.dpopLowercaseMethod",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        ["DPoP", dpopProof({ key: "a", token: tok.b!, jti: "seam-dpop-lower-htm", htm: "get" })],
      ],
    },
    after: closeOnly,
  },
  {
    name: "seam.dpopTwoSegments",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => {
        const [header, payload] = dpopProof({
          key: "a",
          token: tok.b!,
          jti: "seam-dpop-two-segments",
        }).split(".");
        return [
          ["Authorization", `DPoP ${tok.b}`],
          ["DPoP", `${header}.${payload}`],
        ];
      },
    },
  },
  {
    // `!input.proof?.trim()` (`dpop.ts:122`) is the only guard that reads whitespace, so a blank proof is
    // `missing_proof` rather than `malformed_proof` — and both are the same reason on the wire.
    name: "seam.dpopBlankProof",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        ["DPoP", "   "],
      ],
    },
  },
  {
    // The claim that the *other* credential path is not this one's business: an honest `wsTicket` and a
    // proof that would be refused on its own. `authenticateWebSocketUpgrade` never falls through to
    // `authenticateRequest`, so the proof is never read and the socket opens.
    name: "seam.dpopTicketOutranksProof",
    session: SESSIONS.dpop,
    scopes: ["orchestration:read"],
    ticket: "issued",
    target: (ticket) => `/ws?wsTicket=${ticket}`,
    cred: {
      tokens: boundCredential(),
      headers: (tok) => [
        ["Authorization", `DPoP ${tok.b}`],
        ["DPoP", dpopProof({ key: "b", token: tok.b!, jti: "seam-dpop-ignored" })],
      ],
    },
    after: closeOnly,
  },
  // --- where the gate's scopes actually come from ---------------------------
  {
    // `verify` returns `claims.scopes` (`SessionStore.ts:840`), not the row's, so a token narrower than
    // its row gates the connection to the token.
    name: "seam.claimsNarrowerThanRow",
    session: SESSIONS.cookieWide,
    scopes: ["orchestration:read", "orchestration:operate"],
    target: () => "/ws",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieWide, scopes: ["orchestration:read"] } },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.c}`]],
    },
    after: async (probe) => {
      await exchange(probe, "seam.claimsNarrowerThanRow", 2, WS_METHODS.serverUpdateSettings);
      await close(probe, "seam.claimsNarrowerThanRow");
    },
  },
  {
    // ...and wider: the row's `scopes` column never widens a connection, but it does not narrow one
    // either, which a port that read the row would get backwards in the other direction.
    name: "seam.claimsWiderThanRow",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: {
        c: {
          sid: SESSIONS.cookieRead,
          scopes: ["orchestration:read", "orchestration:operate"],
        },
      },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.c}`]],
    },
    after: async (probe) => {
      await exchange(probe, "seam.claimsWiderThanRow", 2, WS_METHODS.serverUpdateSettings);
      await close(probe, "seam.claimsWiderThanRow");
    },
  },
  {
    // The dev-prefix refusal belongs to the ticket path alone: `verifyWebSocketToken` rejects a
    // `dev-auth-` session id that is not the configured dev session, and `verify` has no such check.
    name: "seam.devPrefixSessionCookie",
    session: SESSIONS.cookieDev,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieDev, scopes: ["orchestration:read"] } },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.c}`]],
    },
    after: closeOnly,
  },
  {
    name: "seam.expiredCookieToken",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: {
        c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"], exp: NOW - 1 },
      },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.c}`]],
    },
  },
  {
    // The asymmetry between the two verifiers: `verifyWebSocketToken` refuses a row whose own expiry has
    // passed (`:928-934`), `verify` never looks at `row.expiresAt` — only at `revokedAt`.
    name: "seam.expiredRowCookie",
    session: SESSIONS.cookieExpired,
    scopes: ["orchestration:read"],
    expiresAt: NOW,
    target: () => "/ws",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieExpired, scopes: ["orchestration:read"] } },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.c}`]],
    },
    after: closeOnly,
  },
  {
    name: "seam.revokedCookie",
    session: SESSIONS.cookieRevoked,
    scopes: ["orchestration:read"],
    revokeBefore: true,
    target: () => "/ws",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieRevoked, scopes: ["orchestration:read"] } },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.c}`]],
    },
  },
  {
    name: "seam.missingRowCookie",
    session: SESSIONS.cookieMissing,
    target: () => "/ws",
    cred: {
      tokens: { c: { sid: SESSIONS.cookieMissing, scopes: ["orchestration:read"] } },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.c}`]],
    },
  },
  {
    // The first character of the signature is a full six bits, so corrupting it changes the compared
    // bytes and the token is refused.
    name: "seam.corruptedSignatureCookie",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: {
        c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"], signature: "head" },
      },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.c}`]],
    },
  },
  {
    // ...and the last one does not, because a 32-byte digest leaves that character with two spare bits:
    // the same signature, written differently, still authenticates.
    name: "seam.tailBitSignatureCookie",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: {
        c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"], signature: "tail" },
      },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.c}`]],
    },
    after: closeOnly,
  },
  {
    // `token.split(".")` leaves no signature, so this is the malformed branch rather than the
    // cryptographic one.
    name: "seam.strippedSignatureCookie",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: {
        c: { sid: SESSIONS.cookieRead, scopes: ["orchestration:read"], signature: "strip" },
      },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.c}`]],
    },
  },
  // A session id is `TrimmedNonEmptyString` (`baseSchemas.ts:129-131`), so a padded one is not a refusal:
  // the payload decodes, and the row lookup runs on the *trimmed* id, which is the seeded row. The
  // whitespace is invisible on the wire — the connection is made and the cookie's scopes gate it.
  {
    name: "seam.sidWhitespaceCookie",
    session: SESSIONS.cookieRead,
    scopes: ["orchestration:read"],
    target: () => "/ws",
    cred: {
      tokens: { c: { sid: ` ${SESSIONS.cookieRead} `, scopes: ["orchestration:read"] } },
      headers: (tok, names) => [["Cookie", `${names.cookie}=${tok.c}`]],
    },
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

/** The cookie names, read once from the running server — see `CookieNames`. */
let cookieNames: CookieNames = { cookie: "unresolved", legacy: null };

const readCookieNames = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  return {
    cookie: sessions.cookieName,
    legacy: sessions.legacyCookieName ?? null,
  } satisfies CookieNames;
});

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
  const extraRows = scenario.cred?.rows ?? [];
  for (const [sessionId, scopes, expiresAt] of extraRows) {
    if (seeded.has(sessionId)) continue;
    await runEffect(createRow(sessionId, scopes, expiresAt ?? NOW + 600_000));
    seeded.add(sessionId);
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
      // The other rows the credential cases seeded, so a replay answers a cookie that names one of them.
      rows: extraRows.map(([sessionId, scopes, expiresAt]) => [
        sessionId,
        [...scopes],
        expiresAt ?? NOW + 600_000,
      ]),
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
  const tokens: Record<string, string> = {};
  for (const [name, spec] of Object.entries(scenario.cred?.tokens ?? {})) {
    tokens[name] = mintSessionToken(spec);
  }
  const lines =
    scenario.cred === undefined
      ? scenario.lines
      : [...(scenario.lines ?? UPGRADE_HEADERS), ...scenario.cred.headers(tokens, cookieNames)];
  const probe = await handshake(
    scenario.name,
    scenario.target(token, tokens),
    port,
    lines ?? UPGRADE_HEADERS,
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
  cookieNames = await runtime.runPromise(readCookieNames as never);
  // A comma-separated list, because measuring one guard needs its neighbours in the same run to show
  // which one the route reached first.
  const only = process.env.SEAM_ONLY?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const scenario of scenarios) {
    if (only !== undefined && !only.includes(scenario.name)) continue;
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
      // No reusable dev session runs here, which is what makes `seam.devPrefix` a refusal. It also means
      // no case exercises the `dev-cookie` fallback (`EnvironmentAuth.ts:648-653`), which needs a
      // configured `devAuthToken` — that gap is recorded rather than papered over.
      devSessionId: null,
      // The name the server actually asks cookies for: `resolveSessionCookieName` mixes the port and a
      // hash of the state directory into it, so a replay cannot derive it and must be told.
      sessionCookieName: cookieNames.cookie,
      legacyCookieName: cookieNames.legacy,
      // The bound key, in both forms a replay needs: the `jkt` the row carries and the JWK the proof
      // header repeats. Public values only, so recording them leaks nothing.
      dpopThumbprint: DPOP_THUMBPRINT,
      dpopJwk: DPOP_JWK,
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
      // The replay store's key is a digest of `<thumbprint>:<jti>`, so printing it is what lets the port
      // claim it computed the same name rather than merely the same outcome.
      if (event.event === "secret")
        lines.push(`  ${event.case} secret ${event.detail} ${JSON.stringify(event.value)}`);
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
  // ---------------------------------------------------------------------------
  // The credential a request carries when it carries no ticket
  // ---------------------------------------------------------------------------

  /** The two shapes a refusal comes in, both asserted from the record rather than from the code. */
  const refusedMissing = [
    "seam.bearerLowercase",
    "seam.basicAuthorization",
    "seam.emptyCookieBeatsBearer",
    "seam.legacyCookieIgnored",
    "seam.wrongPortCookie",
    "seam.bearerEmptyScheme",
    "seam.dpopEmptyScheme",
  ];
  const refusedInvalid = [
    "seam.duplicateCookie",
    "seam.sessionTokenAsTicket",
    "seam.ticketAsCookie",
    "seam.expiredCookieToken",
    "seam.revokedCookie",
    "seam.missingRowCookie",
    "seam.corruptedSignatureCookie",
    "seam.strippedSignatureCookie",
  ];
  const refusedProof = [
    "seam.boundBearer",
    "seam.boundCookie",
    "seam.unboundDpopHeader",
    "seam.boundDpopNoProof",
    "seam.boundDpopMalformedProof",
  ];
  const accepted = [
    "seam.cookieRead",
    "seam.cookieBeatsBearer",
    "seam.bearerOnly",
    "seam.bearerPadded",
    "seam.quotedCookie",
    "seam.percentCookie",
    "seam.blankTicketFallsBackToCookie",
    "seam.emptyTicketFallsBackToCookie",
    "seam.ticketBeatsCookie",
    "seam.claimsNarrowerThanRow",
    "seam.claimsWiderThanRow",
    "seam.devPrefixSessionCookie",
    "seam.expiredRowCookie",
    "seam.sidWhitespaceCookie",
    "seam.duplicateCookieHeaders",
    "seam.tailBitSignatureCookie",
  ];
  for (const name of refusedMissing) {
    const event = responseOf(name);
    if (event?.statusLine !== "HTTP/1.1 401 Unauthorized") {
      failures.push(`${name}: expected 401, got ${event?.statusLine ?? "nothing"}`);
    }
    if (!(event?.tailText ?? "").includes('"reason":"missing_credential"')) {
      failures.push(`${name}: expected missing_credential, got ${event?.tailText}`);
    }
  }
  for (const name of refusedInvalid) {
    const event = responseOf(name);
    if (event?.statusLine !== "HTTP/1.1 401 Unauthorized") {
      failures.push(`${name}: expected 401, got ${event?.statusLine ?? "nothing"}`);
    }
    if (
      !(event?.tailText ?? "").includes('"reason":"invalid_credential"') ||
      (event?.tailText ?? "").includes("dpopFailureReason")
    ) {
      failures.push(`${name}: expected a plain invalid_credential, got ${event?.tailText}`);
    }
  }
  // A DPoP refusal is the same 401 plus one field, which is the only place the seam's answer differs
  // between the two credential paths — and the reason the 150-byte body is its own case group.
  for (const name of refusedProof) {
    const event = responseOf(name);
    if (!(event?.tailText ?? "").includes('"dpopFailureReason":"invalid_proof"')) {
      failures.push(`${name}: expected invalid_proof, got ${event?.tailText}`);
    }
    if (
      !(event?.headers ?? []).some(
        ([header, value]) => header.toLowerCase() === "content-length" && value === "150",
      )
    ) {
      failures.push(`${name}: the DPoP field did not grow the body to 150 bytes`);
    }
  }
  for (const name of accepted) {
    if (responseOf(name)?.statusLine !== "HTTP/1.1 101 Switching Protocols") {
      failures.push(`${name}: expected 101, got ${responseOf(name)?.statusLine ?? "nothing"}`);
    }
  }
  // The order `selectRequestCredential` reads (`EnvironmentAuth.ts:572-598`), each step proven by the
  // scopes the connection ended up with rather than by the status code.
  const cookieWon = answerOf("seam.cookieBeatsBearer", 2)?.payload ?? "";
  if (!cookieWon.includes("EnvironmentAuthorizationError")) {
    failures.push(`seam.cookieBeatsBearer: the bearer token outran the cookie`);
  }
  if (!(answerOf("seam.bearerOnly", 2)?.payload ?? "").includes('"ok":"operate"')) {
    failures.push(`seam.bearerOnly: an authorization header alone did not authenticate`);
  }
  if (!(answerOf("seam.bearerPadded", 2)?.payload ?? "").includes('"ok":"operate"')) {
    failures.push(`seam.bearerPadded: padding the token changed the answer`);
  }
  if (!(answerOf("seam.ticketBeatsCookie", 2)?.payload ?? "").includes('"ok":"operate"')) {
    failures.push(`seam.ticketBeatsCookie: the cookie outran the ticket`);
  }
  if (
    (rowOf("seam.bearerOnly")?.lastConnectedAt as number | null | undefined) !== 1_700_000_000_000
  ) {
    failures.push(`seam.bearerOnly: the bearer session's own row was never connected`);
  }
  // The gate is built from the token's `scopes`, not from the row's, in both directions.
  const narrower = answerOf("seam.claimsNarrowerThanRow", 2)?.payload ?? "";
  if (!narrower.includes("EnvironmentAuthorizationError")) {
    failures.push(`seam.claimsNarrowerThanRow: the row's wider scope list gated the connection`);
  }
  if (!(answerOf("seam.claimsWiderThanRow", 2)?.payload ?? "").includes('"ok":"operate"')) {
    failures.push(`seam.claimsWiderThanRow: the row's narrower scope list gated the connection`);
  }
  // A fresh row that was refused never learned about the attempt, from either side of the union.
  if (rowOf("seam.revokedCookie")?.lastConnectedAt !== null) {
    failures.push(`seam.revokedCookie: a refused cookie still recorded a connection`);
  }
  if (rowOf("seam.missingRowCookie")?.missing !== true) {
    failures.push(`seam.missingRowCookie: the row the token named exists`);
  }
  // The name is the server's, and this configuration has no legacy fallback to consult: the two cases
  // that present a bare `t3_session` are refused as though no cookie had been sent.
  if (cookieNames.legacy !== null) {
    failures.push(`legacy cookie name is consulted here: ${cookieNames.legacy}`);
  }
  if (!/^t3_session_\d+_[0-9a-f]{12}$/.test(cookieNames.cookie)) {
    failures.push(`session cookie name is not the derived one: ${cookieNames.cookie}`);
  }

  // ---------------------------------------------------------------------------
  // The DPoP proof, guarded in the order `verifyDpopProof` reads it
  // ---------------------------------------------------------------------------

  /** The refusal's two measurable halves: the reason field and the byte length it costs. */
  const dpopRefusal = (name: string, reason: string, length: number, fresh = false) => {
    const event = responseOf(name);
    if (event?.statusLine !== "HTTP/1.1 401 Unauthorized") {
      failures.push(`${name}: expected 401, got ${event?.statusLine ?? "nothing"}`);
    }
    if (!(event?.tailText ?? "").includes(`"dpopFailureReason":"${reason}"`)) {
      failures.push(`${name}: expected ${reason}, got ${event?.tailText}`);
    }
    if (
      !(event?.headers ?? []).some(
        ([header, value]) => header.toLowerCase() === "content-length" && value === String(length),
      )
    ) {
      failures.push(
        `${name}: ${reason} did not answer with ${length} bytes (${JSON.stringify(event?.headers)})`,
      );
    }
    // Every refused case leaves the row detached, and the one case on a row nothing has connected proves
    // the refusal never reached `recordClientConnection` at all.
    const record = rowOf(name);
    if (record?.connected !== false) {
      failures.push(`${name}: a refused proof left the row connected`);
    }
    if (fresh && record?.lastConnectedAt !== null) {
      failures.push(`${name}: a refused proof still recorded a connection`);
    }
  };
  const dpopAccepted = (name: string) => {
    if (responseOf(name)?.statusLine !== "HTTP/1.1 101 Switching Protocols") {
      failures.push(`${name}: expected 101, got ${responseOf(name)?.statusLine ?? "nothing"}`);
    }
  };

  dpopRefusal("seam.dpopWrongKey", "key_mismatch", 149, true);
  dpopRefusal("seam.dpopMethodMismatch", "request_mismatch", 153);
  dpopRefusal("seam.dpopUrlMismatch", "request_mismatch", 153);
  dpopRefusal("seam.dpopUrlNormalized", "request_mismatch", 153);
  dpopRefusal("seam.dpopMissingAth", "token_mismatch", 151);
  dpopRefusal("seam.dpopAthOfAnotherToken", "token_mismatch", 151);
  dpopRefusal("seam.dpopTooFuture", "time_window", 148);
  dpopRefusal("seam.dpopTooStale", "time_window", 148);
  dpopRefusal("seam.dpopReplayedJti", "replay", 143);
  for (const name of [
    "seam.dpopFlippedSignature",
    "seam.dpopDerSignature",
    "seam.dpopTruncatedSignature",
    "seam.dpopWrongAlg",
    "seam.dpopWrongTyp",
    "seam.dpopPrivateJwk",
    "seam.dpopTwoSegments",
    "seam.dpopBlankProof",
    "seam.dpopEmptyJti",
    "seam.dpopFractionalIat",
    "seam.dpopHeaderNotBase64",
    "seam.dpopShortX",
    "seam.dpopOffCurveKey",
    "seam.dpopZeroR",
    "seam.dpopZeroS",
  ]) {
    dpopRefusal(name, "invalid_proof", 150);
  }
  for (const name of [
    "seam.dpopValid",
    "seam.dpopUrlSignedStripped",
    "seam.dpopFutureEdge",
    "seam.dpopStaleEdge",
    "seam.dpopHighS",
    "seam.dpopTicketOutranksProof",
    // Unknown members are *stripped* rather than refused, on both sides of the JWS: the `kid` a key-
    // labelling client sends, and the `nonce` an older server used to demand. A port that decodes into a
    // strict struct would refuse a client the shipped server admits.
    "seam.dpopJwkHasKid",
    "seam.dpopPayloadHasNonce",
    // `htm.toUpperCase()` against the request method, also upper-cased (`dpop.ts:145`).
    "seam.dpopLowercaseMethod",
  ]) {
    dpopAccepted(name);
  }

  // Two guards are out of the order their failure modes are usually listed, and the reason field is the
  // only evidence: a wrong key plus a wrong method answers `key_mismatch`, and a bad signature plus an
  // out-of-window `iat` answers `invalid_proof`.
  if (!(responseOf("seam.dpopKeyOutranksMethod")?.tailText ?? "").includes("key_mismatch")) {
    failures.push(`seam.dpopKeyOutranksMethod: the method guard outran the key guard`);
  }
  if (!(responseOf("seam.dpopSignatureOutranksTime")?.tailText ?? "").includes("invalid_proof")) {
    failures.push(`seam.dpopSignatureOutranksTime: the window outran the signature`);
  }
  // The window's edges are inclusive on both sides — `seam.dpopFutureEdge` (+5) and `seam.dpopStaleEdge`
  // (-300) above authenticate, one more second of either is refused below.
  // An accepted proof is *spent*, and the name it is spent under is a digest the port has to reproduce.
  const spent = events.filter((event) => event.event === "secret");
  if (spent.length === 0) failures.push(`no DPoP proof was recorded as spent`);
  for (const event of spent) {
    const digest = NodeCrypto.createHash("sha256")
      .update(`${DPOP_THUMBPRINT.a}:${event.value?.match(/jti=([^\n]+)/)?.[1] ?? ""}`, "utf8")
      .digest("base64url");
    if (event.detail !== `dpop-proof-${digest}`) {
      failures.push(`${event.case}: spent under ${event.detail}, not dpop-proof-${digest}`);
    }
    if (event.value !== undefined && !event.value.startsWith(`thumbprint=${DPOP_THUMBPRINT.a}\n`)) {
      failures.push(`${event.case}: the stored proof did not name the bound key`);
    }
  }
  // The second use of the same proof is refused under the *same* name, which is what makes `replay` the
  // store's answer rather than the verifier's.
  const replayed = spent.filter((event) => event.case === "seam.dpopReplayedJti");
  if (replayed.length !== 1) {
    failures.push(`seam.dpopReplayedJti: expected one refused write, got ${replayed.length}`);
  } else if (
    replayed[0]?.detail !== spent.find((event) => event.case === "seam.dpopValid")?.detail
  ) {
    failures.push(`seam.dpopReplayedJti: the replay digested to a different name`);
  }
  // A ticket outranks the credential, so a bound token whose proof would not verify is never consulted.
  if (spent.some((event) => event.case === "seam.dpopTicketOutranksProof")) {
    failures.push(`seam.dpopTicketOutranksProof: the ticket path still spent a proof`);
  }
  return failures;
};

await main();
// The artifact is written with `writeSync`, so exiting here cannot truncate it, and `process.exitCode`
// keeps a violation's failure. `runtime.dispose()` is not used: it waits for the server to drain, and a
// handshake the library refused leaves a socket it never closes, so the run would hang on its own exit.
process.exit(process.exitCode);
