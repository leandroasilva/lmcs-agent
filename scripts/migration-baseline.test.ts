import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import oracleGolden from "../apps/server/scripts/fixtures/migration-oracle.json" with { type: "json" };
import { baselineGate, matchesOracleGolden, writeBaselineReport } from "./migration-baseline.ts";

const ready = {
  inventoryIssues: 0,
  classificationIssues: 0,
  pendingParityChecks: 0,
  failedWireCases: 0,
  failedDeviceHttpCases: 0,
  failedOtlpHttpCases: 0,
  knownRouteDefects: 0,
  oracleMatchesGolden: true,
  ownershipIssues: 0,
  unexercisedAreas: 0,
};
const cli = (...args: string[]) =>
  NodeChildProcess.spawnSync(
    process.execPath,
    [NodeURL.fileURLToPath(new URL("./migration-baseline.ts", import.meta.url)), ...args],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
  );

it("requires all parity criteria before declaring the gate ready", () => {
  assert.deepEqual(baselineGate(ready), { status: "ready", blockers: [] });
  for (const failure of [
    { inventoryIssues: 1 },
    { classificationIssues: 1 },
    { pendingParityChecks: 1 },
    { failedWireCases: 1 },
    { failedDeviceHttpCases: 1 },
    { failedOtlpHttpCases: 1 },
    { knownRouteDefects: 1 },
    { oracleMatchesGolden: false },
    { ownershipIssues: 1 },
    { unexercisedAreas: 1 },
  ]) {
    const gate = baselineGate({ ...ready, ...failure });
    assert.equal(gate.status, "blocked");
    assert.lengthOf(gate.blockers, 1);
  }
  assert.lengthOf(
    baselineGate({
      inventoryIssues: 1,
      classificationIssues: 1,
      pendingParityChecks: 1,
      failedWireCases: 1,
      failedDeviceHttpCases: 1,
      failedOtlpHttpCases: 1,
      knownRouteDefects: 1,
      oracleMatchesGolden: false,
      ownershipIssues: 1,
      unexercisedAreas: 1,
    }).blockers,
    10,
  );
});

it("detects oracle drift without regenerating or mutating the fixed golden", () => {
  assert.isTrue(matchesOracleGolden(oracleGolden));
  const modified = structuredClone(oracleGolden);
  modified.receipts[0]!.resultSequence += 1;
  assert.isFalse(matchesOracleGolden(modified));
  assert.isTrue(matchesOracleGolden(oracleGolden));
});

it("writes portable JSON exclusively and preserves an existing report", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "migration-report-"));
  try {
    const file = NodePath.join(directory, "baseline.json");
    const report = { formatVersion: 1, gate: baselineGate(ready) };
    await writeBaselineReport(file, report);
    assert.deepEqual(JSON.parse(await NodeFSP.readFile(file, "utf8")), report);
    const failure = await writeBaselineReport(file, { overwritten: true }).then(
      () => null,
      (error: NodeJS.ErrnoException) => error.code,
    );
    assert.equal(failure, "EEXIST");
    assert.deepEqual(JSON.parse(await NodeFSP.readFile(file, "utf8")), report);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("documents its CLI options and rejects unknown options", () => {
  const help = cli("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.include(help.stdout, "--check");
  assert.include(help.stdout, "Existing output files are not overwritten");
  const invalid = cli("--unknown-option");
  assert.equal(invalid.status, 1);
  assert.include(invalid.stderr, "unknown-option");
}, 30_000);

it("emits clean JSON and exits 2 for a blocked parity gate", () => {
  const result = cli("--check");
  assert.isUndefined(result.error);
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.phase, 0);
  assert.equal(report.gate.status, "blocked");
  assert.isTrue(report.sqlite.matchesGolden);
  assert.isTrue(report.wire.results.every((entry: { passed: boolean }) => entry.passed));
  assert.lengthOf(report.deviceHttp.results, 32);
  assert.isTrue(report.deviceHttp.results.every((entry: { passed: boolean }) => entry.passed));
  assert.include(report.deviceHttp.interpretation, "No listener, full server middleware");
  assert.sameMembers(
    [...new Set(report.deviceHttp.results.map((entry: { subject: string }) => entry.subject))],
    report.contractCoverage.pendingParity
      .filter((entry: { tests: string[] }) =>
        entry.tests.includes("apps/server/scripts/migration-device-http.test.ts"),
      )
      .map((entry: { subject: string }) => entry.subject),
  );
  assert.lengthOf(report.otlpHttp.results, 7);
  assert.isTrue(report.otlpHttp.results.every((entry: { passed: boolean }) => entry.passed));
  assert.include(report.otlpHttp.interpretation, "not an approved contract");
  assert.lengthOf(report.otlpHttp.knownDefects, 3);
  assert.sameMembers(
    [...new Set(report.otlpHttp.results.map((entry: { subject: string }) => entry.subject))],
    report.contractCoverage.pendingParity
      .filter((entry: { tests: string[] }) =>
        entry.tests.includes("apps/server/scripts/migration-otlp-http.test.ts"),
      )
      .map((entry: { subject: string }) => entry.subject),
  );
  assert.isTrue(
    report.gate.blockers.some((blocker: string) =>
      blocker.includes("known raw route defects must be resolved"),
    ),
  );
  assert.isAbove(report.inventory.rpc.length, 0);
  assert.isAbove(report.coverage.notExercisedBySyntheticBaseline.length, 0);
  assert.deepEqual(report.contractCoverage.reviewIssues, []);
  assert.lengthOf(report.contractCoverage.pendingParity, 25);
  assert.isTrue(
    report.contractCoverage.pendingParity.every(
      (entry: { status: string }) => entry.status === "not-run",
    ),
  );
  assert.isTrue(
    report.gate.blockers.some((blocker: string) =>
      blocker.includes("classified contracts still require functional parity"),
    ),
  );
  assert.equal(report.contractCoverage.entries.length, report.inventory.issues.length);
  assert.isFalse("measurements" in report.sqlite.oracle);
  assert.lengthOf(report.measurements.sqlite.samples, 6);
}, 30_000);

it("writes a report successfully without treating an unapproved gate as execution failure", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "migration-cli-"));
  try {
    const file = NodePath.join(directory, "baseline.json");
    const result = cli("--output", file);
    assert.isUndefined(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "gate: blocked");
    const report = JSON.parse(await NodeFSP.readFile(file, "utf8"));
    assert.equal(report.gate.status, "blocked");
    assert.isTrue(report.sqlite.matchesGolden);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}, 30_000);
