// Golden generator for the **transport** half of `native/protocol`.
//
// `node apps/server/scripts/upgrade-golden.ts > ~/.cache/lmcs-port-traces/upgrade-golden.json`
//
// `protocol-golden.ts` measured what the two sides *say*: the nine envelopes, their key order, the
// refusals. It could do that with `globalThis.WebSocket`, because a browser-grade client hides the
// transport entirely. A Rust server has to implement the hidden half, and every claim about it is a
// byte claim:
//
//   - the `101` response, header for header, including whether `permessage-deflate` is negotiated and
//     with which parameters;
//   - which length encoding an answer crosses in (7-bit, 16-bit, 64-bit), and whether the server
//     compresses it;
//   - **what bytes the server writes when it takes a connection down.** The other generator recorded
//     that three inputs close the connection with no protocol frame; it could not say whether that is
//     a close frame with a code or a bare TCP FIN, and `Reply::Close` has to know.
//
// So this file drives the shipped stack over a raw `node:net` socket and hand-rolls the framing, in
// both directions:
//
//   - the upgrade request is written here with the RFC 6455 example key (whose accept value is a
//     constant, so the artifact asserts `base64(sha1(key + GUID))` without computing anything) and a
//     fixed client mask key, so even the bytes this file *sends* are reproducible;
//   - every frame is recorded with its raw header bytes, FIN, RSV1, opcode, mask bit, the length field
//     it used, and the payload as text when small, as a digest when large, and for a compressed frame
//     as both what crossed and what it inflates to;
//   - a close is recorded as a frame carrying its code and reason, plus an event saying whether the
//     peer then sent FIN, because `close(1005)` and `FIN with nothing` are different servers.
//
// The rpc group is synthetic again, for the same reason as the other generator: framing is
// group-independent, and the real `WsRpcGroup` would add handlers, a database and auth failure modes
// to a measurement of the transport. Auth itself (`wsTicket`, the 401/500 shapes, scope checks) is
// **not** in this file — the route here has none, exactly like `protocol-golden.ts`.
//
// `LMCS_UPGRADE_GOLDEN_RECORD=1` skips the scenario expectations and prints what each case measured,
// which is how every number in the table below was obtained: they are measurements, not guesses.
//
// Run twice and compare with `cmp`: any byte that moves is a claim this file does not pin.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as crypto from "node:crypto";
import { writeSync } from "node:fs";
import * as net from "node:net";
import * as zlib from "node:zlib";

// ---------------------------------------------------------------------------
// The group. `size` exists so the three length encodings can be reached from one handler,
// `seenHeaders` so the upgrade headers the transport injects into every decoded `Request` are measured
// as bytes rather than read out of `RpcServer.ts:1544-1559`, and `stream` so one request answers with
// several frames of two different sizes.
// ---------------------------------------------------------------------------

const PlainRpc = Rpc.make("plain", {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
});
const SizeRpc = Rpc.make("size", {
  payload: Schema.Struct({ s: Schema.String }),
  success: Schema.Struct({ s: Schema.String }),
});
const SeenHeadersRpc = Rpc.make("seenHeaders", {
  payload: Schema.Struct({}),
  success: Schema.Struct({ pairs: Schema.Array(Schema.Tuple([Schema.String, Schema.String])) }),
});
const StreamRpc = Rpc.make("stream", {
  payload: Schema.Struct({ s: Schema.String }),
  success: Schema.Struct({ s: Schema.String }),
  stream: true,
});

const Group = RpcGroup.make(PlainRpc, SizeRpc, SeenHeadersRpc, StreamRpc);

const handlersLayer = Group.toLayer(
  Effect.succeed({
    plain: () => Effect.succeed({}),
    size: ({ s }: { readonly s: string }) => Effect.succeed({ s }),
    seenHeaders: (
      _payload: { readonly [key: string]: never },
      options: { readonly headers: { readonly [name: string]: string } },
    ) =>
      Effect.succeed({
        // `Object.entries` is the order the transport materialised, which is the claim: a Rust server
        // has to hand handlers the same pairs in the same order, or anything reading a header
        // positionally sees something else.
        pairs: Object.entries(options.headers).map(
          ([name, value]) => [name, value] as readonly [string, string],
        ),
      }),
    // Two separate chunks, the second large enough to dwarf the first, so one request answers with
    // frames of two different framings. Back-pressure itself is `protocol-golden.ts`'s measurement.
    stream: ({ s }: { readonly s: string }) =>
      Stream.make({ s: "first" }).pipe(
        Stream.concat(Effect.sleep("150 millis").pipe(Effect.as({ s }), Stream.fromEffect)),
      ),
  }),
);

const serverLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    yield* router.add("GET", "/ws", httpEffect);
    // `disableTracing: true` is what `apps/server/src/ws.ts:3840` ships with, and it is what keeps
    // trace ids out of the recorded bytes.
    yield* RpcServer.make(Group, { disableTracing: true }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.forkScoped,
    );
  }),
).pipe(Layer.provideMerge(handlersLayer), Layer.provide(RpcSerialization.layerJson));

