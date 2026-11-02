import * as NodeUtil from "node:util";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  LOCAL_DEVICE_HOST_ID,
  type AuthEnvironmentScope,
} from "@lmcstools/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";
import type { HttpClientRequest } from "effect/unstable/http";

import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import { DeviceService } from "../src/device/DeviceService.ts";
import { deviceHubProxyRouteLayer } from "../src/device/DeviceHubProxy.ts";

const subject = "environment: * /api/device-hub/*";

const BASE_URL = "http://migration.invalid/api/device-hub";

const DROPPED_REQUEST_HEADERS = [
  "authorization",
  "cookie",
  "dpop",
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "accept-encoding",
  "content-length",
] as const;

const session = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): EnvironmentAuth.AuthenticatedSession => ({
  sessionId: AuthSessionId.make("synthetic-session"),
  subject: "synthetic-migration-client",
  method: "bearer-access-token",
  scopes,
});

interface UpstreamCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface FixtureOptions {
  /** `null` makes authentication fail with a missing credential. */
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope> | null;
  readonly internalAuthError?: boolean;
  readonly ready?: boolean;
  readonly failUpstream?: boolean;
  readonly upstreamStatus?: number;
  readonly upstreamHeaders?: Record<string, string>;
  readonly upstreamBody?: string;
}

const readRequestBody = (request: HttpClientRequest.HttpClientRequest) => {
  const body = request.body;
  if (body._tag === "Stream") {
    return Stream.runCollect(body.stream).pipe(
      Effect.map((chunks) =>
        new TextDecoder().decode(Buffer.concat([...chunks].map((chunk) => Buffer.from(chunk)))),
      ),
      Effect.orElseSucceed(() => ""),
    );
  }
  if (body._tag === "Uint8Array") {
    return Effect.succeed(new TextDecoder().decode(body.body));
  }
  return Effect.succeed("");
};

const makeFixture = (options: FixtureOptions = {}) => {
  const calls: UpstreamCall[] = [];
  const readinessCalls: Array<string | undefined> = [];
  let authCalls = 0;
  const scopes = options.scopes === undefined ? [AuthOrchestrationReadScope] : options.scopes;
  const authFails = scopes === null || options.internalAuthError === true;
  const authError = options.internalAuthError
    ? new EnvironmentAuth.ServerAuthSessionCredentialValidationError({
        cause: new Error("private credential diagnostic"),
      })
    : new EnvironmentAuth.ServerAuthMissingCredentialError();

  const { handler, dispose } = HttpRouter.toWebHandler(
    deviceHubProxyRouteLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
            authenticateWebSocketUpgrade: () => {
              authCalls += 1;
              return authFails ? Effect.fail(authError) : Effect.succeed(session(scopes));
            },
          } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
          Layer.succeed(DeviceService, {
            currentReadiness: (hostId?: string) =>
              Effect.sync(() => {
                readinessCalls.push(hostId);
                return options.ready === false
                  ? null
                  : { hostId: LOCAL_DEVICE_HOST_ID, hub: { origin: "http://hub.test" } };
              }),
          } as unknown as DeviceService["Service"]),
          Logger.layer([]),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.gen(function* () {
                calls.push({
                  method: request.method,
                  url: request.url,
                  headers: { ...request.headers },
                  body: yield* readRequestBody(request),
                });
                if (options.failUpstream === true) {
                  return yield* Effect.die(new Error("upstream failed"));
                }
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(options.upstreamBody ?? "frame", {
                    status: options.upstreamStatus ?? 200,
                    headers: options.upstreamHeaders ?? {},
                  }),
                );
              }),
            ),
          ),
        ),
      ),
    ),
    { disableLogger: true },
  );

  return {
    handler,
    calls,
    readinessCalls,
    authCalls: () => authCalls,
    dispose,
  };
};

const textSnapshot = async (response: Response) => ({
  status: response.status,
  contentType: response.headers.get("content-type"),
  body: await response.text(),
});

const errorSnapshot = async (response: Response) => {
  const text = await response.text();
  const contentType = response.headers.get("content-type");
  const body: unknown = contentType === "application/json" && text ? JSON.parse(text) : text;
  const record = body as Record<string, unknown> | null;
  return {
    status: response.status,
    contentType,
    code: record?.code,
    reasonOrScope: record?.reason ?? record?.requiredScope,
    traceIdIsNonEmptyString: typeof record?.traceId === "string" && record.traceId.length > 0,
    bodyKeys: record ? Object.keys(record).sort() : null,
  };
};

