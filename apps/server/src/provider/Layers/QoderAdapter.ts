import {
  ApprovalRequestId,
  type QoderSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  TurnId,
  DEFAULT_RUNTIME_MODE,
  type ThreadTokenUsageSnapshot,
  type TurnTokenUsage,
  RuntimeItemId,
} from "@lmcstools/core";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import type {
  SDKMessage,
  SDKResultMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKSystemMessage,
  SDKStatusMessage,
  SDKCommandLifecycleMessage,
  Query,
  Options as QueryOptions,
  PermissionResult,
} from "@qoder-ai/qoder-agent-sdk";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { QoderAdapterShape } from "../Services/QoderAdapter.ts";
import { BUNDLED_QODER_MODEL_CATALOG, calculateQoderCost } from "../QoderModelCatalog.ts";

const PROVIDER = ProviderDriverKind.make("qoder");

export interface QoderAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly instanceId?: ProviderInstanceId;
}

interface QoderSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  query: Query | null;
  abortController: AbortController | null;
  currentModel: string | undefined;
  tokenUsage: ThreadTokenUsageSnapshot | null;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
  sessionConfigured: boolean;
  /** Tracks the in-flight message processing promise so we can await it on interrupt/stop */
  messageProcessingPromise: Promise<void> | null;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<
    | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
    | { readonly _tag: "cancelled" }
  >;
}

const nowIso = () => Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Qoder adapter — Real SDK integration following OpenCode pattern.
 */