// `websocket: { perMessageDeflate: true }` is `apps/server/src/server.ts:234-250` verbatim, so the
// handshake and the answers recorded here are the ones a production client gets. No `maxPayload`, no
// `clientTracking`, no `allowedHosts` — which is itself the claim the `limits.*` scenario tests.
const appLayer = HttpRouter.serve(serverLayer, {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provideMerge(
    NodeHttpServer.layer(() => NodeHttp.createServer(), {
      host: "127.0.0.1",
      port: 0,
      websocket: { perMessageDeflate: true },
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

// ---------------------------------------------------------------------------
// Constants of the framing this file writes
// ---------------------------------------------------------------------------

const KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const EXPECTED_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
// A fixed mask key keeps the bytes this file *sends* reproducible too.
const MASK = Buffer.from([0x11, 0x22, 0x33, 0x44]);

const OPCODES: Record<number, string> = {
  0: "continuation",
  1: "text",
  2: "binary",
  3: "reserved3",
  8: "close",
  9: "ping",
  10: "pong",
  11: "reserved11",
};

const DEFINED = "permessage-deflate; client_max_window_bits";

/** What the server writes for `plain`, at the given id: the exact bytes, to be compared with them. */
const exitOf = (id: number, value: unknown) =>
  `{"_tag":"Exit","requestId":${id},"exit":{"_tag":"Success","value":${JSON.stringify(value)}}}`;
const sha = (data: Buffer | string) =>
  crypto
    .createHash("sha256")
    .update(typeof data === "string" ? Buffer.from(data, "utf8") : data)
    .digest("hex");
const utf8 = (value: string) => Buffer.from(value, "utf8");
const repeat = (char: string, length: number) => char.repeat(length);
// `process.exit()` is called once the run is over, which truncates anything still queued on a piped
// stdout: the artifact would sometimes come out empty and sometimes whole. A synchronous write does not
// race the exit.
const emit = (json: string) => writeSync(1, `${json}\n`);

// Payloads above this are recorded as a digest: 2 MiB of `"aaaa…"` in a golden is a file nobody can
// read, and the claim about a big payload is its length encoding and its bytes, which the digest plus
// `payloadBytes` carry.
const INLINE_LIMIT = 2048;
// A compressed payload is kept as bytes while it is small enough to read, because the Rust port has to
// produce a stream the shipped client can inflate, and the sha alone cannot show *how*.
const RAW_LIMIT = 256;

/** Writes one client frame and returns the exact bytes, so they can be recorded as sent. */
const encodeFrame = (
  opcode: number,
  payload: Buffer,
  options?: {
    readonly fin?: boolean;
    readonly rsv1?: boolean;
    readonly rsv2?: boolean;
    readonly masked?: boolean;
  },
): Buffer => {
  const fin = options?.fin ?? true;
  const rsv1 = options?.rsv1 ?? false;
  const rsv2 = options?.rsv2 ?? false;
  const masked = options?.masked ?? true;
  const first = (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | (rsv2 ? 0x20 : 0) | opcode;
  const maskBit = masked ? 0x80 : 0;
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = first;
    header[1] = maskBit | payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = maskBit | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  if (!masked) return Buffer.concat([header, payload]);
  const maskedPayload = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    maskedPayload[index] = payload[index]! ^ MASK[index % 4]!;
  }
  return Buffer.concat([header, MASK, maskedPayload]);
};

/** Total bytes of the frame at the front of `bytes`, or `undefined` while its header is incomplete. */
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

const headerLength = (bytes: Buffer) => {
  const lengthBits = (bytes[1] ?? 0) & 0x7f;
  return lengthBits < 126 ? 2 : lengthBits === 126 ? 4 : 10;
};

/**
 * The plaintext of every compressed message one connection carried.
 *
 * `permessage-deflate` negotiates context takeover unless the offer says otherwise, so message *n* may
 * reference bytes from message *n-1* — inflating each payload on its own is a measurement error rather
 * than a measurement ("invalid distance too far back", which this file hit before it read the
 * extension's semantics). The payloads are therefore re-joined with the four-byte sync marker the
 * sender strips, inflated as one stream prefix by prefix, and cut apart at the cumulative lengths.
 */
const SYNC_MARKER = Buffer.from([0x00, 0x00, 0xff, 0xff]);

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

type FrameInput = {
  readonly case: string;
  readonly direction: "c2s" | "s2c";
  /** What this probe meant the frame as, so an ordered record is readable without decoding it. */
  readonly label?: string | undefined;
  readonly bytes: Buffer;
  /** What an RSV1 payload inflated to, from the connection's own deflate context. */
  readonly inflated?: { readonly bytes?: Buffer | undefined; readonly error?: string | undefined };
};

type RecordedFrame = {
  readonly case: string;
  readonly direction: "c2s" | "s2c";
  readonly label?: string | undefined;
  readonly fin: boolean;
  readonly rsv1: boolean;
  readonly opcode: number;
  readonly opcodeName: string;
  readonly masked: boolean;
  readonly headerHex: string;
  readonly lengthField: "7bit" | "16bit" | "64bit";
  readonly payloadBytes: number;
  // `| undefined` throughout: this file writes what a measurement found, so "no close code" and "no
  // payload recorded" are both real states rather than a missing key to be distinguished from a present one.
  readonly payload?: string | undefined;
  readonly payloadSha?: string | undefined;
  readonly wireHex?: string | undefined;
  readonly inflatedBytes?: number | undefined;
  readonly inflatedSha?: string | undefined;
  readonly inflated?: string | undefined;
  readonly inflateError?: string | undefined;
  readonly closeCode?: number | undefined;
  readonly closeReason?: string | undefined;
  readonly closeHex?: string | undefined;
};

type RecordedEvent = {
  readonly case: string;
  readonly event: "upgrade" | "response" | "peer" | "probe" | "tail" | "write" | "observe";
  readonly statusLine?: string | undefined;
  readonly headers?: Array<[string, string]> | undefined;
  readonly body?: string | undefined;
  readonly detail?: string | undefined;
};

const frames: Array<RecordedFrame> = [];
const events: Array<RecordedEvent> = [];

const describeFrame = (input: FrameInput): RecordedFrame => {
  const { bytes, case: name, direction, label } = input;
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const lengthBits = second & 0x7f;
  const masked = (second & 0x80) !== 0;
  const opcode = first & 0x0f;
  const head = headerLength(bytes) + (masked ? 4 : 0);
  const base = {
    case: name,
    direction,
    label,
    fin: (first & 0x80) !== 0,
    rsv1: (first & 0x40) !== 0,
    opcode,
    opcodeName: OPCODES[opcode] ?? `unknown${opcode}`,
    masked,
    headerHex: bytes.subarray(0, head).toString("hex"),
    lengthField: (lengthBits === 126 ? "16bit" : lengthBits === 127 ? "64bit" : "7bit") as
      | "7bit"
      | "16bit"
      | "64bit",
    payloadBytes: bytes.length - head,
  };
  const shown = (() => {
    const body = bytes.subarray(head);
    if (!masked) return body;
    // A masked payload is unmasked before it is shown, or the record would be the XOR and not the
    // text. The mask key is part of `headerHex` above, so the bytes are still reconstructible.
    const out = Buffer.alloc(body.length);
    for (let index = 0; index < body.length; index += 1) {
      out[index] = body[index]! ^ MASK[index % 4]!;
    }
    return out;
  })();
  if (opcode === 8) {
    // The point of the whole file for `Reply::Close`: a code, or no code at all. The raw body is kept
    // too, because a zero-length close and a two-byte `1005` are different claims.
    return {
      ...base,
      closeCode: shown.length >= 2 ? shown.readUInt16BE(0) : undefined,
      closeReason: shown.length > 2 ? shown.subarray(2).toString("utf8") : undefined,
      closeHex: shown.toString("hex"),
    };
  }
  if (base.rsv1) {
    const inflated = input.inflated ?? {};
    const record = {
      ...base,
      wireHex: shown.length <= RAW_LIMIT ? shown.toString("hex") : undefined,
      inflateError: inflated.error,
    };
    if (inflated.bytes === undefined) return record;
    const plain = inflated.bytes;
    return {
      ...record,
      inflatedBytes: plain.length,
      inflatedSha: sha(plain),
      ...(plain.length <= INLINE_LIMIT ? { inflated: plain.toString("utf8") } : {}),
    };
  }
  if (shown.length > INLINE_LIMIT) return { ...base, payloadSha: sha(shown) };
  return { ...base, payload: shown.toString("utf8") };
};

// ---------------------------------------------------------------------------
// The raw client
// ---------------------------------------------------------------------------

/**
 * A buffered reader over a `net.Socket`.
 *
 * It waits on a **quiet window** rather than a frame count, because how many frames a scenario
 * produces is exactly what is under measurement: a reader that expected N frames could not notice the
 * server answering twice.
 */
const reader = (socket: net.Socket) => {
  let buffer = Buffer.alloc(0);
  let ended = false;
  let endDetail = "still open";
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
  });
  socket.on("end", () => {
    ended = true;
    endDetail = "FIN from peer";
  });
  socket.on("close", () => {
    if (!ended) endDetail = "still open";
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
  return {
    get ended() {
      return ended;
    },
    get endDetail() {
      return endDetail;
    },
    get pending() {
      return buffer.length;
    },
    take,
    /** The response head, up to and including the blank line that ends it. */
    readHead: async (deadlineMs: number) => {
      const found = await waitFor(() => buffer.includes("\r\n\r\n"), deadlineMs);
      const head = found ? take(buffer.indexOf("\r\n\r\n") + 4) : take(buffer.length);
      return { text: head.toString("latin1"), complete: found };
    },
    /** Everything the peer wrote during a quiet window, for a response body. */
    readRaw: async (settleMs: number) => {
      const before = buffer.length;
      await waitFor(() => buffer.length !== before || ended, settleMs);
      return take(buffer.length);
    },
    /**
     * Every frame the peer writes, stopping once `settleMs` passes with nothing new.
     *
     * Complete frames sitting in the buffer are parsed **before** waiting, because a burst that
     * arrives inside one `data` event is one measurement and not two: reading only after growth
     * dropped the last frame of every burst, which is the difference between "the server answered the
     * batch with two exits" and "the server answered with one".
     */
    readFrames: async (settleMs: number, deadlineMs: number) => {
      const out: Array<Buffer> = [];
      const started = Date.now();
      for (;;) {
        for (;;) {
          const total = completeFrame();
          if (total === undefined) break;
          const bytes = take(total);
          out.push(bytes);
          if (((bytes[0] ?? 0) & 0x0f) === 8) return out;
        }
        if (ended) break;
        const before = buffer.length;
        await waitFor(() => buffer.length !== before || ended, settleMs);
        if (buffer.length === before) break;
        if (Date.now() - started > deadlineMs) break;
      }
      return out;
    },
    /**
     * Wait for the peer to finish with the socket. A server that keeps the connection open after its
     * own close frame simply never answers, which is the answer the teardown cases record.
     */
    waitForEnd: async (ms: number) => waitFor(() => ended, ms),
  };
};

type Probe = {
  readonly socket: net.Socket;
  readonly r: ReturnType<typeof reader>;
  readonly write: (data: Buffer) => Promise<void>;
};

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
      new Promise<void>((resolve, reject) =>
        socket.write(data, (error) => (error ? reject(error) : resolve())),
      ),
  };
};

const upgradeRequest = (extra: Array<string>) =>
  [
    "GET /ws?orchestrationProtocol=1 HTTP/1.1",
    "Host: 127.0.0.1",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${KEY}`,
    "Sec-WebSocket-Version: 13",
    ...extra,
    "",
    "",
  ].join("\r\n");

const parseHead = (head: string) => {
  const lines = head.split("\r\n").filter((line) => line !== "");
  // Names keep the case the server wrote them in. A client looks a header up case-insensitively, so
  // this is not a claim about interoperability — it is the byte list a Rust server has to write.
  const fields = lines.slice(1);
  const headers: Array<[string, string]> = fields.map((line) => {
    const at = line.indexOf(":");
    return [line.slice(0, at), line.slice(at + 1).trim()];
  });
  // The artifact keeps names and values, so the separator between them has to be claimed here or it is
  // simply lost: `Name: value` with one space, which is what both writers emit.
  const canonical = fields.every((line) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+: \S/.test(line));
  return { statusLine: lines[0] ?? "", headers, canonical };
};

/** Headers whose name/value separator was not `": "`, which the artifact cannot show. */
const separatorBreaks: Array<string> = [];

/** A header list as the claims below read it: names folded, values as sent. */
const folded = (headers: Array<[string, string]> | undefined) =>
  (headers ?? []).map(([name, value]) => [name.toLowerCase(), value] as [string, string]);

/**
 * How each header name is actually spelled on the wire, which the folded claims above deliberately
 * ignore. A client looks a header up case-insensitively, so none of this is an interoperability claim;
 * it is the byte list a Rust server has to write to be indistinguishable, which is what the transport
 * goldens replay.
 *
 * Both writers happen to title-case, but by different means: `ws` builds its `101` and its own refusals
 * from string literals, while Node's response pipeline title-cases the headers it stamps itself.
 */
const spellings: Record<string, string> = {
  connection: "Connection",
  "content-length": "Content-Length",
  "content-type": "Content-Type",
  date: "Date",
  "keep-alive": "Keep-Alive",
  "sec-websocket-accept": "Sec-WebSocket-Accept",
  "sec-websocket-extensions": "Sec-WebSocket-Extensions",
  "sec-websocket-protocol": "Sec-WebSocket-Protocol",
  "sec-websocket-version": "Sec-WebSocket-Version",
  "transfer-encoding": "Transfer-Encoding",
  upgrade: "Upgrade",
};

/** Every header name as written, across every handshake this file performed. */
const spelledNames = () => {
  const names = new Set<string>();
  for (const event of events)
    for (const [name] of event.headers ?? []) if (name !== undefined) names.add(name);
  return [...names].sort();
};

const requestFrame = (id: number, tag: string, payload?: unknown) =>
  `{"_tag":"Request","id":${id},"tag":"${tag}","payload":${JSON.stringify(payload ?? {})},"headers":[]}`;

const closeBytes = (code?: number, reason?: string) => {
  if (code === undefined) return encodeFrame(8, Buffer.alloc(0));
  const body = Buffer.alloc(2 + Buffer.byteLength(reason ?? "", "utf8"));
  body.writeUInt16BE(code, 0);
  body.write(reason ?? "", 2, "utf8");
  return encodeFrame(8, body);
};

// ---------------------------------------------------------------------------
// One exchange: connect, upgrade, send, record everything the server writes
// ---------------------------------------------------------------------------

type Expect = {
  readonly upgraded: boolean;
  readonly c2s: number;
  readonly s2c: number;
  /** Close frames the server wrote, as `<code>` or `no-code`. */
  readonly closes?: Array<string>;
  /** Exact text expected for a given frame index, uncompressed or after inflation. */
  readonly answer?: string;
  readonly answerSha?: string;
  /**
   * Exact on-wire payload length of the single answer frame. Used only where the length **is** the
   * claim, i.e. the length-field boundaries, since a case that answers 127 bytes does not pin what
   * happens at 126.
   */
  readonly lengthBytes?: number;
};

type Scenario = {
  readonly name: string;
  readonly upgradeExtra?: Array<string>;
  readonly rawUpgrade?: string;
  readonly send?: Array<{
    readonly label: string;
    readonly bytes: Buffer;
    /**
     * Wait this long for the peer to answer before writing, so an `Ack` is staged behind the `Chunk`
     * that owes it instead of in front of it.
     */
    readonly settleBeforeMs?: number;
    /**
     * Record what the peer has done to the TCP connection **before** writing this frame. Needed by the
     * close handshake: the question is whether the server is still open at the moment it is echoed.
     */
    readonly observe?: boolean;
  }>;
  readonly settleMs?: number;
  readonly deadlineMs?: number;
  readonly expect: Expect;
};

/**
 * What each case measured, so record mode can print the table this file then asserts on.
 *
 * `closes` is required here although `Expect` leaves it optional: every case that ever got no close
 * frame was measured as an empty list, and an assertion that has to handle "never looked" would be a
 * claim about this file rather than about the server.
 */
const measured = new Map<
  string,
  Omit<Expect, "closes"> & {
    readonly closes: Array<string>;
    readonly peer: string;
    readonly tails: number;
  }
>();

const exchange = (scenario: Scenario, port: number) =>
  Effect.gen(function* () {
    yield* Effect.promise(async () => {
      const name = scenario.name;
      const probe = await connect(port);
      const wire = scenario.rawUpgrade ?? upgradeRequest(scenario.upgradeExtra ?? []);
      await probe.write(utf8(wire));

      const head = await probe.r.readHead(scenario.deadlineMs ?? 3000);
      const { statusLine, headers, canonical } = parseHead(head.text);
      if (!canonical) separatorBreaks.push(name);
      const upgraded = statusLine.startsWith("HTTP/1.1 101");
      // Both directions in one list, in the order they crossed, so a replay can see that an `Ack`
      // followed the `Chunk` that owed it rather than the request that started the stream.
      const crossed: Array<{ direction: "c2s" | "s2c"; bytes: Buffer; label?: string }> = [];

      if (!upgraded) {
        // The body of a rejection is part of what a Rust server has to reproduce, and a browser never
        // shows it — the handshake simply fails.
        const body = await probe.r.readRaw(scenario.settleMs ?? 300);
        events.push({
          case: name,
          event: "response",
          statusLine,
          // `date` is the one header that moves between runs: Node stamps it on anything written
          // through the response pipeline. The `101` has no date at all, because `ws` writes it
          // straight to the socket, and that difference is itself a claim. Masked by folded name,
          // since the case the writer chose is a separate claim (`headerCase` below).
          headers: headers.map(
            ([key, value]) =>
              [key, key.toLowerCase() === "date" ? "__DATE__" : value] as [string, string],
          ),
          body: body.toString("utf8").slice(0, 2048),
          detail: head.complete ? undefined : "head never ended before the deadline",
        });
      } else {
        events.push({ case: name, event: "upgrade", statusLine, headers });
        for (const frame of scenario.send ?? []) {
          if (frame.settleBeforeMs !== undefined) {
            // Writing the next frame only once the wire has gone quiet is what a real client does: it
            // acks a chunk it has received, not one it has merely asked for.
            for (const bytes of await probe.r.readFrames(
              frame.settleBeforeMs,
              scenario.deadlineMs ?? 5000,
            )) {
              crossed.push({ direction: "s2c", bytes });
            }
          }
          crossed.push({ direction: "c2s", bytes: frame.bytes, label: frame.label });
          if (frame.observe) {
            events.push({
              case: name,
              event: "observe",
              detail: `before writing ${frame.label}: ${probe.r.endDetail}; ${probe.r.pending} unread byte(s)`,
            });
          }
          // Writing into a socket the server already tore down is itself the measurement: it is how
          // "the `8800` closed TCP" is told apart from "the `8800` closed only the WebSocket".
          try {
            await probe.write(frame.bytes);
          } catch (error) {
            events.push({
              case: name,
              event: "write",
              detail: `${frame.label}: ${(error as Error).message}`,
            });
          }
        }
        for (const bytes of await probe.r.readFrames(
          scenario.settleMs ?? 300,
          scenario.deadlineMs ?? 5000,
        )) {
          crossed.push({ direction: "s2c", bytes });
        }
      }

      // Recorded **before** this file destroys the socket, so the detail says what the peer did and
      // not what the probe did.
      //
      // `readFrames` returns as soon as it has read a close frame, which is the moment the peer's FIN
      // is most likely still in flight, so the TCP question is asked after a window rather than at the
      // instant the frame was read. Without this the same server measured "FIN" and "still open" for one
      // case on alternate runs, which is a bug in this file rather than a fact about `ws`.
      if (
        crossed.some((entry) => entry.direction === "s2c" && ((entry.bytes[0] ?? 0) & 0x0f) === 8)
      ) {
        await probe.r.waitForEnd(scenario.settleMs ?? 300);
      }
      const peer = probe.r.endDetail;
      if (probe.r.pending > 0) {
        events.push({
          case: name,
          event: "tail",
          detail: `${probe.r.pending} unparsed byte(s): ${probe.r.take(80).toString("hex")}`,
        });
      }
      probe.socket.destroy();
      await new Promise<void>((done) => setTimeout(done, 50));
      events.push({
        case: name,
        event: "peer",
        detail: `${upgraded ? "after upgrade" : "after response"}: ${peer}`,
      });
      events.push({
        case: name,
        event: "probe",
        detail: `after the probe destroyed its side: ${probe.r.endDetail}`,
      });

      // Compressed answers are inflated with the connection's own deflate context, so this has to see
      // the whole run of frames at once rather than one at a time.
      const answers = crossed.filter((entry) => entry.direction === "s2c");
      const compressed = answers
        .filter((entry) => ((entry.bytes[0] ?? 0) & 0x40) !== 0)
        .map((entry) => entry.bytes.subarray(headerLength(entry.bytes)));
      const inflated = inflateConnection(compressed);
      let cursor = 0;
      for (const entry of crossed) {
        if (entry.direction === "c2s") {
          frames.push(
            describeFrame({ case: name, direction: "c2s", label: entry.label, bytes: entry.bytes }),
          );
          continue;
        }
        const isCompressed = ((entry.bytes[0] ?? 0) & 0x40) !== 0;
        frames.push(
          describeFrame({
            case: name,
            direction: "s2c",
            bytes: entry.bytes,
            ...(isCompressed ? { inflated: inflated[cursor++] } : {}),
          }),
        );
      }

      const out = frames.filter((f) => f.case === name && f.direction === "s2c");
      measured.set(name, {
        upgraded,
        c2s: frames.filter((f) => f.case === name && f.direction === "c2s").length,
        s2c: out.length,
        closes: out
          .filter((f) => f.opcode === 8)
          .map((f) => (f.closeCode === undefined ? "no-code" : String(f.closeCode))),
        peer,
        tails: events.filter((e) => e.case === name && e.event === "tail").length,
      });
    });
  });

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

const deflateOffer = (extra: Array<string> = []) => [
  `Sec-WebSocket-Extensions: ${DEFINED}`,
  ...extra,
];

const SIZE_SIZES = [100, 900, 1000, 1100, 4000];

/** The codes the close battery sends, one scenario each: boundaries and two interior points. */
const CLOSE_CODES = [
  999, 1001, 1004, 1005, 1006, 1007, 1011, 1012, 1013, 1015, 1016, 3000, 4999, 5000,
];

/**
 * The close codes the transport refuses to echo, answered with `1002` instead — measured at every
 * boundary (`999`, `1004`–`1006`, `1015`/`1016`, `5000`) and at two interior points. Everything else
 * in `1000`–`1013` and all of `3000`–`4999` comes back as the peer wrote it.
 */
const refusedCloseCodes = [999, 1004, 1005, 1006, 1015, 1016, 5000];

const SCENARIOS: Array<Scenario> = [
  // --- handshake ---------------------------------------------------------
  {
    name: "handshake.noExtensions",
    // Three headers, no `date`, no `server`: the upgrade response is written straight to the socket.
    expect: { upgraded: true, c2s: 0, s2c: 0 },
  },
  {
    name: "handshake.deflate",
    upgradeExtra: deflateOffer(),
    send: [{ label: "plain", bytes: encodeFrame(1, utf8(requestFrame(9001, "plain"))) }],
    // The offer carried `client_max_window_bits` and the answer came back bare: the parameters the
    // server does not implement are dropped rather than echoed.
    expect: {
      upgraded: true,
      c2s: 1,
      s2c: 1,
      answer: exitOf(9001, {}),
      answerSha: sha(exitOf(9001, {})),
    },
  },
  {
    name: "handshake.deflateBare",
    upgradeExtra: ["Sec-WebSocket-Extensions: permessage-deflate"],
    expect: { upgraded: true, c2s: 0, s2c: 0 },
  },
  {
    name: "handshake.subprotocol",
    // The offered subprotocol is echoed back, so a Rust server that drops it breaks any client that
    // checks the echo.
    upgradeExtra: ["Sec-WebSocket-Protocol: t3"],
    expect: { upgraded: true, c2s: 0, s2c: 0 },
  },
  {
    name: "handshake.origin",
    upgradeExtra: ["Origin: https://app.lmcs.codes"],
    send: [{ label: "plain", bytes: encodeFrame(1, utf8(requestFrame(9002, "plain"))) }],
    expect: { upgraded: true, c2s: 1, s2c: 1, answer: exitOf(9002, {}) },
  },
  {
    name: "handshake.missingKey",
    rawUpgrade:
      "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n",
    expect: { upgraded: false, c2s: 0, s2c: 0 },
  },
  {
    name: "handshake.badVersion",
    // `ws` accepts hybi-08 as well as 13 (`version !== 13 && version !== 8`), so a version-8 client
    // gets a 101 rather than the 426 an RFC-only server would write.
    rawUpgrade: `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 8\r\n\r\n`,
    expect: { upgraded: true, c2s: 0, s2c: 0 },
  },
  {
    name: "handshake.version7",
    rawUpgrade: `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 7\r\n\r\n`,
    expect: { upgraded: false, c2s: 0, s2c: 0 },
  },
  {
    name: "handshake.noUpgradeHeader",
    // A plain GET on the route: the router answers 400 with an empty chunked body and keeps the
    // connection, because `ws` is never consulted.
    rawUpgrade: "GET /ws?orchestrationProtocol=1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
    expect: { upgraded: false, c2s: 0, s2c: 0 },
  },
  {
    name: "handshake.postMethod",
    rawUpgrade: `POST /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    expect: { upgraded: false, c2s: 0, s2c: 0 },
  },
  {
    name: "handshake.otherPath",
    rawUpgrade: `GET /nope HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    expect: { upgraded: false, c2s: 0, s2c: 0 },
  },
  {
    name: "handshake.serverNoContextTakeover",
    // The parameter a Rust server has to honour: with takeover refused, each answer must inflate on
    // its own, so the recorded `inflated` field is the whole claim.
    upgradeExtra: ["Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover"],
    send: [
      { label: "one", bytes: encodeFrame(1, utf8(requestFrame(9003, "plain"))) },
      { label: "two", bytes: encodeFrame(1, utf8(requestFrame(9004, "plain"))) },
    ],
    expect: { upgraded: true, c2s: 2, s2c: 2 },
  },

  // --- what the negotiation answers, parameter by parameter -------------
  //
  // A browser sends one exact offer, so these are not hypotheticals the shipped client will never
  // write: they are the difference between "the Rust port echoes the offer" and "the Rust port answers
  // what `ws` answers", which is only testable by offering things `ws` has opinions about.
  {
    name: "offer.serverMaxWindowBits",
    upgradeExtra: ["Sec-WebSocket-Extensions: permessage-deflate; server_max_window_bits=10"],
    send: [{ label: "plain", bytes: encodeFrame(1, utf8(requestFrame(9040, "plain"))) }],
    expect: { upgraded: true, c2s: 1, s2c: 1 },
  },
  {
    name: "offer.clientNoContextTakeover",
    upgradeExtra: ["Sec-WebSocket-Extensions: permessage-deflate; client_no_context_takeover"],
    send: [{ label: "plain", bytes: encodeFrame(1, utf8(requestFrame(9041, "plain"))) }],
    expect: { upgraded: true, c2s: 1, s2c: 1 },
  },
  {
    name: "offer.unknownParam",
    // Refused outright: an unknown parameter is not dropped, the handshake fails. Nothing is sent after
    // it, because there is no connection to send on.
    upgradeExtra: ["Sec-WebSocket-Extensions: permessage-deflate; foo=bar"],
    send: [{ label: "plain", bytes: encodeFrame(1, utf8(requestFrame(9042, "plain"))) }],
    expect: { upgraded: false, c2s: 0, s2c: 0 },
  },
  {
    name: "offer.everyParam",
    // The maximal offer, which is what a client that has read the RFC rather than the browser sends.
    upgradeExtra: [
      "Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover; client_no_context_takeover; server_max_window_bits=10; client_max_window_bits=10",
    ],
    send: [{ label: "plain", bytes: encodeFrame(1, utf8(requestFrame(9043, "plain"))) }],
    expect: { upgraded: true, c2s: 1, s2c: 1 },
  },
  {
    name: "offer.twoExtensions",
    // Two extension offers, one of them not permessage-deflate: which one the answer names is a
    // decision the port has to make explicitly.
    upgradeExtra: ["Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits, foo"],
    expect: { upgraded: true, c2s: 0, s2c: 0 },
  },
  {
    name: "offer.otherOnly",
    // An extension the server has never heard of is not an upgrade refusal, and nothing is answered
    // about it in the response.
    upgradeExtra: ["Sec-WebSocket-Extensions: foo; bar=1"],
    expect: { upgraded: true, c2s: 0, s2c: 0 },
  },
  {
    name: "offer.clientMaxValue",
    // The same parameter *with* a value, which is the difference `handshake.deflate` cannot see: the
    // browser sends the bare form and the answer drops it.
    upgradeExtra: ["Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits=10"],
    expect: { upgraded: true, c2s: 0, s2c: 0 },
  },
  {
    name: "offer.serverMaxOutOfRange",
    // A `server_max_window_bits` outside 9..=15: either it is a parameter the server declines to
    // implement (answer bare) or it is an unacceptable offer (refusal), and the two differ in the
    // client's error message. It is a refusal — same as an unknown parameter, and for the same reason:
    // `ws` will not answer for a window size it cannot honour.
    upgradeExtra: ["Sec-WebSocket-Extensions: permessage-deflate; server_max_window_bits=16"],
    expect: { upgraded: false, c2s: 0, s2c: 0 },
  },
  {
    name: "offer.repeatedParam",
    // The same parameter twice, which is a malformed offer rather than a redundant one.
    upgradeExtra: [
      "Sec-WebSocket-Extensions: permessage-deflate; client_no_context_takeover; client_no_context_takeover",
    ],
    expect: { upgraded: false, c2s: 0, s2c: 0 },
  },
  {
    name: "offer.protocolAndDeflate",
    // Both optional headers at once, which pins their **order** — the one claim a per-header table
    // cannot make.
    upgradeExtra: ["Sec-WebSocket-Protocol: t3", ...deflateOffer()],
    send: [{ label: "plain", bytes: encodeFrame(1, utf8(requestFrame(9046, "plain"))) }],
    expect: { upgraded: true, c2s: 1, s2c: 1 },
  },
  {
    name: "offer.bigNoTakeover",
    // The half of the threshold rule the `plain` cases cannot reach: a refusal of takeover suppresses
    // *small* answers, but an answer over 1024 bytes still has to be compressed.
    upgradeExtra: ["Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover"],
    send: [
      {
        label: "big",
        bytes: encodeFrame(1, utf8(requestFrame(9044, "size", { s: repeat("a", 4000) }))),
      },
    ],
    expect: { upgraded: true, c2s: 1, s2c: 1 },
  },
  {
    name: "offer.smallNoTakeover",
    // The same request under the threshold, so the two together say the rule is a size comparison and
    // not merely "no takeover means no compression".
    upgradeExtra: ["Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover"],
    send: [
      {
        label: "small",
        bytes: encodeFrame(1, utf8(requestFrame(9045, "size", { s: repeat("a", 900) }))),
      },
    ],
    expect: { upgraded: true, c2s: 1, s2c: 1 },
  },

  // --- the headers the transport injects ---------------------------------
  {
    name: "headers.injected",
    upgradeExtra: deflateOffer(["X-Probe: one", "Cookie: lmcs_probe=value"]),
    send: [{ label: "seen", bytes: encodeFrame(1, utf8(requestFrame(9010, "seenHeaders"))) }],
    expect: { upgraded: true, c2s: 1, s2c: 1 },
  },
  {
    name: "headers.repeated",
    // Two `X-Probe` lines: `IncomingMessage.headers` collapses a repeated header into a
    // comma-joined string, and `Headers.fromInput` keeps the last — so what the handler sees is one
    // pair, comma-joined, not two.
    upgradeExtra: ["X-Probe: one", "X-Probe: two"],
    send: [{ label: "seen", bytes: encodeFrame(1, utf8(requestFrame(9011, "seenHeaders"))) }],
    expect: { upgraded: true, c2s: 1, s2c: 1 },
  },

  // --- framing of the answers -------------------------------------------
  {
    name: "frame.uncompressedSmall",
    // No extension offered, so this is the plain case: `8145` and then the JSON as bytes.
    send: [{ label: "plain", bytes: encodeFrame(1, utf8(requestFrame(9020, "plain"))) }],
    expect: {
      upgraded: true,
      c2s: 1,
      s2c: 1,
      answer: exitOf(9020, {}),
    },
  },
  ...SIZE_SIZES.map((size) => ({
    // Every answer is compressed once the extension is negotiated — including this 70-byte one — so
    // `ws`'s documented 1024-byte threshold does not apply on this path. That is the claim the size
    // ladder exists to keep honest.
    name: `frame.deflate${size}`,
    upgradeExtra: deflateOffer(),
    send: [
      {
        label: "size",
        bytes: encodeFrame(1, utf8(requestFrame(9030 + size, "size", { s: repeat("a", size) }))),
      },
    ],
    expect: {
      upgraded: true,
      c2s: 1,
      s2c: 1,
      answerSha: sha(exitOf(9030 + size, { s: repeat("a", size) })),
    } satisfies Expect,
  })),
  {
    name: "frame.sixtyFourBit",
    // No deflate offered, so a 100 KiB answer crosses uncompressed and forces the 64-bit length
    // field — the only way to reach that encoding without an incompressible blob.
    send: [
      {
        label: "size",
        bytes: encodeFrame(1, utf8(requestFrame(9130, "size", { s: repeat("a", 100000) }))),
      },
    ],
    settleMs: 900,
    deadlineMs: 9000,
    expect: {
      upgraded: true,
      c2s: 1,
      s2c: 1,
      answerSha: sha(exitOf(9130, { s: repeat("a", 100000) })),
    },
  },
  ...[125, 126, 65_535, 65_536].map((target) => {
    // The answer's own byte count, minus the fixed `Exit` text around the string, is the payload the
    // frame has to carry — so the case asks for exactly the `s` length that lands the frame on the
    // boundary rather than near it. Nothing else in the file reaches 126 or 65536: the smallest
    // uncompressed answer is 59 bytes and the largest 16-bit one is 2119.
    const id = 9140 + [125, 126, 65_535, 65_536].indexOf(target);
    // The fixed text is the prefix plus the four characters every answer ends with: the string's own
    // closing quote and the three closing braces of value, exit and envelope.
    const prefix = `{"_tag":"Exit","requestId":${id},"exit":{"_tag":"Success","value":{"s":"`;
    const size = target - prefix.length - 4;
    return {
      name: `length.exact${target}`,
      // Uncompressed on purpose: a deflated answer's length is `ws`'s zlib output, so the only way to
      // drive the length field to an exact value is to skip the extension negotiation.
      send: [
        {
          label: "size",
          bytes: encodeFrame(1, utf8(requestFrame(id, "size", { s: repeat("a", size) }))),
        },
      ],
      settleMs: 900,
      deadlineMs: 9000,
      expect: {
        upgraded: true,
        c2s: 1,
        s2c: 1,
        lengthBytes: target,
        answerSha: sha(exitOf(id, { s: repeat("a", size) })),
      } satisfies Expect,
    };
  }),
  {
    name: "frame.streamDeflated",
    upgradeExtra: deflateOffer(),
    // The Ack written immediately, before chunk one has arrived. Both chunks come back and then the
    // stream goes silent: **the terminal `Exit` is itself gated behind acknowledging the last chunk**,
    // so an Ack-owning client that stopped early is what a Rust server has to reproduce, not a bug.
    // Whether the second chunk references the first's deflate context is the framing question here.
    send: [
      {
        label: "call",
        bytes: encodeFrame(1, utf8(requestFrame(9140, "stream", { s: repeat("b", 4000) }))),
      },
      { label: "ack", bytes: encodeFrame(1, utf8('{"_tag":"Ack","requestId":9140}')) },
    ],
    settleMs: 900,
    deadlineMs: 7000,
    expect: { upgraded: true, c2s: 2, s2c: 2 },
  },
  {
    name: "frame.streamStaged",
    // The same stream with each Ack written only after the wire went quiet, which is what a client
    // that actually received the chunk does. The terminal `Exit` only appears here, so this is the run
    // that pins how a closing answer is framed on a deflated connection.
    upgradeExtra: deflateOffer(),
    send: [
      {
        label: "call",
        bytes: encodeFrame(1, utf8(requestFrame(9141, "stream", { s: repeat("b", 4000) }))),
      },
      {
        label: "ack1",
        bytes: encodeFrame(1, utf8('{"_tag":"Ack","requestId":9141}')),
        settleBeforeMs: 400,
      },
      {
        label: "ack2",
        bytes: encodeFrame(1, utf8('{"_tag":"Ack","requestId":9141}')),
        settleBeforeMs: 400,
      },
    ],
    settleMs: 900,
    deadlineMs: 7000,
    expect: { upgraded: true, c2s: 3, s2c: 3 },
  },

  // --- framing of the requests ------------------------------------------
  {
    name: "client.fragmented",
    send: [
      {
        label: "part1",
        bytes: encodeFrame(1, utf8('{"_tag":"Request","id":9201,"tag":"pl'), { fin: false }),
      },
      {
        label: "part2",
        bytes: encodeFrame(0, utf8('ain","payload":{},"headers":[]}'), { fin: true }),
      },
    ],
    expect: { upgraded: true, c2s: 2, s2c: 1, answer: exitOf(9201, {}) },
  },
  {
    name: "client.continuationFirst",
    send: [{ label: "continuation", bytes: encodeFrame(0, utf8(requestFrame(9202, "plain"))) }],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["1002"] },
  },
  {
    name: "client.unmasked",
    // RFC 6455 is explicit and so is `ws`: 1002, and the request is never routed.
    send: [
      {
        label: "unmasked",
        bytes: encodeFrame(1, utf8(requestFrame(9203, "plain")), { masked: false }),
      },
    ],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["1002"] },
  },
  {
    name: "client.rsv1Unoffered",
    // A reserved bit set without the extension negotiated is a protocol error, not a decode error.
    send: [
      { label: "rsv1", bytes: encodeFrame(1, utf8(requestFrame(9204, "plain")), { rsv1: true }) },
    ],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["1002"] },
  },
  {
    name: "client.rsv1OfferedButRaw",
    // Deflate negotiated, yet the frame claims RSV1 with a payload that is not a deflate stream: the
    // answer is 1007 (bad payload data), because the bytes fail UTF-8 validation before anything else.
    upgradeExtra: deflateOffer(),
    send: [
      {
        label: "badRsv1",
        bytes: encodeFrame(1, utf8(requestFrame(9205, "plain")), { rsv1: true }),
      },
    ],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["1007"] },
  },
  {
    name: "client.deflatedRequest",
    // Does the server *accept* a compressed request, which the shipped client never sends? A Rust
    // server implementing only the outbound half breaks against a browser whose offer was accepted.
    upgradeExtra: deflateOffer(),
    send: [
      {
        label: "deflated",
        bytes: encodeFrame(1, zlib.deflateRawSync(utf8(requestFrame(9206, "plain"))), {
          rsv1: true,
        }),
      },
    ],
    expect: { upgraded: true, c2s: 1, s2c: 1, answer: exitOf(9206, {}) },
  },
  {
    name: "client.binary",
    // A binary frame carrying JSON is answered as if it were text: the transport hands the payload
    // through and the protocol layer parses bytes.
    send: [{ label: "binary", bytes: encodeFrame(2, utf8(requestFrame(9207, "plain"))) }],
    expect: { upgraded: true, c2s: 1, s2c: 1, answer: exitOf(9207, {}) },
  },
  {
    name: "client.unknownOpcode",
    send: [{ label: "opcode3", bytes: encodeFrame(3, utf8(requestFrame(9208, "plain"))) }],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["1002"] },
  },
  {
    name: "client.controlInMidMessage",
    // A control frame interleaved between two fragments: legal, and a real reassembly-state question.
    send: [
      {
        label: "part1",
        bytes: encodeFrame(1, utf8('{"_tag":"Request","id":9209,"tag":"pl'), { fin: false }),
      },
      { label: "ping", bytes: encodeFrame(9, utf8("mid")) },
      {
        label: "part2",
        bytes: encodeFrame(0, utf8('ain","payload":{},"headers":[]}'), { fin: true }),
      },
    ],
    settleMs: 500,
    expect: { upgraded: true, c2s: 3, s2c: 2, answer: exitOf(9209, {}) },
  },
  {
    name: "client.controlPing",
    // The transport answers the ping itself, with the same payload, and the protocol layer never sees
    // it — which is why this case produces one frame and no `{"_tag":"Pong"}`.
    send: [{ label: "ping", bytes: encodeFrame(9, utf8("ping-body")) }],
    expect: { upgraded: true, c2s: 1, s2c: 1 },
  },
  {
    name: "client.controlPingEmpty",
    send: [{ label: "ping", bytes: encodeFrame(9, Buffer.alloc(0)) }],
    expect: { upgraded: true, c2s: 1, s2c: 1 },
  },
  {
    name: "client.controlPong",
    // A pong the server never asked for is swallowed: nothing is written.
    send: [{ label: "pong", bytes: encodeFrame(10, utf8("unsolicited")) }],
    settleMs: 500,
    expect: { upgraded: true, c2s: 1, s2c: 0 },
  },
  {
    name: "client.controlTooLong",
    // A control frame over 125 bytes is a protocol error even though the payload is valid JSON.
    send: [{ label: "ping", bytes: encodeFrame(9, utf8(repeat("x", 126))) }],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["1002"] },
  },
  {
    name: "client.controlFragmented",
    // A control frame that claims more is coming. RFC 6455 forbids it and so does the transport, which
    // says so before it reads the payload.
    send: [{ label: "ping", bytes: encodeFrame(9, utf8("x"), { fin: false }) }],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["1002"] },
  },
  {
    name: "client.rsv2Set",
    // Only RSV1 means anything here, so an unassigned bit is the same protocol error RSV1 is when it
    // was not offered.
    send: [
      {
        label: "rsv2",
        bytes: encodeFrame(1, utf8(requestFrame(9211, "plain")), { rsv2: true }),
      },
    ],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["1002"] },
  },
  {
    name: "client.closeOneByte",
    // A close body of one byte can hold neither a code nor a reason.
    send: [{ label: "close", bytes: encodeFrame(8, Buffer.from([0x03])) }],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["1002"] },
  },
  {
    name: "client.invalidUtf8Text",
    // Whether the bytes decode at all is checked before the handler is consulted, so this is answered
    // by the transport rather than by the protocol layer's `Defect`.
    send: [{ label: "text", bytes: encodeFrame(1, Buffer.from([0x7b, 0xff, 0x7d])) }],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["1007"] },
  },
  {
    name: "client.rpcPing",
    send: [{ label: "rpcPing", bytes: encodeFrame(1, utf8('{"_tag":"Ping"}')) }],
    expect: { upgraded: true, c2s: 1, s2c: 1, answer: '{"_tag":"Pong"}' },
  },
  {
    name: "client.emptyText",
    // An empty text frame is not a teardown: the protocol layer reports the JSON failure and the
    // connection lives.
    send: [{ label: "empty", bytes: encodeFrame(1, Buffer.alloc(0)) }],
    expect: { upgraded: true, c2s: 1, s2c: 1 },
  },
  {
    name: "client.zeroLengthClose",
    // A close with no body is answered with a close that has no body either: the port must not invent
    // a code here, and this is the same `8800` the three teardown inputs produce.
    send: [{ label: "close", bytes: closeBytes() }],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["no-code"] },
  },
  {
    name: "client.closeNormal",
    // The peer's code and reason are echoed back verbatim.
    send: [{ label: "close", bytes: closeBytes(1000, "bye") }],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["1000"] },
  },
  {
    name: "client.closeReserved",
    // 1004 is reserved, so the peer's code is refused with 1002 rather than echoed.
    send: [{ label: "close", bytes: closeBytes(1004, "") }],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["1002"] },
  },
  {
    name: "client.closeBadReason",
    // A close reason that is not valid UTF-8: 1007. The shipped client can never write one, a hostile
    // peer can, and `native/protocol` has to say what it does.
    send: [{ label: "close", bytes: encodeFrame(8, Buffer.from([0x03, 0xe8, 0xff])) }],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["1007"] },
  },
  {
    name: "client.closeNoMask",
    send: [{ label: "close", bytes: encodeFrame(8, Buffer.alloc(0), { masked: false }) }],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["1002"] },
  },
  // The close-code table, one case per boundary. A code the transport refuses answers with `1002`
  // instead of the peer's own number, which is the only way a client learns its code was not taken —
  // and the only way the port knows which numbers it may echo.
  ...[999, 1001, 1004, 1005, 1006, 1007, 1011, 1012, 1013, 1015, 1016, 3000, 4999, 5000].map(
    (code) => ({
      name: `close.code${code}`,
      send: [{ label: "close", bytes: closeBytes(code, "") }],
      settleMs: 200,
      expect: {
        upgraded: true,
        c2s: 1,
        s2c: 1,
        closes: refusedCloseCodes.includes(code) ? ["1002"] : [String(code)],
      } satisfies Expect,
    }),
  ),
  {
    name: "client.requestThenClose", // The race a real disconnect produces: the request and the close arrive back to back, so the
    // server answers the request **and** echoes the close, in that order, on a socket that is going
    // away underneath it.
    send: [
      {
        label: "call",
        bytes: encodeFrame(1, utf8(requestFrame(9210, "size", { s: repeat("c", 20) }))),
      },
      { label: "close", bytes: closeBytes(1000, "") },
    ],
    settleMs: 500,
    expect: { upgraded: true, c2s: 2, s2c: 2, closes: ["1000"] },
  },

  // --- the three inputs that end the connection at the protocol layer ----
  {
    name: "teardown.null",
    // The measurement `Reply::Close` needed: the server writes a **zero-body close frame** (`8800`),
    // which is why the browser recorded code 1005 — 1005 is what "no status code" means. Then FIN.
    send: [{ label: "null", bytes: encodeFrame(1, utf8("null")) }],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["no-code"] },
  },
  {
    name: "teardown.batchWithNull",
    send: [
      { label: "batch", bytes: encodeFrame(1, utf8(`[null,${requestFrame(9211, "plain")}]`)) },
    ],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["no-code"] },
  },
  {
    name: "teardown.noHeaders",
    send: [
      {
        label: "noHeaders",
        bytes: encodeFrame(1, utf8('{"_tag":"Request","id":9212,"tag":"plain","payload":{}}')),
      },
    ],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["no-code"] },
  },
  {
    name: "teardown.thenCanary",
    // Same connection, teardown first: the canary writes nothing, so the close was the frame's doing
    // and not the socket's.
    send: [
      { label: "null", bytes: encodeFrame(1, utf8("null")) },
      { label: "canary", bytes: encodeFrame(1, utf8(requestFrame(9213, "plain"))) },
    ],
    settleMs: 500,
    expect: { upgraded: true, c2s: 2, s2c: 1, closes: ["no-code"] },
  },
  {
    name: "teardown.stagedThenCanary",
    // The canary written only once the `8800` has been *received*, which is the case the un-staged run
    // cannot tell apart: the write either fails on a socket the server already destroyed, or lands on
    // one the server left open and simply stopped reading.
    send: [
      { label: "null", bytes: encodeFrame(1, utf8("null")) },
      {
        label: "canary",
        bytes: encodeFrame(1, utf8(requestFrame(9214, "plain"))),
        settleBeforeMs: 400,
      },
    ],
    settleMs: 500,
    expect: { upgraded: true, c2s: 2, s2c: 1, closes: ["no-code"] },
  },
  {
    name: "teardown.deflatedNull",
    // The same teardown reached through a compressed frame: does the close answer differ? It must not,
    // because the teardown happens after inflation.
    upgradeExtra: deflateOffer(),
    send: [
      { label: "null", bytes: encodeFrame(1, zlib.deflateRawSync(utf8("null")), { rsv1: true }) },
    ],
    expect: { upgraded: true, c2s: 1, s2c: 1, closes: ["no-code"] },
  },
  {
    name: "teardown.thenClientClose",
    // The other half of the handshake the browser never shows: the protocol layer already wrote its
    // `8800`, and now the peer sends its own close. Whether that produces a second frame, and whether
    // TCP goes away after it, is what `Reply::Close` cannot express but a Rust socket has to.
    send: [
      { label: "null", bytes: encodeFrame(1, utf8("null")) },
      {
        label: "close",
        bytes: closeBytes(1000, "after"),
        settleBeforeMs: 400,
        observe: true,
      },
    ],
    settleMs: 700,
    expect: { upgraded: true, c2s: 2, s2c: 1, closes: ["no-code"] },
  },

  // --- the envelope layer over a real transport --------------------------
  {
    name: "batch.twoRequests",
    // One input frame, two answer frames, in the order the batch listed them.
    send: [
      {
        label: "batch",
        bytes: encodeFrame(
          1,
          utf8(`[${requestFrame(9220, "plain")},${requestFrame(9221, "plain")}]`),
        ),
      },
    ],
    settleMs: 500,
    expect: { upgraded: true, c2s: 1, s2c: 2 },
  },
  {
    name: "batch.empty",
    // An empty array is a valid batch the server answers with nothing, on a connection that lives.
    send: [{ label: "batch", bytes: encodeFrame(1, utf8("[]")) }],
    settleMs: 500,
    expect: { upgraded: true, c2s: 1, s2c: 0 },
  },
  {
    name: "batch.nested",
    // An array inside an array: the decoder sees a two-element batch whose second element is not a
    // message, which is how the nesting case reaches the switch.
    send: [{ label: "batch", bytes: encodeFrame(1, utf8(`[[${requestFrame(9222, "plain")}]]`)) }],
    settleMs: 500,
    expect: { upgraded: true, c2s: 1, s2c: 1 },
  },
  {
    name: "batch.twoThenNull",
    // A batch whose *second* element tears the connection down, so the question is whether the first
    // element's answer was written first — the one thing `protocol-golden.ts` could not measure.
    send: [
      { label: "batch", bytes: encodeFrame(1, utf8(`[${requestFrame(9223, "plain")},null]`)) },
    ],
    settleMs: 500,
    expect: { upgraded: true, c2s: 1, s2c: 2, closes: ["no-code"] },
  },

  // --- limits ------------------------------------------------------------
  {
    name: "limits.bigRequest",
    // `ws` defaults to `maxPayload: 100 MiB`, which the server never overrides, so a 2 MiB request is
    // accepted. Its answer is 2 MiB of plaintext too, which reaches the 64-bit field *with* deflate
    // on — and comes back at a tenth of the size, which is what makes the length field of a
    // compressed answer worth pinning separately from its payload.
    upgradeExtra: deflateOffer(),
    send: [
      {
        label: "size",
        bytes: encodeFrame(
          1,
          utf8(requestFrame(9230, "size", { s: repeat("d", 2 * 1024 * 1024) })),
        ),
      },
    ],
    settleMs: 2000,
    deadlineMs: 30000,
    expect: {
      upgraded: true,
      c2s: 1,
      s2c: 1,
      answerSha: sha(exitOf(9230, { s: repeat("d", 2 * 1024 * 1024) })),
    },
  },
];

