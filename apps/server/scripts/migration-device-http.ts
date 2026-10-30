import * as NodeUtil from "node:util";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import { HttpRouter } from "effect/unstable/http";
import * as DeviceRegistry from "../src/DeviceRegistry.ts";
import { deviceRoutesLayer } from "../src/device/http.ts";

const subjects = {
  register: "environment: POST /api/devices",
  list: "environment: GET /api/devices",
  byId: "environment: GET /api/devices/:deviceId",
  byToken: "environment: GET /api/devices/by-token/:token",
} as const;

const firstDevice = {
  deviceId: "device-a",
  token: "synthetic-shared-token",
  name: "Dispositivo 漢字",
  platform: "synthetic-ios",
};
const secondDevice = {
  deviceId: "synthetic-shared-token",
  token: "synthetic-shared-token",
  name: "Second device",
  platform: "synthetic-android",
};

const jsonResponse = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  cookies: [],
  body,
});
const missingDevice = jsonResponse({ error: "Device not found" }, 404);

export async function runMigrationDeviceHttp() {
  const results: {
    id: string;
    subject: (typeof subjects)[keyof typeof subjects];
    passed: boolean;
    expected: unknown;
    actual: unknown;
  }[] = [];
  const check = (
    id: string,
    subject: (typeof subjects)[keyof typeof subjects],
    actual: unknown,
    expected: unknown,
  ) => {
    results.push({
      id,
      subject,
      passed: NodeUtil.isDeepStrictEqual(actual, expected),
      expected,
      actual,
    });
  };
  const { handler, dispose } = HttpRouter.toWebHandler(
    deviceRoutesLayer.pipe(Layer.provideMerge(DeviceRegistry.layer)),
    { disableLogger: true },
  );
  const request = async (path: string, init?: RequestInit) => {
    const response = await handler(new Request(`http://migration.invalid${path}`, init));
    const text = await response.text();
    const contentType = response.headers.get("content-type");
    const body: unknown = contentType === "application/json" && text ? JSON.parse(text) : text;
    return { status: response.status, contentType, cookies: response.headers.getSetCookie(), body };
  };
  const register = async (id: string, device: typeof firstDevice) => {
    const before = Date.now();
    const response = await request("/api/devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...device,
        ignored: "extra-field",
        connected: false,
        registeredAt: -1,
      }),
    });
    const after = Date.now();
    const timestamp = Predicate.hasProperty(response.body, "registeredAt")
      ? response.body.registeredAt
      : null;
    check(
      `${id}-timestamp`,
      subjects.register,
      typeof timestamp === "number" &&
        Number.isSafeInteger(timestamp) &&
        timestamp >= before &&
        timestamp <= after,
      true,
    );
    const info = { ...device, registeredAt: timestamp, lastSeenAt: timestamp, connected: true };
    check(id, subjects.register, response, jsonResponse(info));
    return info;
  };

  try {
    check(
      "empty-list",
      subjects.list,
      await request("/api/devices"),
      jsonResponse({ devices: [] }),
    );
    const first = await register("register-without-credentials", firstDevice);
    const second = await register("register-duplicate-token", secondDevice);
    check(
      "list-includes-synthetic-tokens",
      subjects.list,
      await request("/api/devices"),
      jsonResponse({ devices: [first, second] }),
    );
    check(
      "id-lookup-ignores-query",
      subjects.byId,
      await request("/api/devices/device-a?token=unrelated"),
      jsonResponse(first),
    );
    check(
      "token-lookup-first-match-and-route-precedence",
      subjects.byToken,
      await request("/api/devices/by-token/synthetic-shared-token?deviceId=unrelated"),
      jsonResponse(first),
    );
    check(
      "id-equal-to-token-is-a-distinct-lookup",
      subjects.byId,
      await request("/api/devices/synthetic-shared-token"),
      jsonResponse(second),
    );

    const replacement = await register("upsert-replaces-device", {
      ...firstDevice,
      token: "synthetic-rotated-token",
      name: "Replacement",
      platform: "synthetic-linux",
    });
    check(
      "upsert-keeps-one-entry-and-insertion-order",
      subjects.list,
      await request("/api/devices"),
      jsonResponse({ devices: [replacement, second] }),
    );
    check(
      "old-token-no-longer-matches-replaced-device",
      subjects.byToken,
      await request("/api/devices/by-token/synthetic-shared-token"),
      jsonResponse(second),
    );
    check(
      "new-token-matches-replaced-device",
      subjects.byToken,
      await request("/api/devices/by-token/synthetic-rotated-token"),
      jsonResponse(replacement),
    );
    check(
      "id-lookup-sees-replacement",
      subjects.byId,
      await request("/api/devices/device-a"),
      jsonResponse(replacement),
    );

    for (const [id, subject, path] of [
      ["missing-id", subjects.byId, "/api/devices/missing"],
      ["missing-token", subjects.byToken, "/api/devices/by-token/missing"],
      ["encoded-id-is-not-decoded", subjects.byId, "/api/devices/%64evice-a"],
      [
        "encoded-token-is-not-decoded",
        subjects.byToken,
        "/api/devices/by-token/%73ynthetic-rotated-token",
      ],
    ] as const) {
      check(id, subject, await request(path), missingDevice);
    }
    for (const [id, subject, path] of [
      ["invalid-host-id-lookup", subjects.byId, "/api/devices/device-a"],
      [
        "invalid-host-token-lookup",
        subjects.byToken,
        "/api/devices/by-token/synthetic-rotated-token",
      ],
    ] as const) {
      check(
        id,
        subject,
        await request(path, { headers: { host: "[" } }),
        jsonResponse({ error: "Bad Request" }, 400),
      );
    }

    for (const [id, body, status] of [
      ["malformed-json", "{", 400],
      ["empty-body", "", 400],
      ["missing-fields", JSON.stringify({ deviceId: "device-a" }), 500],
      ["wrong-field-type", JSON.stringify({ ...firstDevice, token: 42 }), 500],
      ["null-body", "null", 500],
      ["array-body", "[]", 500],
    ] as const) {
      const response = await request("/api/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      check(id, subjects.register, response, { status, contentType: null, cookies: [], body: "" });
    }
    check(
      "rejected-registrations-do-not-mutate-state",
      subjects.list,
      await request("/api/devices"),
      jsonResponse({ devices: [replacement, second] }),
    );
    check(
      "head-uses-get-without-body",
      subjects.list,
      await request("/api/devices", { method: "HEAD" }),
      { status: 200, contentType: "application/json", cookies: [], body: "" },
    );
    const empty = await register("empty-string-fields-are-accepted", {
      deviceId: "",
      token: "",
      name: "",
      platform: "",
    });
    check(
      "empty-string-device-is-listed",
      subjects.list,
      await request("/api/devices"),
      jsonResponse({ devices: [replacement, second, empty] }),
    );
  } finally {
    await dispose();
  }

  return {
    interpretation:
      "Executed Node handlers and production in-memory DeviceRegistry through HttpRouter.toWebHandler with synthetic unauthenticated Requests. No listener, full server middleware, browser, native device or Rust implementation is exercised. Expected behavior is characterization, not an approved security policy.",
    timestampPolicy:
      "Registration timestamps must be integer wall-clock values within each request interval and equal lastSeenAt. Subsequent reads must preserve the exact observed timestamps. No global clock patch or timestamp normalization is used.",
    knownLimitations: [
      "Unauthenticated access and token disclosure are recorded, not endorsed; deployment-level authentication remains untested.",
      "Malformed JSON returns 400, but schema-invalid JSON produces 500; empty string fields and duplicate tokens are accepted.",
      "Lookup uses the encoded pathname segment rather than decoded router parameters.",
      "An invalid Host header reaches both lookup 400 branches in-process; real network URL and header parsing are not covered.",
      "No persistence/restart, concurrent requests, cancellation or client reconnection is proven by this in-process corpus.",
    ],
    results,
  };
}
