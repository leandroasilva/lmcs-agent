// Golden generator for the **authorization** half of `native/protocol`: the `wsTicket` a client
// presents on the upgrade, the table saying which scope each rpc needs, and the bytes the route writes
// when it refuses to upgrade.
//
// `node apps/server/scripts/auth-golden.ts > ~/.cache/lmcs-port-traces/auth-golden.json`
//
// `upgrade-golden.ts` deliberately ships a route with no auth, because auth would have hidden the
// transport behind a `401`. This file measures the other side of that door, and does it with the real
// functions rather than a paraphrase of them:
//
//   - `base64UrlEncode`, `base64UrlDecodeUtf8`, `signPayload`, `timingSafeEqualBase64Url` from
//     `apps/server/src/auth/utils.ts`, which is exactly what `SessionStore.issueWebSocketToken` and
//     `verifyWebSocketToken` (`SessionStore.ts:847-951`) are built out of;
//   - `failEnvironmentAuthInvalid`, `failEnvironmentInternal` from `apps/server/src/auth/http.ts`, which
//     is exactly what `ws.ts:3804-3877` answers a refused upgrade with;
//   - `RPC_REQUIRED_SCOPES`, `requiredScopeForRpcMethod`, `requiredScopeForDeviceList` from
//     `apps/server/src/auth/RpcAuthorization.ts`, which is the whole scope table.
//
// The refusal is then read **off a socket**, not off an object: the recorded head is what Node's
// response pipeline wrote, so header spelling, `Date`, `Transfer-Encoding` versus `Content-Length`, and
// whether the connection survives are measurements rather than assumptions.
//
// What this file cannot measure is written where it is used rather than here. The two candidates are
// `verifyWebSocketToken`'s branch order — six lines of `if` whose *inputs* are all measured below — and
// the reason an `AuthenticatedSession` row contributes, which needs the database.
//
// `LMCS_AUTH_GOLDEN_RECORD=1` skips the scenario expectations and prints what each case measured, which
// is how every number pinned below was obtained.
//
// Run twice and compare with `cmp`: any byte that moves is a claim this file does not pin.

import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as NodeHttp from "node:http";
import * as net from "node:net";
import { writeSync } from "node:fs";
import { AuthSessionId, EnvironmentAuthorizationError } from "@lmcstools/core";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../src/auth/http.ts";
import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForDeviceList,
  requiredScopeForRpcMethod,
} from "../src/auth/RpcAuthorization.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../src/auth/utils.ts";

// ---------------------------------------------------------------------------
// The ticket. `SessionStore.ts:487` reads a 32-byte secret out of the secret store under
// `server-signing-key`; the value is irrelevant to the bytes, so a fixed one is used, and what matters
// is that the mint is the same expression: `base64url(JSON.stringify(claims)) + "." +
// signPayload(payload, secret)` (`SessionStore.ts:847-880`).
// ---------------------------------------------------------------------------

const SECRET = Uint8Array.from({ length: 32 }, (_, index) => (index * 13 + 7) & 0xff);

/** The claims object as `issueWebSocketToken` builds it, with the key order it builds it in. */
const claimsOf = (
  sid: string,
  iat: number,
  exp: number,
): {
  readonly v: 1;
  readonly kind: "websocket";
  readonly sid: string;
  readonly iat: number;
  readonly exp: number;
} => ({
  v: 1,
  kind: "websocket",
  sid,
  iat,
  exp,
});

const IAT = 1_700_000_000_000;
const EXP = 1_700_000_300_000;

const CLAIM_CASES: Array<[string, Record<string, unknown>]> = [
  ["canonical", claimsOf("sess_01", IAT, EXP)],
  // `sid` reaches the token through JSON and then through base64url, so a `.` in it is the one input
  // that changes how many parts `verifyWebSocketToken`'s `token.split(".")` finds.
  ["sidWithDot", claimsOf("a.b", IAT, EXP)],
  ["sidEmpty", claimsOf("", IAT, EXP)],
  ["sidUnreserved", claimsOf("sess-01_2/3+4", IAT, EXP)],
  ["sidNonAscii", claimsOf("sess_ãã", IAT, EXP)],
  ["expBeforeIat", claimsOf("sess_01", EXP, IAT)],
  // `-0` is what `JSON.stringify` writes as `0`, and a mint is only ever an integer number of
  // milliseconds, so no case here needs JavaScript's exponential or fractional number text.
  ["zeroTimes", claimsOf("sess_01", -0, 0)],
  ["maxSafeTimes", claimsOf("sess_01", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2)],
];

const mint = (claims: Record<string, unknown>) => {
  const json = JSON.stringify(claims);
  const payload = base64UrlEncode(json);
  const signature = signPayload(payload, SECRET);
  return { json, payload, signature, token: `${payload}.${signature}` };
};

const tickets = CLAIM_CASES.map(([name, claims]) => ({ name, ...mint(claims) }));

// ---------------------------------------------------------------------------
// The verification inputs. Every branch `verifyWebSocketToken` takes is decided by one of these four
// primitives, so each is recorded over the inputs that branch on it.
// ---------------------------------------------------------------------------

/** `token.split(".")`, which the port has to reproduce including the empty-string and trailing-dot cases. */
const SPLIT_INPUTS = ["", ".", "a", "a.b", "a.b.c", "a..b", ".a.b", "a.", "a.b.", "..", "a.b.c.d"];
const splits = SPLIT_INPUTS.map((input) => ({ input, parts: input.split(".") }));

/**
 * The other half of the route's input: `HttpServerRequest.toURL(request)` and then
 * `searchParams.get("wsTicket")`, which is `application/x-www-form-urlencoded` parsing and not a string
 * search. `+` is a space, `%zz` survives, a bare `wsTicket` is the empty string rather than absent, the
 * first of repeated keys wins, and the key is case sensitive.
 */
const QUERY_INPUTS = [
  "/ws?wsTicket=a",
  "/ws?wsTicket=a&wsTicket=b",
  "/ws?wsTicket",
  "/ws?wsTicket=",
  "/ws?wsTicket=%20",
  "/ws?wsTicket=+",
  "/ws?wsTicket=a+b",
  "/ws?wsTicket=a%20b",
  "/ws?wsTicket=a%26b",
  "/ws?wsTicket=a=b",
  "/ws?wsTicket=%zz",
  "/ws?wsTicket=%25",
  "/ws?wsTicket=%C3%A9",
  "/ws?wsTicket=%D8%A3",
  "/ws?wsTicket=a#frag",
  "/ws?;wsTicket=x&wsTicket=y",
  "/ws?WSTICKET=a&wsTicket=b",
  "/ws?=a&wsTicket=b",
  "/ws",
  "/ws?",
  "/ws##?wsTicket=x",
];

