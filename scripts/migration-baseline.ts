#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { HostProcessArchitecture, HostProcessPlatform } from "@lmcstools/core/hostProcess";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import oracleGolden from "../apps/server/scripts/fixtures/migration-oracle.json" with { type: "json" };
import { runMigrationDeviceHttp } from "../apps/server/scripts/migration-device-http.ts";
import { runMigrationOtlpHttp } from "../apps/server/scripts/migration-otlp-http.ts";
import { runMigrationOracle } from "../apps/server/scripts/migration-oracle.ts";
import { buildMigrationInventory } from "./migration-inventory.ts";
import {
  classifyMigrationInventory,
  migrationContractClassifications,
  migrationCoverage,
  migrationOwnership,
  validateOwnership,
} from "./migration-coverage.ts";
import { measureTerminalSerialization } from "./migration-metrics.ts";
import { runWireCorpus } from "./migration-wire.ts";

const root = NodeURL.fileURLToPath(new URL("..", import.meta.url));

export function baselineGate(input: {
  inventoryIssues: number;
  classificationIssues: number;
  pendingParityChecks: number;
  failedWireCases: number;
  failedDeviceHttpCases: number;
  failedOtlpHttpCases: number;
  knownRouteDefects: number;
  oracleMatchesGolden: boolean;
  ownershipIssues: number;
  unexercisedAreas: number;
}) {
  const blockers = [];
  if (input.inventoryIssues)
    blockers.push(`${input.inventoryIssues} inventory findings need classification or repair.`);
  if (input.classificationIssues)
    blockers.push(`${input.classificationIssues} contract classifications are stale or invalid.`);
  if (input.pendingParityChecks)
    blockers.push(
      `${input.pendingParityChecks} classified contracts still require functional parity checks.`,
    );
  if (input.failedWireCases)
    blockers.push(`${input.failedWireCases} wire golden cases differ from the Node oracle.`);
  if (input.failedDeviceHttpCases)
    blockers.push(
      `${input.failedDeviceHttpCases} device HTTP checks differ from the Node baseline.`,
    );
  if (input.failedOtlpHttpCases)
    blockers.push(`${input.failedOtlpHttpCases} OTLP HTTP checks differ from the Node baseline.`);
  if (input.knownRouteDefects)
    blockers.push(
      `${input.knownRouteDefects} known raw route defects must be resolved or explicitly accepted.`,
    );
  if (!input.oracleMatchesGolden)
    blockers.push("SQLite replay, receipts or migration output differ from the fixed golden.");
  if (input.ownershipIssues)
    blockers.push(`${input.ownershipIssues} resources have conflicting owners.`);
  if (input.unexercisedAreas)
    blockers.push(
      `${input.unexercisedAreas} coverage areas still require non-synthetic validation.`,
    );
  return { status: blockers.length ? ("blocked" as const) : ("ready" as const), blockers };
}

export const matchesOracleGolden = (oracle: unknown) =>
  NodeUtil.isDeepStrictEqual(JSON.parse(JSON.stringify(oracle)), oracleGolden);

export async function buildMigrationBaseline() {
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const inventory = await buildMigrationInventory(root);
  const wire = await runWireCorpus();
  const { result, platform, arch } = await Effect.runPromise(
    Effect.gen(function* () {
      return {
        result: yield* runMigrationOracle,
        platform: yield* HostProcessPlatform,
        arch: yield* HostProcessArchitecture,
      };
    }).pipe(Effect.provideService(Logger.LogToStderr, true)),
  );
  const { oracle, measurements } = result;
  const oracleMatchesGolden = matchesOracleGolden(oracle);
  const ownershipIssues = validateOwnership(migrationOwnership);
  const contractCoverage = classifyMigrationInventory(inventory, migrationContractClassifications);
  const deviceHttp = await runMigrationDeviceHttp();
  const otlpHttp = await runMigrationOtlpHttp();
  const gate = baselineGate({
    inventoryIssues: contractCoverage.unresolved.length,
    classificationIssues: contractCoverage.reviewIssues.length,
    pendingParityChecks: contractCoverage.pendingParity.length,
    failedWireCases: wire.filter((result) => !result.passed).length,
    failedDeviceHttpCases: deviceHttp.results.filter((result) => !result.passed).length,
    failedOtlpHttpCases: otlpHttp.results.filter((result) => !result.passed).length,
    knownRouteDefects: otlpHttp.knownDefects.length,
    oracleMatchesGolden,
    ownershipIssues: ownershipIssues.length,
    unexercisedAreas: migrationCoverage.notExercisedBySyntheticBaseline.length,
  });
  return {
    formatVersion: 1,
    phase: 0,
    generatedAt: new Date().toISOString(),
    revision: {
      head: git("rev-parse", "HEAD"),
      branch: git("branch", "--show-current"),
      dirty: git("status", "--porcelain").length > 0,
      lockfileSha256: NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(NodePath.join(root, "pnpm-lock.yaml")))
        .digest("hex"),
    },
    host: {
      node: process.version,
      platform,
      arch,
      logicalCpus: NodeOS.cpus().length,
    },
    gate,
    inventory,
    contractCoverage,
    deviceHttp,
    otlpHttp,
    wire: {
      interpretation: "Schema decode/encode only, not token verification or provider execution.",
      results: wire,
    },
    sqlite: {
      matchesGolden: oracleMatchesGolden,
      expectedFixture: "apps/server/scripts/fixtures/migration-oracle.json",
      interpretation:
        "Synthetic production-engine commands and migration-25 database; no real provider or complete historical database corpus.",
      knownDifferences: [
        "Equal-timestamp messages use message-ID order in SQL snapshots and event order in pure replay.",
        "SQL snapshots and pure replay differ in optional absent/null fields; neither output is silently normalized.",
      ],
      oracle,
    },
    ownership: {
      interpretation: "Declared cutover ownership; no new runtime locks or writers are installed.",
      entries: migrationOwnership,
      issues: ownershipIssues,
    },
    coverage: migrationCoverage,
    measurements: {
      interpretation:
        "Exploratory baseline, not evidence of improvement. Compare identical workloads on the same host/runtime.",
      sqlite: measurements,
      terminal: measureTerminalSerialization(),
    },
  };
}

export async function writeBaselineReport(file: string, report: unknown) {
  await NodeFSP.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

if (import.meta.main) {
  try {
    const { values } = NodeUtil.parseArgs({
      options: {
        output: { type: "string" },
        check: { type: "boolean" },
        help: { type: "boolean" },
      },
      strict: true,
    });
    if (values.help) {
      console.log(
        "Usage: node scripts/migration-baseline.ts [--output NEW_FILE] [--check]\nWrites a synthetic parity report; never reads live LMCS state. Existing output files are not overwritten. --check exits 2 while the gate is blocked.",
      );
    } else {
      const report = await buildMigrationBaseline();
      if (values.output) {
        await writeBaselineReport(values.output, report);
        console.log(`Baseline saved to ${values.output}; gate: ${report.gate.status}.`);
      } else console.log(JSON.stringify(report, null, 2));
      if (values.check && report.gate.status !== "ready") process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
