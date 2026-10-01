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
} from "@lmcstools/core";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type {
  SDKMessage,
  SDKResultMessage,
  SDKAssistantMessage,
  Query,
  Options as QueryOptions,
  PermissionResult,
} from "@qoder-ai/qoder-agent-sdk";

import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
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
 * Qoder adapter — Real SDK integration.
 *
 * Uses @qoder-ai/qoder-agent-sdk query() with async iterators.
 * Supports PAT auth via QODER_PERSONAL_ACCESS_TOKEN or qodercliAuth().
 */
export function makeQoderAdapter(
  config: QoderSettings,
  options: QoderAdapterLiveOptions = {},
): Effect.Effect<QoderAdapterShape, never> {
  return Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map<ThreadId, QoderSessionContext>());
    const eventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const pendingApprovals = yield* Ref.make(new Map<ApprovalRequestId, PendingApproval>());
    const pendingUserInputs = yield* Ref.make(new Map<ApprovalRequestId, PendingUserInput>());

    // Store the favorite model from settings for use in sendTurn
    const favoriteModel = config.favoriteModel?.trim() || undefined;

    const emit = (event: ProviderRuntimeEvent) => PubSub.publish(eventPubSub, event);

    const asEventId = (suffix: string) =>
      EventId.make(`qoder:${options.instanceId ?? "default"}:${suffix}`);

    /**
     * Build auth options for the SDK query.
     */
    const buildAuthOptions = () => {
      const pat =
        config.personalAccessToken?.trim() ||
        options.environment?.QODER_PERSONAL_ACCESS_TOKEN?.trim();
      if (pat) {
        return { type: "accessToken" as const, accessToken: pat };
      }
      // Fall back to qodercli auth (reads ~/.qoder/.auth/user)
      return { type: "qodercli" as const };
    };

    /**
     * Map SDK messages to ProviderRuntimeEvents.
     */
    const processSdkMessage = (
      message: SDKMessage,
      context: QoderSessionContext,
      turnId: TurnId,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* nowIso();

        if (message.type === "assistant") {
          const assistantMsg = message as SDKAssistantMessage;
          const content = assistantMsg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") {
                // Use content.delta for text streaming
                yield* emit({
                  type: "content.delta",
                  eventId: asEventId(`content-${String(turnId)}`),
                  provider: PROVIDER,
                  createdAt: now,
                  threadId: context.threadId,
                  payload: {
                    streamKind: "assistant_text",
                    delta: block.text ?? "",
                  },
                });
              } else if (block.type === "tool_use") {
                // Use item.started for tool invocations
                yield* emit({
                  type: "item.started",
                  eventId: asEventId(`item-started-${block.id}`),
                  provider: PROVIDER,
                  createdAt: now,
                  threadId: context.threadId,
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
            type: "turn.completed",
            eventId: asEventId(`turn-completed-${String(turnId)}`),
            provider: PROVIDER,
            createdAt: now,
            threadId: context.threadId,
            payload: {
              state: resultMsg.subtype === "success" ? "completed" : "failed",
              ...(usage ? { tokenUsage: usage } : {}),
            },
          });
        } else if (message.type === "system") {
          // Handle system messages like init, status changes, etc.
          if (message.subtype === "init") {
            yield* emit({
              type: "session.configured",
              eventId: asEventId(`session-configured-${String(context.threadId)}`),
              provider: PROVIDER,
              createdAt: now,
              threadId: context.threadId,
              payload: {
                config: {},
              },
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
        };

        yield* Ref.update(sessions, (map) => map.set(input.threadId, context));

        yield* emit({
          type: "session.started",
          eventId: asEventId(`session-started-${String(input.threadId)}`),
          provider: PROVIDER,
          createdAt: now,
          threadId: input.threadId,
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

        const turnId = TurnId.make(
          `qoder-turn-${String(input.threadId)}-${context.turns.length + 1}`,
        );

        // Use the model from modelSelection, or fall back to favorite model from settings
        const selectedModel = input.modelSelection?.model || favoriteModel;
        context.currentModel = selectedModel;

        context.turns.push({ id: turnId, items: [] });

        yield* emit({
          type: "turn.started",
          eventId: asEventId(`turn-started-${String(turnId)}`),
          provider: PROVIDER,
          createdAt: context.session.updatedAt,
          threadId: input.threadId,
          payload: { model: selectedModel },
        });

        // Build SDK query options
        const abortController = new AbortController();
        context.abortController = abortController;

        const queryOptions: QueryOptions = {
          auth: buildAuthOptions(),
          cwd: context.session.cwd ?? process.cwd(),
          ...(selectedModel ? { model: selectedModel } : {}),
          abortController,
          canUseTool: (toolName, toolInput, _canUseToolOptions): Promise<PermissionResult> =>
            new Promise((resolve) => {
              const requestId = ApprovalRequestId.make(
                `qoder-approval-${String(turnId)}-${toolName}`,
              );

              // Create deferred synchronously using Effect.runSync
              const decisionDeferred = Effect.runSync(Deferred.make<ProviderApprovalDecision>());
              const pending: PendingApproval = { decision: decisionDeferred };

              void Ref.update(pendingApprovals, (map) => {
                const next = new Map(map);
                next.set(requestId, pending);
                return next;
              });

              void emit({
                type: "request.opened",
                eventId: asEventId(`request-${requestId}`),
                provider: PROVIDER,
                createdAt: new Date().toISOString(),
                threadId: input.threadId,
                payload: {
                  requestType: "permission_approval",
                  detail: `Tool approval requested: ${toolName}`,
                  args: { toolName, toolInput },
                },
              });

              void Effect.runPromise(Deferred.await(decisionDeferred)).then(
                (dec: ProviderApprovalDecision) => {
                  if (dec === "accept" || dec === "acceptForSession" || dec === "acceptAlways") {
                    resolve({ behavior: "allow" });
                  } else {
                    resolve({
                      behavior: "deny",
                      message: "User denied tool execution",
                    });
                  }
                },
              );
            }),
        };

        // Import query dynamically to avoid issues if SDK is not available
        const { query } = yield* Effect.promise(() => import("@qoder-ai/qoder-agent-sdk"));

        const prompt = input.input ?? "";
        if (!prompt && !input.continuation) {
          const now = yield* DateTime.now;
          yield* emit({
            type: "turn.aborted",
            eventId: asEventId(`turn-error-${String(turnId)}`),
            provider: PROVIDER,
            createdAt: DateTime.formatIso(now),
            threadId: input.threadId,
            payload: { reason: "empty_input" },
          });
          return { threadId: input.threadId, turnId };
        }

        try {
          const q = query({
            prompt,
            options: queryOptions,
          });

          context.query = q;

          // Process messages in background using async iteration
          const processMessages = async () => {
            try {
              for await (const message of q) {
                await Effect.runPromise(processSdkMessage(message, context, turnId));
              }
            } catch (error) {
              await Effect.runPromise(Effect.logError("Qoder SDK query error", { error }));
              await Effect.runPromise(
                emit({
                  type: "turn.aborted",
                  eventId: asEventId(`turn-error-${String(turnId)}`),
                  provider: PROVIDER,
                  createdAt: new Date().toISOString(),
                  threadId: input.threadId,
                  payload: { reason: "error" },
                }),
              );
            }
          };
          void processMessages();
        } catch (error) {
          yield* Effect.logError("Failed to start Qoder query", { error });
          yield* emit({
            type: "turn.aborted",
            eventId: asEventId(`turn-error-${String(turnId)}`),
            provider: PROVIDER,
            createdAt: new Date().toISOString(),
            threadId: input.threadId,
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

        // Abort the query
        if (context.abortController) {
          context.abortController.abort();
        }

        yield* emit({
          type: "turn.aborted",
          eventId: asEventId(`turn-aborted-${String(threadId)}`),
          provider: PROVIDER,
          createdAt: yield* nowIso(),
          threadId,
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
          type: "request.resolved",
          eventId: asEventId(`request-resolved-${requestId}`),
          provider: PROVIDER,
          createdAt: yield* nowIso(),
          threadId,
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

        // Abort any running query
        if (context.abortController) {
          context.abortController.abort();
        }

        yield* Scope.close(context.scope, Exit.void);

        yield* Ref.update(sessions, (map) => {
          const next = new Map(map);
          next.delete(threadId);
          return next;
        });

        yield* emit({
          type: "session.exited",
          eventId: asEventId(`session-exited-${String(threadId)}`),
          provider: PROVIDER,
          createdAt: yield* nowIso(),
          threadId,
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

        // TODO: Implement rollback via Qoder SDK session management
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

    const streamEvents = Stream.fromPubSub(eventPubSub);

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

/**
 * Normalize Qoder SDK result message to TurnTokenUsage.
 */
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

  // Calculate cost if we have model pricing
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