const queries = QUERY_INPUTS.map((url) => {
  const parsed = new URL(url, "http://127.0.0.1:1");
  const ticket = parsed.searchParams.get("wsTicket");
  return {
    url,
    ticket,
    uses: ticket !== null && ticket.trim().length > 0,
    // What the port has to agree on for the refusal to be the right one: the route compares the *decoded*
    // value, so `path` and `search` are recorded to show where the query actually starts.
    path: parsed.pathname,
    search: parsed.search,
  };
});

/**
 * `Encoding.decodeBase64Url`, whose rules a Rust port cannot infer from RFC 4648: it accepts padding it
 * never produces, it strips CRLF before checking, it rejects a length that is 1 mod 4, and it is
 * case-insensitive.
 */
const DECODE_INPUTS = [
  "",
  "a",
  "ab",
  "abc",
  "abcd",
  "SGVsbG8",
  "SGVsbG8=",
  "SGVsbG8_",
  "aGVsbG8=",
  "aGVsbG8",
  "aGVs\r\nbG8=",
  "aGVs\nbG8=",
  "aGVsbG8==",
  "aGVsbG8===",
  "aGVsblG8",
  "aGVs+G8=",
  "aGVs-G8=",
  "!!!!",
  "ÿÿ",
  // A `=` in the middle is refused by the shape regex, and a short input that *needs* padding to reach a
  // multiple of 4 ends up with a `=` that is not at the end, which is the other message this decoder can
  // write. A port that only implements RFC 4648's lenient path accepts both.
  "A=BC",
  "AB=C",
  "a=",
  "A==",
];

const decodes = DECODE_INPUTS.map((input) => {
  const result = Encoding.decodeBase64Url(input);
  const asUtf8 = (() => {
    try {
      return { ok: true, value: base64UrlDecodeUtf8(input) };
    } catch (error) {
      const thrown = error as { constructor: { name: string }; message?: string };
      return { ok: false, thrown: `${thrown.constructor.name}:${thrown.message ?? ""}` };
    }
  })();
  const failure = (result as unknown as { failure?: { message?: string; input?: string } }).failure;
  return {
    input: JSON.stringify(input),
    decode: result._tag,
    bytes:
      result._tag === "Success"
        ? Buffer.from((result as unknown as { success: Uint8Array }).success).toString("hex")
        : undefined,
    message: failure?.message,
    utf8: asUtf8,
  };
});

/**
 * `timingSafeEqualBase64Url`, which decodes both sides with `Buffer.from(…, "base64url")` first. That
 * pre-decode is the whole claim: two strings that differ but decode equal compare **equal**, and an
 * undecodable string is not an error, it is fewer bytes.
 */
const TIMING_PAIRS: Array<[string, string]> = [
  ["aGVsbG8", "aGVsbG8"],
  ["aGVsbG8", "aGVsbG9"],
  ["aGVsbG8", "aGVsbG8="],
  ["aGVsbG8", "aGVz bG8"],
  ["", ""],
  ["", "aGVsbG8"],
  ["!!!!", ""],
  ["!!!!", "aGVsbG8"],
  ["aGVs", "aGVsbG8"],
];

const timing = TIMING_PAIRS.map(([left, right]) => ({
  left,
  right,
  equal: timingSafeEqualBase64Url(left, right),
  decoded: [
    Buffer.from(left, "base64url").toString("hex"),
    Buffer.from(right, "base64url").toString("hex"),
  ],
}));

// ---------------------------------------------------------------------------
// The claims, decoded by the **real** schema: `WebSocketClaims` is a struct of two literals,
// `AuthSessionId` and two `Schema.Number`s. The signature is checked *before* this runs, so every row
// below describes a correctly-signed payload. `sid` is the field a port cannot get from a spec:
// `AuthSessionId` is `TrimmedNonEmptyString` (`baseSchemas.ts:129-131`), so `" a "` decodes to `"a"`
// and `"  "` decodes to nothing, which is a refusal the client cannot predict from the token.
// ---------------------------------------------------------------------------

const decodeClaims = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      v: Schema.Literal(1),
      kind: Schema.Literal("websocket"),
      sid: AuthSessionId,
      iat: Schema.Number,
      exp: Schema.Number,
    }),
  ),
);

const PAYLOAD_CASES: Array<string> = [
  // The payload the mint produces, so the decode round-trips the encode the server itself ran.
  tickets[0].json,
  '{"v":1,"kind":"session","sid":"s","iat":1,"exp":2}',
  '{"v":"1","kind":"websocket","sid":"s","iat":1,"exp":2}',
  // `1.0` is one to `JSON.parse`, so `Schema.Literal(1)` sees a `1`.
  '{"v":1.0,"kind":"websocket","sid":"s","iat":1,"exp":2}',
  '{"kind":"websocket","sid":"s","iat":1,"exp":2}',
  '{"v":1,"kind":"websocket","iat":1,"exp":2}',
  '{"v":1,"kind":"websocket","sid":"","iat":1,"exp":2}',
  '{"v":1,"kind":"websocket","sid":"  ","iat":1,"exp":2}',
  '{"v":1,"kind":"websocket","sid":" a ","iat":1,"exp":2}',
  '{"v":1,"kind":"websocket","sid":"\\u00e9 ","iat":1,"exp":2}',
  '{"v":1,"kind":"websocket","sid":"\\u0085a","iat":1,"exp":2}',
  '{"v":1,"kind":"websocket","sid":"\\u001fa","iat":1,"exp":2}',
  '{"v":1,"kind":"websocket","sid":"\\u00a0","iat":1,"exp":2}',
  '{"v":1,"kind":"websocket","sid":"\\u2028a\\u2029","iat":1,"exp":2}',
  '{"v":1,"kind":"websocket","sid":"\\ufeff","iat":1,"exp":2}',
  '{"v":1,"kind":"websocket","sid":7,"iat":1,"exp":2}',
  '{"v":1,"kind":"websocket","sid":"s","iat":1,"exp":2,"extra":true}',
  '{"v":1,"kind":"websocket","sid":"s","iat":"1","exp":2}',
  // `1e999` is `Infinity` after `JSON.parse`, and `Schema.Number` is the finite numbers only.
  '{"v":1,"kind":"websocket","sid":"s","iat":1,"exp":1e999}',
  '{"v":1,"kind":"websocket","sid":"s","iat":1,"exp":1.5}',
  '{"v":1,"kind":"websocket","sid":"s","iat":1,"exp":-0}',
  // Key order is the mint's claim, not the decoder's.
  '{"sid":"s","exp":2,"kind":"websocket","v":1,"iat":1}',
  '{"v":1,"kind":"websocket","sid":"a","sid":"b","iat":1,"exp":2}',
  "not json",
  "null",
  "123",
  '"aGVsbG8"',
  "[]",
  "{}",
];