/**
 * What happened to TCP after the server wrote a close frame, for **every** scenario that got one.
 *
 * This is the whole reason the file exists. The server-initiated teardown — the zero-body `8800` the
 * protocol layer writes when an input cannot be a message — is the only close after which the socket
 * stays open: `ws` waits for the peer to finish the handshake, which is why the browser saw `1005` and
 * why a Rust server that hung up after `8800` would look, to every real client, like a dropped
 * connection. Every close that *completes* a peer-initiated exchange is followed by a FIN — including
 * the echo of a peer's own codeless close, which is a different server from the one that initiates it.
 *
 * `open` and `fin` are read from the probe's own socket after its last read, i.e. as of the moment this
 * file gave up on the connection. Rejections are not listed: their FIN races that window.
 */
const tcpAfterClose: Record<string, "open" | "fin"> = {
  // Every close the transport answers — the peer's own, echoed or replaced — ends TCP as well.
  ...Object.fromEntries(CLOSE_CODES.map((code) => [`close.code${code}`, "fin"])),
  // --- the server writes `8800` because the protocol layer told it to ----------
  "teardown.null": "open",
  "teardown.batchWithNull": "open",
  "teardown.noHeaders": "open",
  "teardown.thenCanary": "open",
  "teardown.stagedThenCanary": "open",
  "teardown.deflatedNull": "open",
  "batch.twoThenNull": "open",
  // ...and the peer's close ends it, which is the half the browser hides.
  "teardown.thenClientClose": "fin",

  // --- transport errors, and the peer's own close -----------------------------
  "client.continuationFirst": "fin",
  "client.unmasked": "fin",
  "client.rsv1Unoffered": "fin",
  "client.rsv1OfferedButRaw": "fin",
  "client.unknownOpcode": "fin",
  "client.controlTooLong": "fin",
  "client.controlFragmented": "fin",
  "client.rsv2Set": "fin",
  "client.closeOneByte": "fin",
  "client.invalidUtf8Text": "fin",
  "client.closeReserved": "fin",
  "client.closeBadReason": "fin",
  "client.closeNoMask": "fin",
  "client.closeNormal": "fin",
  "client.requestThenClose": "fin",
  "client.zeroLengthClose": "fin",
};

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const recordTable = () => {
  const rows = [...measured].map(
    ([name, value]) =>
      `${name.padEnd(32)} upgraded=${String(value.upgraded).padEnd(5)} c2s=${value.c2s} s2c=${value.s2c}` +
      ` closes=${JSON.stringify(value.closes)} tails=${value.tails} peer=${value.peer}`,
  );
  process.stderr.write(`${rows.join("\n")}\n`);
};

