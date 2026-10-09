/**
 * CommandCodeAdapterLive — CLI-based adapter for the Command Code provider.
 *
 * Spawns `cmd -p` (print mode) with `--output-format json` for each turn,
 * parses the newline-delimited AgentEvent frames, and emits canonical
 * runtime events.
 *
 * @module CommandCodeAdapter
 */
import {
  ApprovalRequestId,
  type CommandCodeSettings,
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

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";
import type { CommandCodeAdapterShape } from "../Services/CommandCodeAdapter.ts";

const PROVIDER = ProviderDriverKind.make("commandCode");

export interface CommandCodeAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

interface CommandCodeSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  currentModel: string | undefined;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
}

const nowIso = () => Effect.map(DateTime.now, DateTime.formatIso);

function buildCmdAuthEnv(
  config: CommandCodeSettings,
  environment?: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const apiKey = config.apiKey?.trim() || environment?.COMMAND_CODE_API_KEY?.trim();
  if (apiKey) {
    return { COMMAND_CODE_API_KEY: apiKey };
  }
  return {};
}

/**
 * Parse a single JSON line from CommandCode's `--output-format json` output.
 * Returns null for non-JSON lines (progress indicators, etc.).
 */
function parseCmdJsonLine(line: string): Record<string, unknown> | null {
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

export function makeCommandCodeAdapter(
  config: CommandCodeSettings,
  options: CommandCodeAdapterLiveOptions = {},
): Effect.Effect<CommandCodeAdapterShape, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const sessions = yield* Ref.make(new Map<ThreadId, CommandCodeSessionContext>());
    const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(eventQueue, event).pipe(Effect.asVoid);

    const asEventId = (suffix: string) =>
      EventId.make(`commandCode:${options.instanceId ?? "default"}:${suffix}`);

    // -----------------------------------------------------------------------
    // startSession
    // -----------------------------------------------------------------------
    const startSession: CommandCodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const allSessions = yield* Ref.get(sessions);
        if (allSessions.has(input.threadId)) {
          // Session already exists — reuse it instead of failing.
          // This can happen when a previous turn failed but the session was not cleaned up.
          const existingContext = allSessions.get(input.threadId)!;
          return existingContext.session;
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

        const context: CommandCodeSessionContext = {
          threadId: input.threadId,
          session,
          scope,
          turns: [],
          currentModel: undefined,
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
    const sendTurn: CommandCodeAdapterShape["sendTurn"] = (input) =>
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
          `cmd-turn-${String(input.threadId)}-${context.turns.length + 1}`,
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
        const binaryPath = config.binaryPath?.trim() || "cmd";
        const authEnv = buildCmdAuthEnv(config, options.environment);

        const args = [
          "-p",
          prompt,
          "--output-format",
          "json",
          "--yolo",
          "--skip-onboarding",
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
            stdout: "pipe",
            stderr: "pipe",
          }),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

        // Parse JSON output and emit events
        const lines = result.stdout.split("\n");
        let hasEmittedCompletion = false;

        for (const line of lines) {
          const parsed = parseCmdJsonLine(line);
          if (!parsed) continue;

          const eventType = parsed.type as string | undefined;

          if (eventType === "result") {
            if (parsed.subtype === "success") {
              const resultText = parsed.result as string | undefined;
              if (resultText) {
                yield* emit({
                  eventId: asEventId(`content-delta-${String(turnId)}-${Date.now()}`),
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
            } else {
              // Handle error results (subtype === "error" or other non-success)
              const errorMessage =
                (parsed.error as string | undefined) ||
                (parsed.result as string | undefined) ||
                "Command Code turn failed";
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
              hasEmittedCompletion = true;
            }
          } else if (eventType === "assistant") {
            const message = parsed.message as Record<string, unknown> | undefined;
            if (message?.content) {
              const content = message.content as Array<Record<string, unknown>> | undefined;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "text" && typeof block.text === "string") {
                    yield* emit({
                      eventId: asEventId(`content-delta-${String(turnId)}-${Date.now()}`),
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
                      eventId: asEventId(`item-started-${String(turnId)}-${Date.now()}`),
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

        // Fallback: if no result message was found, treat as error
        if (!hasEmittedCompletion) {
          const errorMessage =
            result.code !== 0
              ? `Command Code CLI exited with code ${result.code}${result.stderr ? `: ${result.stderr.slice(-500)}` : ""}`
              : "Command Code CLI returned no result";
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
        Effect.catchTag("ProviderCommandNotFoundError", (error) =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: `Command Code CLI not found: ${error.binaryPath}`,
            }),
          ),
        ),
      );

    // -----------------------------------------------------------------------
    // interruptTurn
    // -----------------------------------------------------------------------
    const interruptTurn: CommandCodeAdapterShape["interruptTurn"] = (threadId, _turnId?) =>
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
    const stopSession: CommandCodeAdapterShape["stopSession"] = (threadId) =>
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
    const listSessions: CommandCodeAdapterShape["listSessions"] = () =>
      Effect.map(Ref.get(sessions), (map) => Array.from(map.values()).map((ctx) => ctx.session));

    const hasSession: CommandCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.map(Ref.get(sessions), (map) => map.has(threadId));

    // -----------------------------------------------------------------------
    // readThread / rollbackThread
    // -----------------------------------------------------------------------
    const readThread: CommandCodeAdapterShape["readThread"] = (threadId) =>
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

    const rollbackThread: CommandCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
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
    const respondToRequest: CommandCodeAdapterShape["respondToRequest"] = (
      _threadId,
      _requestId,
      _decision,
    ) => Effect.void;

    const respondToUserInput: CommandCodeAdapterShape["respondToUserInput"] = (
      _threadId,
      _requestId,
      _answers,
    ) => Effect.void;

    // -----------------------------------------------------------------------
    // stopAll
    // -----------------------------------------------------------------------
    const stopAll: CommandCodeAdapterShape["stopAll"] = () =>
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
    } satisfies CommandCodeAdapterShape;
  });
}