const payloads = PAYLOAD_CASES.map((json) => {
  const result = decodeClaims(json);
  return {
    json,
    decode: result._tag,
    sid: result._tag === "Success" ? JSON.stringify(result.success.sid) : undefined,
    roundTrip: result._tag === "Success" ? JSON.stringify(result.success) : undefined,
    message:
      result._tag === "Failure"
        ? (result.failure as { message?: string }).message?.slice(0, 400)
        : undefined,
  };
});

// ---------------------------------------------------------------------------
// The scope table.
// ---------------------------------------------------------------------------

const scopeEntries = Object.entries(RPC_REQUIRED_SCOPES);

const scopes = {
  count: scopeEntries.length,
  entries: scopeEntries,
  distinct: [...new Set(scopeEntries.map(([, scope]) => scope))].sort(),
  // The lookup is total for a known method and throws for an unknown one, and the throw is a plain
  // `Error` — a defect, not a typed failure — so it escapes `Effect.catchTags` and reaches the client as
  // whatever the router does with a dying handler.
  unknownThrow: (() => {
    try {
      return `no throw: ${requiredScopeForRpcMethod("no.such.method")}`;
    } catch (error) {
      const thrown = error as Error;
      return `${thrown.constructor.name}:${thrown.message}`;
    }
  })(),
  // `Object.hasOwn` is the gate, so an inherited name is not a method.
  inheritedThrow: (() => {
    try {
      return `no throw: ${requiredScopeForRpcMethod("toString")}`;
    } catch (error) {
      return `${(error as Error).constructor.name}:${(error as Error).message}`;
    }
  })(),
  deviceList: [
    { input: {}, scope: requiredScopeForDeviceList({} as never) },
    {
      input: { retryHostId: "host-1" },
      scope: requiredScopeForDeviceList({ retryHostId: "host-1" } as never),
    },
    {
      input: { updateTool: "codex" },
      scope: requiredScopeForDeviceList({ updateTool: "codex" } as never),
    },
    {
      input: { retryHostId: "", updateTool: "" },
      scope: requiredScopeForDeviceList({ retryHostId: "", updateTool: "" } as never),
    },
  ],
  authorizationError: JSON.stringify(
    new EnvironmentAuthorizationError({
      message: "The authenticated token is missing required scope: orchestration:read.",
      requiredScope: "orchestration:read",
    }),
  ),
};

// ---------------------------------------------------------------------------
// The refusal, over a socket.
//
// The route below replicates `EnvironmentAuth.authenticateWebSocketUpgrade`'s predicate
// (`EnvironmentAuth.ts:1075-1095`) and `ws.ts:3811-3821`'s two `catchIf` branches, and then hands the
// failure to the same `Effect.catchTags({…: HttpServerRespondable.toResponse})` the real route ends with.
// The predicate and the reason mapping are therefore read off the source; **the bytes are the
// measurement**, including which headers Node adds and whether the connection outlives the answer.
// ---------------------------------------------------------------------------

type Branch = {
  readonly url: string;
  readonly ticket: string | null;
  readonly usesTicket: boolean;
};

const branches: Array<Branch> = [];

const REFUSALS: Record<string, () => Effect.Effect<never, never>> = {
  missing: () => failEnvironmentAuthInvalid("missing_credential") as never,
  invalid: () => failEnvironmentAuthInvalid("invalid_credential") as never,
  dpop: () => failEnvironmentAuthInvalid("invalid_credential", "invalid_proof") as never,
  internal: () => failEnvironmentInternal("internal_error") as never,
};

/**
 * The tail `ws.ts:3872-3877` puts on the route. The router does not turn a typed error into a response
 * by itself, which is why every refusal site ends with these two lines — mounting the failing effect
 * without them would measure the router's default answer instead of the app's.
 */
const responded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  );

const wsRoute = responded(
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const ticket = Option.isSome(url) ? url.value.searchParams.get("wsTicket") : null;
    const usesTicket = ticket !== null && ticket !== undefined && ticket.trim().length > 0;
    branches.push({ url: request.originalUrl, ticket, usesTicket });
    // A ticket that was presented and did not verify is `invalid_credential`; one that was never
    // presented is `missing_credential`, which is the only difference the client sees.
    return yield* (usesTicket ? REFUSALS.invalid : REFUSALS.missing)();
  }),
);

const serverLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    yield* router.add("GET", "/ws", wsRoute);
    for (const [name, failure] of Object.entries(REFUSALS)) {
      yield* router.add("GET", `/refuse/${name}`, responded(failure()));
    }
    // `Effect.currentParentSpan` is where the body's `traceId` comes from, and with no span it is the
    // literal `"unavailable"`; the spanned route shows what the field becomes when tracing is on.
    yield* router.add(
      "GET",
      "/refuse/span",
      responded(REFUSALS.invalid().pipe(Effect.withSpan("auth-golden.refusal"))),
    );
  }),
);

const appLayer = HttpRouter.serve(serverLayer, {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provideMerge(
    NodeHttpServer.layer(() => NodeHttp.createServer(), {
      host: "127.0.0.1",
      port: 0,
      // The app's own websocket option (`apps/server/src/server.ts:234-250`), so a refused upgrade is
      // refused by a server that *could* have answered one.
      websocket: { perMessageDeflate: true },
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

// ---------------------------------------------------------------------------
// Raw socket reading. A response is complete when its `content-length` bytes have arrived, or when its
// chunked encoding says so, so nothing here waits on a timer.
// ---------------------------------------------------------------------------

type Head = {
  readonly statusLine: string;
  readonly headers: Array<[string, string]>;
};

const parseHead = (text: string): Head => {
  const lines = text.split("\r\n").filter((line) => line !== "");
  return {
    statusLine: lines[0] ?? "",
    headers: lines.slice(1).map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at), line.slice(at + 1).trim()] as [string, string];
    }),
  };
};

const reader = (socket: net.Socket) => {
  let buffer = Buffer.alloc(0);
  let ended = false;
  let endDetail = "open";
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
  });
  socket.on("end", () => {
    ended = true;
    endDetail = "fin";
  });
  socket.on("close", () => {
    if (!ended) endDetail = "closed";
    ended = true;
  });
  socket.on("error", (error: NodeJS.ErrnoException) => {
    ended = true;
    endDetail = `error ${error.code ?? error.message}`;
  });
  const take = (count: number) => {
    const got = buffer.subarray(0, count);
    buffer = buffer.subarray(got.length);
    return got;
  };
  const waitFor = (predicate: () => boolean, ms: number) =>
    new Promise<void>((done) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (predicate() || Date.now() - started > ms) {
          clearInterval(timer);
          done();
        }
      }, 1);
    });
  return {
    get ended() {
      return ended;
    },
    get endDetail() {
      return endDetail;
    },
    get leftover() {
      return buffer.length;
    },
    /** One response: head, then exactly the body the head promises. */
    readResponse: async (deadlineMs = 2000) => {
      await waitFor(() => buffer.includes("\r\n\r\n") || ended, deadlineMs);
      const at = buffer.indexOf("\r\n\r\n");
      const headText = take(at === -1 ? buffer.length : at + 4);
      const head = parseHead(headText.toString("latin1"));
      const value = (name: string) => head.headers.find(([key]) => key.toLowerCase() === name)?.[1];
      let body = Buffer.alloc(0);
      if (value("transfer-encoding")?.toLowerCase().includes("chunked")) {
        // Chunked bodies are recorded as the framing, not as the payload: the framing is the claim.
        const chunks: Array<string> = [];
        for (;;) {
          await waitFor(() => buffer.includes("\r\n") || ended, deadlineMs);
          const lineEnd = buffer.indexOf("\r\n");
          if (lineEnd === -1) break;
          const sizeText = take(lineEnd + 2)
            .toString("latin1")
            .trim();
          const size = Number.parseInt(sizeText, 16);
          if (Number.isNaN(size)) {
            chunks.push(sizeText);
            break;
          }
          chunks.push(sizeText);
          if (size === 0) {
            await waitFor(() => buffer.length >= 2 || ended, deadlineMs);
            chunks.push(take(buffer.length).toString("latin1"));
            break;
          }
          await waitFor(() => buffer.length >= size + 2 || ended, deadlineMs);
          body = Buffer.concat([body, take(size)]);
          take(2);
        }
        return { head, body: body.toString("utf8"), chunks };
      }
      const declared = Number.parseInt(value("content-length") ?? "", 10);
      if (!Number.isNaN(declared)) {
        await waitFor(() => buffer.length >= declared || ended, deadlineMs);
        body = take(declared);
      }
      return { head, body: body.toString("utf8") };
    },
  };
};