/**
 * The exact header list of every refusal, in the order the bytes carry them.
 *
 * Two different writers produce them, and a Rust server that merges them is a different byte stream:
 *
 *   - `ws` answers its own protocol refusals **straight onto the socket**, so there is no `date`, the
 *     connection is already closing and the body has a byte-exact `content-length`;
 *   - a request the *router* never accepts (no `upgrade` header, wrong method, wrong path) goes through
 *     Node's response pipeline, which stamps `date`, keeps the connection alive and switches the body to
 *     a chunked encoding — so its body is literally `0\r\n\r\n`, an empty chunked response.
 *
 * The last three cases in the list are worth naming: an unknown `permessage-deflate` parameter, a
 * `server_max_window_bits` outside the supported range and a repeated parameter are not quietly dropped
 * — the **handshake fails**. A Rust port that implements the negotiation as "keep the parameters I
 * know", or that normalizes a duplicate, would upgrade clients `ws` turns away. All three answer with
 * the same sentence, so the refusal is the only observable difference between them.
 */
const refusalHeaders: Record<string, Array<string>> = {
  "handshake.missingKey": ["connection", "content-type", "content-length"],
  "handshake.version7": ["connection", "content-type", "content-length", "sec-websocket-version"],
  "offer.unknownParam": ["connection", "content-type", "content-length"],
  "offer.serverMaxOutOfRange": ["connection", "content-type", "content-length"],
  "offer.repeatedParam": ["connection", "content-type", "content-length"],
  "handshake.noUpgradeHeader": ["date", "connection", "keep-alive", "transfer-encoding"],
  // The 404s omit the `keep-alive: timeout=5` the 400 carries, which is Node's own decision about a
  // response whose body it wrote before the handler ran. Pinned because it is byte-stable across runs,
  // not because the port has to reproduce it: no client reads that header.
  "handshake.postMethod": ["date", "connection", "transfer-encoding"],
  "handshake.otherPath": ["date", "connection", "transfer-encoding"],
};

