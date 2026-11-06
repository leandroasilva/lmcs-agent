import { assert, it } from "@effect/vitest";
import { runMigrationStaticHttp } from "./migration-static-http.ts";

it("characterizes the static/dev fallback route against a synthetic build", async () => {
  const report = await runMigrationStaticHttp();
  assert.lengthOf(report.results, 30);
  assert.equal(new Set(report.results.map((result) => result.id)).size, 30);
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
  assert.include(report.interpretation, "hand-rolls its own If-None-Match");
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

it("pins the conditional round trip against the emitted validators", async () => {
  const report = await runMigrationStaticHttp();
  const row = (id: string) => {
    const result = report.results.find((entry) => entry.id === id);
    if (result === undefined) throw new Error(`Missing static check: ${id}`);
    return result.actual as {
      status: number;
      cacheControl: string | null;
      vary: string | null;
      etag: string | null;
      lastModified: string | null;
      body: string;
    };
  };

  const emitted = row("script-emits-weak-validator-and-last-modified");
  assert.match(emitted.etag ?? "", /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
  assert.isString(emitted.lastModified);

  for (const id of [
    "if-none-match-with-the-emitted-etag-returns-304",
    "if-none-match-compares-weakly-so-the-strong-form-matches",
    "if-none-match-list-containing-the-etag-returns-304",
    "if-modified-since-with-the-emitted-date-returns-304",
  ]) {
    const notModified = row(id);
    assert.equal(notModified.status, 304, id);
    assert.equal(notModified.body, "", id);
    assert.equal(notModified.vary, "Accept-Encoding", id);
    // A 304 keeps the validators, so a client can revalidate again without a full fetch.
    assert.deepEqual(
      { etag: notModified.etag, lastModified: notModified.lastModified },
      { etag: emitted.etag, lastModified: emitted.lastModified },
      id,
    );
  }

  for (const id of [
    "if-none-match-with-a-stale-etag-returns-200",
    "if-modified-since-with-an-older-date-returns-200",
    "if-none-match-takes-precedence-over-if-modified-since",
    "if-modified-since-with-an-unparsable-date-returns-200",
  ]) {
    assert.equal(row(id).status, 200, id);
    assert.isAbove(row(id).body.length, 0, id);
  }

  // HTML deliberately carries no validator, unlike the asset route's strong ETag on every file.
  const html = row("html-has-no-validator-so-if-modified-since-returns-200");
  assert.deepEqual(
    { status: html.status, etag: html.etag, lastModified: html.lastModified },
    { status: 200, etag: null, lastModified: null },
  );
  assert.equal(
    row("immutable-asset-304-keeps-immutable-cache-control").cacheControl,
    "public, max-age=31536000, immutable",
  );
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
