/**
 * LocalLlmAdapter — HTTP-based adapter for local LLM servers.
 *
 * Communicates with local LLM servers (llama.cpp, Ollama, vLLM, etc.) via
 * OpenAI Chat or Anthropic Messages API formats. Each turn sends a chat
 * completion request and streams the response as runtime events.
 *
 * @module LocalLlmAdapter
 */
import {
  type LocalLlmSettings,
  DEFAULT_RUNTIME_MODE,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@lmcstools/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import {
  chatCompletion,
  chatCompletionStream,
  type LocalLlmClientConfig,
} from "../Drivers/LocalLlm/httpClient.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("localLlm");

export interface LocalLlmAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
}

interface LocalLlmSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  currentModel: string | undefined;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
  turnInterrupted: boolean;
}

const nowIso = () => Effect.map(DateTime.now, DateTime.formatIso);

export function makeLocalLlmAdapter(
  config: LocalLlmSettings,
  options: LocalLlmAdapterLiveOptions = {},
): Effect.Effect<
  ProviderAdapterShape<ProviderAdapterRequestError | ProviderAdapterSessionNotFoundError>
> {
  return Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map<ThreadId, LocalLlmSessionContext>());
    const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(eventQueue, event).pipe(Effect.asVoid);

    const asEventId = (suffix: string) =>
      EventId.make(`localLlm:${options.instanceId ?? "default"}:${suffix}`);

    const clientConfig: LocalLlmClientConfig = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      apiFormat: config.apiFormat,
    };

    // -----------------------------------------------------------------------
    // startSession
    // -----------------------------------------------------------------------
    const startSession: ProviderAdapterShape<any>["startSession"] = (input) =>
      Effect.gen(function* () {
        const allSessions = yield* Ref.get(sessions);
        if (allSessions.has(input.threadId)) {
          const existingContext = allSessions.get(input.threadId)!;
          return existingContext.session;
        }

        const now = yield* nowIso();

        const session: ProviderSession = {
          provider: PROVIDER,
          ...(input.providerInstanceId !== undefined
            ? { providerInstanceId: input.providerInstanceId }
            : {}),
          status: "ready",
          runtimeMode: input.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          threadId: input.threadId,
          cwd: input.cwd ?? process.cwd(),
          createdAt: now,
          updatedAt: now,
        };

        const context: LocalLlmSessionContext = {
          threadId: input.threadId,
          session,
          turns: [],
          currentModel: config.model || undefined,
          activeTurnId: undefined,
          stopped: false,
          turnInterrupted: false,
        };

        yield* Ref.update(sessions, (map) => map.set(input.threadId, context));

        yield* emit({
          eventId: asEventId(`session-started-${String(input.threadId)}`),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId: undefined,
          createdAt: now,
          type: "session.started",
          payload: {},
        });

        return session;
      });

    // -----------------------------------------------------------------------
    // sendTurn
    // -----------------------------------------------------------------------
    const sendTurn: ProviderAdapterShape<any>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const allSessions = yield* Ref.get(sessions);
        const context = allSessions.get(input.threadId);
        if (!context || context.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }

        const turnId = TurnId.make(
          `localLlm-turn-${String(input.threadId)}-${context.turns.length + 1}`,
        );
        context.activeTurnId = turnId;
        context.turnInterrupted = false;

        const selectedModel = input.modelSelection?.model ?? context.currentModel;
        if (selectedModel) {
          context.currentModel = selectedModel;
        }

        context.turns.push({ id: turnId, items: [] });

        const startedAt = yield* nowIso();

        yield* emit({
          eventId: asEventId(`turn-started-${String(turnId)}`),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          createdAt: startedAt,
          type: "turn.started",
          payload: context.currentModel ? { model: context.currentModel } : {},
        });

        const prompt = input.input ?? "";
        if (!prompt) {
          yield* emit({
            eventId: asEventId(`turn-error-${String(turnId)}`),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            createdAt: yield* nowIso(),
            type: "turn.aborted",
            payload: { reason: "empty_input" },
          });
          context.activeTurnId = undefined;
          return { threadId: input.threadId, turnId };
        }

        // Build messages for the API request
        const messages = [
          {
            role: "user" as const,
            content: prompt,
          },
        ];

        try {
          // Use streaming for real-time feedback
          const stream = chatCompletionStream(
            { ...clientConfig, model: context.currentModel ?? clientConfig.model },
            { messages, stream: true },
          );

          let contentSeq = 0;
          let fullContent = "";
          let hasError = false;

          yield* stream.pipe(
            Stream.runForEach((delta: any) =>
              Effect.gen(function* () {
                if (context.turnInterrupted) {
                  return;
                }

                if (delta.type === "text" && delta.text) {
                  fullContent += delta.text;
                  contentSeq += 1;
                  yield* emit({
                    eventId: asEventId(`content-delta-${String(turnId)}-${contentSeq}`),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    createdAt: yield* nowIso(),
                    type: "content.delta",
                    payload: {
                      streamKind: "assistant_text",
                      delta: delta.text,
                      contentIndex: 0,
                    },
                  });
                } else if (delta.type === "toolCallStart" && delta.toolCall) {
                  const toolUseId = delta.toolCall.id ?? `tool-${contentSeq}`;
                  const toolName = delta.toolCall.name ?? "tool_call";
                  yield* emit({
                    eventId: asEventId(`item-started-${String(turnId)}-${toolUseId}`),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    itemId: RuntimeItemId.make(toolUseId),
                    createdAt: yield* nowIso(),
                    type: "item.started",
                    payload: {
                      itemType: "dynamic_tool_call",
                      status: "inProgress",
                      title: toolName,
                      data: { toolName, toolInput: {} },
                    },
                  });
                } else if (delta.type === "toolCallDelta" && delta.toolCall) {
                  // Accumulate tool call arguments
                } else if (delta.type === "toolCallEnd" && delta.toolCall) {
                  const toolUseId = delta.toolCall.id ?? `tool-${contentSeq}`;
                  yield* emit({
                    eventId: asEventId(`item-finished-${String(turnId)}-${toolUseId}`),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    itemId: RuntimeItemId.make(toolUseId),
                    createdAt: yield* nowIso(),
                    type: "item.updated",
                    payload: {
                      itemType: "dynamic_tool_call",
                      status: "completed",
                      title: "tool_call",
                      data: { toolName: "tool_call", toolInput: {}, toolResult: "" },
                    },
                  });
                } else if (delta.type === "done") {
                  // Stream completed
                }
              }),
            ),
          );

          if (context.turnInterrupted) {
            yield* emit({
              eventId: asEventId(`turn-aborted-${String(turnId)}`),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              createdAt: yield* nowIso(),
              type: "turn.aborted",
              payload: { reason: "interrupted" },
            });
          } else if (hasError) {
            yield* emit({
              eventId: asEventId(`turn-completed-error-${String(turnId)}`),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              createdAt: yield* nowIso(),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: "Local LLM request failed",
              },
            });
          } else {
            yield* emit({
              eventId: asEventId(`turn-completed-${String(turnId)}`),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              createdAt: yield* nowIso(),
              type: "turn.completed",
              payload: { state: "completed" },
            });
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          yield* emit({
            eventId: asEventId(`turn-completed-error-${String(turnId)}`),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            createdAt: yield* nowIso(),
            type: "turn.completed",
            payload: {
              state: "failed",
              errorMessage,
            },
          });
        }

        context.activeTurnId = undefined;
        return { threadId: input.threadId, turnId };
      }).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: `Process error: ${error.message ?? String(error)}`,
            }),
          ),
        ),
      );

    // -----------------------------------------------------------------------
    // interruptTurn
    // -----------------------------------------------------------------------
    const interruptTurn: ProviderAdapterShape<any>["interruptTurn"] = (threadId, _turnId?) =>
      Effect.gen(function* () {
        const allSessions = yield* Ref.get(sessions);
        const context = allSessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        context.turnInterrupted = true;
      });

    // -----------------------------------------------------------------------
    // stopSession
    // -----------------------------------------------------------------------
    const stopSession: ProviderAdapterShape<any>["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const allSessions = yield* Ref.get(sessions);
        const context = allSessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        context.stopped = true;
        context.turnInterrupted = true;

        yield* Ref.update(sessions, (map) => {
          const next = new Map(map);
          next.delete(threadId);
          return next;
        });

        yield* emit({
          eventId: asEventId(`session-exited-${String(threadId)}`),
          provider: PROVIDER,
          threadId,
          turnId: undefined,
          createdAt: yield* nowIso(),
          type: "session.exited",
          payload: {},
        });
      });

    // -----------------------------------------------------------------------
    // listSessions / hasSession
    // -----------------------------------------------------------------------
    const listSessions: ProviderAdapterShape<any>["listSessions"] = () =>
      Effect.map(Ref.get(sessions), (map) => Array.from(map.values()).map((ctx) => ctx.session));

    const hasSession: ProviderAdapterShape<any>["hasSession"] = (threadId) =>
      Effect.map(Ref.get(sessions), (map) => map.has(threadId));

    // -----------------------------------------------------------------------
    // readThread / rollbackThread
    // -----------------------------------------------------------------------
    const readThread: ProviderAdapterShape<any>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const allSessions = yield* Ref.get(sessions);
        const context = allSessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        return {
          threadId: context.threadId,
          turns: context.turns.map((t) => ({ id: t.id, items: t.items })),
        };
      });

    const rollbackThread: ProviderAdapterShape<any>["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const allSessions = yield* Ref.get(sessions);
        const context = allSessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const newTurns = context.turns.slice(0, Math.max(0, context.turns.length - numTurns));
        context.turns = newTurns;
        return {
          threadId: context.threadId,
          turns: newTurns.map((t) => ({ id: t.id, items: t.items })),
        };
      });

    // -----------------------------------------------------------------------
    // respondToRequest / respondToUserInput (no-op for local LLM)
    // -----------------------------------------------------------------------
    const respondToRequest: ProviderAdapterShape<any>["respondToRequest"] = (
      _threadId,
      _requestId,
      _decision,
    ) => Effect.void;

    const respondToUserInput: ProviderAdapterShape<any>["respondToUserInput"] = (
      _threadId,
      _requestId,
      _answers,
    ) => Effect.void;

    // -----------------------------------------------------------------------
    // stopAll
    // -----------------------------------------------------------------------
    const stopAll: ProviderAdapterShape<any>["stopAll"] = () =>
      Effect.gen(function* () {
        const allSessions = yield* Ref.get(sessions);
        for (const threadId of allSessions.keys()) {
          yield* stopSession(threadId).pipe(Effect.ignore);
        }
      });

    // -----------------------------------------------------------------------
    // streamEvents
    // -----------------------------------------------------------------------
    const streamEvents = Stream.fromQueue(eventQueue);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "unsupported",
        supportsConversationRollback: false,
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents,
    } satisfies ProviderAdapterShape<any>;
  });
}
