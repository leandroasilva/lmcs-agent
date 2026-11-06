import * as NodeHttp from "node:http";
import * as NodeUtil from "node:util";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  LOCAL_DEVICE_HOST_ID,
  type AuthEnvironmentScope,
} from "@lmcstools/core";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import { DeviceService } from "../src/device/DeviceService.ts";
import { deviceHubProxyRouteLayer } from "../src/device/DeviceHubProxy.ts";

const subject = "environment: * /api/device-hub/*";
const ROUTE_PREFIX = "/api/device-hub";

const session = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): EnvironmentAuth.AuthenticatedSession => ({
  sessionId: AuthSessionId.make("synthetic-session"),
  subject: "synthetic-migration-client",
  method: "bearer-access-token",
  scopes,
});

interface Frame {
  readonly kind: "text" | "binary";
  readonly data: string;
}

const frame = (data: unknown, isBinary: boolean): Frame => ({
  kind: isBinary ? "binary" : "text",
  data: isBinary ? Buffer.from(data as ArrayBuffer).toString("base64") : String(data),
});

/** Appends every item and resolves `reached` from the append, never from a timer. */
const recorder = <T>() => {
  const recorded: T[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  return {
    recorded,
    push(item: T) {
      recorded.push(item);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index]!;
        if (recorded.length >= waiter.count) {
          waiters.splice(index, 1);
          waiter.resolve();
        }
      }
    },
    reached(count: number) {
      return recorded.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ count, resolve }));
    },
  };
};

interface HubConnection {
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

const HUB_HEADER_PROBE = [
  "authorization",
  "cookie",
  "dpop",
  "origin",
  "x-custom",
  "sec-websocket-protocol",
] as const;

/** A real `ws` listener on an ephemeral loopback port standing in for expo-device-hub. */
const openHub = async () => {
  const connections = recorder<HubConnection>();
  const received = recorder<Frame>();
  const closes = recorder<{ code: number; reason: string }>();
  const sockets: NodeSocket.NodeWS.WebSocket[] = [];
  const server = new NodeSocket.NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket, request) => {
    sockets.push(socket);
    const headers: Record<string, string | string[] | undefined> = {};
    for (const name of HUB_HEADER_PROBE) headers[name] = request.headers[name];
    connections.push({ path: request.url ?? "", headers });
    socket.on("message", (data, isBinary) => received.push(frame(data, isBinary)));
    socket.on("close", (code, reason) => closes.push({ code, reason: reason.toString() }));
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    connections,
    received,
    closes,
    sockets,
    send(data: string | Buffer) {
      for (const socket of sockets) socket.send(data);
    },
    close() {
      for (const socket of sockets) socket.terminate();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

interface FixtureOptions {
  /** `null` makes authentication fail with a missing credential. */
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope> | null;
  readonly ready?: boolean;
  /** Closes the hub listener before the proxy dials it. */
  readonly deadHub?: boolean;
}

const openFixture = async (options: FixtureOptions = {}) => {
  const hub = await openHub();
  // A hub whose listener is already closed makes the proxy's dial fail with a refusal.
  if (options.deadHub === true) await hub.close();
  const readinessCalls: Array<string | undefined> = [];
  let authCalls = 0;
  const scopes = options.scopes === undefined ? [AuthOrchestrationReadScope] : options.scopes;
  const authFails = scopes === null;
  const authError = new EnvironmentAuth.ServerAuthMissingCredentialError();

  // The route's requirements surface through HttpRouter.serve rather than through the route layer,
  // so the stubs are provided to the serve layer and merged back out to expose the bound address.
  const layer = HttpRouter.serve(deviceHubProxyRouteLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
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
                : { hostId: LOCAL_DEVICE_HOST_ID, hub: { origin: hub.origin } };
            }),
        } as unknown as DeviceService["Service"]),
        // The upgrade branch must not reach the HTTP client; if it does, the row dies loudly.
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die(new Error("the upgrade branch used HttpClient"))),
        ),
        Logger.layer([]),
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
          // Mirrors the production server's WebSocket framing setting.
          websocket: { perMessageDeflate: true },
        }),
      ),
    ),
  );

  const runtime = ManagedRuntime.make(layer);
  const address = await runtime.runPromise(
    Effect.map(HttpServer.HttpServer, (server) => server.address as NetAddress.InetAddress),
  );

  return {
    hub,
    origin: `http://127.0.0.1:${address.port}`,
    readinessCalls,
    authCalls: () => authCalls,
    dial(path: string, headers?: Record<string, string>) {
      return dialSocket(`${this.origin}${ROUTE_PREFIX}${path}`, headers);
    },
    async dispose() {
      await runtime.dispose();
      await hub.close();
    },
  };
};

