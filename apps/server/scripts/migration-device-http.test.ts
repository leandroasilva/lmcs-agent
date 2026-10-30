import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { runMigrationDeviceHttp } from "./migration-device-http.ts";

it("characterizes all four production device routes without a listener or credentials", async () => {
  const report = await runMigrationDeviceHttp();
  assert.lengthOf(report.results, 32);
  assert.equal(new Set(report.results.map((result) => result.id)).size, 32);
  assert.deepEqual(
    report.results.filter((result) => !result.passed),
    [],
  );
  assert.sameMembers(
    [...new Set(report.results.map((result) => result.subject))],
    [
      "environment: POST /api/devices",
      "environment: GET /api/devices",
      "environment: GET /api/devices/:deviceId",
      "environment: GET /api/devices/by-token/:token",
    ],
  );
  assert.include(report.interpretation, "not an approved security policy");
  assert.include(report.interpretation, "No listener, full server middleware");
});

it("keeps independently built route registries isolated even when corpora run concurrently", async () => {
  const reports = await Promise.all([runMigrationDeviceHttp(), runMigrationDeviceHttp()]);
  for (const report of reports) {
    assert.deepEqual(
      report.results.filter((result) => !result.passed),
      [],
    );
    assert.deepEqual(report.results.find((result) => result.id === "empty-list")?.actual, {
      status: 200,
      contentType: "application/json",
      cookies: [],
      body: { devices: [] },
    });
  }
});

it("checks that registration and replacement timestamps come from the current request", async () => {
  let now = 1_800_000_000_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now++);
  try {
    const report = await runMigrationDeviceHttp();
    assert.deepEqual(
      report.results.filter((result) => !result.passed),
      [],
    );
    const registrations = report.results.filter((result) => result.id.endsWith("-timestamp"));
    assert.lengthOf(registrations, 4);
    assert.isTrue(registrations.every((result) => result.actual === true));
  } finally {
    clock.mockRestore();
  }
});

it("reports out-of-window timestamps as failed checks rather than normalizing them away", async () => {
  let now = 1_800_000_000_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now--);
  try {
    const report = await runMigrationDeviceHttp();
    assert.sameMembers(
      report.results.filter((result) => !result.passed).map((result) => result.id),
      [
        "register-without-credentials-timestamp",
        "register-duplicate-token-timestamp",
        "upsert-replaces-device-timestamp",
        "empty-string-fields-are-accepted-timestamp",
      ],
    );
    for (const result of report.results.filter((result) => !result.passed)) {
      assert.isFalse(result.actual);
      assert.isTrue(result.expected);
    }
  } finally {
    clock.mockRestore();
  }
});
