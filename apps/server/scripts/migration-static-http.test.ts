import { assert, it } from "@effect/vitest";
import { runMigrationStaticHttp } from "./migration-static-http.ts";

it("characterizes the static/dev fallback route against a synthetic build", async () => {
  const report = await runMigrationStaticHttp();
  assert.lengthOf(report.results, 19);
  assert.equal(new Set(report.results.map((result) => result.id)).size, 19);
  assert.deepEqual(
    report.results.filter((result) => !result.passed),
    [],
  );
  assert.deepEqual(
    [...new Set(report.results.map((result) => result.subject))],
    ["environment: GET *"],
  );
  assert.include(report.interpretation, "does not prove a secure static policy");
  assert.include(report.interpretation, "No listener, compression");
});

it("keeps static fixtures isolated even when corpora run concurrently", async () => {
  const reports = await Promise.all([runMigrationStaticHttp(), runMigrationStaticHttp()]);
  for (const report of reports) {
    assert.deepEqual(
      report.results.filter((result) => !result.passed),
      [],
    );
    const root = report.results.find((result) => result.id === "root-serves-index-html")
      ?.actual as {
      body: string;
    };
    assert.equal(root.body, "<!doctype html><h1>synthetic index</h1>");
  }
});

it("pins SPA fallback, immutable caching and conditional response behavior", async () => {
  const report = await runMigrationStaticHttp();
  const actual = (id: string) =>
    report.results.find((result) => result.id === id)?.actual as {
      status: number;
      cacheControl: string | null;
      vary: string | null;
      etagIsWeakSizeMtime: boolean | null;
      body: string;
    };
  assert.equal(
    actual("missing-extension-file-falls-back-to-html-index").body,
    "<!doctype html><h1>synthetic index</h1>",
  );
  assert.equal(
    actual("manifest-asset-is-immutable").cacheControl,
    "public, max-age=31536000, immutable",
  );
  assert.equal(actual("hash-like-file-outside-manifest-is-revalidated").cacheControl, "no-cache");
  assert.deepEqual(
    {
      status: actual("if-none-match-star-returns-304-without-body").status,
      vary: actual("if-none-match-star-returns-304-without-body").vary,
      etag: actual("if-none-match-star-returns-304-without-body").etagIsWeakSizeMtime,
    },
    { status: 304, vary: "Accept-Encoding", etag: true },
  );
  assert.equal(actual("html-ignores-if-none-match-star").status, 200);
});

it("rejects encoded parent segments and invalid hosts before serving files", async () => {
  const report = await runMigrationStaticHttp();
  const status = (id: string) => {
    const result = report.results.find((entry) => entry.id === id);
    if (result === undefined) throw new Error(`Missing static check: ${id}`);
    return (result.actual as { status: number }).status;
  };
  assert.equal(status("encoded-parent-segment-is-rejected"), 400);
  assert.equal(status("invalid-host-is-a-bad-request"), 400);
  assert.equal(status("post-is-not-served-by-the-get-route"), 404);
  assert.equal(status("no-static-dir-and-no-dev-url"), 503);
});