const connect = async (port: number) => {
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
    write: (data: string) =>
      new Promise<string | undefined>((resolve) =>
        // A write onto a socket the peer already finished is itself a measurement, so it is recorded
        // rather than thrown.
        socket.write(data, (error) => resolve(error ? (error.code ?? error.message) : undefined)),
      ),
  };
};

const UPGRADE_LINES = [
  "Upgrade: websocket",
  "Connection: Upgrade",
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version: 13",
];

/**
 * `Connection: Upgrade` is what the whole difference turns on. A browser sends it on the upgrade, and a
 * server that refuses has to decide whether the connection survives the refusal — which is why the same
 * route is asked twice with it and twice without it.
 */
const PLAIN_LINES = ["Connection: keep-alive"];

const requestTo = (path: string, extra: Array<string> = [], method = "GET", upgrade = true) =>
  [
    `${method} ${path} HTTP/1.1`,
    "Host: 127.0.0.1",
    ...(upgrade ? UPGRADE_LINES : PLAIN_LINES),
    ...extra,
    "",
    "",
  ].join("\r\n");

const DATE = /^Date: .+$/im;
const TRACE = /"traceId":"[0-9a-f]{32}"/;
const masked = (head: Head) =>
  head.headers.map(([name, value]) => [name, name.toLowerCase() === "date" ? "__DATE__" : value]);

type Refusal = {
  readonly case: string;
  readonly request: string;
  readonly statusLine: string;
  readonly headers: Array<[string, string]>;
  readonly body: string;
  readonly traceShape: string;
  readonly tcp: string;
  readonly branch: Branch | undefined;
  readonly chunks?: Array<string>;
};

const refusals: Array<Refusal> = [];

/**
 * The raw `traceId` per case, kept out of the artifact: it is a random hex id, and a golden that changes
 * between runs proves nothing. What is pinned is its **shape** and the literal `"unavailable"`.
 */
const traces: Record<string, string> = {};

/**
 * A `traceId` is a random hex id, so the artifact holds its **shape** and never the id: a golden whose
 * body changed between runs would pin nothing, and the shape is the part a port has to reproduce —
 * `"unavailable"` when no span is open, 32 hex characters when one is.
 */
const traceShapes: Record<string, string> = {};
const shapeOfTrace = (traceId: string) =>
  traceId === ""
    ? "absent"
    : traceId === "unavailable"
      ? "unavailable"
      : /^[0-9a-f]{32}$/.test(traceId)
        ? "hex32"
        : `other:${traceId}`;

const ask = async (
  port: number,
  name: string,
  path: string,
  options: {
    extra?: Array<string>;
    method?: string;
    upgrade?: boolean;
    reuse?: Awaited<ReturnType<typeof connect>>;
  } = {},
) => {
  const request = requestTo(path, options.extra, options.method, options.upgrade ?? true);
  const own = options.reuse ? undefined : await connect(port);
  const probe = own ?? options.reuse!;
  if (process.env.LMCS_AUTH_GOLDEN_DEBUG) process.stderr.write(`case ${name}\n`);
  const branchBefore = branches.length;
  const writeError = await probe.write(request);
  const answer = await probe.r.readResponse();
  traces[name] = answer.body.match(/"traceId":"([^"]+)"/)?.[1] ?? "";
  traceShapes[name] = shapeOfTrace(traces[name]);
  if (writeError !== undefined) {
    refusals.push({
      case: name,
      request,
      statusLine: `write error ${writeError}`,
      headers: [],
      body: "",
      traceShape: traceShapes[name]!,
      tcp: probe.r.endDetail,
      branch: branches.length > branchBefore ? branches[branches.length - 1] : undefined,
    });
    return { probe, answer };
  }
  const tcp = answer.chunks
    ? `chunked ${JSON.stringify(answer.chunks)}`
    : probe.r.leftover > 0
      ? `${probe.r.endDetail}+${probe.r.leftover}leftover`
      : probe.r.endDetail;
  refusals.push({
    case: name,
    request,
    statusLine: answer.head.statusLine.replace(DATE, ""),
    headers: masked(answer.head) as Array<[string, string]>,
    body: answer.body.replace(DATE, "__DATE__").replace(TRACE, '"traceId":"__TRACE__"'),
    traceShape: traceShapes[name]!,
    tcp,
    branch: branches.length > branchBefore ? branches[branches.length - 1] : undefined,
    ...(answer.chunks ? { chunks: answer.chunks } : {}),
  });
  return { probe, answer };
};

/** Ask once, on a socket this function then closes, and record what came back. */
const askOnce = async (
  port: number,
  name: string,
  path: string,
  options: { extra?: Array<string>; method?: string; upgrade?: boolean } = {},
) => {
  const { probe } = await ask(port, name, path, options);
  probe.socket.destroy();
  return probe;
};

