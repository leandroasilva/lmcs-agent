import * as NodePerfHooks from "node:perf_hooks";
import * as NodeUtil from "node:util";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";

export const terminalSerializationWorkload = {
  frames: 512,
  warmups: 2,
  samples: 5,
  text: "ação 漢字\r\n".repeat(64),
} as const;

export function measureTerminalSerialization() {
  const { frames, warmups, samples, text } = terminalSerializationWorkload;
  const parser = RpcSerialization.json.makeUnsafe();
  const messages = Array.from(
    { length: frames },
    (_, sequence) =>
      ({
        _tag: "Chunk" as const,
        requestId: "1",
        values: [
          {
            type: "output",
            threadId: "thread-fixture",
            terminalId: "term-1",
            sequence,
            data: text,
          },
        ],
      }) satisfies RpcMessage.FromServerEncoded,
  );
  for (const message of messages) {
    const encoded = parser.encode(message);
    if (encoded === undefined || !NodeUtil.isDeepStrictEqual(parser.decode(encoded), [message])) {
      throw new Error("Terminal RPC JSON round trip failed before measurement.");
    }
  }
  const sampleResults = [];
  for (let sample = -warmups; sample < samples; sample++) {
    let bytes = 0;
    const start = NodePerfHooks.performance.now();
    for (const message of messages) {
      const encoded = parser.encode(message)!;
      bytes +=
        typeof encoded === "string" ? Buffer.byteLength(encoded, "utf8") : encoded.byteLength;
    }
    const durationMs = NodePerfHooks.performance.now() - start;
    if (sample >= 0) sampleResults.push({ durationMs, bytes });
  }
  return {
    operation: "terminal-rpc-json-encode-and-utf8-byte-accounting",
    interpretation:
      "Exploratory serialization only; excludes PTY, sockets, TLS, backpressure and rendering.",
    workload: { frames, warmups, samples, payloadBytesPerFrame: Buffer.byteLength(text, "utf8") },
    samples: sampleResults,
  };
}