/**
 * The `Sec-WebSocket-Extensions` answer each offer earns, keyed by the offer rather than by the case,
 * because most of the 55 upgrades in this file share the same browser offer.
 *
 * Three of these rows are the port's business, not trivia:
 *
 *   - `client_max_window_bits` **alone** is dropped and the answer comes back bare, while
 *     `server_max_window_bits=10` and both `*_no_context_takeover` flags are echoed verbatim — so the
 *     rule is not "echo what was offered" nor "drop what is unknown" but *keep only what you implement*.
 *   - an unknown parameter (`foo=bar`) refuses the whole handshake rather than being dropped.
 *   - an offer that does not mention `permessage-deflate` at all still upgrades, with no header back.
 */
const answersForOffer: Record<string, string | null> = {
  "": null,
  "permessage-deflate": "permessage-deflate",
  "permessage-deflate; client_max_window_bits": "permessage-deflate",
  "permessage-deflate; client_no_context_takeover":
    "permessage-deflate; client_no_context_takeover",
  "permessage-deflate; server_max_window_bits=10": "permessage-deflate; server_max_window_bits=10",
  "permessage-deflate; server_no_context_takeover":
    "permessage-deflate; server_no_context_takeover",
  "permessage-deflate; server_no_context_takeover; client_no_context_takeover; server_max_window_bits=10; client_max_window_bits=10":
    "permessage-deflate; server_no_context_takeover; client_no_context_takeover; server_max_window_bits=10; client_max_window_bits=10",
  "permessage-deflate; client_max_window_bits=10": "permessage-deflate; client_max_window_bits=10",
  "permessage-deflate; client_max_window_bits, foo": "permessage-deflate",
  "foo; bar=1": null,
};

