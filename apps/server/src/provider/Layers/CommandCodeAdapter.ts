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
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@lmcstools/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import { buildCommandCodeAuthEnv } from "../commandCodeRuntime.ts";
import { collectStreamAsString, ProviderCommandNotFoundError } from "../providerSnapshot.ts";
import { isWindowsCommandNotFound } from "../../processRunner.ts";
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

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

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
        const authEnv = buildCommandCodeAuthEnv(config, options.environment);

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

        // Spawn the CLI and stream its stdout incrementally. The previous
        // spawnAndCollect buffered the entire output before parsing, so with
        // `--output-format json` (an NDJSON event stream) the UI saw nothing
        // until the process exited and then received every event in one burst —
        // a multi-tool turn looked frozen. Decode chunks and split lines by hand
        // instead of piping through Stream.splitLines, which can hit an undefined
        // channel on a child-process stream in this Effect RC and kill the turn.
        let hasEmittedCompletion = false;
        let contentSeq = 0;
        // text_delta streams the reply live; finalText on the result line would
        // duplicate it, so only fall back to finalText when nothing streamed.
        let emittedAssistantText = false;
        const toolsInFlight = new Map<string, { name: string; input: unknown }>();

        const processLine = (line: string): Effect.Effect<void> =>
          Effect.gen(function* () {
            const parsed = parseCmdJsonLine(line);
            if (!parsed) return;

            const topType = parsed.type as string | undefined;

            // The final line terminates the turn: {"type":"result",...}.
            if (topType === "result") {
              if (parsed.subtype === "success") {
                const finalText = asNonEmptyString(parsed.finalText);
                if (finalText && !emittedAssistantText) {
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
                      delta: finalText,
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
                  asNonEmptyString(parsed.error) ||
                  asNonEmptyString(parsed.result) ||
                  asNonEmptyString(parsed.finalText) ||
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
              return;
            }

            // Everything else arrives wrapped as {"type":"event","event":{...}}.
            // cmd 1.79 streams these frames live; the previous parser only looked
            // for top-level "assistant"/"result" and silently dropped all of them,
            // so the UI showed no progress until the final result line.
            if (topType !== "event") return;
            const event = asRecord(parsed.event);
            if (!event) return;
            const eventType = event.type as string | undefined;

            if (eventType === "text_delta") {
              const delta = asNonEmptyString(event.delta);
              if (!delta) return;
              emittedAssistantText = true;
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
                  delta,
                },
              });
              return;
            }

            if (eventType === "thinking_delta") {
              const delta = asNonEmptyString(event.delta);
              if (!delta) return;
              contentSeq += 1;
              yield* emit({
                eventId: asEventId(`content-delta-${String(turnId)}-${contentSeq}`),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                createdAt: yield* nowIso(),
                type: "content.delta",
                payload: {
                  streamKind: "reasoning_text",
                  delta,
                },
              });
              return;
            }

            if (eventType === "tool_queued" || eventType === "tool_running") {
              const toolCallId = asNonEmptyString(event.toolCallId);
              if (!toolCallId) return;
              // tool_queued carries the input, tool_running does not. Register the
              // call once and emit item.started once (on the first frame seen).
              const existing = toolsInFlight.get(toolCallId);
              const toolName = asNonEmptyString(event.toolName) ?? existing?.name ?? "tool_call";
              if (existing) {
                existing.name = toolName;
                if (event.input !== undefined) existing.input = event.input;
                return;
              }
              const toolInput = event.input;
              toolsInFlight.set(toolCallId, {
                name: toolName,
                input: toolInput,
              });
              yield* emit({
                eventId: asEventId(`item-started-${String(turnId)}-${toolCallId}`),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                itemId: RuntimeItemId.make(toolCallId),
                createdAt: yield* nowIso(),
                type: "item.started",
                payload: {
                  itemType: "dynamic_tool_call",
                  status: "inProgress",
                  title: toolName,
                  data: { toolName, toolInput },
                },
              });
              return;
            }

            if (eventType === "tool_completed") {
              const toolCallId = asNonEmptyString(event.toolCallId);
              if (!toolCallId) return;
              const tool = toolsInFlight.get(toolCallId);
              const toolName = asNonEmptyString(event.toolName) ?? tool?.name ?? "tool_call";
              toolsInFlight.delete(toolCallId);
              const failed = event.isError === true || event.error !== undefined;
              yield* emit({
                eventId: asEventId(`item-finished-${String(turnId)}-${toolCallId}`),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                itemId: RuntimeItemId.make(toolCallId),
                createdAt: yield* nowIso(),
                type: "item.updated",
                payload: {
                  itemType: "dynamic_tool_call",
                  status: failed ? "failed" : "completed",
                  title: toolName,
                  data: {
                    toolName,
                    toolInput: tool?.input,
                    toolResult: event.result,
                  },
                },
              });
              return;
            }
            // Remaining frames (run_start, turn_start/end, message_*, model_*,
            // api_retry, tool_update, run_end) carry no canonical runtime event.
          });

        const turnScope = yield* Scope.make();
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              env: { ...process.env, ...authEnv },
              cwd,
              shell: spawnCommand.shell,
              stdout: "pipe",
              stderr: "pipe",
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, turnScope));

        let stdoutLineBuffer = "";
        const processStdoutChunk = (chunk: string): Effect.Effect<void> =>
          Effect.gen(function* () {
            stdoutLineBuffer += chunk;
            let newlineIndex = stdoutLineBuffer.indexOf("\n");
            while (newlineIndex >= 0) {
              const line = stdoutLineBuffer.slice(0, newlineIndex).trim();
              stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
              if (line) {
                yield* processLine(line).pipe(Effect.orElseSucceed(() => undefined));
              }
              newlineIndex = stdoutLineBuffer.indexOf("\n");
            }
          });

        const [stdoutExit, stderrExit, exitCodeExit] = yield* Effect.all(
          [
            Effect.exit(
              handle.stdout.pipe(Stream.decodeText(), Stream.runForEach(processStdoutChunk)),
            ),
            Effect.exit(collectStreamAsString(handle.stderr)),
            Effect.exit(
              handle.exitCode.pipe(
                Effect.map(Number),
                Effect.catchTag("PlatformError", () => Effect.succeed(-1)),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );

        // Close the turn scope to clean up the child process.
        yield* Scope.close(turnScope, Exit.void).pipe(Effect.ignore);

        if (Exit.isFailure(stdoutExit)) {
          yield* Effect.logWarning(
            "Command Code CLI stdout collection degraded; continuing with partial output",
          );
        }

        // Flush a trailing line that the CLI never terminated with a newline.
        const trailingLine = stdoutLineBuffer.trim();
        stdoutLineBuffer = "";
        if (trailingLine) {
          yield* processLine(trailingLine).pipe(Effect.orElseSucceed(() => undefined));
        }

        const stderr = Exit.isSuccess(stderrExit) ? stderrExit.value : "";
        const exitCode = Exit.isSuccess(exitCodeExit) ? exitCodeExit.value : -1;

        // Preserve spawnAndCollect's Windows "command not found" detection so the
        // outer catchTag still maps it to a ProviderAdapterRequestError.
        if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
          return yield* new ProviderCommandNotFoundError({
            binaryPath,
            exitCode,
            stdoutLength: 0,
            stderrLength: stderr.length,
          });
        }

        // Fallback: if no result message was found, treat as error
        if (!hasEmittedCompletion) {
          const errorMessage =
            exitCode !== 0
              ? `Command Code CLI exited with code ${exitCode}${stderr ? `: ${stderr.slice(-500)}` : ""}`
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
