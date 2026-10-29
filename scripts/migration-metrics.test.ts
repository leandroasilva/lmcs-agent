import { assert, it } from "@effect/vitest";
import {
  measureTerminalSerialization,
  terminalSerializationWorkload,
} from "./migration-metrics.ts";

it("accounts for actual RPC JSON envelope and UTF-8 bytes, not character counts", () => {
  const result = measureTerminalSerialization();
  const { frames, text } = terminalSerializationWorkload;
  const payloadBytes = Buffer.byteLength(text, "utf8");
  assert.isAbove(payloadBytes, text.length);
  let expected = 0;
  for (let sequence = 0; sequence < frames; sequence++) {
    expected += Buffer.byteLength(
      JSON.stringify({
        _tag: "Chunk",
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
      }),
      "utf8",
    );
  }
  assert.equal(result.samples.length, 5);
  for (const sample of result.samples) {
    assert.equal(sample.bytes, expected);
    assert.isAbove(sample.bytes, payloadBytes * frames);
    assert.isAtLeast(sample.durationMs, 0);
    assert.isTrue(Number.isFinite(sample.durationMs));
  }
});
