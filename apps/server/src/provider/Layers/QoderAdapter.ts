/**
 * QoderAdapter — CLI-based adapter for the Qoder provider.
 *
 * Spawns `qoder -p` (print mode) with `--output-format json` for each turn,
 * parses the JSON result, and emits canonical runtime events.
 *
 * @module QoderAdapter
 */
import {
  type QoderSettings,
  DEFAULT_RUNTIME_MODE,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  TurnId,
} from "@lmcstools/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@lmcstools/core/shell";

import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";
import type { QoderAdapterShape } from "../Services/QoderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("qoder");

export interface QoderAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

interface QoderSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  currentModel: string | undefined;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
}

const nowIso = () => Effect.map(DateTime.now, DateTime.formatIso);

function buildQoderAuthEnv(
  config: QoderSettings,
  environment?: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const pat =
    config.personalAccessToken?.trim() || environment?.QODER_PERSONAL_ACCESS_TOKEN?.trim();
  if (pat) {
    return { QODER_PERSONAL_ACCESS_TOKEN: pat };
  }
  return {};
}

/**
 * Parse a single JSON line from Qoder's `--output-format json` output.
 * Returns null for non-JSON lines (progress indicators, etc.).
 */
function parseQoderJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON, skip
  }
  return null;
}

