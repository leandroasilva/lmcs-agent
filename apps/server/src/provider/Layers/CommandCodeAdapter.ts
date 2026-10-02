import {
  type CommandCodeSettings,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ThreadId,
  TurnId,
  DEFAULT_RUNTIME_MODE,
  type ThreadTokenUsageSnapshot,
  type TurnTokenUsage,
} from "@lmcstools/core";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import type { CommandCodeAdapterShape } from "../Services/CommandCodeAdapter.ts";
import {
  type CommandCodeHeadlessResult,
  type CommandCodeNdjsonLine,
  type CommandCodeUsage,
  parseCommandCodeNdjsonLine,
} from "../commandCodeRuntime.ts";

const PROVIDER = ProviderDriverKind.make("commandcode");

export interface CommandCodeAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly instanceId?: ProviderInstanceId;
}

interface CommandCodeSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  currentModel: string | undefined;
  tokenUsage: ThreadTokenUsageSnapshot | null;
  abortController: AbortController | null;
  runningChild: NodeChildProcess.ChildProcess | null;
}

const nowIso = () => Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Command Code adapter — CLI-based integration.
 *
 * Uses `cmd -p "message" --output-format json` for headless turns. Each turn
 * spawns a new subprocess, streams NDJSON events, and maps them onto the
 * LMCS Code `ProviderRuntimeEvent` protocol.
 */
