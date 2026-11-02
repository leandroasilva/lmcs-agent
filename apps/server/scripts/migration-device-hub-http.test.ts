import { assert, it } from "@effect/vitest";
import { runMigrationDeviceHubHttp } from "./migration-device-hub-http.ts";

const valueOf = (
  report: Awaited<ReturnType<typeof runMigrationDeviceHubHttp>>,
  id: string,
): unknown => {
  const result = report.results.find((entry) => entry.id === id);
  if (result === undefined) throw new Error(`Missing device hub check: ${id}`);
  return result.actual;
};

const actualOf = (
  report: Awaited<ReturnType<typeof runMigrationDeviceHubHttp>>,
  id: string,
): Record<string, unknown> => valueOf(report, id) as Record<string, unknown>;

it("characterizes the device hub proxy without a listener or hub", async () => {
  const report = await runMigrationDeviceHubHttp();
  assert.lengthOf(report.results, 41);
  assert.equal(new Set(report.results.map((result) => result.id)).size, 41);
  assert.deepEqual(
    report.results.filter((result) => !result.passed),
    [],
  );
  assert.deepEqual(
    [...new Set(report.results.map((result) => result.subject))],
    ["environment: * /api/device-hub/*"],
  );
  assert.include(report.interpretation, "not an approved contract");
  assert.include(report.interpretation, "No listener, real hub");
  assert.isAbove(report.knownLimitations.length, 0);
});

it("keeps device hub fixtures isolated even when corpora run concurrently", async () => {
  const reports = await Promise.all([runMigrationDeviceHubHttp(), runMigrationDeviceHubHttp()]);
  for (const report of reports) {
    assert.deepEqual(
      report.results.filter((result) => !result.passed),
      [],
    );
    assert.deepEqual(actualOf(report, "read-scope-can-list-devices"), {
      status: 200,
      contentType: "text/plain;charset=UTF-8",
      cacheControl: "no-store, no-transform",
      contentEncoding: null,
      transferEncoding: null,
      connection: null,
      body: "frame",
    });
  }
});

it("pins path and method gating before authentication", async () => {
  const report = await runMigrationDeviceHubHttp();
  assert.deepEqual(actualOf(report, "unsupported-path-is-404"), {
    status: 404,
    contentType: "text/plain",
    body: "Not Found",
  });
  assert.deepEqual(actualOf(report, "post-to-read-only-path-is-405"), {
    status: 405,
    contentType: "text/plain",
    body: "Method Not Allowed",
  });
  assert.deepEqual(
    {
      authCalls: actualOf(report, "unsupported-path-does-not-authenticate").authCalls,
      upstream: actualOf(report, "method-gating-does-not-authenticate").upstream,
    },
    { authCalls: 0, upstream: 0 },
  );
  assert.equal(valueOf(report, "duo-panel-2-is-404"), 404);
  assert.equal(valueOf(report, "plain-get-to-websocket-path-is-404"), 404);
});

it("pins the scope matrix, query sanitization and response rewriting", async () => {
  const report = await runMigrationDeviceHubHttp();
  assert.equal(actualOf(report, "read-scope-cannot-change-fold").code, "insufficient_scope");
  assert.equal(
    actualOf(report, "read-scope-cannot-change-fold").reasonOrScope,
    "orchestration:operate",
  );
  assert.equal(valueOf(report, "operate-scope-can-change-fold"), 200);
  assert.deepEqual(actualOf(report, "fold-write-body-is-forwarded"), {
    method: "POST",
    body: '{"posture":"closed"}',
  });
  assert.equal(actualOf(report, "helper-websocket-upgrade-with-read-scope-is-403").status, 403);
  assert.equal(valueOf(report, "ticket-and-host-id-are-stripped"), "http://hub.test/api/devices");
  assert.deepEqual(valueOf(report, "credentials-and-hop-headers-are-dropped"), []);
  assert.equal(valueOf(report, "origin-rewrite-value"), "http://hub.test");
  assert.equal(
    actualOf(report, "upstream-status-and-content-type-are-preserved").cacheControl,
    "no-store, no-transform",
  );
});
