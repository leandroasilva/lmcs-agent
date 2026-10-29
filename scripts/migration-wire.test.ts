import { assert, describe, it } from "@effect/vitest";
import { evaluateWireCorpus, runWireCorpus } from "./migration-wire.ts";

const corpus = (cases: unknown[]) => ({
  formatVersion: 1,
  provenance: "synthetic-no-user-data",
  cases,
});

const terminalCase = {
  id: "terminal-size",
  schema: "TerminalResizeInput",
  input: { threadId: "thread-fixture", terminalId: "term-1", cols: 120, rows: 30 },
  expected: {
    accepted: true,
    encoded: { threadId: "thread-fixture", terminalId: "term-1", cols: 120, rows: 30 },
  },
} as const;

describe("migration wire oracle", () => {
  it("matches the fixed synthetic corpus without regenerating expected values", async () => {
    const results = await runWireCorpus();
    assert.deepEqual(
      results.filter((result) => !result.passed),
      [],
    );
    assert.isAtLeast(results.filter((result) => result.actual.accepted).length, 10);
    assert.isAtLeast(results.filter((result) => !result.actual.accepted).length, 5);
  });

  it("reports acceptance and payload drift instead of updating the golden", () => {
    const results = evaluateWireCorpus(
      corpus([
        { ...terminalCase, expected: { accepted: false } },
        {
          ...terminalCase,
          id: "changed-output",
          expected: {
            accepted: true,
            encoded: { ...terminalCase.expected.encoded, cols: 80 },
          },
        },
      ]),
    );
    assert.deepEqual(
      results.map((result) => result.passed),
      [false, false],
    );
    assert.deepEqual(results[0]?.actual, terminalCase.expected);
  });

  it("keeps rejection distinct from a harness or fixture error", () => {
    const result = evaluateWireCorpus(
      corpus([{ ...terminalCase, input: { cols: 0 }, expected: { accepted: false } }]),
    );
    assert.isTrue(result[0]!.passed);
    assert.throws(() => evaluateWireCorpus(corpus([{ ...terminalCase, schema: "Unknown" }])));
    assert.throws(() => evaluateWireCorpus(corpus([terminalCase, terminalCase])), /Duplicate/);
    assert.throws(() => evaluateWireCorpus(corpus([])), /must not be empty/);
  });
});