export function makeQoderAdapter(
  config: QoderSettings,
  options: QoderAdapterLiveOptions = {},
): Effect.Effect<QoderAdapterShape, never> {
  return Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map<ThreadId, QoderSessionContext>());
    const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const pendingApprovals = yield* Ref.make(new Map<ApprovalRequestId, PendingApproval>());
    const pendingUserInputs = yield* Ref.make(new Map<ApprovalRequestId, PendingUserInput>());

    const favoriteModel = config.favoriteModel?.trim() || undefined;

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(eventQueue, event).pipe(Effect.asVoid);

    const asEventId = (suffix: string) =>
      EventId.make(`qoder:${options.instanceId ?? "default"}:${suffix}`);

    const buildAuthOptions = () => {
      const pat =
        config.personalAccessToken?.trim() ||
        options.environment?.QODER_PERSONAL_ACCESS_TOKEN?.trim();
      if (pat) {
        return { type: "accessToken" as const, accessToken: pat };
      }
      return { type: "qodercli" as const };
    };

    const processSdkMessage = (
      message: SDKMessage,
      context: QoderSessionContext,
      turnId: TurnId,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* nowIso();

        yield* Effect.logDebug(`Qoder SDK message`, {
          type: message.type,
          subtype: "subtype" in message ? message.subtype : undefined,
        });

        if (message.type === "assistant") {
          const assistantMsg = message as SDKAssistantMessage;
          const content = assistantMsg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                yield* emit({
                  eventId: asEventId(`content-${String(turnId)}-${Date.now()}`),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId,
                  createdAt: now,
                  type: "content.delta",
                  payload: {
                    streamKind: "assistant_text",
                    delta: block.text,
                  },
                });
              } else if (block.type === "tool_use") {
                yield* emit({
                  eventId: asEventId(`item-started-${block.id ?? Date.now()}`),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId,
                  createdAt: now,
                  type: "item.started",
                  payload: {
                    itemType: "dynamic_tool_call",
                    title: block.name ?? "unknown",
                    data: {
                      toolName: block.name ?? "unknown",
                      toolUseId: block.id ?? "",
                      input: block.input,
                    },
                  },
                });
              }
            }
          }
        } else if (message.type === "stream_event") {
          const streamMsg = message as SDKPartialAssistantMessage;
          const event = streamMsg.event;

          if (event.type === "content_block_delta" && event.delta) {
            const delta = event.delta as { type?: string; text?: string };
            if (delta.type === "text_delta" && delta.text) {
              yield* emit({
                eventId: asEventId(`stream-${String(turnId)}-${Date.now()}`),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId,
                createdAt: now,
                type: "content.delta",
                payload: {
                  streamKind: "assistant_text",
                  delta: delta.text,
                },
              });
            }
          }
        } else if (message.type === "result") {
          const resultMsg = message as SDKResultMessage;
          const usage = normalizeQoderTurnTokenUsage(resultMsg, context.currentModel);

          if (usage && usage.usageStatus === "complete") {
            const totalTokens = usage.inputTokens + usage.outputTokens;
            context.tokenUsage = {
              usedTokens: totalTokens,
              lastUsedTokens: totalTokens,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            };
          }

          yield* emit({
            eventId: asEventId(`turn-completed-${String(turnId)}`),
            provider: PROVIDER,
            threadId: context.threadId,
            turnId,
            createdAt: now,
            type: "turn.completed",
            payload: {
              state: resultMsg.subtype === "success" ? "completed" : "failed",
              ...(usage ? { tokenUsage: usage } : {}),
            },
          });
        } else if (message.type === "system") {
          const systemMsg = message as SDKSystemMessage;
          // Only emit session.configured once on the first init message
          if (systemMsg.subtype === "init" && !context.sessionConfigured) {
            context.sessionConfigured = true;
            yield* emit({
              eventId: asEventId(`session-configured-${String(context.threadId)}`),
              provider: PROVIDER,
              threadId: context.threadId,
              createdAt: now,
              type: "session.configured",
              payload: { config: {} },
            });
          }
        }
      });

    const startSession = (input: {
      threadId: ThreadId;
      cwd?: string;
      runtimeMode?: string;
      providerInstanceId?: ProviderInstanceId;
      resumeCursor?: { opaque: string };
    }) =>
      Effect.gen(function* () {
        const now = yield* nowIso();
        const scope = yield* Scope.make();

        const session: ProviderSession = {
          provider: PROVIDER,
          ...(input.providerInstanceId !== undefined
            ? { providerInstanceId: input.providerInstanceId }
            : {}),
          status: "ready",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          threadId: input.threadId,
          resumeCursor: input.resumeCursor ?? {
            opaque: `qoder-resume-${String(input.threadId)}`,
          },
          cwd: input.cwd ?? process.cwd(),
          createdAt: now,
          updatedAt: now,
        };

        const context: QoderSessionContext = {
          threadId: input.threadId,
          session,
          scope,
          turns: [],
          query: null,
          abortController: null,
          currentModel: favoriteModel,
          tokenUsage: null,
          activeTurnId: undefined,
          stopped: false,
          sessionConfigured: false,
          messageProcessingPromise: null,
        };

        yield* Ref.update(sessions, (map) => map.set(input.threadId, context));

        yield* emit({
          eventId: asEventId(`session-started-${String(input.threadId)}`),
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt: now,
          type: "session.started",
          payload: { message: "Qoder session started" },
        });

        return session;
      });

    const sendTurn = (input: {
      threadId: ThreadId;
      continuation?: boolean;
      input?: string;
      attachments?: ReadonlyArray<unknown>;
      modelSelection?: {
        provider: string;
        model: string;
        options?: ReadonlyArray<{ id: string; value: unknown }>;
      };
      interactionMode?: string;
    }) =>
      Effect.gen(function* () {
        const sessionMap = yield* Ref.get(sessions);
        const context = sessionMap.get(input.threadId);

        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }

        if (context.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }

        const turnId = TurnId.make(
          `qoder-turn-${String(input.threadId)}-${context.turns.length + 1}`,
        );

        const selectedModel = input.modelSelection?.model || favoriteModel;
        context.currentModel = selectedModel;
        context.activeTurnId = turnId;

        context.turns.push({ id: turnId, items: [] });

        yield* emit({
          eventId: asEventId(`turn-started-${String(turnId)}`),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          createdAt: yield* nowIso(),
          type: "turn.started",
          payload: { model: selectedModel },
        });

        const abortController = new AbortController();
        context.abortController = abortController;

        const sdkSessionId = `lmcs-${String(input.threadId)}`;

        const queryOptions: QueryOptions = {
          auth: buildAuthOptions(),
          cwd: context.session.cwd ?? process.cwd(),
          ...(selectedModel ? { model: selectedModel } : {}),
          abortController,
          sessionId: sdkSessionId,
          persistSession: false,
          canUseTool: (toolName, toolInput, _canUseToolOptions): Promise<PermissionResult> =>
            new Promise((resolve) => {
              const requestId = ApprovalRequestId.make(
                `qoder-approval-${String(turnId)}-${toolName}`,
              );

              const decisionDeferred = Effect.runSync(Deferred.make<ProviderApprovalDecision>());
              const pending: PendingApproval = { decision: decisionDeferred };

              void Ref.update(pendingApprovals, (map) => {
                const next = new Map(map);
                next.set(requestId, pending);
                return next;
              });

              void emit({
                eventId: asEventId(`request-${requestId}`),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                createdAt: new Date().toISOString(),
                type: "request.opened",
                payload: {
                  requestType: "permission_approval",
                  detail: `Tool approval requested: ${toolName}`,
                  args: { toolName, toolInput },
                },
              });

              const timeoutMs = 5 * 60 * 1000;
              let resolved = false;

              const timeoutId = setTimeout(() => {
                if (!resolved) {
                  resolved = true;
                  resolve({
                    behavior: "deny",
                    message: "Tool approval timed out (5 minutes)",
                  });
                }
              }, timeoutMs);

              void Effect.runPromise(Deferred.await(decisionDeferred)).then(
                (dec: ProviderApprovalDecision) => {
                  if (!resolved) {
                    resolved = true;
                    clearTimeout(timeoutId);
                    if (dec === "accept" || dec === "acceptForSession" || dec === "acceptAlways") {
                      resolve({ behavior: "allow" });
                    } else {
                      resolve({
                        behavior: "deny",
                        message: "User denied tool execution",
                      });
                    }
                  }
                },
              );
            }),
        };

        const prompt = input.input ?? "";
        if (!prompt && !input.continuation) {
          yield* emit({
            eventId: asEventId(`turn-error-${String(turnId)}`),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            createdAt: yield* nowIso(),
            type: "turn.aborted",
            payload: { reason: "empty_input" },
          });
          return { threadId: input.threadId, turnId };
        }

        try {
          yield* Effect.logInfo("Starting Qoder query", {
            prompt: prompt.substring(0, 100),
            model: selectedModel,
            cwd: context.session.cwd,
          });

          const { query } = yield* Effect.tryPromise({
            try: () => import("@qoder-ai/qoder-agent-sdk"),
            catch: (error) =>
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: `Failed to import Qoder SDK: ${error}`,
              }),
          });

          const q = query({
            prompt,
            options: queryOptions,
          });

          context.query = q;

          // Track message processing so we can await it on interrupt/stop
          const messageProcessingPromise = (async () => {
            try {
              let messageCount = 0;
              let hasReceivedInit = false;

              for await (const message of q) {
                // Check if we should stop processing (interrupt/stop requested)
                if (context.stopped || abortController.signal.aborted) {
                  await Effect.runPromise(
                    Effect.logInfo("Qoder query processing stopped by user", {
                      messageCount,
                    }),
                  );
                  break;
                }

                messageCount++;

                // Track if we received the init message for session.configured
                if (
                  message.type === "system" &&
                  "subtype" in message &&
                  message.subtype === "init"
                ) {
                  hasReceivedInit = true;
                }

                await Effect.runPromise(processSdkMessage(message, context, turnId));
              }

              // If we never received init, emit session.configured anyway
              // This ensures the UI doesn't hang waiting for session.configured
              if (!hasReceivedInit && !context.sessionConfigured && messageCount > 0) {
                context.sessionConfigured = true;
                const now = new Date().toISOString();
                await Effect.runPromise(
                  emit({
                    eventId: asEventId(`session-configured-fallback-${String(context.threadId)}`),
                    provider: PROVIDER,
                    threadId: context.threadId,
                    createdAt: now,
                    type: "session.configured",
                    payload: { config: {} },
                  }),
                );
              }

              await Effect.runPromise(Effect.logInfo("Qoder query completed", { messageCount }));
            } catch (error) {
              if (!context.stopped && !abortController.signal.aborted) {
                await Effect.runPromise(
                  Effect.logError("Qoder SDK query iteration error", { error }),
                );
                // Emit turn.aborted on unexpected error
                const now = new Date().toISOString();
                await Effect.runPromise(
                  emit({
                    eventId: asEventId(`turn-error-${String(turnId)}`),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    createdAt: now,
                    type: "turn.aborted",
                    payload: { reason: "sdk_error" },
                  }),
                );
              }
            }
          })();

          context.messageProcessingPromise = messageProcessingPromise;
        } catch (error) {
          yield* Effect.logError("Failed to start Qoder query", { error });
          yield* emit({
            eventId: asEventId(`turn-error-${String(turnId)}`),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            createdAt: yield* nowIso(),
            type: "turn.aborted",
            payload: { reason: "error" },
          });
        }

        return {
          threadId: input.threadId,
          turnId,
        };
      });

    const interruptTurn = (threadId: ThreadId, _turnId?: TurnId) =>
      Effect.gen(function* () {
        const sessionMap = yield* Ref.get(sessions);
        const context = sessionMap.get(threadId);

        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        // Signal the message processing loop to stop
        if (context.abortController) {
          context.abortController.abort();
        }

        // Wait for the message processing to finish (with timeout)
        if (context.messageProcessingPromise) {
          yield* Effect.tryPromise({
            try: () =>
              Promise.race([
                context.messageProcessingPromise,
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error("interrupt timeout")), 5000),
                ),
              ]),
            catch: () => null, // Ignore timeout errors
          });
        }

        yield* emit({
          eventId: asEventId(`turn-aborted-${String(threadId)}`),
          provider: PROVIDER,
          threadId,
          createdAt: yield* nowIso(),
          type: "turn.aborted",
          payload: { reason: "interrupted" },
        });
      });

    const respondToRequest = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ) =>
      Effect.gen(function* () {
        const approvalsMap = yield* Ref.get(pendingApprovals);
        const pending = approvalsMap.get(requestId);

        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToRequest",
            detail: "No pending approval found",
          });
        }

        yield* Deferred.succeed(pending.decision, decision);
        yield* Ref.update(pendingApprovals, (map) => {
          const next = new Map(map);
          next.delete(requestId);
          return next;
        });

        yield* emit({
          eventId: asEventId(`request-resolved-${requestId}`),
          provider: PROVIDER,
          threadId,
          createdAt: yield* nowIso(),
          type: "request.resolved",
          payload: {
            requestType: "permission_approval",
            decision: decision,
          },
        });
      });

    const respondToUserInput = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        const inputsMap = yield* Ref.get(pendingUserInputs);
        const pending = inputsMap.get(requestId);

        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToUserInput",
            detail: "No pending user input found",
          });
        }

        yield* Deferred.succeed(pending.resolution, {
          _tag: "answered",
          answers,
        });
        yield* Ref.update(pendingUserInputs, (map) => {
          const next = new Map(map);
          next.delete(requestId);
          return next;
        });
      });

    const stopSession = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const sessionMap = yield* Ref.get(sessions);
        const context = sessionMap.get(threadId);

        if (!context) {
          return;
        }

        context.stopped = true;

        // Signal the message processing loop to stop
        if (context.abortController) {
          context.abortController.abort();
        }

        // Wait for the message processing to finish (with timeout)
        if (context.messageProcessingPromise) {
          yield* Effect.tryPromise({
            try: () =>
              Promise.race([
                context.messageProcessingPromise,
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error("stop timeout")), 5000),
                ),
              ]),
            catch: () => null, // Ignore timeout errors
          });
        }

        yield* Scope.close(context.scope, Exit.void);

        yield* Ref.update(sessions, (map) => {
          const next = new Map(map);
          next.delete(threadId);
          return next;
        });

        yield* emit({
          eventId: asEventId(`session-exited-${String(threadId)}`),
          provider: PROVIDER,
          threadId,
          createdAt: yield* nowIso(),
          type: "session.exited",
          payload: { reason: "stopped" },
        });
      });

    const listSessions = () =>
      Ref.get(sessions).pipe(
        Effect.map((map) => Array.from(map.values()).map((ctx) => ctx.session)),
      );

    const hasSession = (threadId: ThreadId) =>
      Ref.get(sessions).pipe(Effect.map((map) => map.has(threadId)));

    const readThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const sessionMap = yield* Ref.get(sessions);
        const context = sessionMap.get(threadId);

        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        return {
          threadId,
          turns: context.turns.map((t) => ({
            id: t.id,
            items: t.items,
          })),
        };
      });

    const rollbackThread = (threadId: ThreadId, _numTurns: number) =>
      Effect.gen(function* () {
        const sessionMap = yield* Ref.get(sessions);
        const has = sessionMap.has(threadId);

        if (!has) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        const context = sessionMap.get(threadId)!;
        return {
          threadId,
          turns: context.turns.map((t) => ({
            id: t.id,
            items: t.items,
          })),
        };
      });

    const uploadFeedback = (_input: unknown) => Effect.void;

    const stopAll = () =>
      Effect.gen(function* () {
        const sessionMap = yield* Ref.get(sessions);
        for (const threadId of sessionMap.keys()) {
          yield* stopSession(threadId);
        }
      });

    const streamEvents = Stream.fromQueue(eventQueue);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
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
      uploadFeedback,
      stopAll,
      streamEvents,
    } satisfies QoderAdapterShape;
  });
}

function normalizeQoderTurnTokenUsage(
  result: SDKResultMessage | undefined,
  model: string | undefined,
): TurnTokenUsage | undefined {
  if (!result || result.subtype !== "success") {
    return undefined;
  }

  const usage = result.usage as Record<string, unknown> | undefined;
  if (!usage) {
    return undefined;
  }

  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;

  if (inputTokens === 0 && outputTokens === 0) {
    return undefined;
  }

  let cost: number | undefined;
  if (model) {
    const pricing = calculateQoderCost(
      BUNDLED_QODER_MODEL_CATALOG,
      model,
      inputTokens,
      outputTokens,
    );
    if (pricing !== null) {
      cost = pricing;
    }
  }

  return {
    usageStatus: "complete",
    usageScope: "main_agent",
    hasSubagents: false,
    inputTokens,
    outputTokens,
    ...(cost !== undefined ? { totalCostUsd: cost } : {}),
  };
}
