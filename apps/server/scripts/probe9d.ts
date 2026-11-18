// Scratch probe: what `readClaudeResetCredits` puts on the wire and when it gives up.
// Deleted once the answers are known.

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

type ReadFixture = {
  platform?: "darwin" | "linux";
  credentials?: { contents: string } | { notFound: true } | { blocked: true };
  response: { status: number; body?: string };
};

async function runRead(fixture: ReadFixture) {
  const files: string[] = [];
  const requests: unknown[] = [];
  const program = Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    return yield* credits.readClaudeResetCredits("/cfg", "1.2.3");
  });
  const outcome = await Effect.runPromise(
    program.pipe(
      Effect.match({
        onFailure: (error: unknown) => ({ failure: String(error) }),
        onSuccess: (value) => ({ value }),
      }),
      Effect.provide(TestClock.layer()),
      Effect.provide(Layer.succeed(HostProcessPlatform, fixture.platform ?? "linux")),
      Effect.provide(
        Layer.succeed(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: (path: string) => {
              files.push(path);
              const file = fixture.credentials;
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
          }),
        ),
      ),
      Effect.provide(Path.layer),
      Effect.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requests.push({
              method: request.method,
              url: request.url,
              headers: request.headers,
              body: (request.body as { text?: string } | undefined)?.text,
            });
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(fixture.response.body ?? null, {
                  status: fixture.response.status,
                  headers: { "content-type": "application/json" },
                }),
              ),
            );
          }),
        ),
      ),
    ),
  );
  return { outcome, files, requests };
}

const token = JSON.stringify({ claudeAiOauth: { accessToken: "tok" } });
const block = (grants: unknown[], next?: string) =>
  JSON.stringify({
    cedar_ember: { eligible: true, grants, ...(next === undefined ? {} : { next_grant_id: next }) },
  });
const grant = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "g1",
  resets_left: 2,
  usable_now: true,
  ...over,
});

for (const [label, fixture] of [
  [
    "ok",
    { credentials: { contents: token }, response: { status: 200, body: block([grant()], "g1") } },
  ],
  [
    "future",
    {
      credentials: { contents: token },
      response: {
        status: 200,
        body: block([grant({ ends_at: "2026-06-01T00:00:00.000Z" })], "g1"),
      },
    },
  ],
  [
    "at-now",
    {
      credentials: { contents: token },
      response: { status: 200, body: block([grant({ ends_at: NOW_ISO })], "g1") },
    },
  ],
  [
    "darwin",
    {
      platform: "darwin" as const,
      credentials: { contents: token },
      response: { status: 200, body: block([grant()], "g1") },
    },
  ],
  [
    "no-credentials",
    {
      credentials: { notFound: true } as const,
      response: { status: 200, body: block([grant()], "g1") },
    },
  ],
  [
    "blocked",
    {
      credentials: { blocked: true } as const,
      response: { status: 200, body: block([grant()], "g1") },
    },
  ],
  [
    "blank-token",
    {
      credentials: { contents: JSON.stringify({ claudeAiOauth: { accessToken: " " } }) },
      response: { status: 200, body: block([grant()], "g1") },
    },
  ],
  [
    "403",
    { credentials: { contents: token }, response: { status: 403, body: block([grant()], "g1") } },
  ],
  [
    "500",
    { credentials: { contents: token }, response: { status: 500, body: block([grant()], "g1") } },
  ],
  [
    "201",
    { credentials: { contents: token }, response: { status: 201, body: block([grant()], "g1") } },
  ],
  ["204", { credentials: { contents: token }, response: { status: 204 } }],
  ["bad-json", { credentials: { contents: token }, response: { status: 200, body: "not json" } }],
  ["empty-object", { credentials: { contents: token }, response: { status: 200, body: "{}" } }],
  [
    "null-block",
    { credentials: { contents: token }, response: { status: 200, body: '{"cedar_ember":null}' } },
  ],
  ["array-body", { credentials: { contents: token }, response: { status: 200, body: "[]" } }],
  ["scalar-body", { credentials: { contents: token }, response: { status: 200, body: "5" } }],
  [
    "extra-keys",
    {
      credentials: { contents: token },
      response: {
        status: 200,
        body: `{"cedar_ember":${JSON.stringify({ eligible: true, grants: [grant()], next_grant_id: "g1", other: 1 })},"spam":1}`,
      },
    },
  ],
] as const) {
  const ran = await runRead(fixture as ReadFixture);
  show(label, { ...ran.outcome, files: ran.files, requests: ran.requests });
}
