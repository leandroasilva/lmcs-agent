// Scratch probe (não commitar): o oráculo da fatia 7 precisa do `EnvironmentAuth` real sobre um banco em
// memória, com segredo e relógio fixos e linhas de sessão de id fixo, para que o ticket gravado seja
// determinístico.

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, EnvironmentId } from "@lmcstools/core";

import * as ServerConfig from "../src/config.ts";
import * as AuthSessions from "../src/persistence/AuthSessions.ts";
import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as SessionStore from "../src/auth/SessionStore.ts";
import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";

const SECRET = Uint8Array.from({ length: 32 }, (_, index) => (index * 13 + 7) & 0xff);
const NOW = 1_700_000_000_000;
const at = (milliseconds: number) => DateTime.makeUnsafe(milliseconds);

const fixedSecrets = Layer.succeed(ServerSecretStore.ServerSecretStore, {
  get: () => Effect.succeed(Option.some(SECRET)),
  set: () => Effect.void,
  create: () => Effect.void,
  getOrCreateRandom: (_name: string, bytes: number) => Effect.succeed(SECRET.slice(0, bytes)),
  remove: () => Effect.void,
} satisfies ServerSecretStore.ServerSecretStore["Service"]);

const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(fixedSecrets),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("seam-probe")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "lmcs-seam-probe-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(TestClock.layer()),
);

const client = {
  label: "probe",
  ipAddress: null,
  userAgent: null,
  deviceType: "desktop",
  os: null,
  browser: null,
} as const;

const row = (sessionId: string, scopes: ReadonlyArray<string>) => ({
  sessionId: AuthSessionId.make(sessionId),
  subject: "seam-probe",
  scopes: scopes as never,
  method: "browser-session-cookie" as never,
  client,
  issuedAt: at(NOW - 1000),
  expiresAt: at(NOW + 600_000),
});

const asRequest = (url: string) => ({ method: "GET", url, originalUrl: url, headers: {} }) as never;

const probe = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const sessions = yield* SessionStore.SessionStore;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const repository = yield* AuthSessions.AuthSessionRepository;
  console.log(
    "repository",
    typeof repository.create,
    "auth fn",
    typeof auth.authenticateWebSocketUpgrade,
  );

  yield* repository.create(row("sess_read", ["orchestration:read"]));
  const ticket = yield* sessions.issueWebSocketToken(AuthSessionId.make("sess_read"));
  console.log("ticket", ticket.token);
  console.log("expiresAt", ticket.expiresAt);
  const attempt = auth.authenticateWebSocketUpgrade(
    asRequest(`/ws?wsTicket=${encodeURIComponent(ticket.token)}`),
  );
  console.log(
    "attempt keys",
    Object.getOwnPropertyNames(attempt as never),
    "iterable",
    Symbol.iterator in (attempt as never),
    "effect",
    Effect.isEffect ? Effect.isEffect(attempt) : "no isEffect",
    "either fn",
    typeof (Effect as never).either,
    "result fn",
    typeof (Effect as never).result,
  );
  const verified = yield* Effect.result(attempt as never);
  console.log("verified", JSON.stringify(verified));
  console.log(
    "bad",
    JSON.stringify(
      yield* Effect.result(auth.authenticateWebSocketUpgrade(asRequest("/ws?wsTicket=x.y"))),
    ),
  );
  // A row that is gone, a revoked row, and a row whose own expiry has passed.
  const missing = yield* sessions.issueWebSocketToken(AuthSessionId.make("sess_missing"));
  console.log(
    "missing",
    JSON.stringify(
      yield* Effect.result(
        auth.authenticateWebSocketUpgrade(
          asRequest(`/ws?wsTicket=${encodeURIComponent(missing.token)}`),
        ),
      ),
    ),
  );
  yield* repository.create(row("sess_revoked", ["access:write", "relay:read"]));
  yield* repository.revoke({ sessionId: AuthSessionId.make("sess_revoked"), revokedAt: at(NOW) });
  const revoked = yield* sessions.issueWebSocketToken(AuthSessionId.make("sess_revoked"));
  console.log(
    "revoked",
    JSON.stringify(
      yield* Effect.result(
        auth.authenticateWebSocketUpgrade(
          asRequest(`/ws?wsTicket=${encodeURIComponent(revoked.token)}`),
        ),
      ),
    ),
  );
  yield* repository.create({ ...row("sess_stale", ["orchestration:read"]), expiresAt: at(NOW) });
  const stale = yield* sessions.issueWebSocketToken(AuthSessionId.make("sess_stale"));
  console.log(
    "stale row",
    JSON.stringify(
      yield* Effect.result(
        auth.authenticateWebSocketUpgrade(
          asRequest(`/ws?wsTicket=${encodeURIComponent(stale.token)}`),
        ),
      ),
    ),
  );
  // An expired ticket: minted with a ttl in the past.
  const past = yield* sessions.issueWebSocketToken(AuthSessionId.make("sess_read"), {
    ttl: Duration.millis(-1),
  });
  console.log(
    "past ticket",
    JSON.stringify(
      yield* Effect.result(
        auth.authenticateWebSocketUpgrade(
          asRequest(`/ws?wsTicket=${encodeURIComponent(past.token)}`),
        ),
      ),
    ),
  );
  // The empty credential: no ticket at all, which falls through to the bearer/cookie path.
  console.log(
    "no ticket",
    JSON.stringify(yield* Effect.result(auth.authenticateWebSocketUpgrade(asRequest("/ws")))),
  );
});

Effect.runPromise(Effect.provide(authLayer)(probe)).then(
  () => console.log("OK"),
  (cause) => console.log("FAIL", String((cause as Error)?.stack ?? cause).slice(0, 3000)),
);
