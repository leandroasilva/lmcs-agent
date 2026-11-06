import { assert, it } from "@effect/vitest";
import { runMigrationDeviceHubWs } from "./migration-device-hub-ws.ts";

type Report = Awaited<ReturnType<typeof runMigrationDeviceHubWs>>;

const valueOf = (report: Report, id: string): unknown => {
  const result = report.results.find((entry) => entry.id === id);
  if (result === undefined) throw new Error(`Missing device hub upgrade check: ${id}`);
  return result.actual;
};

const actualOf = (report: Report, id: string): Record<string, unknown> =>
  valueOf(report, id) as Record<string, unknown>;

const failuresOf = (report: Report) => report.results.filter((result) => !result.passed);

it("characterizes the device hub upgrade branch on a real listener", async () => {
  const report = await runMigrationDeviceHubWs();
  assert.lengthOf(report.results, 25);
  assert.equal(new Set(report.results.map((result) => result.id)).size, 25);
  assert.deepEqual(failuresOf(report), []);
  assert.deepEqual(
    [...new Set(report.results.map((result) => result.subject))],
    ["environment: * /api/device-hub/*"],
  );
  assert.include(report.interpretation, "not an approved contract");
  assert.include(report.interpretation, "real ephemeral loopback listener");
  assert.include(report.interpretation, "the HttpClient dies if the upgrade branch touches it");
  assert.isAbove(report.knownLimitations.length, 0);
});

it("keeps upgrade fixtures isolated even when corpora run concurrently", async () => {
  const reports = await Promise.all([runMigrationDeviceHubWs(), runMigrationDeviceHubWs()]);
  for (const report of reports) {
    assert.deepEqual(failuresOf(report), []);
    // Each fixture owns its own two ephemeral ports, so the recorded dial is port-free and the
    // same in both runs.
    assert.equal(
      valueOf(report, "ticket-and-host-id-are-stripped-before-the-dial"),
      "/api/devices/ws?keep=1",
    );
    assert.equal(valueOf(report, "devices-ws-upgrades-with-read-scope"), true);
  }
});

it("pins upgrade gating, scope and readiness before any dial happens", async () => {
  const report = await runMigrationDeviceHubWs();
  assert.deepEqual(actualOf(report, "http-only-path-is-404-on-upgrade"), {
    status: 404,
    body: "Not Found",
  });
  assert.deepEqual(actualOf(report, "ws-path-with-extra-segment-is-404"), {
    status: 404,
    body: "Not Found",
  });
  assert.equal(actualOf(report, "helper-ws-with-read-scope-is-403").code, "insufficient_scope");
  assert.equal(
    actualOf(report, "helper-ws-with-read-scope-is-403").reasonOrScope,
    "orchestration:operate",
  );
  assert.equal(actualOf(report, "missing-credential-is-401-on-upgrade").code, "auth_invalid");
  assert.deepEqual(actualOf(report, "not-ready-hub-is-503-on-upgrade"), {
    status: 503,
    body: "Device hub is not running",
  });
  assert.equal(valueOf(report, "emu-ws-with-operate-scope-upgrades"), true);
  assert.equal(valueOf(report, "emu-ws-dials-the-vendor-path"), "/vendor/serve-emu/ws");
  assert.deepEqual(
    [
      valueOf(report, "http-only-path-never-dials"),
      valueOf(report, "ws-path-with-extra-segment-never-dials"),
      valueOf(report, "helper-ws-403-never-dials"),
      valueOf(report, "not-ready-hub-is-not-dialed"),
      valueOf(report, "refused-upstream-never-reaches-the-hub"),
    ],
    [0, 0, 0, 0, 0],
  );
  assert.deepEqual(actualOf(report, "missing-credential-stops-before-readiness-and-dial"), {
    authCalls: 1,
    readiness: 0,
    dials: 0,
  });
});

it("pins the dial, the frame pump in both directions and the close asymmetry", async () => {
  const report = await runMigrationDeviceHubWs();
  assert.deepEqual(valueOf(report, "readiness-receives-host-id-on-upgrade"), ["remote-1"]);
  // Unlike the HTTP leg, which forwards everything outside its drop list and rewrites Origin, the
  // upgrade leg carries no request headers at all: the client's own credentials and custom headers
  // never reach the hub.
  assert.deepEqual(actualOf(report, "the-upgrade-leg-forwards-no-request-headers"), {
    authorization: undefined,
    cookie: undefined,
    dpop: undefined,
    origin: undefined,
    "x-custom": undefined,
    "sec-websocket-protocol": undefined,
  });
  assert.deepEqual(valueOf(report, "client-to-upstream-frames-are-unchanged"), [
    { kind: "text", data: "client-text" },
    { kind: "binary", data: "AAEC/f7/" },
  ]);
  assert.deepEqual(valueOf(report, "upstream-to-client-frames-are-unchanged"), [
    { kind: "text", data: "hub-text" },
    { kind: "binary", data: "AAEC/f7/" },
  ]);
  assert.deepEqual(actualOf(report, "client-close-is-observed-by-the-client"), {
    code: 4001,
    reason: "client-reason",
  });
  // The proxy closes the upstream with a real 1000 close frame through its scope teardown...
  assert.deepEqual(actualOf(report, "client-close-closes-the-upstream-through-teardown"), {
    code: 1000,
    reason: "",
  });
  // ...but a hub that closes or refuses the dial ends the client socket with no close frame, so
  // the client sees 1005 and the hub's own 4002 never crosses the proxy.
  assert.deepEqual(actualOf(report, "upstream-close-ends-the-client-without-a-close-code"), {
    code: 1005,
    reason: "",
  });
  assert.deepEqual(actualOf(report, "the-hub-observed-its-own-close-code"), {
    code: 4002,
    reason: "",
  });
  assert.equal(valueOf(report, "refused-upstream-still-upgrades-the-client"), true);
  assert.deepEqual(actualOf(report, "refused-upstream-ends-the-client-without-a-close-code"), {
    code: 1005,
    reason: "",
  });
});