export function makeQoderAdapter(
  config: QoderSettings,
  options: QoderAdapterLiveOptions = {},
): Effect.Effect<QoderAdapterShape, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const sessions = yield* Ref.make(new Map<ThreadId, QoderSessionContext>());
    const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(eventQueue, event).pipe(Effect.asVoid);

    const asEventId = (suffix: string) =>
      EventId.make(`qoder:${options.instanceId ?? "default"}:${suffix}`);

    // -----------------------------------------------------------------------
    // startSession
    // -----------------------------------------------------------------------
    const startSession: QoderAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const allSessions = yield* Ref.get(sessions);
        if (allSessions.has(input.threadId)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "startSession",
            detail: `Session already exists for thread ${input.threadId}`,
          });
        }

        const now = yield* nowIso();
        const scope = yield* Scope.make();

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

        const context: QoderSessionContext = {
          threadId: input.threadId,
          session,
          scope,
          turns: [],
          currentModel: config.favoriteModel?.trim() || undefined,
          activeTurnId: undefined,
          stopped: false,
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
    const sendTurn: QoderAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const allSessions = yield* Ref.get(sessions);
        const context = allSessions.get(input.threadId);
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
        context.activeTurnId = turnId;

        const selectedModel = input.modelSelection?.model || context.currentModel;
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

        const cwd = context.session.cwd ?? process.cwd();
        const binaryPath = config.binaryPath?.trim() || "qoder";
        const authEnv = buildQoderAuthEnv(config, options.environment);

        const args = [
          "-p",
          prompt,
          "--output-format",
          "json",
          "--permission-mode",
          "bypass_permissions",
          "--no-session-persistence",
          "--max-turns",
          "100",
          ...(context.currentModel ? ["-m", context.currentModel] : []),
        ];

        const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, {
          env: { ...process.env, ...authEnv },
        });

        const result = yield* spawnAndCollect(
          binaryPath,
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            env: { ...process.env, ...authEnv },
            cwd,
            shell: spawnCommand.shell,
          }),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

        // Parse JSON output and emit events
        const lines = result.stdout.split("\n");
        let hasEmittedCompletion = false;

        for (const line of lines) {
          const parsed = parseQoderJsonLine(line);
          if (!parsed) continue;

          const eventType = parsed.type as string | undefined;

          if (eventType === "result" && parsed.subtype === "success") {
            const resultText = parsed.result as string | undefined;
            if (resultText) {
              yield* emit({
                eventId: asEventId(`content-delta-${String(turnId)}-${yield* nowIso()}`),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                createdAt: yield* nowIso(),
                type: "content.delta",
                payload: {
                  streamKind: "assistant_text",
                  delta: resultText,
                },
              });
            }
            yield* emit({
              eventId: asEventId(`turn-completed-${String(turnId)}`),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              createdAt: yield* nowIso(),
              type: "turn.completed",
              payload: { state: "completed" },
            });
            hasEmittedCompletion = true;
          } else if (eventType === "assistant") {
            const message = parsed.message as Record<string, unknown> | undefined;
            if (message?.content) {
              const content = message.content as Array<Record<string, unknown>> | undefined;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "text" && typeof block.text === "string") {
                    yield* emit({
                      eventId: asEventId(`content-delta-${String(turnId)}-${yield* nowIso()}`),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      createdAt: yield* nowIso(),
                      type: "content.delta",
                      payload: {
                        streamKind: "assistant_text",
                        delta: block.text,
                      },
                    });
                  } else if (block.type === "tool_use") {
                    yield* emit({
                      eventId: asEventId(`item-started-${String(turnId)}-${yield* nowIso()}`),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      createdAt: yield* nowIso(),
                      type: "item.started",
                      payload: {
                        itemType: "dynamic_tool_call",
                        title: (block.name as string) ?? "tool_call",
                        data: { toolName: block.name, toolInput: block.input },
                      },
                    });
                  }
                }
              }
            }
          }
        }

        // Fallback completion if no result message was found
        if (!hasEmittedCompletion && result.code === 0) {
          yield* emit({
            eventId: asEventId(`turn-completed-fallback-${String(turnId)}`),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            createdAt: yield* nowIso(),
            type: "turn.completed",
            payload: { state: "completed" },
          });
        }

        if (result.code !== 0) {
          yield* emit({
            eventId: asEventId(`turn-completed-error-${String(turnId)}`),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            createdAt: yield* nowIso(),
            type: "turn.completed",
            payload: { state: "failed" },
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
        Effect.catchTag("ProviderCommandNotFoundError", (error) =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: `Qoder CLI not found: ${error.binaryPath}`,
            }),
          ),
        ),
      );

    // -----------------------------------------------------------------------
    // interruptTurn
    // -----------------------------------------------------------------------
    const interruptTurn: QoderAdapterShape["interruptTurn"] = (threadId, _turnId?) =>
      Effect.gen(function* () {
        const allSessions = yield* Ref.get(sessions);
        const context = allSessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        if (context.activeTurnId) {
          yield* emit({
            eventId: asEventId(`turn-aborted-${String(context.activeTurnId)}`),
            provider: PROVIDER,
            threadId,
            turnId: context.activeTurnId,
            createdAt: yield* nowIso(),
            type: "turn.aborted",
            payload: { reason: "interrupted" },
          });
          context.activeTurnId = undefined;
        }
      });

    // -----------------------------------------------------------------------
    // stopSession
    // -----------------------------------------------------------------------
    const stopSession: QoderAdapterShape["stopSession"] = (threadId) =>
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
    const listSessions: QoderAdapterShape["listSessions"] = () =>
      Effect.map(Ref.get(sessions), (map) => Array.from(map.values()).map((ctx) => ctx.session));

    const hasSession: QoderAdapterShape["hasSession"] = (threadId) =>
      Effect.map(Ref.get(sessions), (map) => map.has(threadId));

    // -----------------------------------------------------------------------
    // readThread / rollbackThread
    // -----------------------------------------------------------------------
    const readThread: QoderAdapterShape["readThread"] = (threadId) =>
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

    const rollbackThread: QoderAdapterShape["rollbackThread"] = (threadId, numTurns) =>
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
    // respondToRequest / respondToUserInput (no-op for print mode)
    // -----------------------------------------------------------------------
    const respondToRequest: QoderAdapterShape["respondToRequest"] = (
      _threadId,
      _requestId,
      _decision,
    ) => Effect.void;

    const respondToUserInput: QoderAdapterShape["respondToUserInput"] = (
      _threadId,
      _requestId,
      _answers,
    ) => Effect.void;

    // -----------------------------------------------------------------------
    // stopAll
    // -----------------------------------------------------------------------
    const stopAll: QoderAdapterShape["stopAll"] = () =>
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
    } satisfies QoderAdapterShape;
  });
}
