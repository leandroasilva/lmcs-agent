// Scratch probe: reads what the shipped Claude reset-credit code decides, before any Rust
// assertion is written. Deleted once the answers are known.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { HostProcessPlatform } from "@lmcstools/core/hostProcess";

import * as credits from "../src/provider/Layers/claudeResetCredits.ts";

const NOW_ISO = "2026-05-08T12:00:00.000Z";
const NOW = Date.parse(NOW_ISO);

const show = (label: string, value: unknown) => {
  console.log(`${label} => ${value === undefined ? "undefined" : JSON.stringify(value)}`);
};

console.log("### A: claudeResetCreditsToContract");

const grant = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "g1",
  resets_left: 2,
  usable_now: true,
  ...over,
});

// A1: the block's own shape.
for (const [label, block] of [
  ["not-eligible", { eligible: false }],
  ["missing-eligible", { grants: [grant()] }],
  ["eligible-string", { eligible: "true", grants: [grant()] }],
  ["eligible-1", { eligible: 1, grants: [grant()] }],
  ["null", null],
  ["undefined", undefined],
  ["string", "cedar"],
  ["number", 0],
  ["array", []],
  ["grants-null", { eligible: true, grants: null }],
  ["grants-object", { eligible: true, grants: {} }],
  ["grants-empty", { eligible: true, grants: [] }],
  ["next-id-null", { eligible: true, grants: [grant()], next_grant_id: null }],
  ["next-id-number", { eligible: true, grants: [grant()], next_grant_id: 7 }],
] as const) {
  show(`A1/${label}`, credits.claudeResetCreditsToContract(block as unknown, NOW));
}

// A2: one grant, every spelling of every field.
const one = (over: Record<string, unknown>) =>
  show(
    `A2/${JSON.stringify(over)}`,
    credits.claudeResetCreditsToContract(
      { eligible: true, grants: [grant(over)], next_grant_id: "g1" },
      NOW,
    ),
  );
for (const over of [
  {},
  { id: "G1" },
  { id: "g.dot" },
  { id: "" },
  { id: "x".repeat(41) },
  { id: "x".repeat(40) },
  { id: "a_b-c0" },
  { id: 5 },
  { resets_left: 0 },
  { resets_left: 1.5 },
  { resets_left: -1 },
  { resets_left: "2" },
  { resets_left: -0 },
  { resets_left: null },
  { resets_left: 1e21 },
  { resets_left: undefined },
  { paused: true },
  { paused: false },
  { paused: undefined },
  { paused: "true" },
  { usable_now: undefined },
  { usable_now: false },
  { usable_now: "yes" },
  { usable_now: 1 },
  { ends_at: null },
  { ends_at: undefined },
  { ends_at: "2026-05-08T12:00:00Z" },
  { ends_at: "2026-05-08T11:59:59.999Z" },
  { ends_at: "2026-05-08T12:00:00.000Z" },
  { ends_at: "2026-05-08T12:00:00+02:00" },
  { ends_at: "2026-05-08T12:00:00-0330" },
  { ends_at: "2026-05-08T12:00:00" },
  { ends_at: "2026-05-08" },
  { ends_at: " 2026-05-08T12:00:00Z" },
  { ends_at: "2026-05-08T12:00:00Z " },
  { ends_at: "2026-02-30T00:00:00Z" },
  { ends_at: "2026-02-28T00:00:00Z" },
  { ends_at: "2024-02-29T00:00:00Z" },
  { ends_at: "2026-13-01T00:00:00Z" },
  { ends_at: "2026-05-08T12:00:00.123456Z" },
  { ends_at: "2026-05-08t12:00:00z" },
  { ends_at: "2026-05-08T25:00:00Z" },
  { ends_at: "not a date" },
  { ends_at: 1777000000000 },
]) {
  one(over);
}

// A3: the next-grant rule, which is what decides whether the sum is said at all.
const many = (grants: Record<string, unknown>[], nextGrantId?: unknown) =>
  credits.claudeResetCreditsToContract(
    {
      eligible: true,
      grants,
      ...(nextGrantId === undefined ? {} : { next_grant_id: nextGrantId }),
    },
    NOW,
  );
