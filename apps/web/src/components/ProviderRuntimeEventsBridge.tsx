import { useEffect, useRef } from "react";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { WsRpcGroup } from "@lmcstools/core";
import type { ProviderRuntimeEvent } from "@lmcstools/core";
import { connectionAtomRuntime } from "~/connection/runtime";

/**
 * Bridge component that subscribes to provider runtime events via RPC
 * and dispatches them as custom DOM events for consumption by React hooks.
 *
 * This component should be mounted at the app root level to enable
 * real-time tool execution visibility in the UI.
 */
export function ProviderRuntimeEventsBridge() {
  const fiberRef = useRef<ReturnType<typeof Effect.runFork> | null>(null);

  useEffect(() => {
    // Create RPC client and subscribe to events
    const subscribe = Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      const events = client.subscribeProviderRuntimeEvents({});

      // Consume the stream and dispatch DOM events
      yield* Stream.runForEach(events, (event: ProviderRuntimeEvent) =>
        Effect.sync(() => {
          window.dispatchEvent(
            new CustomEvent("provider-runtime-event", {
              detail: event,
            }),
          );
        }),
      );
    });

    // Run the effect with the connection runtime context
    const effectWithRuntime = Effect.provide(subscribe, connectionAtomRuntime.context);

    // Run the effect
    fiberRef.current = Effect.runFork(effectWithRuntime);

    return () => {
      if (fiberRef.current) {
        Fiber.interrupt(fiberRef.current);
        fiberRef.current = null;
      }
    };
  }, []);

  return null;
}