/**
 * The exact text `ws` writes for the refusals it produces itself, which is what its
 * `content-length` counts. The router's refusals are not here: they carry a chunked encoding and no
 * body at all, which the writer rule below is the claim about.
 */
const refusalBodies: Record<string, string> = {
  "handshake.missingKey": "Missing or invalid Sec-WebSocket-Key header",
  "handshake.version7": "Missing or invalid Sec-WebSocket-Version header",
  // The three negotiation refusals share one sentence, so a port cannot tell an out-of-range window
  // from a repeated parameter from an unknown one by the body — only by the fact that it refuses.
  "offer.unknownParam": "Invalid or unacceptable Sec-WebSocket-Extensions header",
  "offer.serverMaxOutOfRange": "Invalid or unacceptable Sec-WebSocket-Extensions header",
  "offer.repeatedParam": "Invalid or unacceptable Sec-WebSocket-Extensions header",
};

/** The offer a case sent, or `""` for none. */
const offerOf = (name: string): string => {
  const line = (SCENARIOS.find((s) => s.name === name)?.upgradeExtra ?? []).find((l) =>
    l.startsWith("Sec-WebSocket-Extensions:"),
  );
  return line === undefined ? "" : line.slice("Sec-WebSocket-Extensions:".length).trim();
};

/**
 * Claims about what was measured.
 *
 * These are **collected, not thrown**. The first version of this file threw from inside an `Effect.sync`
 * at the end of a scoped run; the defect never reached `runPromise`'s rejection handler, so a broken
 * assertion exited `0` and printed nothing. An oracle that reports success while failing is worse than no
 * oracle, so the list is returned and the exit code is derived from its length.
 */