show("A3/no-next-id", many([grant(), grant({ id: "g2" })]));
show("A3/next-not-live", many([grant()], "g9"));
show("A3/next-dropped", many([grant({ paused: true }), grant({ id: "g2" })], "g1"));
show("A3/next-and-sum", many([grant(), grant({ id: "g2", resets_left: 5 })], "g1"));
show(
  "A3/duplicate-ids",
  many([grant({ resets_left: 1 }), grant({ resets_left: 2 }), grant({ id: "g2" })], "g1"),
);
show(
  "A3/next-with-null-end",
  many([grant({ ends_at: null }), grant({ id: "g2", ends_at: "2026-06-01T00:00:00Z" })], "g2"),
);
show("A3/only-dropped", many([grant({ usable_now: false })], "g1"));
show(
  "A3/negative-and-big",
  many([grant({ resets_left: -0 }), grant({ id: "g2", resets_left: 1e21 }), grant()], "g1"),
);

console.log("### B: consumeClaudeResetCredit");

type ClaimFixture = {
  platform?: "darwin" | "linux" | "win32";
  credentials?: { contents: string } | { notFound: true } | { blocked: true };
  account?: { contents: string } | { notFound: true } | { blocked: true };
  response: { status: number; body?: string };
  grantId?: string;
  requestId?: string;
  version?: string;
};

function stubFs(fixture: ClaimFixture, seen: string[]) {
  const pick = (which: "credentials" | "account") =>
    which === "credentials" ? fixture.credentials : fixture.account;
  return FileSystem.makeNoop({
    readFileString: (path: string) => {
      seen.push(path);
      const kind = path.endsWith(".credentials.json") ? "credentials" : "account";
      const file = pick(kind);
      if (file && "contents" in file) return Effect.succeed(file.contents);
      if (file && "blocked" in file) {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFileString",
            description: "blocked",
            pathOrDescriptor: path,
          }),
        );
      }
      return Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
          description: "No such file or directory",
          pathOrDescriptor: path,
        }),
      );
    },
  });
}

