import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeUtil from "node:util";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@lmcstools/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpRouter } from "effect/unstable/http";
import { OtlpSerialization } from "effect/unstable/observability";
import * as BrowserTraceCollector from "../src/observability/BrowserTraceCollector.ts";
import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as ServerConfig from "../src/config.ts";
import { otlpTracesProxyRouteLayer } from "../src/http.ts";

const subject = "environment: POST /api/observability/v1/traces";

const session = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): EnvironmentAuth.AuthenticatedSession => ({
  sessionId: AuthSessionId.make("synthetic-session"),
  subject: "synthetic-migration-client",
  method: "bearer-access-token",
  scopes,
});

export async function runMigrationOtlpHttp() {
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

  // The auth stub mirrors the production order: credential validation happens
  // before the route reads the body or any ServerConfig field.
  const authState: { session: EnvironmentAuth.AuthenticatedSession | null } = { session: null };
  const recorded: unknown[] = [];
  const upstreamRequests: string[] = [];

  const { handler, dispose } = HttpRouter.toWebHandler(
    otlpTracesProxyRouteLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            authenticateHttpRequest: () =>
              authState.session === null
                ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError())
                : Effect.succeed(authState.session),
          }),
          Layer.mock(BrowserTraceCollector.BrowserTraceCollector)({
            record: (records) =>
              Effect.sync(() => {
                recorded.push(...records);
              }),
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                upstreamRequests.push(request.url);
              }).pipe(
                Effect.andThen(Effect.die("No upstream collector is configured for this corpus.")),
              ),
            ),
          ),
          OtlpSerialization.layerJson,
          ServerConfig.layerTest(process.cwd(), {
            prefix: "lmcs-migration-otlp-",
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
    { disableLogger: true },
  );

  const request = async (init?: RequestInit) => {
    const response = await handler(
      new Request("http://migration.invalid/api/observability/v1/traces", init),
    );
    const text = await response.text();
    const contentType = response.headers.get("content-type");
    const body: unknown = contentType === "application/json" && text ? JSON.parse(text) : text;
    return { status: response.status, contentType, cookies: response.headers.getSetCookie(), body };
  };
  const authenticatedRequest = (
    scopes: ReadonlyArray<AuthEnvironmentScope>,
    init?: RequestInit,
  ) => {
    authState.session = session(scopes);
    return request(init);
  };
  const errorShape = (actual: {
    status: number;
    contentType: string | null;
    cookies: string[];
    body: unknown;
  }) => {
    const body = actual.body as Record<string, unknown> | null;
    return {
      status: actual.status,
      contentType: actual.contentType,
      cookies: actual.cookies,
      code: body?.code,
      reasonOrScope: body?.reason ?? body?.requiredScope,
      traceIdIsNonEmptyString: typeof body?.traceId === "string" && body.traceId.length > 0,
      bodyKeys: body ? Object.keys(body).sort() : null,
    };
  };

  try {
    check(
      "anonymous-request-is-rejected-before-body-parsing",
      errorShape(
        await request({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      ),
      {
        status: 401,
        contentType: "application/json",
        cookies: [],
        code: "auth_invalid",
        reasonOrScope: "missing_credential",
        traceIdIsNonEmptyString: true,
        bodyKeys: ["_tag", "code", "reason", "traceId"],
      },
    );
    check(
      "read-scope-is-rejected-before-body-parsing",
      errorShape(
        await authenticatedRequest([AuthOrchestrationReadScope], {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      ),
      {
        status: 403,
        contentType: "application/json",
        cookies: [],
        code: "insufficient_scope",
        reasonOrScope: "orchestration:operate",
        traceIdIsNonEmptyString: true,
        bodyKeys: ["_tag", "code", "requiredScope", "traceId"],
      },
    );

    const operate = await authenticatedRequest([AuthOrchestrationOperateScope], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [] }),
    });
    check("operate-scope-response-with-current-config", operate, {
      status: 500,
      contentType: null,
      cookies: [],
      body: "",
    });
    check("operate-scope-records-no-traces-with-current-config", recorded.length, 0);
    check("operate-scope-requests-no-upstream-with-current-config", upstreamRequests, []);

    // The defect happens before body decoding, so malformed and valid JSON are
    // indistinguishable at the HTTP boundary today.
    check(
      "malformed-json-is-not-reached-with-current-config",
      await authenticatedRequest([AuthOrchestrationOperateScope], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      { status: 500, contentType: null, cookies: [], body: "" },
    );
    check(
      "get-is-not-served-by-this-route",
      await authenticatedRequest([AuthOrchestrationOperateScope]),
      { status: 404, contentType: null, cookies: [], body: "" },
    );
  } finally {
    await dispose();
  }

  return {
    interpretation:
      "Executed the real POST /api/observability/v1/traces handler through HttpRouter.toWebHandler with a stubbed EnvironmentAuth, a current-shape ServerConfig (no OTLP fields), an in-memory trace collector and a dying HttpClient. No listener, upstream collector, full server middleware, settings reload or Rust implementation is exercised. The 500 is characterization of the source at this revision, not an approved contract.",
    configPolicy:
      "The corpus uses ServerConfig.layerTest, which mirrors production construction. Commit 370a2edd removed otlpTracesUrl/otlpTracesExport from ServerConfig, but http.ts still reads both fields, so an authenticated request dies before request.json or the collector is reached.",
    knownDefects: [
      "apps/server/src/http.ts reads config.otlpTracesUrl and config.otlpTracesExport, which no longer exist in ServerConfig; apps/server/src/ws.ts references the same removed fields.",
      "The route therefore returns 500 for every authenticated request instead of 204/502; the existing server.test.ts OTLP success test now fails with 500 instead of 204, and trace decoding, recording and upstream forwarding are unreachable.",
      "The intended forwarding/502 behavior cannot be characterized from the current config contract; restoring or deleting telemetry is a product decision for Phase 1.",
    ],
    knownLimitations: [
      "Authentication is stubbed at the EnvironmentAuth service boundary; real cookie, bearer, DPoP, bootstrap and pairing validation are not exercised.",
      "CORS preflight, compression and command-readiness middleware are not mounted in this isolated router.",
      "No upstream collector, concurrent requests, cancellation, settings reload or persistence is covered.",
    ],
    results,
  };
}