const streamSnapshot = async (response: Response) => ({
  status: response.status,
  contentType: response.headers.get("content-type"),
  cacheControl: response.headers.get("cache-control"),
  contentEncoding: response.headers.get("content-encoding"),
  transferEncoding: response.headers.get("transfer-encoding"),
  connection: response.headers.get("connection"),
  body: await response.text(),
});

const forwardedDroppedHeaders = (call: UpstreamCall) =>
  DROPPED_REQUEST_HEADERS.filter((name) => call.headers[name] !== undefined);

export async function runMigrationDeviceHubHttp() {
  const results: {
    id: string;
    subject: typeof subject;
    passed: boolean;
    expected: unknown;
    actual: unknown;
  }[] = [];
  const check = (id: string, actual: unknown, expected: unknown) => {
    results.push({
      id,
      subject,
      passed: NodeUtil.isDeepStrictEqual(actual, expected),
      expected,
      actual,
    });
  };

  const request = (fixture: ReturnType<typeof makeFixture>, path: string, init?: RequestInit) =>
    fixture.handler(new Request(`${BASE_URL}${path}`, init));

  // Credential and internal auth failures are translated before any upstream work.
  {
    const fixture = makeFixture({ scopes: null });
    check(
      "missing-credential-is-401",
      await errorSnapshot(await request(fixture, "/api/devices")),
      {
        status: 401,
        contentType: "application/json",
        code: "auth_invalid",
        reasonOrScope: "missing_credential",
        traceIdIsNonEmptyString: true,
        bodyKeys: ["_tag", "code", "reason", "traceId"],
      },
    );
    check(
      "missing-credential-stops-before-readiness-and-upstream",
      {
        authCalls: fixture.authCalls(),
        readinessCalls: fixture.readinessCalls.length,
        upstream: fixture.calls.length,
      },
      { authCalls: 1, readinessCalls: 0, upstream: 0 },
    );
    fixture.dispose();
  }
  {
    const fixture = makeFixture({ internalAuthError: true });
    const response = await request(fixture, "/api/devices");
    const rawBody = await response.clone().text();
    check("internal-auth-error-is-500", await errorSnapshot(response), {
      status: 500,
      contentType: "application/json",
      code: "internal_error",
      reasonOrScope: "internal_error",
      traceIdIsNonEmptyString: true,
      bodyKeys: ["_tag", "code", "reason", "traceId"],
    });
    check(
      "internal-auth-error-does-not-leak-cause",
      rawBody.includes("private credential diagnostic"),
      false,
    );
    fixture.dispose();
  }

  // Path and method gating happens before authentication.
  {
    const fixture = makeFixture({ scopes: null });
    check(
      "unsupported-path-is-404",
      await textSnapshot(await request(fixture, "/vendor/serve-sim/exec", { method: "POST" })),
      {
        status: 404,
        contentType: "text/plain",
        body: "Not Found",
      },
    );
    check(
      "unsupported-path-does-not-authenticate",
      { authCalls: fixture.authCalls(), upstream: fixture.calls.length },
      { authCalls: 0, upstream: 0 },
    );
    check(
      "duo-panel-2-is-404",
      (await request(fixture, "/vendor/serve-sim/helper/duo/panel/2/stream.avcc")).status,
      404,
    );
    check(
      "plain-get-to-websocket-path-is-404",
      (await request(fixture, "/vendor/serve-emu/ws")).status,
      404,
    );
    check(
      "post-to-read-only-path-is-405",
      await textSnapshot(await request(fixture, "/api/devices", { method: "POST" })),
      { status: 405, contentType: "text/plain", body: "Method Not Allowed" },
    );
    check(
      "method-gating-does-not-authenticate",
      { authCalls: fixture.authCalls(), upstream: fixture.calls.length },
      { authCalls: 0, upstream: 0 },
    );
    fixture.dispose();
  }

  // Read scope reaches GET routes; operate scope gates tuning, input sockets and fold writes.
  {
    const fixture = makeFixture();
    check(
      "read-scope-can-list-devices",
      await streamSnapshot(await request(fixture, "/api/devices")),
      {
        status: 200,
        contentType: "text/plain;charset=UTF-8",
        cacheControl: "no-store, no-transform",
        contentEncoding: null,
        transferEncoding: null,
        connection: null,
        body: "frame",
      },
    );
    check(
      "devices-request-is-forwarded-with-method-and-origin",
      {
        method: fixture.calls[0]?.method,
        url: fixture.calls[0]?.url,
        origin: fixture.calls[0]?.headers.origin,
      },
      { method: "GET", url: "http://hub.test/api/devices", origin: undefined },
    );
    check(
      "read-scope-can-read-fold",
      (await request(fixture, "/vendor/serve-emu/api/fold?device=emulator-5554")).status,
      200,
    );
    check(
      "fold-read-is-forwarded-with-query",
      fixture.calls[1]?.url,
      "http://hub.test/vendor/serve-emu/api/fold?device=emulator-5554",
    );
    check(
      "read-scope-cannot-change-fold",
      await errorSnapshot(
        await request(fixture, "/vendor/serve-emu/api/fold?device=emulator-5554", {
          method: "POST",
          body: '{"posture":"closed"}',
        }),
      ),
      {
        status: 403,
        contentType: "application/json",
        code: "insufficient_scope",
        reasonOrScope: "orchestration:operate",
        traceIdIsNonEmptyString: true,
        bodyKeys: ["_tag", "code", "requiredScope", "traceId"],
      },
    );
    check("denied-fold-write-is-not-forwarded", fixture.calls.length, 2);
    check(
      "read-scope-can-post-screenshot",
      (await request(fixture, "/vendor/serve-sim/api/screenshot", { method: "POST" })).status,
      200,
    );
    check("screenshot-post-reaches-upstream", fixture.calls[2]?.method, "POST");
    check(
      "duo-panel-1-is-forwarded",
      (await request(fixture, "/vendor/serve-sim/helper/duo/panel/1/stream.avcc?wsTicket=secret"))
        .status,
      200,
    );
    check(
      "duo-panel-1-drops-the-ticket",
      fixture.calls[3]?.url,
      "http://hub.test/vendor/serve-sim/helper/duo/panel/1/stream.avcc",
    );
    fixture.dispose();
  }
  {
    const fixture = makeFixture({ scopes: [AuthOrchestrationOperateScope] });
    check(
      "operate-scope-can-tune-stream",
      (await request(fixture, "/vendor/serve-emu/api/stream-settings", { method: "POST" })).status,
      200,
    );
    check(
      "stream-tuning-reaches-upstream",
      fixture.calls[0]?.url,
      "http://hub.test/vendor/serve-emu/api/stream-settings",
    );
    const fold = await request(fixture, "/vendor/serve-emu/api/fold?device=emulator-5554", {
      method: "POST",
      body: '{"posture":"closed"}',
    });
    check("operate-scope-can-change-fold", fold.status, 200);
    check(
      "fold-write-body-is-forwarded",
      { method: fixture.calls[1]?.method, body: fixture.calls[1]?.body },
      { method: "POST", body: '{"posture":"closed"}' },
    );
    fixture.dispose();
  }
  {
    const fixture = makeFixture();
    check(
      "helper-websocket-upgrade-with-read-scope-is-403",
      await errorSnapshot(
        await request(fixture, "/vendor/serve-sim/helper/ws", {
          headers: { upgrade: "websocket" },
        }),
      ),
      {
        status: 403,
        contentType: "application/json",
        code: "insufficient_scope",
        reasonOrScope: "orchestration:operate",
        traceIdIsNonEmptyString: true,
        bodyKeys: ["_tag", "code", "requiredScope", "traceId"],
      },
    );
    check("denied-websocket-upgrade-is-not-forwarded", fixture.calls.length, 0);
    fixture.dispose();
  }

  // Readiness, host selection and query sanitization.
  {
    const fixture = makeFixture({ ready: false });
    check("not-ready-hub-is-503", await textSnapshot(await request(fixture, "/api/devices")), {
      status: 503,
      contentType: "text/plain",
      body: "Device hub is not running",
    });
    check("not-ready-hub-is-not-forwarded", fixture.calls.length, 0);
    fixture.dispose();
  }
  {
    const fixture = makeFixture();
    check(
      "host-id-selects-readiness",
      (await request(fixture, "/api/devices?hostId=remote-1")).status,
      200,
    );
    check("readiness-receives-host-id", fixture.readinessCalls, ["remote-1"]);
    check("ticket-and-host-id-are-stripped", fixture.calls[0]?.url, "http://hub.test/api/devices");
    fixture.dispose();
  }
  {
    const fixture = makeFixture();
    check(
      "ticket-and-host-id-stripping-keeps-other-query-params",
      (await request(fixture, "/api/devices?wsTicket=secret&hostId=remote-1&device=emulator-5554"))
        .status,
      200,
    );
    check(
      "remaining-query-params-are-forwarded",
      fixture.calls[0]?.url,
      "http://hub.test/api/devices?device=emulator-5554",
    );
    fixture.dispose();
  }

  // Header hygiene and response rewriting.
  {
    const fixture = makeFixture();
    const response = await request(fixture, "/api/devices", {
      headers: {
        cookie: "session=secret",
        authorization: "Bearer secret",
        dpop: "proof",
        "accept-encoding": "gzip",
        "x-custom": "1",
      },
    });
    check("header-hygiene-keeps-the-route-successful", response.status, 200);
    check(
      "credentials-and-hop-headers-are-dropped",
      forwardedDroppedHeaders(fixture.calls[0]!),
      [],
    );
    check("non-credential-headers-are-forwarded", fixture.calls[0]?.headers["x-custom"], "1");
    fixture.dispose();
  }
  {
    const fixture = makeFixture();
    check(
      "origin-is-rewritten-to-hub-origin",
      (await request(fixture, "/api/devices", { headers: { origin: "http://evil.invalid" } }))
        .status,
      200,
    );
    check("origin-rewrite-value", fixture.calls[0]?.headers.origin, "http://hub.test");
    fixture.dispose();
  }
  {
    const fixture = makeFixture({
      upstreamStatus: 418,
      upstreamHeaders: {
        "content-type": "image/png",
        "content-encoding": "gzip",
        "transfer-encoding": "chunked",
        connection: "close",
        "cache-control": "public, max-age=600",
      },
      upstreamBody: "pixels",
    });
    check(
      "upstream-status-and-content-type-are-preserved",
      await streamSnapshot(
        await request(fixture, "/vendor/serve-sim/api/screenshot", { method: "POST" }),
      ),
      {
        status: 418,
        contentType: "image/png",
        cacheControl: "no-store, no-transform",
        contentEncoding: null,
        transferEncoding: null,
        connection: null,
        body: "pixels",
      },
    );
    fixture.dispose();
  }
  {
    const fixture = makeFixture({ failUpstream: true });
    check("upstream-failure-is-500", await textSnapshot(await request(fixture, "/api/devices")), {
      status: 500,
      contentType: null,
      body: "",
    });
    check("upstream-failure-still-reaches-upstream", fixture.calls.length, 1);
    fixture.dispose();
  }

  return {
    interpretation:
      "Executed the real * /api/device-hub/* handler through HttpRouter.toWebHandler with stubbed EnvironmentAuth and DeviceService plus a recording in-memory HttpClient. No listener, real hub, WebSocket upgrade, cookie/bearer/DPoP validation, readiness lifecycle, middleware or Rust implementation is exercised. These snapshots characterize the source at this revision; they are not an approved contract.",
    fixturePolicy:
      "Authentication, host readiness and the upstream response are fixed per fixture; every upstream call is recorded with method, URL, headers and body. The corpus only asserts the dropped-header set, one forwarded custom header, the rewritten Origin and explicit response headers, not a full header dump.",
    knownLimitations: [
      "WebSocket upgrades cannot be carried by a Web Request: only the 403 scope denial is exercised, while frame pumping, close propagation and upstream dialing remain untested.",
      "The 400 response for an unparsable request URL is unreachable because the web handler requires a valid absolute URL.",
      "Authentication is stubbed at the EnvironmentAuth service boundary; no real ticket, cookie, bearer or DPoP validation is performed.",
      "Host readiness is stubbed, so hub lifecycle, SSH/remote hosts and multi-host routing are not exercised.",
      "CORS, compression and command-readiness middleware are not mounted in this isolated router.",
      "Upstream streaming, cancellation, aborted clients and MJPEG/AVCC backpressure remain untested.",
    ],
    results,
  };
}