function stubClient(fixture: ClaimFixture, seen: Record<string, unknown>) {
  return HttpClient.make((request) => {
    seen["request"] = {
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body: request.body?.toString(),
    };
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(fixture.response.body ?? null, {
          status: fixture.response.status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
}

async function runClaim(fixture: ClaimFixture) {
  const files: string[] = [];
  const request: Record<string, unknown> = {};
  const program = credits.consumeClaudeResetCredit({
    configDir: "/cfg",
    accountConfigPath: "/cfg/.claude.json",
    version: fixture.version ?? "1.2.3",
    grantId: fixture.grantId ?? "g1",
    requestId: fixture.requestId ?? "req1",
  });
  const outcome = await Effect.runPromise(
    program.pipe(
      Effect.match({
        onFailure: (error: unknown) => ({
          _tag: (error as { _tag?: string })?._tag,
          reason: (error as { reason?: string })?.reason,
          message: (error as { message?: string })?.message,
          isSettled: credits.isSettledClaudeResetCreditFailure(error),
          cause: String((error as { cause?: unknown })?.cause ?? ""),
        }),
        onSuccess: (value) => ({ outcome: value }),
      }),
      Effect.provide(TestClock.layer()),
      Effect.provide(Layer.succeed(HostProcessPlatform, fixture.platform ?? "linux")),
      Effect.provide(Layer.succeed(FileSystem.FileSystem, stubFs(fixture, files))),
      Effect.provide(Path.layer),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, stubClient(fixture, request))),
    ),
  );
  return { outcome, files, request };
}

const token = JSON.stringify({ claudeAiOauth: { accessToken: "tok" } });
const account = JSON.stringify({ oauthAccount: { organizationUuid: "org-1" } });
const claim = (result: string) => ({ status: 200, body: JSON.stringify({ result }) });

// B1: the id gate, before anything is read.
for (const [label, over] of [
  ["bad-grant-upper", { grantId: "G1" }],
  ["bad-grant-dot", { grantId: "g.1" }],
  ["bad-grant-empty", { grantId: "" }],
  ["bad-grant-long", { grantId: "g".repeat(41) }],
  ["bad-request", { requestId: "req!" }],
  ["bad-request-empty", { requestId: "" }],
] as const) {
  const ran = await runClaim({ response: claim("reset"), ...over });
  show(`B1/${label}`, { ...ran.outcome, files: ran.files, request: ran.request["request"] });
}

// B2: the credential stage.
for (const [label, over] of [
  ["darwin", { platform: "darwin" as const }],
  ["creds-notfound", { credentials: { notFound: true } as const }],
  ["creds-blocked", { credentials: { blocked: true } as const }],
  [
    "creds-blank-token",
    { credentials: { contents: JSON.stringify({ claudeAiOauth: { accessToken: "  " } }) } },
  ],
  ["creds-no-oauth", { credentials: { contents: "{}" } }],
  [
    "creds-token-number",
    { credentials: { contents: JSON.stringify({ claudeAiOauth: { accessToken: 5 } }) } },
  ],
  ["creds-not-object", { credentials: { contents: "[]" } }],
  ["account-notfound", { account: { notFound: true } as const }],
  ["account-blocked", { account: { blocked: true } as const }],
  [
    "account-blank-org",
    { account: { contents: JSON.stringify({ oauthAccount: { organizationUuid: " " } }) } },
  ],
  ["account-no-org", { account: { contents: "{}" } }],
  [
    "account-org-number",
    { account: { contents: JSON.stringify({ oauthAccount: { organizationUuid: 7 } }) } },
  ],
] as const) {
  const ran = await runClaim({
    credentials: { contents: token },
    account: { contents: account },
    response: claim("reset"),
    ...over,
  });
  show(`B2/${label}`, { ...ran.outcome, files: ran.files, request: ran.request["request"] });
}

// B3: statuses and results.
for (const [label, response] of [
  ["reset", claim("reset")],
  ["not-limited", claim("not_limited")],
  ["already-used", claim("already_used")],
  ["ineligible", claim("ineligible")],
  ["cooldown", claim("cooldown")],
  ["unavailable", claim("unavailable")],
  ["unknown-result", { status: 200, body: JSON.stringify({ result: "maybe" }) }],
  ["missing-result", { status: 200, body: "{}" }],
  ["bad-json", { status: 200, body: "not json" }],
  ["204", { status: 204 }],
  ["201", { status: 201, body: JSON.stringify({ result: "reset" }) }],
  ["401", { status: 401, body: JSON.stringify({ result: "reset" }) }],
  ["403", { status: 403, body: JSON.stringify({ result: "reset" }) }],
  ["404", { status: 404, body: JSON.stringify({ result: "reset" }) }],
  ["429", { status: 429, body: JSON.stringify({ result: "reset" }) }],
  ["500", { status: 500, body: JSON.stringify({ result: "reset" }) }],
] as const) {
  const ran = await runClaim({
    credentials: { contents: token },
    account: { contents: account },
    response,
  });
  show(`B3/${label}`, { ...ran.outcome, files: ran.files, request: ran.request["request"] });
}

// B4: what the request looks like, including the org escaping.
for (const [label, organizationUuid] of [
  ["plain", "org-1"],
  ["slash", "or/g1"],
  ["hash", "org#1"],
  ["space", "org 1"],
  ["percent", "org%41"],
  ["unicode", "orgçã"],
] as const) {
  const ran = await runClaim({
    credentials: { contents: token },
    account: { contents: JSON.stringify({ oauthAccount: { organizationUuid } }) },
    response: claim("reset"),
    version: "2.0.0-rc",
    grantId: "credit_9",
    requestId: "req_-abc123",
  });
  show(`B4/${label}`, { request: ran.request["request"] });
}

console.log("### C: claudeAccountConfigPath + clock");
show(
  "C/path-with-config-dir",
  await Effect.runPromise(credits.claudeAccountConfigPath("/cfg").pipe(Effect.provide(Path.layer))),
);