interface DialFailure {
  readonly status: number;
  readonly body: string;
}

type DialOutcome =
  | { readonly socket: NodeSocket.NodeWS.WebSocket }
  | { readonly failure: DialFailure };

const dialSocket = (url: string, headers?: Record<string, string>) =>
  new Promise<DialOutcome>((resolve) => {
    const socket = new NodeSocket.NodeWS.WebSocket(url, { headers });
    const settle = (outcome: DialOutcome) => {
      socket.off("error", onError);
      socket.off("unexpected-response", onUnexpected);
      resolve(outcome);
    };
    const onError = () => settle({ failure: { status: 0, body: "" } });
    const onUnexpected = (
      _request: NodeHttp.IncomingMessage,
      response: NodeHttp.ServerResponse,
    ) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        settle({
          failure: {
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          },
        }),
      );
    };
    socket.once("open", () => settle({ socket }));
    socket.once("unexpected-response", onUnexpected);
    socket.once("error", onError);
  });

const failureOf = (outcome: DialOutcome) => ("failure" in outcome ? outcome.failure : null);
const socketOf = (outcome: DialOutcome) => ("socket" in outcome ? outcome.socket : null);

const statusBody = (failure: DialFailure | null) => {
  if (failure === null) return null;
  if (!failure.body.startsWith("{")) return { status: failure.status, body: failure.body };
  const record = JSON.parse(failure.body) as Record<string, unknown>;
  return {
    status: failure.status,
    code: record.code,
    reasonOrScope: record.reason ?? record.requiredScope,
    traceIdIsNonEmptyString: typeof record.traceId === "string" && record.traceId.length > 0,
  };
};

const closeOf = (socket: NodeSocket.NodeWS.WebSocket) =>
  new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });

const BINARY = Buffer.from([0, 1, 2, 253, 254, 255]);

