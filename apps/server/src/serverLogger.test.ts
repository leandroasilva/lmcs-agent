import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Tracer from "effect/Tracer";

import * as ServerConfig from "./config.ts";
import { ServerLoggerLive } from "./serverLogger.ts";

const configLayer = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseDir = path.join(NodeOS.tmpdir(), "lmcs-server-logger-test");
      const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      return ServerConfig.make({
        logLevel: "Info",
        traceMinLevel: "Info",
        traceTimingEnabled: false,
        traceBatchWindowMs: 200,
        traceMaxBytes: 1024,
        traceMaxFiles: 1,
        cwd: baseDir,
        baseDir,
        ...derivedPaths,
        mode: "web",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        port: 0,
        host: undefined,
        desktopBootstrapToken: undefined,
        desktopTelemetryFd: undefined,
        desktopTelemetryControlFd: undefined,
        resourceMonitorPath: undefined,
        staticDir: undefined,
        devUrl: undefined,
        devAllowedOrigins: [],
        noBrowser: false,
        startupPresentation: "browser",
        ...overrides,
      });
    }),
  ).pipe(Layer.provide(NodePath.layer));

/**
 * Logs inside a span so the tracer logger has somewhere to attach an event,
 * then reports what landed on the span.
 */
const logInSpanThrough = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracerLayer = Layer.succeed(
      Tracer.Tracer,
      Tracer.make({
        span: (spanOptions) => {
          const span = new Tracer.NativeSpan(spanOptions);
          spans.push(span);
          return span;
        },
      }),
    );
    yield* Effect.log("server logger under test").pipe(
      Effect.withSpan("server-logger-test"),
      Effect.provide(
        Layer.mergeAll(ServerLoggerLive.pipe(Layer.provide(configLayer(overrides))), tracerLayer),
      ),
    );
    return { spans };
  });

describe("ServerLoggerLive", () => {
  it.effect("attaches log messages to the active span", () =>
    Effect.gen(function* () {
      const { spans } = yield* logInSpanThrough({});

      assert.lengthOf(spans, 1);
      assert.deepEqual(
        spans[0]?.events.map(([name]) => name),
        ["server logger under test"],
      );
    }),
  );
});