const runCases = async (port: number) => {
  // 1. A well-formed upgrade with no credential: the refusal has to pre-empt the handshake entirely.
  await askOnce(port, "noTicket", "/ws?orchestrationProtocol=1");
  // 2. The empty and whitespace tickets, which `trim().length > 0` sends down the *no-ticket* path.
  await askOnce(port, "emptyTicket", "/ws?wsTicket=");
  await askOnce(port, "spaceTicket", "/ws?wsTicket=%20");
  await askOnce(port, "plusTicket", "/ws?wsTicket=+");
  // 3. A ticket that is present and does not verify.
  await askOnce(port, "garbageTicket", "/ws?wsTicket=not-a-ticket");
  await askOnce(
    port,
    "mintedButWrongSecret",
    `/ws?wsTicket=${encodeURIComponent(tickets[0].token)}`,
  );
  await askOnce(port, "unsigned", "/ws?wsTicket=aGVsbG8.bm9wZQ");
  const dotted = tickets.find((ticket) => ticket.name === "sidWithDot")!;
  await askOnce(port, "threeParts", `/ws?wsTicket=${encodeURIComponent(dotted.token)}`);
  await askOnce(port, "dotOnly", "/ws?wsTicket=.");
  // 4. Query parsing itself, since the port has to reproduce `URLSearchParams` on these.
  await askOnce(port, "repeatedTicket", "/ws?wsTicket=first&wsTicket=second");
  await askOnce(port, "encodedTicket", "/ws?wsTicket=a%2Bb%2Fc%3D%3D");
  await askOnce(port, "noQuery", "/ws");
  // 5. Each refusal shape the route can produce, written by the real handlers.
  for (const name of ["missing", "invalid", "dpop", "internal"]) {
    await askOnce(port, `refuse-${name}`, `/refuse/${name}`);
  }
  await askOnce(port, "refuse-span", "/refuse/span");
  // 6. Does the connection outlive a refusal? Asked twice on one socket, which is the proof rather than
  //    a timer: a server that FINs cannot answer the second one, and the write says so.
  const reused = await connect(port);
  await ask(port, "upgradeRefusal-first", "/refuse/missing", { reuse: reused });
  await ask(port, "upgradeRefusal-second", "/refuse/invalid", { reuse: reused });
  reused.socket.destroy();
  //    The same route, refused on a request that never asked to be upgraded: `Connection: Upgrade` is
  //    the only difference, and it is the difference that closes the socket.
  const plain = await connect(port);
  await ask(port, "plainRefusal-first", "/refuse/missing", { reuse: plain, upgrade: false });
  await ask(port, "plainRefusal-second", "/refuse/invalid", { reuse: plain, upgrade: false });
  plain.socket.destroy();
  await askOnce(port, "plain401", "/ws", { upgrade: false });
  // 7. A method the route does not have, to show a refusal is not the only answer the path can give.
  await askOnce(port, "postRefusal", "/refuse/missing", { method: "POST" });
};

const summary = () => ({
  secretBytes: SECRET.length,
  tickets: tickets.length,
  splits: splits.length,
  queries: queries.length,
  decodes: decodes.length,
  payloads: payloads.length,
  timing: timing.length,
  scopeEntries: scopeEntries.length,
  refusals: refusals.length,
  branches: branches.length,
});

const emit = (json: string) => writeSync(1, `${json}\n`);

const recordTable = () => {
  for (const line of [
    ...tickets.map(
      (ticket) => `ticket ${ticket.name} ${ticket.json} ${ticket.payload} ${ticket.token}`,
    ),
    ...decodes.map(
      (decode) =>
        `decode ${decode.input} ${decode.decode} ${decode.bytes ?? decode.message ?? decode.utf8.thrown}`,
    ),
    ...timing.map(
      (pair) => `timing ${JSON.stringify(pair.left)} ${JSON.stringify(pair.right)} ${pair.equal}`,
    ),
    ...queries.map(
      (query) =>
        `query ${JSON.stringify(query.url)} -> ${JSON.stringify(query.ticket)} uses=${query.uses} path=${query.path} search=${JSON.stringify(query.search)}`,
    ),
    ...payloads.map(
      (payload) =>
        `payload ${payload.decode} ${JSON.stringify(payload.json)} -> ${payload.sid ?? payload.roundTrip ?? (payload.message ?? "").replace(/\s+/g, " ").slice(0, 140)}`,
    ),
    ...refusals.map((refusal) =>
      [
        `refusal ${refusal.case}`,
        `status ${refusal.statusLine}`,
        `headers ${JSON.stringify(refusal.headers)}`,
        `body ${refusal.body}`,
        `trace ${refusal.traceShape}`,
        `tcp ${refusal.tcp}`,
        `branch ${JSON.stringify(refusal.branch ?? null)}`,
      ].join(" | "),
    ),
    `scopes count ${scopes.count} distinct ${JSON.stringify(scopes.distinct)}`,
    `scopes unknown ${scopes.unknownThrow}`,
    `scopes inherited ${scopes.inheritedThrow}`,
    `scopes deviceList ${JSON.stringify(scopes.deviceList)}`,
    `scopes authorizationError ${scopes.authorizationError}`,
  ]) {
    process.stderr.write(`${line}\n`);
  }
};

