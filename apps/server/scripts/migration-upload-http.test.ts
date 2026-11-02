import { assert, it } from "@effect/vitest";
import { runMigrationUploadHttp } from "./migration-upload-http.ts";

it("characterizes the attachment upload route against a synthetic directory", async () => {
  const report = await runMigrationUploadHttp();
  assert.lengthOf(report.results, 19);
  assert.equal(new Set(report.results.map((result) => result.id)).size, 19);
  assert.deepEqual(
    report.results.filter((result) => !result.passed),
    [],
  );
  assert.deepEqual(
    [...new Set(report.results.map((result) => result.subject))],
    ["environment: POST /api/attachments/upload/*"],
  );
  assert.include(report.interpretation, "not an approved contract");
  assert.include(report.interpretation, "No listener, authentication middleware");
  assert.isAbove(report.knownLimitations.length, 0);
});

it("keeps upload fixtures isolated even when corpora run concurrently", async () => {
  const reports = await Promise.all([runMigrationUploadHttp(), runMigrationUploadHttp()]);
  for (const report of reports) {
    assert.deepEqual(
      report.results.filter((result) => !result.passed),
      [],
    );
    const files = report.results.find(
      (result) => result.id === "file-upload-keeps-lowercased-extension",
    )?.actual as { files: string[] };
    assert.deepEqual(files.files, ["pending-<uuid>-pdf.pdf"]);
  }
});

it("pins token rejection before body handling", async () => {
  const report = await runMigrationUploadHttp();
  const status = (id: string) => {
    const result = report.results.find((entry) => entry.id === id);
    if (result === undefined) throw new Error(`Missing upload check: ${id}`);
    return (result.actual as { status: number }).status;
  };
  assert.equal(status("missing-token-is-not-found"), 404);
  assert.equal(status("malformed-token-is-not-found"), 404);
  assert.equal(status("tampered-signature-is-not-found"), 404);
  assert.equal(status("extra-token-segment-is-not-found"), 404);
  assert.equal(status("expired-token-is-not-found"), 404);
  assert.equal(status("get-is-not-served-by-this-route"), 404);
});

it("pins declared-size enforcement and exact-byte storage", async () => {
  const report = await runMigrationUploadHttp();
  const actual = (id: string) => {
    const result = report.results.find((entry) => entry.id === id);
    if (result === undefined) throw new Error(`Missing upload check: ${id}`);
    return result.actual as {
      status: number;
      body: string;
      files?: string[];
      bytes?: number[];
    };
  };
  assert.deepEqual(
    {
      status: actual("content-length-mismatch-is-rejected").status,
      body: actual("content-length-mismatch-is-rejected").body,
    },
    { status: 400, body: "Content-Length must match the upload size." },
  );
  assert.equal(actual("short-body-is-rejected").body, "Body was 3 bytes, expected 6.");
  assert.equal(actual("long-body-is-rejected").body, "Body was 7 bytes, expected 6.");
  assert.deepEqual(actual("rejected-bodies-leave-no-files").files ?? [], []);
  assert.deepEqual(actual("chunked-body-writes-concatenated-bytes").bytes, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(actual("exact-body-writes-one-complete-file").files, ["pending-<uuid>.png"]);
});
