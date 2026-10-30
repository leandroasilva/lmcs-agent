import { assert, it } from "@effect/vitest";
import { runMigrationOtlpHttp } from "./migration-otlp-http.ts";

it("characterizes the OTLP trace route through its current config-induced failure", async () => {
  const report = await runMigrationOtlpHttp();
  assert.lengthOf(report.results, 7);
  assert.equal(new Set(report.results.map((result) => result.id)).size, 7);
  assert.deepEqual(
    report.results.filter((result) => !result.passed),
    [],
  );
  assert.deepEqual(
    [...new Set(report.results.map((result) => result.subject))],
    ["environment: POST /api/observability/v1/traces"],
  );
  assert.include(report.interpretation, "not an approved contract");
  assert.include(report.configPolicy, "370a2edd");
  assert.include(report.configPolicy, "otlpTracesExport");
  assert.lengthOf(report.knownDefects, 3);
  assert.isTrue(report.knownDefects.some((defect) => defect.includes("http.ts")));
  assert.isTrue(report.knownDefects.some((defect) => defect.includes("ws.ts")));
});

it("keeps OTLP handler state isolated even when corpora run concurrently", async () => {
  const reports = await Promise.all([runMigrationOtlpHttp(), runMigrationOtlpHttp()]);
  for (const report of reports) {
    assert.deepEqual(
      report.results.filter((result) => !result.passed),
      [],
    );
    assert.deepEqual(
      report.results.find(
        (result) => result.id === "operate-scope-requests-no-upstream-with-current-config",
      )?.actual,
      [],
    );
  }
});

it("proves credential and scope rejection happen before request body decoding", async () => {
  const report = await runMigrationOtlpHttp();
  const byId = (id: string) =>
    report.results.find((result) => result.id === id)?.actual as {
      status: number;
      bodyKeys: string[] | null;
    };
  assert.equal(byId("anonymous-request-is-rejected-before-body-parsing").status, 401);
  assert.equal(byId("read-scope-is-rejected-before-body-parsing").status, 403);
  assert.deepEqual(byId("read-scope-is-rejected-before-body-parsing").bodyKeys, [
    "_tag",
    "code",
    "requiredScope",
    "traceId",
  ]);
  assert.equal(byId("malformed-json-is-not-reached-with-current-config").status, 500);
});