export async function runMigrationDeviceHubWs() {
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

  // The upgrade allowlist is a different list from the HTTP one and is checked first.
  {
    const fixture = await openFixture();
    const outcome = await fixture.dial("/vendor/serve-sim/api");
    check("http-only-path-is-404-on-upgrade", statusBody(failureOf(outcome)), {
      status: 404,
      body: "Not Found",
    });
    check("http-only-path-never-dials", fixture.hub.connections.recorded.length, 0);
    await fixture.dispose();
  }
  {
    const fixture = await openFixture();
    const outcome = await fixture.dial("/api/devices/ws/extra");
    check("ws-path-with-extra-segment-is-404", statusBody(failureOf(outcome)), {
      status: 404,
      body: "Not Found",
    });
    check("ws-path-with-extra-segment-never-dials", fixture.hub.connections.recorded.length, 0);
    await fixture.dispose();
  }

  // Scope gating on the upgrade leg: the device feed is read, the vendor sockets are operate.
  {
    const fixture = await openFixture();
    const outcome = await fixture.dial("/vendor/serve-sim/helper/ws");
    check("helper-ws-with-read-scope-is-403", statusBody(failureOf(outcome)), {
      status: 403,
      code: "insufficient_scope",
      reasonOrScope: AuthOrchestrationOperateScope,
      traceIdIsNonEmptyString: true,
    });
    check("helper-ws-403-never-dials", fixture.hub.connections.recorded.length, 0);
    await fixture.dispose();
  }
  {
    const fixture = await openFixture({ scopes: [AuthOrchestrationOperateScope] });
    const outcome = await fixture.dial("/vendor/serve-emu/ws");
    const socket = socketOf(outcome);
    check("emu-ws-with-operate-scope-upgrades", socket !== null, true);
    await fixture.hub.connections.reached(1);
    check(
      "emu-ws-dials-the-vendor-path",
      fixture.hub.connections.recorded[0]?.path,
      "/vendor/serve-emu/ws",
    );
    socket?.terminate();
    await fixture.dispose();
  }

  // Credentials and readiness are settled before any socket is opened.
  {
    const fixture = await openFixture({ scopes: null });
    const outcome = await fixture.dial("/api/devices/ws");
    check("missing-credential-is-401-on-upgrade", statusBody(failureOf(outcome)), {
      status: 401,
      code: "auth_invalid",
      reasonOrScope: "missing_credential",
      traceIdIsNonEmptyString: true,
    });
    check(
      "missing-credential-stops-before-readiness-and-dial",
      {
        authCalls: fixture.authCalls(),
        readiness: fixture.readinessCalls.length,
        dials: fixture.hub.connections.recorded.length,
      },
      { authCalls: 1, readiness: 0, dials: 0 },
    );
    await fixture.dispose();
  }
  {
    const fixture = await openFixture({ ready: false });
    const outcome = await fixture.dial("/api/devices/ws");
    check("not-ready-hub-is-503-on-upgrade", statusBody(failureOf(outcome)), {
      status: 503,
      body: "Device hub is not running",
    });
    check("not-ready-hub-is-not-dialed", fixture.hub.connections.recorded.length, 0);
    await fixture.dispose();
  }

  // The dial itself: URL rewrite, ticket stripping and what the hub sees on the upgrade.
  {
    const fixture = await openFixture();
    const outcome = await fixture.dial(
      "/api/devices/ws?wsTicket=synthetic-ticket&hostId=remote-1&keep=1",
      {
        cookie: "synthetic-session-cookie",
        authorization: "Bearer synthetic-token",
        dpop: "synthetic-dpop",
        origin: "http://client.test",
        "x-custom": "1",
      },
    );
    const socket = socketOf(outcome);
    check("devices-ws-upgrades-with-read-scope", socket !== null, true);
    if (socket === null) throw new Error("The upgrade did not succeed.");
    await fixture.hub.connections.reached(1);
    const connection = fixture.hub.connections.recorded[0]!;
    check("readiness-receives-host-id-on-upgrade", fixture.readinessCalls, ["remote-1"]);
    check(
      "ticket-and-host-id-are-stripped-before-the-dial",
      connection.path,
      "/api/devices/ws?keep=1",
    );
    check(
      "the-upgrade-leg-forwards-no-request-headers",
      connection.headers,
      Object.fromEntries(HUB_HEADER_PROBE.map((name) => [name, undefined])),
    );
    // Frames are opaque in both directions: H.264 access units one way, input packets the other.
    socket.send("client-text");
    socket.send(BINARY);
    await fixture.hub.received.reached(2);
    check("client-to-upstream-frames-are-unchanged", fixture.hub.received.recorded.slice(0, 2), [
      { kind: "text", data: "client-text" },
      { kind: "binary", data: BINARY.toString("base64") },
    ]);
    const clientFrames = recorder<Frame>();
    socket.on("message", (data, isBinary) => clientFrames.push(frame(data, isBinary)));
    fixture.hub.send("hub-text");
    fixture.hub.send(BINARY);
    await clientFrames.reached(2);
    check("upstream-to-client-frames-are-unchanged", clientFrames.recorded.slice(0, 2), [
      { kind: "text", data: "hub-text" },
      { kind: "binary", data: BINARY.toString("base64") },
    ]);
    // Whichever side closes first ends the other through the proxy's scope teardown.
    const upstreamClosed = closeOf(socket);
    socket.close(4001, "client-reason");
    await fixture.hub.closes.reached(1);
    check("client-close-is-observed-by-the-client", await upstreamClosed, {
      code: 4001,
      reason: "client-reason",
    });
    check("client-close-closes-the-upstream-through-teardown", fixture.hub.closes.recorded[0], {
      code: 1000,
      reason: "",
    });
    await fixture.dispose();
  }

  // The hub closing first: the upstream close code never reaches the client, and the client side is
  // ended without a close handshake at all, while the upstream side is closed with a real 1000.
  {
    const fixture = await openFixture();
    const outcome = await fixture.dial("/api/devices/ws");
    const socket = socketOf(outcome);
    if (socket === null) throw new Error("The upgrade did not succeed.");
    await fixture.hub.connections.reached(1);
    const clientClosed = closeOf(socket);
    fixture.hub.sockets[0]!.close(4002, "hub-reason");
    check("upstream-close-ends-the-client-without-a-close-code", await clientClosed, {
      code: 1005,
      reason: "",
    });
    // The hub's own close event reports the code it sent but not the reason, which only travels
    // in the frame the peer receives.
    check("the-hub-observed-its-own-close-code", fixture.hub.closes.recorded[0], {
      code: 4002,
      reason: "",
    });
    await fixture.dispose();
  }

  // A hub that is gone by the time the proxy dials it.
  {
    const fixture = await openFixture({ deadHub: true });
    const outcome = await fixture.dial("/api/devices/ws");
    const socket = socketOf(outcome);
    check("refused-upstream-still-upgrades-the-client", socket !== null, true);
    const clientClosed = socket === null ? null : closeOf(socket);
    check(
      "refused-upstream-ends-the-client-without-a-close-code",
      clientClosed === null ? null : await clientClosed,
      {
        code: 1005,
        reason: "",
      },
    );
    check("refused-upstream-never-reaches-the-hub", fixture.hub.connections.recorded.length, 0);
    await fixture.dispose();
  }

  return {
    interpretation:
      "Executed the real * /api/device-hub/* upgrade branch on a real ephemeral loopback listener built by NodeHttpServer with the production perMessageDeflate setting, dialing a real ws WebSocketServer that stands in for expo-device-hub. EnvironmentAuth, DeviceService and HttpClient are stubbed; the HttpClient dies if the upgrade branch touches it. The shipped request.upgrade, Socket.makeWebSocket dial, pumpFrames loop, raceFirst and scope teardown all run for real, so frames, close propagation and the dial URL are observed rather than described. One asymmetry is recorded, not approved: the proxy closes the upstream with a real 1000 close frame when the client goes away, but a hub that closes or refuses the dial ends the client socket with no close frame at all, so the client observes 1005 and the hub's own code and reason never cross the proxy. No real hub, cookie/bearer/DPoP validation, readiness lifecycle, middleware, compression negotiation beyond the server setting or Rust implementation is exercised. These snapshots characterize the source at this revision; they are not an approved contract.",
    fixturePolicy:
      "Authentication, host readiness and the hub listener are fixed per fixture, and every fixture owns its own two ephemeral ports, so no row shares a socket with another. Ephemeral ports never appear in the recorded values: the hub-side URL is recorded as path and query only. Frame waits resolve from the recording append, never from a timer or a sleep.",
    knownLimitations: [
      "The hub is a local ws echo-less recorder, not expo-device-hub, so hub behaviour, its own authentication and its stream semantics are out of scope.",
      "Authentication is stubbed at the EnvironmentAuth service boundary; no real wsTicket, cookie, bearer or DPoP validation is performed, and the ticket minting route is not exercised.",
      "Host readiness is stubbed, so hub lifecycle, SSH/remote hosts and multi-host routing are not exercised.",
      "CORS, compression and command-readiness middleware are not mounted in this isolated router, and the response-write guard the production server wraps around createServer is not applied.",
      "Frames are pinned as text and one six-byte binary payload; large H.264 access units, fragmentation, backpressure and cancellation mid-stream remain untested.",
    ],
    results,
  };
}
