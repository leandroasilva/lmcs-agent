import * as NodeFSP from "node:fs/promises";
import { assert, it } from "@effect/vitest";
import { migrationCoverage, migrationOwnership, validateOwnership } from "./migration-coverage.ts";

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
    migrationCoverage.providerEvidence,
  ];
  for (const path of paths) {
    const stats = await NodeFSP.stat(new URL(`../${path}`, import.meta.url));
    assert.isTrue(stats.isFile(), path);
  }
});
