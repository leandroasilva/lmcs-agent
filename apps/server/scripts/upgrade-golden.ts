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
  options?: { readonly fin?: boolean; readonly rsv1?: boolean; readonly masked?: boolean },
): Buffer => {
  const fin = options?.fin ?? true;
  const rsv1 = options?.rsv1 ?? false;
  const masked = options?.masked ?? true;
  const first = (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode;
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
  readonly label?: string;
  readonly bytes: Buffer;
  /** What an RSV1 payload inflated to, from the connection's own deflate context. */
  readonly inflated?: { readonly bytes?: Buffer; readonly error?: string };
};

type RecordedFrame = {
  readonly case: string;
  readonly direction: "c2s" | "s2c";
  readonly label?: string;
  readonly fin: boolean;
  readonly rsv1: boolean;
  readonly opcode: number;
  readonly opcodeName: string;
  readonly masked: boolean;
  readonly headerHex: string;
  readonly lengthField: "7bit" | "16bit" | "64bit";
  readonly payloadBytes: number;
  readonly payload?: string;
  readonly payloadSha?: string;
  readonly wireHex?: string;
  readonly inflatedBytes?: number;
  readonly inflatedSha?: string;
  readonly inflated?: string;
  readonly inflateError?: string;
  readonly closeCode?: number;
  readonly closeReason?: string;
  readonly closeHex?: string;
};

type RecordedEvent = {
  readonly case: string;
  readonly event: "upgrade" | "response" | "peer" | "probe" | "tail" | "write" | "observe";
  readonly statusLine?: string;
  readonly headers?: Array<[string, string]>;
  readonly body?: string;
  readonly detail?: string;
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
  const headers: Array<[string, string]> = lines.slice(1).map((line) => {
    const at = line.indexOf(":");
    return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
  });
  return { statusLine: lines[0] ?? "", headers };
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
  /**
   * What the peer had done to TCP by the time this probe destroyed its side, e.g. `still open` or
   * `FIN from peer`. A close frame that ends the WebSocket and a close frame that ends the connection
   * are different servers, and only this says which.
   */
  readonly peer?: string;
  /** Exact text expected for a given frame index, uncompressed or after inflation. */
  readonly answer?: string;
  readonly answerSha?: string;
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

/** What each case measured, so record mode can print the table this file then asserts on. */
const measured = new Map<string, Expect & { peerBeforeDestroy: string; tails: number }>();

const exchange = (scenario: Scenario, port: number) =>
  Effect.gen(function* () {
    yield* Effect.promise(async () => {
      const name = scenario.name;
      const probe = await connect(port);
      const wire = scenario.rawUpgrade ?? upgradeRequest(scenario.upgradeExtra ?? []);
      await probe.write(utf8(wire));

      const head = await probe.r.readHead(scenario.deadlineMs ?? 3000);
      const { statusLine, headers } = parseHead(head.text);
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
          // straight to the socket, and that difference is itself a claim.
          headers: headers.map(
            ([key, value]) => [key, key === "date" ? "__DATE__" : value] as [string, string],
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
  {
    name: "frame.streamDeflated",
    upgradeExtra: deflateOffer(),
    // The ack is written immediately, before chunk one has arrived: whether the server latches it is
    // `protocol-golden.ts`'s measurement; here the question is how the two chunks are framed and
    // whether the second references the first's deflate context.
    send: [
      {
        label: "call",
        bytes: encodeFrame(1, utf8(requestFrame(9140, "stream", { s: repeat("b", 4000) }))),
      },
      { label: "ack", bytes: encodeFrame(1, utf8('{"_tag":"Ack","requestId":9140}')) },
    ],
    settleMs: 900,
    deadlineMs: 7000,
    expect: { upgraded: true, c2s: 2, s2c: 3 },
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
  {
    name: "client.requestThenClose",
    // The race a real disconnect produces: the request and the close arrive back to back, so the
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
      { label: "close", bytes: closeBytes(1000, "after"), settleBeforeMs: 400 },
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

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const recordTable = () => {
  const rows = [...measured].map(
    ([name, value]) =>
      `${name.padEnd(32)} upgraded=${String(value.upgraded).padEnd(5)} c2s=${value.c2s} s2c=${value.s2c}` +
      ` closes=${JSON.stringify(value.closes)} tails=${value.tails} peer=${value.peerBeforeDestroy}`,
  );
  process.stderr.write(`${rows.join("\n")}\n`);
};

const check = Effect.sync(() => {
  const upgrades = events.filter((e) => e.event === "upgrade");
  const accepts = upgrades.flatMap((e) =>
    (e.headers ?? []).filter(([name]) => name === "sec-websocket-accept").map(([, value]) => value),
  );
  if (accepts.length !== upgrades.length) {
    throw new Error(
      `${upgrades.length - accepts.length} of ${upgrades.length} upgrades answered without Sec-WebSocket-Accept`,
    );
  }
  for (const accept of accepts) {
    if (accept !== EXPECTED_ACCEPT) {
      throw new Error(
        `Sec-WebSocket-Accept was ${accept}, expected ${EXPECTED_ACCEPT} for the RFC 6455 example key`,
      );
    }
  }

  // The `101` is written by the transport straight onto the socket, so it carries no `date`. Every
  // rejection that goes through the Node response pipeline does. Nothing in the port may rely on the
  // upgrade response having framework headers.
  for (const event of [...upgrades, ...events.filter((e) => e.event === "response")]) {
    const hasDate = (event.headers ?? []).some(([name]) => name === "date");
    if (hasDate !== (event.event === "response")) {
      throw new Error(
        `${event.case}: ${event.event} carried date=${hasDate}, which splits the two write paths`,
      );
    }
  }

  // `permessage-deflate` appears in the response exactly where it was offered, which is a claim about
  // the negotiation rather than about the frames that followed.
  for (const event of upgrades) {
    const extensions = (event.headers ?? []).filter(
      ([name]) => name === "sec-websocket-extensions",
    );
    const offered = (SCENARIOS.find((s) => s.name === event.case)?.upgradeExtra ?? []).some(
      (line) => line.startsWith("Sec-WebSocket-Extensions:"),
    );
    if (offered !== (extensions.length === 1)) {
      throw new Error(
        `${event.case}: offered=${offered} but the response carried ${JSON.stringify(extensions)}`,
      );
    }
    // A negotiated offer must come back naming the extension: `permessage-deflate; foo=bar` echoed
    // with unknown parameters would mean the server accepted parameters it cannot implement.
    if (offered && extensions[0]?.[1].split(";")[0]?.trim() !== "permessage-deflate") {
      throw new Error(
        `${event.case}: negotiated ${JSON.stringify(extensions[0]?.[1])} is not permessage-deflate`,
      );
    }
  }

  for (const scenario of SCENARIOS) {
    const got = measured.get(scenario.name);
    if (got === undefined) throw new Error(`${scenario.name}: never measured`);
    if (got.upgraded !== scenario.expect.upgraded) {
      throw new Error(
        `${scenario.name}: upgraded=${got.upgraded}, expected ${scenario.expect.upgraded}`,
      );
    }
    if (got.closes.join(",") !== (scenario.expect.closes ?? []).join(",")) {
      throw new Error(
        `${scenario.name}: closes were ${JSON.stringify(got.closes)}, expected ${JSON.stringify(scenario.expect.closes ?? [])}`,
      );
    }
    const out = frames.filter((f) => f.case === scenario.name && f.direction === "s2c");
    if (out.length !== scenario.expect.s2c) {
      throw new Error(
        `${scenario.name}: ${out.length} answer frames, expected ${scenario.expect.s2c}`,
      );
    }
    if (out.length === 1) {
      // One answer frame is a claim about content as well as count: either the plain payload or what
      // the compressed payload inflates to has to be exactly what the protocol layer wrote.
      const plain = out[0]!.payload ?? out[0]!.inflated;
      const digest = out[0]!.payloadSha ?? out[0]!.inflatedSha;
      if (scenario.expect.answer !== undefined && plain !== scenario.expect.answer) {
        throw new Error(
          `${scenario.name}: answer was ${JSON.stringify(plain)?.slice(0, 160)}, expected ${JSON.stringify(scenario.expect.answer).slice(0, 160)}`,
        );
      }
      if (scenario.expect.answerSha !== undefined && digest !== scenario.expect.answerSha) {
        throw new Error(
          `${scenario.name}: answer sha ${digest} is not the ${scenario.expect.answerSha} the rpc's own success schema produces`,
        );
      }
    }
  }

  // Answers are text or control, never masked, never fragmented and never binary: a Rust server that
  // sent a binary frame would contradict `protocol-golden.ts`, which recorded every frame as text.
  const badOut = frames
    .filter((f) => f.direction === "s2c")
    .filter((f) => f.masked || (f.opcode !== 1 && f.opcode !== 8 && f.opcode !== 10))
    .map((f) => `${f.case}: opcode ${f.opcodeName} masked=${f.masked}`);
  if (badOut.length > 0)
    throw new Error(`server wrote unexpected frames: ${JSON.stringify(badOut)}`);
  if (frames.some((f) => f.direction === "s2c" && !f.fin)) {
    throw new Error("the server fragmented an answer, which nothing in the port assumed");
  }
  // A compressed answer that does not inflate is a bug in *this file*, not the server: the artifact
  // would otherwise carry a `payloadBytes` no reader can use.
  const broken = frames.filter(
    (f) => f.direction === "s2c" && f.rsv1 && f.inflateError !== undefined,
  );
  if (broken.length > 0) {
    throw new Error(
      `compressed answer(s) that do not inflate: ${JSON.stringify(broken.map((f) => [f.case, f.inflateError]))}`,
    );
  }
  // Every answer frame the port has to reproduce must therefore be readable: either it is
  // uncompressed text, or it inflated.
  const unreadable = frames
    .filter((f) => f.direction === "s2c" && f.opcode === 1)
    .filter(
      (f) => f.payload === undefined && f.payloadSha === undefined && f.inflatedSha === undefined,
    )
    .map((f) => f.case);
  if (unreadable.length > 0)
    throw new Error(`text answer(s) with no recorded content: ${unreadable}`);

  const summary = {
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
    serialization: "RpcSerialization.layerJson",
    websocket: { perMessageDeflate: true },
  };
  process.stderr.write(`${JSON.stringify(summary)}\n`);
  process.stdout.write(`${JSON.stringify({ summary, frames, events }, undefined, 2)}\n`);
});

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
  if (process.env.LMCS_UPGRADE_GOLDEN_RECORD) {
    recordTable();
    process.stdout.write(
      `${JSON.stringify({ frames, events, measured: [...measured] }, undefined, 2)}\n`,
    );
    return;
  }
  yield* check;
}).pipe(Effect.scoped, Effect.provide(appLayer));

Effect.runPromise(run).then(
  () => process.exit(0),
  (cause) => {
    process.stderr.write(`upgrade-golden failed: ${cause}\n`);
    if (process.env.LMCS_UPGRADE_GOLDEN_RECORD || process.env.LMCS_UPGRADE_GOLDEN_DEBUG) {
      recordTable();
      process.stderr.write(`${JSON.stringify([...measured])}\n`);
    }
    process.exit(1);
  },
);