const check = (): Array<string> => {
  const out: Array<string> = [];
  const upgrades = events.filter((e) => e.event === "upgrade");

  /** Names as written, since the artifact replay compares bytes and the case is part of them. */
  const spelled = (event: RecordedEvent) => {
    for (const [name] of event.headers ?? []) {
      const expected = spellings[name.toLowerCase()];
      if (expected === undefined) {
        out.push(`${event.case}: wrote an unlisted header name ${JSON.stringify(name)}`);
      } else if (name !== expected) {
        out.push(`${event.case}: wrote ${JSON.stringify(name)}, not ${JSON.stringify(expected)}`);
      }
    }
  };

  for (const event of upgrades) {
    spelled(event);
    const names = folded(event.headers).map(([name]) => name);
    // Three headers, always in this order, and the `101` is written by the transport rather than by a
    // response pipeline: it has no `date`, no `server`, nothing a framework would add.
    if (names.slice(0, 3).join(",") !== "upgrade,connection,sec-websocket-accept") {
      out.push(`${event.case}: the upgrade answered ${JSON.stringify(names)}`);
    }
    if (names.includes("date")) {
      out.push(`${event.case}: the upgrade carried date, which the direct socket write never does`);
    }
    for (const extra of names.slice(3)) {
      if (extra !== "sec-websocket-extensions" && extra !== "sec-websocket-protocol") {
        out.push(`${event.case}: the upgrade carried an unexpected ${extra}`);
      }
    }
    // `offer.protocolAndDeflate` is the only case that answers both optional headers, so this is where
    // their order is a claim rather than an assumption: `ws` writes the protocol before the extension.
    const protocol = names.indexOf("sec-websocket-protocol");
    const extensions = names.indexOf("sec-websocket-extensions");
    if (protocol !== -1 && extensions !== -1 && protocol > extensions) {
      out.push(
        `${event.case}: answered the protocol after the extension, which is ${JSON.stringify(names)}`,
      );
    }
    for (const [name, value] of folded(event.headers)) {
      if (name === "sec-websocket-accept" && value !== EXPECTED_ACCEPT) {
        out.push(
          `${event.case}: Sec-WebSocket-Accept was ${value}, expected ${EXPECTED_ACCEPT} for the RFC 6455 example key`,
        );
      }
      // A negotiated offer must come back naming the extension: `permessage-deflate; foo=bar` echoed
      // with unknown parameters would mean the server accepted parameters it cannot implement.
      if (
        name === "sec-websocket-extensions" &&
        value.split(";")[0]?.trim() !== "permessage-deflate"
      ) {
        out.push(`${event.case}: negotiated ${JSON.stringify(value)} is not permessage-deflate`);
      }
    }
    // The offer→answer mapping, which is the whole of what `deflate::negotiate` has to get right.
    const offer = offerOf(event.case);
    const expected = answersForOffer[offer];
    if (expected === undefined) {
      out.push(`${event.case}: offer ${JSON.stringify(offer)} is not listed`);
    } else {
      const answered =
        folded(event.headers).find(([name]) => name === "sec-websocket-extensions")?.[1] ?? null;
      if (answered !== expected) {
        out.push(
          `${event.case}: offered ${JSON.stringify(offer)}, answered ${JSON.stringify(answered)}, expected ${JSON.stringify(expected)}`,
        );
      }
    }
  }

  for (const event of events.filter((e) => e.event === "response")) {
    const expected = refusalHeaders[event.case];
    spelled(event);
    const names = folded(event.headers).map(([name]) => name);
    if (expected === undefined) {
      out.push(`${event.case}: refused with ${JSON.stringify(names)}, which is not listed`);
      continue;
    }
    if (names.join(",") !== expected.join(",")) {
      out.push(
        `${event.case}: headers were ${JSON.stringify(names)}, expected ${JSON.stringify(expected)}`,
      );
    }
    // The two writers also differ in their body: `content-length` carries text, chunked carries nothing.
    const chunked = names.includes("transfer-encoding");
    if (
      (event.body ?? "") === "" ||
      (chunked ? event.body !== "0\r\n\r\n" : event.body === "0\r\n\r\n")
    ) {
      out.push(
        `${event.case}: body ${JSON.stringify(event.body)} does not match its ${chunked ? "chunked" : "length-carrying"} writer`,
      );
    }
    const text = refusalBodies[event.case];
    if (text !== undefined) {
      if (event.body !== text) {
        out.push(
          `${event.case}: body was ${JSON.stringify(event.body)}, expected ${JSON.stringify(text)}`,
        );
      }
      // The length header counts those bytes, so a port that rewords the sentence has to rewrite it.
      const length = folded(event.headers).find(([name]) => name === "content-length")?.[1];
      if (length !== String(Buffer.byteLength(text, "utf8"))) {
        out.push(
          `${event.case}: content-length ${length} is not ${Buffer.byteLength(text, "utf8")}`,
        );
      }
    }
  }

  for (const scenario of SCENARIOS) {
    const got = measured.get(scenario.name);
    if (got === undefined) {
      out.push(`${scenario.name}: never measured`);
      continue;
    }
    if (got.upgraded !== scenario.expect.upgraded) {
      out.push(`${scenario.name}: upgraded=${got.upgraded}, expected ${scenario.expect.upgraded}`);
    }
    if (got.closes.join(",") !== (scenario.expect.closes ?? []).join(",")) {
      out.push(
        `${scenario.name}: closes were ${JSON.stringify(got.closes)}, expected ${JSON.stringify(scenario.expect.closes ?? [])}`,
      );
    }
    if (got.tails !== 0) {
      out.push(
        `${scenario.name}: ${got.tails} unparsed tail(s), so the framing here is not fully read`,
      );
    }
    const listed = tcpAfterClose[scenario.name];
    if (got.closes.length > 0 !== (listed !== undefined)) {
      // The table is exhaustive on purpose: a case that writes a close belongs in it, and a case that
      // writes none must not appear, or the rule it encodes silently stops covering anything.
      out.push(
        `${scenario.name}: closes ${JSON.stringify(got.closes)} against a TCP entry of ${JSON.stringify(listed ?? null)}`,
      );
    } else if (listed !== undefined) {
      const open = got.peer === "still open";
      if (open !== (listed === "open")) {
        out.push(`${scenario.name}: the peer said ${got.peer}, the table says ${listed}`);
      }
    } else if (got.upgraded && got.peer !== "still open") {
      // Nothing else in the whole exchange ends a connection. A server that hangs up after an answer, a
      // pong or a rejected frame would be caught here rather than by a client reconnecting in a loop.
      out.push(`${scenario.name}: ${got.peer} on a connection no close frame was written for`);
    }
    const answers = frames.filter((f) => f.case === scenario.name && f.direction === "s2c");
    if (answers.length !== scenario.expect.s2c) {
      out.push(
        `${scenario.name}: ${answers.length} answer frames, expected ${scenario.expect.s2c}`,
      );
    }
    if (answers.length === 1) {
      // One answer frame is a claim about content as well as count: either the plain payload or what the
      // compressed payload inflates to has to be exactly what the protocol layer wrote.
      const plain = answers[0]!.payload ?? answers[0]!.inflated;
      // A frame's content is recorded as text when it is short and as a digest when it is not, so the
      // claim has to hash the text it was given to stay a claim about content rather than about size.
      const digest =
        answers[0]!.payloadSha ??
        answers[0]!.inflatedSha ??
        (plain === undefined ? undefined : sha(plain));
      if (scenario.expect.answer !== undefined && plain !== scenario.expect.answer) {
        out.push(
          `${scenario.name}: answer was ${JSON.stringify(plain)?.slice(0, 160)}, expected ${JSON.stringify(scenario.expect.answer).slice(0, 160)}`,
        );
      }
      if (scenario.expect.answerSha !== undefined && digest !== scenario.expect.answerSha) {
        out.push(
          `${scenario.name}: answer sha ${digest} is not the ${scenario.expect.answerSha} the rpc's own success schema produces`,
        );
      }
      if (
        scenario.expect.lengthBytes !== undefined &&
        answers[0]!.payloadBytes !== scenario.expect.lengthBytes
      ) {
        out.push(
          `${scenario.name}: answer was ${answers[0]!.payloadBytes} bytes on the wire, expected exactly ${scenario.expect.lengthBytes}`,
        );
      }
    }
  }

  // The length field is the *minimal* one for the payload, which is the rule a port writing
  // `frame.encode` has to reproduce byte for byte: 7-bit below 126, 16-bit below 65536, 64-bit above.
  // Every answer frame in the artifact is checked, and the four `length.exact*` cases put a measured
  // payload on each side of both boundaries.
  for (const frame of frames.filter((f) => f.direction === "s2c")) {
    const expected =
      frame.payloadBytes <= 125 ? "7bit" : frame.payloadBytes <= 65_535 ? "16bit" : "64bit";
    if (frame.lengthField !== expected) {
      out.push(
        `${frame.case}: ${frame.payloadBytes}-byte payload used ${frame.lengthField}, expected ${expected}`,
      );
    }
  }

  // Answers are text or control, never masked, never fragmented and never binary: a Rust server that sent
  // a binary frame would contradict `protocol-golden.ts`, which recorded every frame as text.
  const badOut = frames
    .filter((f) => f.direction === "s2c")
    .filter((f) => f.masked || (f.opcode !== 1 && f.opcode !== 8 && f.opcode !== 10))
    .map((f) => `${f.case}: opcode ${f.opcodeName} masked=${f.masked}`);
  if (badOut.length > 0) out.push(`server wrote unexpected frames: ${JSON.stringify(badOut)}`);
  if (frames.some((f) => f.direction === "s2c" && !f.fin)) {
    out.push("the server fragmented an answer, which nothing in the port assumed");
  }
  // A compressed answer that does not inflate is a bug in *this file*, not the server: the artifact would
  // otherwise carry a `payloadBytes` no reader can use.
  const broken = frames.filter(
    (f) => f.direction === "s2c" && f.rsv1 && f.inflateError !== undefined,
  );
  if (broken.length > 0) {
    out.push(
      `compressed answer(s) that do not inflate: ${JSON.stringify(broken.map((f) => [f.case, f.inflateError]))}`,
    );
  }
  // Every answer frame the port has to reproduce must therefore be readable: either it is uncompressed
  // text, or it inflated.
  const unreadable = frames
    .filter((f) => f.direction === "s2c" && f.opcode === 1)
    .filter(
      (f) => f.payload === undefined && f.payloadSha === undefined && f.inflatedSha === undefined,
    )
    .map((f) => f.case);
  if (unreadable.length > 0) out.push(`text answer(s) with no recorded content: ${unreadable}`);

  // ---------------------------------------------------------------- compression
  //
  // Which answers the server deflates is the one transport decision the offer does not state, and it
  // splits on context takeover rather than on size alone:
  //
  //   - no `permessage-deflate` answered → nothing is ever compressed;
  //   - takeover (the default) → **every** answer is compressed, including the 63-byte `plain` reply and
  //     the 4053-byte stream chunk, so `ws`'s documented 1024-byte threshold does not apply;
  //   - `server_no_context_takeover` → the threshold applies, which is what `offer.smallNoTakeover`
  //     (975 bytes, raw) and `offer.bigNoTakeover` (4075 bytes, RSV1) measure on either side of it.
  for (const frame of frames.filter((f) => f.direction === "s2c" && f.opcode === 1)) {
    const answer = answersForOffer[offerOf(frame.case)] ?? null;
    const plain = frame.inflatedBytes ?? frame.payloadBytes;
    const expected =
      answer !== null && (answer.includes("server_no_context_takeover") ? plain >= 1024 : true);
    if (frame.rsv1 !== expected) {
      out.push(
        `${frame.case}: ${plain}-byte answer had rsv1=${frame.rsv1}, expected ${expected} under ${JSON.stringify(answer)}`,
      );
    }
  }

  if (separatorBreaks.length > 0) {
    out.push(
      `handshake(s) whose headers were not written as \`Name: value\`: ${JSON.stringify(separatorBreaks)}`,
    );
  }

  return out;
};

