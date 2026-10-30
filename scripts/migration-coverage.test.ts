import * as NodeFSP from "node:fs/promises";
import { assert, it } from "@effect/vitest";
import {
  classifyMigrationInventory,
  migrationContractClassifications,
  migrationCoverage,
  migrationOwnership,
  validateOwnership,
  type ContractClassification,
} from "./migration-coverage.ts";

it("rejects a resource assigned to two cutover owners", () => {
  assert.deepEqual(validateOwnership(migrationOwnership), []);
  const conflicts = validateOwnership([
    ...migrationOwnership,
    { id: "rust-engine", currentWriter: "environment-rust", resources: ["orchestration-events"] },
  ]);
  assert.deepEqual(conflicts, ["orchestration-events is claimed by orchestration and rust-engine"]);
});

it("keeps the evidence and focused suite references navigable", async () => {
  const paths = [
    ...migrationOwnership.map((owner) => owner.evidence),
    ...migrationCoverage.focusedSuites.flatMap((suite) => suite.paths),
    ...migrationContractClassifications.flatMap((entry) => entry.tests),
    migrationCoverage.providerEvidence,
  ];
  for (const path of new Set(paths)) {
    const stats = await NodeFSP.stat(new URL(`../${path}`, import.meta.url));
    assert.isTrue(stats.isFile(), path);
  }
});

const sources = [
  { file: "apps/desktop/src/ipc/channels.ts", fingerprint: "a".repeat(64) },
  { file: "apps/desktop/src/preload.ts", fingerprint: "b".repeat(64) },
];
const finding = { code: "ipc-schema-not-declared", subject: "EVENT_CHANNEL", source: null };
const inventory = { sources, issues: [finding] };
const classification = {
  code: "ipc-schema-not-declared",
  subject: "EVENT_CHANNEL",
  owner: "desktop",
  resources: ["desktop-settings"],
  representation: "typescript-only",
  contract: "Event payload type, not a runtime decoder.",
  direction: "main-to-renderer",
  authorization: "Main-process event delivered through preload.",
  effects: "Delivers a settings-change notification to the renderer.",
  evidence: sources,
  tests: ["scripts/migration-coverage.test.ts"],
  parityRequirement: "Deliver and unsubscribe a settings event in the desktop client.",
} as const satisfies ContractClassification;

it("classifies source metadata without claiming tests ran or functional parity", () => {
  const result = classifyMigrationInventory(inventory, [classification]);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.reviewIssues, []);
  assert.equal(result.entries[0]!.status, "classified");
  assert.equal(result.pendingParity[0]!.status, "not-run");
  assert.deepEqual(result.pendingParity[0]!.tests, classification.tests);
  assert.deepEqual(inventory.issues, [finding]);
});

it("invalidates reviewed metadata when evidence changes or disappears", () => {
  for (const changed of [
    sources.map((source, index) => (index ? { ...source, fingerprint: "c".repeat(64) } : source)),
    sources.slice(0, 1),
  ]) {
    const result = classifyMigrationInventory({ ...inventory, sources: changed }, [classification]);
    assert.deepEqual(result.unresolved, [finding]);
    assert.equal(result.entries[0]!.status, "stale-or-invalid");
    assert.include(result.reviewIssues[0]!.reason, "Source evidence changed or is missing");
    assert.deepEqual(result.pendingParity, []);
  }
});

it("keeps new findings blocked and rejects dangling or ambiguous classifications", () => {
  const unknown = { ...finding, subject: "NEW_CHANNEL" };
  const added = classifyMigrationInventory({ ...inventory, issues: [finding, unknown] }, [
    classification,
  ]);
  assert.deepEqual(added.unresolved, [unknown]);
  const removed = classifyMigrationInventory({ ...inventory, issues: [] }, [classification]);
  assert.include(removed.reviewIssues[0]!.reason, "no longer matches");
  const duplicate = classifyMigrationInventory(inventory, [classification, classification]);
  assert.deepEqual(duplicate.unresolved, [finding]);
  assert.include(duplicate.reviewIssues[0]!.reason, "Multiple classifications");
  const duplicateFinding = classifyMigrationInventory(
    { ...inventory, issues: [finding, finding] },
    [classification],
  );
  assert.lengthOf(duplicateFinding.unresolved, 2);
  assert.include(duplicateFinding.reviewIssues[0]!.reason, "ambiguous");
});

it("requires ownership and distinct anchored evidence instead of accepting a whitelist", () => {
  for (const invalid of [
    { ...classification, resources: ["unowned-resource"] },
    { ...classification, evidence: [sources[1]!] },
    { ...classification, evidence: [sources[0]!, sources[0]!] },
    { ...classification, parityRequirement: "" },
  ]) {
    const result = classifyMigrationInventory(inventory, [invalid]);
    assert.deepEqual(result.unresolved, [finding]);
    assert.isAbove(result.reviewIssues.length, 0);
  }
  const scope = { code: "missing-rpc-scope", subject: "vcs.deleteBranch", source: null };
  const result = classifyMigrationInventory({ ...inventory, issues: [scope] }, [classification]);
  assert.deepEqual(result.unresolved, [scope]);
});