const check = (): Array<string> => {
  const out: Array<string> = [];
  const expect = (name: string, got: unknown, want: unknown) => {
    const text = JSON.stringify(got);
    if (text !== JSON.stringify(want))
      out.push(`${name}: got ${text}, want ${JSON.stringify(want)}`);
  };

  // The mint: unpadded URL-safe base64 of the claims, then `.` then an unpadded URL-safe HMAC-SHA256.
  expect(
    "ticket canonical json",
    tickets[0].json,
    `{"v":1,"kind":"websocket","sid":"sess_01","iat":${IAT},"exp":${EXP}}`,
  );
  // The whole token, fixed secret and fixed clock: this is the string the Rust mint has to reproduce.
  expect(
    "ticket canonical token",
    tickets[0].token,
    "eyJ2IjoxLCJraW5kIjoid2Vic29ja2V0Iiwic2lkIjoic2Vzc18wMSIsImlhdCI6MTcwMDAwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMzAwMDAwfQ" +
      ".wBgssj3CaQy1i5gO4FwpM7bPH0DOeWeB1uWly71YeCY",
  );
  // Payload and signature are URL-safe and unpadded, from `Encoding.encodeBase64Url` and from Node's
  // `digest("base64url")` respectively — two different code paths that had to agree.
  expect(
    "ticket mint alphabet",
    tickets.every((t) => !/[=+/]/.test(t.payload + t.signature)),
    true,
  );
  expect(
    "ticket canonical unpadded",
    /[=+/]/.test(tickets[0].payload + tickets[0].signature),
    false,
  );
  // A `.` inside the sid cannot forge a third part, because the part it is in is base64url and never
  // contains one: the token still splits in two.
  expect(
    "ticket sidWithDot parts",
    tickets.find((t) => t.name === "sidWithDot")!.token.split(".").length,
    2,
  );
  expect(
    "ticket -0 writes 0",
    tickets.find((t) => t.name === "zeroTimes")!.json.includes("-0"),
    false,
  );
  expect(
    "ticket MAX_SAFE_INTEGER stays integer",
    tickets
      .find((t) => t.name === "maxSafeTimes")!
      .json.includes('"iat":9007199254740991,"exp":9007199254740992'),
    true,
  );
  // `sidUnreserved` is the case that shows the mint escapes a `/` and a `+` in the value it is given:
  // the alphabet applies to the encoding, not to the input.
  expect(
    "ticket sid with unreserved chars",
    tickets.find((t) => t.name === "sidUnreserved")!.json.includes("/"),
    true,
  );
  expect(
    "ticket sid encodes to url-safe",
    /[=+/]/.test(tickets.find((t) => t.name === "sidUnreserved")!.payload),
    false,
  );

  expect("split empty", splits[0].parts, [""]);
  expect("split a.b.c", splits.find((s) => s.input === "a.b.c")!.parts, ["a", "b", "c"]);
  expect("split trailing dot", splits.find((s) => s.input === "a.")!.parts, ["a", ""]);
  expect("split double dot", splits.find((s) => s.input === "a..b")!.parts, ["a", "", "b"]);

  const query = (url: string) => queries.find((row) => row.url === url)!;
  // `get` returns the first value, and a key with no `=` is the empty string rather than absent — which,
  // combined with `trim().length > 0`, makes `?wsTicket` behave exactly like no ticket at all.
  expect("query repeated takes the first", query("/ws?wsTicket=a&wsTicket=b").ticket, "a");
  expect("query bare key", query("/ws?wsTicket").ticket, "");
  expect("query bare key is missing", query("/ws?wsTicket").uses, false);
  expect("query empty value is missing", query("/ws?wsTicket=").uses, false);
  expect("query plus is a space", query("/ws?wsTicket=+").ticket, " ");
  expect("query space is missing", query("/ws?wsTicket=%20").uses, false);
  expect("query space inside", query("/ws?wsTicket=a+b").ticket, "a b");
  expect("query percent escape", query("/ws?wsTicket=a%20b").ticket, "a b");
  expect("query invalid escape survives", query("/ws?wsTicket=%zz").ticket, "%zz");
  expect("query literal percent", query("/ws?wsTicket=%25").ticket, "%");
  expect("query escaped separator", query("/ws?wsTicket=a%26b").ticket, "a&b");
  expect("query equals inside value", query("/ws?wsTicket=a=b").ticket, "a=b");
  expect("query key is case sensitive", query("/ws?WSTICKET=a&wsTicket=b").ticket, "b");
  expect("query semicolon is not a separator", query("/ws?;wsTicket=x&wsTicket=y").ticket, "y");
  expect("query utf8", query("/ws?wsTicket=%C3%A9").ticket, "é");
  expect("query fragment is dropped", query("/ws?wsTicket=a#frag").search, "?wsTicket=a");
  expect("query absent", query("/ws").ticket, null);
  expect("query empty", query("/ws?").ticket, null);
  expect("query after hash never arrives", query("/ws##?wsTicket=x").ticket, null);

  const decode = (input: string) => decodes.find((d) => d.input === JSON.stringify(input))!;
  expect("decode unpadded ok", decode("SGVsbG8").utf8, { ok: true, value: "Hello" });
  expect("decode padded ok", decode("SGVsbG8=").utf8, { ok: true, value: "Hello" });
  // Two characters are one byte and three are two: the tail bits are dropped, not an error.
  expect("decode two chars one byte", decode("ab").bytes, "69");
  expect("decode three chars two bytes", decode("abc").bytes, "69b7");
  expect("decode 1 mod 4 fails", decode("a").decode, "Failure");
  expect(
    "decode 1 mod 4 message",
    decode("a").message,
    "Length should be a multiple of 4, but is 1",
  );
  expect(
    "decode over-padding fails",
    decode("aGVsbG8==").message,
    "Length should be a multiple of 4, but is 9",
  );
  expect("decode crlf tolerated", decode("aGVs\r\nbG8=").utf8, { ok: true, value: "hello" });
  expect("decode lf tolerated", decode("aGVs\nbG8=").utf8, { ok: true, value: "hello" });
  // The alphabet is URL-safe only: `-` and `_` are in, `+` and `/` are out, and nothing is repaired.
  expect("decode hyphen ok", decode("aGVs-G8=").bytes, "68656cf86f");
  expect("decode plus fails", decode("aGVs+G8=").message, "Invalid input");
  // Padding is optional but a length that is a whole multiple of 4 is decoded fully, so the same five
  // letters arrive as six bytes: the 8th character carries a real bit and `_` makes it `?`.
  expect("decode eighth char adds a byte", decode("SGVsbG8_").bytes, "48656c6c6f3f");
  expect("decode bang fails", decode("!!!!").decode, "Failure");
  // The two `=` messages are not the same rule: the shape check rejects an `=` anywhere but the tail, and
  // the padding *repair* then makes a short input put one in the middle, which is the only way a
  // `Base64Url` decode reaches `Base64`'s message.
  expect("decode equals in middle", decode("A=BC").message, "Invalid input");
  expect(
    "decode single char padding",
    decode("a=").message,
    "Found a '=' character, but it is not at the end",
  );
  expect(
    "decode two char padding",
    decode("A==").message,
    "Found a '=' character, but it is not at the end",
  );
  expect("decode non-ascii fails", decode("ÿÿ").decode, "Failure");
  expect("decode empty ok", decode("").utf8, { ok: true, value: "" });

  const payload = (json: string) => payloads.find((row) => row.json === json)!;
  expect("payload canonical decodes", payload(tickets[0].json).sid, JSON.stringify("sess_01"));
  expect(
    "payload kind is a literal",
    payload('{"v":1,"kind":"session","sid":"s","iat":1,"exp":2}').message,
    'Expected "websocket"\n  at ["kind"]',
  );
  expect(
    "payload v is a literal",
    payload('{"v":"1","kind":"websocket","sid":"s","iat":1,"exp":2}').message,
    'Expected 1\n  at ["v"]',
  );
  expect(
    "payload 1.0 is one",
    payload('{"v":1.0,"kind":"websocket","sid":"s","iat":1,"exp":2}').decode,
    "Success",
  );
  expect(
    "payload missing key",
    payload('{"kind":"websocket","sid":"s","iat":1,"exp":2}').message,
    'Missing key\n  at ["v"]',
  );
  expect(
    "payload missing sid",
    payload('{"v":1,"kind":"websocket","iat":1,"exp":2}').message,
    'Missing key\n  at ["sid"]',
  );
  // `sid` is `TrimmedNonEmptyString`, so the trim happens **before** the length check: whitespace is not
  // a short id, it is no id, and a token can carry a `sid` the server then looks up differently.
  expect(
    "payload blank sid is empty sid",
    payload('{"v":1,"kind":"websocket","sid":"  ","iat":1,"exp":2}').message,
    'Expected a value with a length of at least 1\n  at ["sid"]',
  );
  expect(
    "payload empty sid",
    payload('{"v":1,"kind":"websocket","sid":"","iat":1,"exp":2}').message,
    'Expected a value with a length of at least 1\n  at ["sid"]',
  );
  expect(
    "payload sid is trimmed",
    payload('{"v":1,"kind":"websocket","sid":" a ","iat":1,"exp":2}').sid,
    JSON.stringify("a"),
  );
  expect(
    "payload sid trims unicode space",
    payload('{"v":1,"kind":"websocket","sid":"\\u00e9 ","iat":1,"exp":2}').sid,
    JSON.stringify("é"),
  );
  expect(
    "payload sid must be a string",
    payload('{"v":1,"kind":"websocket","sid":7,"iat":1,"exp":2}').message,
    'Expected string\n  at ["sid"]',
  );
  expect(
    "payload iat must be a number",
    payload('{"v":1,"kind":"websocket","sid":"s","iat":"1","exp":2}').message,
    'Expected number\n  at ["iat"]',
  );
  // An unknown key is dropped rather than refused, so the decoded object is exactly the five fields.
  expect(
    "payload drops unknown key",
    payload('{"v":1,"kind":"websocket","sid":"s","iat":1,"exp":2,"extra":true}').roundTrip,
    '{"v":1,"kind":"websocket","sid":"s","iat":1,"exp":2}',
  );
  expect(
    "payload duplicate key takes the last",
    payload('{"v":1,"kind":"websocket","sid":"a","sid":"b","iat":1,"exp":2}').sid,
    JSON.stringify("b"),
  );
  expect(
    "payload key order is free",
    payload('{"sid":"s","exp":2,"kind":"websocket","v":1,"iat":1}').roundTrip,
    '{"v":1,"kind":"websocket","sid":"s","iat":1,"exp":2}',
  );
  // `1e999` is `Infinity` to `JSON.parse` and **decodes**: the finite check is not the schema's, it is
  // `DateTime.make`'s, which is the line the port must not skip. `JSON.stringify` writes it as `null`.
  expect(
    "payload infinite exp decodes",
    payload('{"v":1,"kind":"websocket","sid":"s","iat":1,"exp":1e999}').roundTrip,
    '{"v":1,"kind":"websocket","sid":"s","iat":1,"exp":null}',
  );
  expect(
    "payload fractional exp decodes",
    payload('{"v":1,"kind":"websocket","sid":"s","iat":1,"exp":1.5}').decode,
    "Success",
  );
  expect(
    "payload negative zero exp is zero",
    payload('{"v":1,"kind":"websocket","sid":"s","iat":1,"exp":-0}').roundTrip,
    '{"v":1,"kind":"websocket","sid":"s","iat":1,"exp":0}',
  );
  expect("payload not json", payload("not json").message, "Expected a valid JSON string");
  expect("payload array is not an object", payload("[]").message, "Expected object");
  expect("payload null is not an object", payload("null").message, "Expected object");
  expect("payload string is not an object", payload('"aGVsbG8"').message, "Expected object");
  expect("payload number is not an object", payload("123").message, "Expected object");
  expect("payload empty object", payload("{}").message, 'Missing key\n  at ["v"]');
  // `String.prototype.trim` is not Unicode `White_Space`, which is the difference between a `sid` that
  // exists and one that is refused: U+0085 and the C0 separators survive, and NBSP, U+2028/29 and the
  // BOM do not. `str::trim` in a port gets four of these five wrong.
  expect(
    "payload NEL survives trim",
    payload('{"v":1,"kind":"websocket","sid":"\\u0085a","iat":1,"exp":2}').sid,
    JSON.stringify("\u0085a"),
  );
  expect(
    "payload C0 separator survives trim",
    payload('{"v":1,"kind":"websocket","sid":"\\u001fa","iat":1,"exp":2}').sid,
    JSON.stringify("\u001fa"),
  );
  expect(
    "payload nbsp trims away",
    payload('{"v":1,"kind":"websocket","sid":"\\u00a0","iat":1,"exp":2}').decode,
    "Failure",
  );
  expect(
    "payload line separator trims",
    payload('{"v":1,"kind":"websocket","sid":"\\u2028a\\u2029","iat":1,"exp":2}').sid,
    JSON.stringify("a"),
  );
  expect(
    "payload bom trims away",
    payload('{"v":1,"kind":"websocket","sid":"\\ufeff","iat":1,"exp":2}').decode,
    "Failure",
  );
  expect("payload accepted count", payloads.filter((row) => row.decode === "Success").length, 13);

  expect("timing equal", timing[0].equal, true);
  // The last character of a 43-character base64url HMAC carries bits that do not exist in the 32-byte
  // digest, so two *different* signatures compare equal. A port that compares strings would report a
  // mismatch where the server reports none.
  expect("timing trailing bits ignored", timing[1].equal, true);
  expect("timing padded equals unpadded", timing[2].equal, true);
  expect("timing space decodes short", timing[3].equal, false);
  expect("timing both empty", timing[4].equal, true);
  expect("timing length differs", timing[5].equal, false);
  // `Buffer.from("!!!!", "base64url")` is not an error, it is zero bytes.
  expect("timing garbage equals empty", timing[6].equal, true);

  expect("scope count", scopes.count, 147);
  expect("scope first", scopes.entries[0], [
    "orchestration.dispatchCommand",
    "orchestration:operate",
  ]);
  expect("scope distinct", scopes.distinct, [
    "access:read",
    "orchestration:operate",
    "orchestration:read",
    "relay:read",
    "relay:write",
    "review:write",
    "terminal:operate",
  ]);
  expect(
    "scope unknown throws",
    scopes.unknownThrow,
    "Error:RPC method no.such.method has no declared authorization scope.",
  );
  expect(
    "scope inherited throws",
    scopes.inheritedThrow,
    "Error:RPC method toString has no declared authorization scope.",
  );
  expect(
    "scope deviceList",
    scopes.deviceList.map((row) => row.scope),
    ["orchestration:read", "orchestration:operate", "orchestration:operate", "orchestration:read"],
  );
  expect(
    "authorization error json",
    scopes.authorizationError,
    '{"_tag":"EnvironmentAuthorizationError","message":"The authenticated token is missing required scope: orchestration:read.","requiredScope":"orchestration:read"}',
  );

  const refusal = (name: string) => refusals.find((row) => row.case === name)!;
  for (const name of [
    "noTicket",
    "emptyTicket",
    "spaceTicket",
    "plusTicket",
    "garbageTicket",
    "mintedButWrongSecret",
    "unsigned",
    "threeParts",
    "dotOnly",
    "repeatedTicket",
    "encodedTicket",
    "noQuery",
    "refuse-missing",
    "refuse-invalid",
    "refuse-dpop",
    "refuse-internal",
    "refuse-span",
    "upgradeRefusal-first",
    "upgradeRefusal-second",
    "plainRefusal-first",
    "plainRefusal-second",
    "plain401",
    "postRefusal",
  ]) {
    if (refusal(name) === undefined) out.push(`missing refusal ${name}`);
  }
  // The refusal is HTTP, never a handshake: no `101`, no `Sec-WebSocket-Accept`, no close frame.
  for (const row of refusals) {
    if (row.statusLine.includes("101")) out.push(`${row.case}: got a handshake, want a refusal`);
    if (row.headers.some(([name]) => name.toLowerCase() === "sec-websocket-accept"))
      out.push(`${row.case}: answered Sec-WebSocket-Accept`);
    if (row.headers.some(([name]) => name.toLowerCase() === "www-authenticate"))
      out.push(`${row.case}: answered WWW-Authenticate, which only the DPoP routes do`);
  }
  expect("noTicket status", refusal("noTicket").statusLine, "HTTP/1.1 401 Unauthorized");
  expect("noTicket headers", refusal("noTicket").headers, [
    ["content-type", "application/json"],
    ["content-length", "114"],
    ["Date", "__DATE__"],
    ["Connection", "keep-alive"],
  ]);
  expect(
    "noTicket body",
    refusal("noTicket").body,
    '{"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"missing_credential","traceId":"unavailable"}',
  );
  expect(
    "internal body",
    refusal("refuse-internal").body,
    '{"_tag":"EnvironmentInternalError","code":"internal_error","reason":"internal_error","traceId":"unavailable"}',
  );
  expect(
    "internal status",
    refusal("refuse-internal").statusLine,
    "HTTP/1.1 500 Internal Server Error",
  );
  expect("internal length", refusal("refuse-internal").headers[1], ["content-length", "109"]);
  expect(
    "dpop field order",
    refusal("refuse-dpop").body,
    '{"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"invalid_credential","dpopFailureReason":"invalid_proof","traceId":"unavailable"}',
  );
  expect("dpop length", refusal("refuse-dpop").headers[1], ["content-length", "150"]);
  expect("body length matches", refusal("refuse-dpop").body.length, 150);
  expect("unrouted method", refusal("postRefusal").statusLine, "HTTP/1.1 404 Not Found");
  // Which branch the route took, which is the only thing a client can infer from the reason.
  expect("empty ticket branch", refusal("emptyTicket").branch, {
    url: "/ws?wsTicket=",
    ticket: "",
    usesTicket: false,
  });
  expect("space ticket branch", refusal("spaceTicket").branch, {
    url: "/ws?wsTicket=%20",
    ticket: " ",
    usesTicket: false,
  });
  // A `+` in a query is a space to `URLSearchParams`, so a ticket containing one is not the ticket that
  // was sent — which is why the mint never emits one and a port must not either.
  expect("plus ticket branch", refusal("plusTicket").branch, {
    url: "/ws?wsTicket=+",
    ticket: " ",
    usesTicket: false,
  });
  expect("garbage ticket branch", refusal("garbageTicket").branch!.usesTicket, true);
  expect("repeated ticket value", refusal("repeatedTicket").branch!.ticket, "first");
  expect("encoded ticket value", refusal("encodedTicket").branch!.ticket, "a+b/c==");
  expect("no query ticket", refusal("noQuery").branch, {
    url: "/ws",
    ticket: null,
    usesTicket: false,
  });
  expect("dot only ticket branch", refusal("dotOnly").branch!.usesTicket, true);
  expect("three parts status", refusal("threeParts").statusLine, "HTTP/1.1 401 Unauthorized");
  // **A refused upgrade is the only refusal that ends the connection.** The response says
  // `Connection: keep-alive` and Node FINs anyway, because the request asked for an upgrade; a refusal
  // on a plain request keeps the socket and adds the `Keep-Alive` Node stamps on its own connections.
  expect("refused upgrade closes", refusal("upgradeRefusal-first").tcp, "fin");
  expect(
    "refused upgrade answers twice",
    refusal("upgradeRefusal-second").statusLine,
    "write error EPIPE",
  );
  expect("refused plain keeps alive", refusal("plainRefusal-first").tcp, "open");
  expect(
    "refused plain answers twice",
    refusal("plainRefusal-second").body.includes("invalid_credential"),
    true,
  );
  expect("plain refusal headers", refusal("plain401").headers, [
    ["content-type", "application/json"],
    ["content-length", "114"],
    ["Date", "__DATE__"],
    ["Connection", "keep-alive"],
    ["Keep-Alive", "timeout=5"],
  ]);
  expect("upgrade refusal has no Keep-Alive", refusal("noTicket").headers.length, 4);
  // With a span, `traceId` is the 32-hex trace; without one it is the literal `"unavailable"`, which is
  // what every refusal above carries because the capture runs with tracing off. The id itself is random,
  // so only its shape is comparable — and the shape is what decides a byte-exact `content-length`.
  expect("spanned traceId shape", traceShapes["refuse-span"], "hex32");
  expect("unspanned traceId shape", traceShapes["refuse-invalid"], "unavailable");
  expect("unrouted traceId shape", traceShapes["postRefusal"], "absent");
  expect(
    "only the spanned body escapes the pinned length",
    refusals.filter((row) => row.traceShape === "hex32").map((row) => row.case),
    ["refuse-span"],
  );
  return out;
};

const run = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const address = server.address;
  if (typeof address === "string" || !("port" in address)) {
    throw new Error(`expected a TCP address, got ${JSON.stringify(address)}`);
  }
  yield* Effect.promise(() => runCases(address.port));
  const counted = summary();
  if (process.env.LMCS_AUTH_GOLDEN_RECORD) {
    recordTable();
    emit(
      JSON.stringify(
        { summary: counted, tickets, splits, queries, decodes, payloads, timing, scopes, refusals },
        undefined,
        2,
      ),
    );
    return;
  }
  const violations = check();
  emit(
    JSON.stringify(
      { summary: counted, tickets, splits, queries, decodes, payloads, timing, scopes, refusals },
      undefined,
      2,
    ),
  );
  for (const violation of violations) process.stderr.write(`violation: ${violation}\n`);
  if (violations.length > 0) {
    recordTable();
    process.exitCode = 1;
  }
}).pipe(Effect.scoped, Effect.provide(appLayer));

Effect.runPromise(run).then(
  () => process.exit(process.exitCode),
  (cause) => {
    process.stderr.write(`auth-golden failed: ${cause}\n`);
    process.exit(1);
  },
);