const summarize = () => {
  const upgrades = events.filter((e) => e.event === "upgrade");
  return {
    methods: (Group as unknown as { requests: Map<string, unknown> }).requests.size,
    scenarios: SCENARIOS.length,
    frames: frames.length,
    clientToServer: frames.filter((f) => f.direction === "c2s").length,
    serverToClient: frames.filter((f) => f.direction === "s2c").length,
    upgrades: upgrades.length,
    responses: events.filter((e) => e.event === "response").length,
    rsv1Used: frames.filter((f) => f.direction === "s2c" && f.rsv1).length,
    lengthFields: {
      bit7: frames.filter((f) => f.direction === "s2c" && f.lengthField === "7bit").length,
      bit16: frames.filter((f) => f.direction === "s2c" && f.lengthField === "16bit").length,
      bit64: frames.filter((f) => f.direction === "s2c" && f.lengthField === "64bit").length,
    },
    closeCodes: frames
      .filter((f) => f.direction === "s2c" && f.opcode === 8)
      .map((f) => `${f.case}=${f.closeCode === undefined ? "no-code" : String(f.closeCode)}`),
    tcp: Object.entries(tcpAfterClose).map(([name, value]) => `${name}=${value}`),
    headerNames: spelledNames(),
    serialization: "RpcSerialization.layerJson",
    websocket: { perMessageDeflate: true },
  };
};

const run = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const address = server.address;
  if (typeof address === "string" || !("port" in address)) {
    throw new Error(`expected a TCP address, got ${JSON.stringify(address)}`);
  }
  const port = address.port;
  for (const scenario of SCENARIOS) {
    yield* exchange(scenario, port);
  }
  const summary = summarize();
  if (process.env.LMCS_UPGRADE_GOLDEN_RECORD) {
    recordTable();
    emit(JSON.stringify({ summary, frames, events, measured: [...measured] }, undefined, 2));
    return;
  }
  const violations = check();
  emit(JSON.stringify({ summary, frames, events }, undefined, 2));
  for (const violation of violations) process.stderr.write(`violation: ${violation}\n`);
  if (violations.length > 0) {
    recordTable();
    process.exitCode = 1;
  }
}).pipe(Effect.scoped, Effect.provide(appLayer));

// The artifact is written with `writeSync`, so exiting here cannot truncate it; `process.exitCode` keeps
// the violations' exit code.
Effect.runPromise(run).then(
  () => process.exit(process.exitCode),
  (cause) => {
    process.stderr.write(`upgrade-golden failed: ${cause}\n`);
    if (process.env.LMCS_UPGRADE_GOLDEN_RECORD || process.env.LMCS_UPGRADE_GOLDEN_DEBUG) {
      recordTable();
      process.stderr.write(`${JSON.stringify([...measured])}\n`);
    }
    process.exit(1);
  },
);
