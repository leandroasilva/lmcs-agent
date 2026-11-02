import { assert, it } from "@effect/vitest";
import { runMigrationAssetHttp } from "./migration-asset-http.ts";

const actualOf = (
  report: Awaited<ReturnType<typeof runMigrationAssetHttp>>,
  id: string,
): Record<string, unknown> => {
  const result = report.results.find((entry) => entry.id === id);
  if (result === undefined) throw new Error(`Missing asset check: ${id}`);
  return result.actual as Record<string, unknown>;
};

it("characterizes the asset route against synthetic attachments", async () => {
  const report = await runMigrationAssetHttp();
  assert.lengthOf(report.results, 15);
  assert.equal(new Set(report.results.map((result) => result.id)).size, 15);
  assert.deepEqual(
    report.results.filter((result) => !result.passed),
    [],
  );
  assert.deepEqual(
    [...new Set(report.results.map((result) => result.subject))],
    ["environment: GET /api/assets/*"],
  );
  assert.include(report.interpretation, "not an approved contract");
  assert.include(report.interpretation, "No listener, workspace-file");
  assert.isAbove(report.knownLimitations.length, 0);
});

it("keeps asset fixtures isolated even when corpora run concurrently", async () => {
  const reports = await Promise.all([runMigrationAssetHttp(), runMigrationAssetHttp()]);
  for (const report of reports) {
    assert.deepEqual(
      report.results.filter((result) => !result.passed),
      [],
    );
    assert.deepEqual(actualOf(report, "image-is-served-inline").body, [97, 98, 99, 100, 101, 102]);
  }
});

it("pins claim rejection before any file is served", async () => {
  const report = await runMigrationAssetHttp();
  for (const id of [
    "missing-token-segment-is-not-found",
    "tampered-signature-is-not-found",
    "expired-token-is-not-found",
    "deleted-file-is-not-found",
    "post-is-not-served-by-the-asset-route",
  ]) {
    assert.equal(actualOf(report, id).status, 404, id);
  }
  assert.equal(actualOf(report, "invalid-host-is-a-bad-request").status, 400);
});

it("pins range, caching and disposition behavior", async () => {
  const report = await runMigrationAssetHttp();
  const image = actualOf(report, "image-ignores-range-request");
  assert.deepEqual(
    { status: image.status, acceptRanges: image.acceptRanges, contentRange: image.contentRange },
    { status: 200, acceptRanges: null, contentRange: null },
  );
  const videoRange = actualOf(report, "video-range-returns-partial-content");
  assert.deepEqual(
    {
      status: videoRange.status,
      cacheControl: videoRange.cacheControl,
      contentRange: videoRange.contentRange,
      contentLength: videoRange.contentLength,
    },
    {
      status: 206,
      cacheControl: "private, no-store",
      contentRange: "bytes 2-4/6",
      contentLength: "3",
    },
  );
  const unsatisfiable = actualOf(report, "video-unsatisfiable-range-is-416");
  assert.deepEqual(
    { status: unsatisfiable.status, contentRange: unsatisfiable.contentRange },
    { status: 416, contentRange: "bytes */6" },
  );
  assert.equal(
    actualOf(report, "generic-file-downloads-with-disposition").contentDisposition,
    'attachment; filename="report.pdf"',
  );
  assert.equal(
    actualOf(report, "html-inline-is-sandboxed").contentSecurityPolicy,
    "sandbox allow-scripts allow-forms allow-popups allow-modals",
  );
});
