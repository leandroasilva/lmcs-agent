import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import golden from "./fixtures/migration-oracle.json" with { type: "json" };
import { runMigrationOracle } from "./migration-oracle.ts";

// JSON is the portable boundary. No snapshot update or fixture-generation path exists here.
const portable = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

it.effect("matches the synthetic golden across independent SQLite sandboxes and reopen", () =>
  Effect.gen(function* () {
    const first = yield* runMigrationOracle;
    const second = yield* runMigrationOracle;
    assert.deepStrictEqual(portable(first.oracle), golden);
    assert.deepStrictEqual(portable(second.oracle), golden);
    assert.equal(first.oracle.latestSequence, 8);
    assert.equal(first.oracle.events.length, 8);
    assert.equal(first.oracle.receipts.length, 9);
    assert.deepStrictEqual(first.oracle.dispatch.acceptedRetry, { sequence: 1 });
    assert.equal(first.oracle.dispatch.rejectedInitial.tag, "OrchestrationCommandInvariantError");
    assert.equal(
      first.oracle.dispatch.rejectedRetry.tag,
      "OrchestrationCommandPreviouslyRejectedError",
    );
    assert.equal(first.oracle.reopenStable, true);
    assert.deepStrictEqual(first.oracle.persistence.journalMode, [{ journal_mode: "wal" }]);
    assert.equal(first.measurements.samples.length, 6);
    assert.isFalse("measurements" in first.oracle);
  }),
);

it.effect(
  "preserves legacy identities and receipts while upgrading migration 25 idempotently",
  () =>
    Effect.gen(function* () {
      const { oracle } = yield* runMigrationOracle;
      const { legacy } = oracle;
      assert.equal(legacy.fromMigration, 25);
      assert.equal(legacy.applied.length, 29);
      assert.deepStrictEqual(legacy.repeated, []);
      assert.deepStrictEqual(legacy.after.projects, legacy.before.projects);
      assert.deepStrictEqual(legacy.after.receipts, legacy.before.receipts);
      assert.deepStrictEqual(legacy.persistence, oracle.persistence);
      const selection = {
        instanceId: "claudeAgent",
        model: "claude-opus-4-6",
        options: [
          { id: "effort", value: "max" },
          { id: "thinking", value: false },
        ],
      };
      assert.deepStrictEqual(portable(legacy.snapshot.threads[0]?.modelSelection), selection);
      assert.deepStrictEqual(portable(legacy.replay.threads[0]?.modelSelection), selection);
      assert.equal(legacy.snapshot.threads[0]?.branch, "legacy-branch");
      assert.equal(legacy.events[1]?.causationEventId, legacy.events[0]?.eventId);
      assert.deepStrictEqual(portable(legacy.events.map((event) => event.correlationId)), [
        "legacy-correlation",
        "legacy-correlation",
      ]);
      assert.equal(legacy.reopenStable, true);
      assert.deepStrictEqual(portable(legacy), golden.legacy);
    }),
);

it.effect("records rather than hides existing snapshot versus replay differences", () =>
  Effect.gen(function* () {
    const { oracle } = yield* runMigrationOracle;
    // SQL breaks equal createdAt ties by message ID; the pure projector keeps event order.
    assert.deepStrictEqual(
      oracle.snapshot.threads[0]?.messages.map((message) => message.id),
      ["assistant-message", "user-message"],
    );
    assert.deepStrictEqual(
      oracle.replay.threads[0]?.messages.map((message) => message.id),
      ["user-message", "assistant-message"],
    );
    assert.equal(oracle.snapshot.threads[0]?.messages[0]?.text, "Hello back");
    assert.equal(oracle.snapshot.threads[0]?.messages[0]?.streaming, false);
    assert.equal(oracle.snapshot.threads[0]?.archivedAt, null);
    assert.equal(oracle.snapshot.projects[0]?.repositoryIdentity, null);
    assert.isFalse("repositoryIdentity" in oracle.replay.projects[0]!);
  }),
);
