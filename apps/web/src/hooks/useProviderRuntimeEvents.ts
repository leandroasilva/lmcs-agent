import { useEffect, useRef, useState, useCallback } from "react";
import type { ProviderRuntimeEvent } from "@lmcstools/core";

export interface UseProviderRuntimeEventsOptions {
  /** Whether to subscribe to events. */
  enabled?: boolean;
  /** Filter events by provider instance id. */
  instanceId?: string;
  /** Filter events by thread id. */
  threadId?: string;
}

export interface UseProviderRuntimeEventsResult {
  /** Latest events received. */
  events: ReadonlyArray<ProviderRuntimeEvent>;
  /** Events filtered by type. */
  toolCallEvents: ReadonlyArray<ProviderRuntimeEvent>;
  /** Whether the subscription is active. */
  isActive: boolean;
  /** Clear all events. */
  clear: () => void;
}

/**
 * Subscribe to provider runtime events in real-time.
 *
 * Returns all events emitted by providers, with optional filtering by
 * instance id or thread id. Events are accumulated in memory and can be
 * cleared with the `clear` function.
 */
export function useProviderRuntimeEvents(
  options: UseProviderRuntimeEventsOptions = {},
): UseProviderRuntimeEventsResult {
  const { enabled = true, instanceId, threadId } = options;
  const [events, setEvents] = useState<ReadonlyArray<ProviderRuntimeEvent>>([]);
  const [isActive, setIsActive] = useState(false);
  const eventsRef = useRef<ProviderRuntimeEvent[]>([]);

  const clear = useCallback(() => {
    eventsRef.current = [];
    setEvents([]);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setIsActive(false);
      return;
    }

    setIsActive(true);

    // Listen for provider runtime events via custom DOM event
    const handleEvent = (event: CustomEvent<ProviderRuntimeEvent>) => {
      const runtimeEvent = event.detail;

      // Filter by instance id if provided
      if (instanceId && runtimeEvent.providerInstanceId !== instanceId) {
        return;
      }

      // Filter by thread id if provided
      if (threadId && runtimeEvent.threadId !== threadId) {
        return;
      }

      eventsRef.current = [...eventsRef.current, runtimeEvent];
      // Keep only last 1000 events to avoid memory issues
      if (eventsRef.current.length > 1000) {
        eventsRef.current = eventsRef.current.slice(-1000);
      }
      setEvents([...eventsRef.current]);
    };

    window.addEventListener("provider-runtime-event", handleEvent as EventListener);

    return () => {
      setIsActive(false);
      window.removeEventListener("provider-runtime-event", handleEvent as EventListener);
    };
  }, [enabled, instanceId, threadId]);

  // Filter tool call events (item.started and item.updated)
  const toolCallEvents = events.filter((event) => {
    const type = event.type;
    return type === "item.started" || type === "item.updated" || type === "item.completed";
  });

  return {
    events,
    toolCallEvents,
    isActive,
    clear,
  };
}