export function makeCommandCodeAdapter(
  config: CommandCodeSettings,
  options: CommandCodeAdapterLiveOptions = {},
): Effect.Effect<CommandCodeAdapterShape, never> {
  return Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map<ThreadId, CommandCodeSessionContext>());
    const eventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const favoriteModel = config.favoriteModel?.trim() || undefined;
    const binaryPath = config.binaryPath || "cmd";

    const emit = (event: ProviderRuntimeEvent) => PubSub.publish(eventPubSub, event);

    const asEventId = (suffix: string) =>
      EventId.make(`commandcode:${options.instanceId ?? "default"}:${suffix}`);

    const providerInstanceFields = options.instanceId
      ? { providerInstanceId: options.instanceId }
      : {};

    const normalizeUsage = (usage: CommandCodeUsage | undefined): TurnTokenUsage | undefined => {
      if (!usage) return undefined;
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      if (inputTokens === 0 && outputTokens === 0) return undefined;
      return {
        usageStatus: "complete",
        usageScope: "main_agent",
        hasSubagents: false,
        inputTokens,
        outputTokens,
        ...(usage.cacheReadTokens ? { cachedInputTokens: usage.cacheReadTokens } : {}),
      };
    };

    const buildTokenUsageSnapshot = (
      result: CommandCodeHeadlessResult,
      previousSnapshot: ThreadTokenUsageSnapshot | null,
    ): ThreadTokenUsageSnapshot => {
      const usage = result.usage;
      const inputTokens = usage?.inputTokens ?? 0;
      const outputTokens = usage?.outputTokens ?? 0;
      const totalTokens = inputTokens + outputTokens;
      const previousTotal = previousSnapshot?.usedTokens ?? 0;
      return {
        usedTokens: previousTotal + totalTokens,
        lastUsedTokens: totalTokens,
        inputTokens,
        outputTokens,
        ...(usage?.cacheReadTokens ? { cachedInputTokens: usage.cacheReadTokens } : {}),
        ...(result.durationMs ? { durationMs: result.durationMs } : {}),
      };
    };

    const processEvent = (
      parsed: CommandCodeNdjsonLine,
      context: CommandCodeSessionContext,
      turnId: TurnId,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* nowIso();

        if (parsed.type !== "event") return;
        const event = parsed.event as Record<string, unknown>;
        const eventType = event.type as string;

        switch (eventType) {
          case "text_delta": {
            const delta = typeof event.delta === "string" ? event.delta : "";
            yield* emit({
              type: "content.delta",
              eventId: asEventId(
                `content-${String(turnId)}-${yield* Effect.map(DateTime.now, (d) => d.toJSON())}`,
              ),
              provider: PROVIDER,
              ...providerInstanceFields,
              createdAt: now,
              threadId: context.threadId,
              turnId,
              payload: { streamKind: "assistant_text", delta },
            } as ProviderRuntimeEvent);
            break;
          }
          case "model_request_start": {
            if (typeof event.model === "string") {
              context.currentModel = event.model;
            }
            break;
          }
          case "message_update": {
            const content = Array.isArray(event.content) ? event.content : [];
            for (const block of content) {
              if (!block || typeof block !== "object") continue;
              const b = block as Record<string, unknown>;
              if (b.type === "tool_use" || b.type === "tool-call") {
                const toolName = String(b.name ?? b.toolName ?? "unknown");
                const toolId = String(b.id ?? b.toolUseId ?? "");
                yield* emit({
                  type: "item.started",
                  eventId: asEventId(`tool-${toolId}`),
                  provider: PROVIDER,
                  ...providerInstanceFields,
                  createdAt: now,
                  threadId: context.threadId,
                  turnId,
                  payload: {
                    itemType: "dynamic_tool_call",
                    title: toolName,
                    data: { toolName, toolUseId: toolId, input: b.input ?? b.args ?? {} },
                  },
                } as ProviderRuntimeEvent);
              }
            }
            break;
          }
          default:
            break;
        }
      });

    const startSession = (input: ProviderSessionStartInput) =>
      Effect.gen(function* () {
        const now = yield* nowIso();
        const scope = yield* Scope.make();

        const session: ProviderSession = {
          provider: PROVIDER,
          ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
          status: "ready",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          threadId: input.threadId,
          resumeCursor: input.resumeCursor ?? {
            opaque: `commandcode-resume-${String(input.threadId)}`,
          },
          cwd: input.cwd ?? process.cwd(),
          createdAt: now,
          updatedAt: now,
        };

        const context: CommandCodeSessionContext = {
          threadId: input.threadId,
          session,
          scope,
          turns: [],
          currentModel: favoriteModel,
          tokenUsage: null,
          abortController: null,
          runningChild: null,
        };

        yield* Ref.update(sessions, (map) => map.set(input.threadId, context));

        yield* emit({
          type: "session.started",
          eventId: asEventId(`session-started-${String(input.threadId)}`),
          provider: PROVIDER,
          ...providerInstanceFields,
          createdAt: now,
          threadId: input.threadId,
          payload: { message: "Command Code session started" },
        } as ProviderRuntimeEvent);

        yield* emit({
          type: "session.configured",
          eventId: asEventId(`session-configured-${String(input.threadId)}`),
          provider: PROVIDER,
          ...providerInstanceFields,
          createdAt: now,
          threadId: input.threadId,
          payload: { config: {} },
        } as ProviderRuntimeEvent);

        return session;
      });

    const sendTurn = (input: ProviderSendTurnInput) =>
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
          `commandcode-turn-${String(input.threadId)}-${context.turns.length + 1}`,
        );

        const selectedModel = input.modelSelection?.model || favoriteModel;
        context.currentModel = selectedModel;
        context.turns.push({ id: turnId, items: [] });

        yield* emit({
          type: "turn.started",
          eventId: asEventId(`turn-started-${String(turnId)}`),
          provider: PROVIDER,
          ...providerInstanceFields,
          createdAt: context.session.updatedAt,
          threadId: input.threadId,
          turnId,
          payload: selectedModel !== undefined ? { model: selectedModel } : {},
        } as ProviderRuntimeEvent);

        const prompt = input.input ?? "";
        if (!prompt && !input.continuation) {
          const now = yield* DateTime.now;
          yield* emit({
            type: "turn.aborted",
            eventId: asEventId(`turn-error-${String(turnId)}`),
            provider: PROVIDER,
            ...providerInstanceFields,
            createdAt: DateTime.formatIso(now),
            threadId: input.threadId,
            turnId,
            payload: { reason: "empty_input" },
          } as ProviderRuntimeEvent);
          return { threadId: input.threadId, turnId } satisfies ProviderTurnStartResult;
        }

        const args: Array<string> = [
          "-p",
          prompt,
          "--output-format",
          "json",
          "--no-session",
          "--skip-onboarding",
        ];
        if (selectedModel) {
          args.push("--model", selectedModel);
        }

        const abortController = new AbortController();
        context.abortController = abortController;

        // Spawn the Command Code CLI in the background using Node.js child_process
        // directly, avoiding the need to thread Effect services through the
        // background work.
        const env = { ...(options.environment ?? process.env) };
        const cwd = context.session.cwd ?? process.cwd();

        const child = NodeChildProcess.spawn(binaryPath, args, {
          env,
          cwd,
          shell: true,
        });
        context.runningChild = child;

        // Process stdout NDJSON in the background
        let stdoutBuffer = "";
        let finalResult: CommandCodeHeadlessResult | null = null;

        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutBuffer += chunk.toString();
          const lines = stdoutBuffer.split("\n");
          // Keep the last (possibly incomplete) line in the buffer
          stdoutBuffer = lines.pop() ?? "";

          for (const line of lines) {
            const parsed = parseCommandCodeNdjsonLine(line);
            if (!parsed) continue;
            if (parsed.type === "result") {
              finalResult = parsed;
            } else {
              void Effect.runPromise(processEvent(parsed, context, turnId));
            }
          }
        });

        let stderrBuffer = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderrBuffer += chunk.toString();
        });

        child.on("close", (code: number | null) => {
          // Process any remaining buffered output
          if (stdoutBuffer.trim()) {
            const parsed = parseCommandCodeNdjsonLine(stdoutBuffer.trim());
            if (parsed?.type === "result") {
              finalResult = parsed;
            }
          }

          context.runningChild = null;
          context.abortController = null;

          void Effect.runPromise(
            Effect.gen(function* () {
              const now = yield* nowIso();

              if (abortController.signal.aborted) {
                yield* emit({
                  type: "turn.aborted",
                  eventId: asEventId(`turn-aborted-${String(turnId)}`),
                  provider: PROVIDER,
                  ...providerInstanceFields,
                  createdAt: now,
                  threadId: input.threadId,
                  turnId,
                  payload: { reason: "interrupted" },
                } as ProviderRuntimeEvent);
                return;
              }

              if (finalResult) {
                const usage = normalizeUsage(finalResult.usage);
                context.tokenUsage = buildTokenUsageSnapshot(finalResult, context.tokenUsage);

                yield* emit({
                  type: "turn.completed",
                  eventId: asEventId(`turn-completed-${String(turnId)}`),
                  provider: PROVIDER,
                  ...providerInstanceFields,
                  createdAt: now,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: finalResult.subtype === "success" ? "completed" : "failed",
                    ...(usage ? { tokenUsage: usage } : {}),
                  },
                } as ProviderRuntimeEvent);
              } else if (code !== 0) {
                yield* emit({
                  type: "turn.aborted",
                  eventId: asEventId(`turn-error-${String(turnId)}`),
                  provider: PROVIDER,
                  ...providerInstanceFields,
                  createdAt: now,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    reason: "error",
                    ...(stderrBuffer.trim() ? { detail: stderrBuffer.trim() } : {}),
                  },
                } as ProviderRuntimeEvent);
              } else {
                yield* emit({
                  type: "turn.completed",
                  eventId: asEventId(`turn-completed-${String(turnId)}`),
                  provider: PROVIDER,
                  ...providerInstanceFields,
                  createdAt: now,
                  threadId: input.threadId,
                  turnId,
                  payload: { state: "completed" },
                } as ProviderRuntimeEvent);
              }
            }),
          );
        });

        return { threadId: input.threadId, turnId } satisfies ProviderTurnStartResult;
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

        if (context.abortController) {
          context.abortController.abort();
        }
        if (context.runningChild) {
          context.runningChild.kill("SIGTERM");
        }

        yield* emit({
          type: "turn.aborted",
          eventId: asEventId(`turn-aborted-${String(threadId)}`),
          provider: PROVIDER,
          ...providerInstanceFields,
          createdAt: yield* nowIso(),
          threadId,
          payload: { reason: "interrupted" },
        } as ProviderRuntimeEvent);
      });

    const respondToRequest = () => Effect.void;

    const respondToUserInput = () => Effect.void;

    const stopSession = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const sessionMap = yield* Ref.get(sessions);
        const context = sessionMap.get(threadId);

        if (!context) return;

        if (context.abortController) {
          context.abortController.abort();
        }
        if (context.runningChild) {
          context.runningChild.kill("SIGTERM");
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
          ...providerInstanceFields,
          createdAt: yield* nowIso(),
          threadId,
          payload: { reason: "stopped" },
        } as ProviderRuntimeEvent);
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
      stopAll,
      streamEvents,
    } satisfies CommandCodeAdapterShape;
  });
}
