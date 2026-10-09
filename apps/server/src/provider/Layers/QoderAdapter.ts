/**
 * QoderAdapter — CLI-based adapter for the Qoder provider.
 *
 * Spawns `qoder -p` (print mode) with `--output-format stream-json` for each
 * turn and translates the NDJSON event stream into canonical runtime events as
 * it arrives, so long turns report progress instead of going silent. Each
 * thread maps to a deterministic Qoder session id: the first turn creates it
 * with `--session-id` and later turns continue it with `--resume`, so the
 * conversation survives across turns (and across server restarts).
 *
 * @module QoderAdapter
 */
import * as NodeCrypto from "node:crypto";
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
import type * as PlatformError from "effect/PlatformError";
import { CommandResolutionError, resolveSpawnCommand } from "@lmcstools/core/shell";

import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import { collectStreamAsString } from "../providerSnapshot.ts";
import type { QoderAdapterShape } from "../Services/QoderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("qoder");

export interface QoderAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

interface QoderSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  currentModel: string | undefined;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
  /** Deterministic Qoder CLI session id for this thread. */
  qoderSessionId: string;
  /** Whether the Qoder session has been created on disk yet. */
  qoderSessionCreated: boolean;
  /** In-flight CLI process so interruptTurn can stop it. */
  activeProcess: ChildProcessSpawner.ChildProcessHandle | undefined;
  /** Set by interruptTurn/stopSession; sendTurn consults it when the process ends without a result. */
  turnInterrupted: boolean;
}

/**
 * Derive a stable UUID from a seed so every turn of a thread maps to the same
 * Qoder session, which can also be resumed from a terminal with
 * `qoder --resume <id>`. The CLI rejects non-UUID session ids.
 */
const deterministicQoderSessionId = (seed: string): string => {
  const digest = NodeCrypto.createHash("sha256").update(seed).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `${((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
};

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
 * Parse a single JSON line from Qoder's `--output-format stream-json` output.
 * Returns null for non-JSON lines (progress indicators, errors, etc.).
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

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

interface TurnTerminal {
  readonly ok: boolean;
  readonly errorMessage?: string;
}

interface TurnAttemptOutcome {
  readonly terminal: TurnTerminal | null;
  readonly stderrTail: string;
  readonly exitCode: number;
  readonly sessionIdInUse: boolean;
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
          turns: [],
          currentModel: config.favoriteModel?.trim() || undefined,
          activeTurnId: undefined,
          stopped: false,
          qoderSessionId: deterministicQoderSessionId(
            `lmcs-qoder:${String(options.instanceId ?? "default")}:${String(input.threadId)}`,
          ),
          qoderSessionCreated: false,
          activeProcess: undefined,
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
    const sendTurn: QoderAdapterShape["sendTurn"] = (input) =>
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
          `qoder-turn-${String(input.threadId)}-${context.turns.length + 1}`,
        );
        context.activeTurnId = turnId;
        context.turnInterrupted = false;

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
        const env = { ...process.env, ...options.environment, ...authEnv };

        const runAttempt = (
          sessionMode: "session-id" | "resume",
        ): Effect.Effect<
          TurnAttemptOutcome,
          PlatformError.PlatformError | CommandResolutionError
        > =>
          Effect.gen(function* () {
            const args = [
              "-p",
              prompt,
              "--output-format",
              "stream-json",
              "--permission-mode",
              "bypass_permissions",
              "--max-turns",
              "100",
              sessionMode === "session-id" ? "--session-id" : "--resume",
              context.qoderSessionId,
              ...(context.currentModel ? ["-m", context.currentModel] : []),
            ];

            const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, { env });

            const turnScope = yield* Scope.make();
            const handle = yield* spawner
              .spawn(
                ChildProcess.make(spawnCommand.command, spawnCommand.args, {
                  env,
                  cwd,
                  shell: spawnCommand.shell,
                  stdin: "ignore",
                }),
              )
              .pipe(
                Effect.provideService(Scope.Scope, turnScope),
                Effect.ensuring(Scope.close(turnScope, Exit.void)),
              );

            context.activeProcess = handle;

            // An interrupt that raced in before the process registered still
            // needs to stop the turn — kill now instead of running to completion.
            if (context.turnInterrupted) {
              yield* handle
                .kill({ killSignal: "SIGINT", forceKillAfter: "5 seconds" })
                .pipe(Effect.ignore);
            }

            let contentSeq = 0;
            let terminal: TurnTerminal | null = null;
            const toolsInFlight = new Map<string, { name: string; input: unknown }>();

            const processLine = (line: string): Effect.Effect<void> =>
              Effect.gen(function* () {
                const parsed = parseQoderJsonLine(line);
                if (!parsed) return;

                if (parsed.type === "assistant") {
                  const message = asRecord(parsed.message);
                  const content = message?.content;
                  if (!Array.isArray(content)) return;
                  for (const [blockIndex, blockValue] of content.entries()) {
                    const block = asRecord(blockValue);
                    if (!block) continue;
                    if (block.type === "text") {
                      const text = asNonEmptyString(block.text);
                      if (!text) continue;
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
                          delta: text,
                          contentIndex: blockIndex,
                        },
                      });
                    } else if (block.type === "thinking") {
                      const thinking = asNonEmptyString(block.thinking);
                      if (!thinking) continue;
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
                          delta: thinking,
                          contentIndex: blockIndex,
                        },
                      });
                    } else if (block.type === "tool_use") {
                      const toolUseId = asNonEmptyString(block.id) ?? `tool-${String(blockIndex)}`;
                      const toolName = asNonEmptyString(block.name) ?? "tool_call";
                      toolsInFlight.set(toolUseId, { name: toolName, input: block.input });
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
                          data: { toolName, toolInput: block.input },
                        },
                      });
                    }
                  }
                  return;
                }

                if (parsed.type === "user") {
                  const message = asRecord(parsed.message);
                  const content = message?.content;
                  if (!Array.isArray(content)) return;
                  for (const blockValue of content) {
                    const block = asRecord(blockValue);
                    if (!block || block.type !== "tool_result") continue;
                    const toolUseId = asNonEmptyString(block.tool_use_id);
                    const tool = toolUseId ? toolsInFlight.get(toolUseId) : undefined;
                    if (!toolUseId || !tool) continue;
                    toolsInFlight.delete(toolUseId);
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
                        status: block.is_error === true ? "failed" : "completed",
                        title: tool.name,
                        data: {
                          toolName: tool.name,
                          toolInput: tool.input,
                          toolResult: block.content,
                        },
                      },
                    });
                  }
                  return;
                }

                if (parsed.type === "result") {
                  if (parsed.subtype === "success") {
                    terminal = { ok: true };
                  } else {
                    const errors = Array.isArray(parsed.errors)
                      ? parsed.errors.filter((e): e is string => typeof e === "string")
                      : [];
                    terminal = {
                      ok: false,
                      errorMessage:
                        errors.join("; ") || asNonEmptyString(parsed.result) || "Qoder turn failed",
                    };
                  }
                }
              });

            const [stdout, stderr, exitCode] = yield* Effect.all(
              [
                collectStreamAsString(handle.stdout),
                collectStreamAsString(handle.stderr),
                handle.exitCode,
              ],
              { concurrency: "unbounded" },
            );

            // Process stdout lines after collection to avoid Stream.splitLines issues
            const lines = stdout.split("\n");
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              yield* processLine(trimmed).pipe(Effect.orElseSucceed(() => undefined));
            }

            context.activeProcess = undefined;

            const stderrTail = stderr.trim().slice(-500);
            return {
              terminal,
              stderrTail,
              exitCode: Number(exitCode),
              sessionIdInUse: stderrTail.includes("is already in use"),
            } satisfies TurnAttemptOutcome;
          });

        // The session is created on the first turn with `--session-id`; later
        // turns continue it with `--resume`. When the server restarts mid-thread
        // the in-memory flag is lost while the Qoder session still exists on
        // disk — the "already in use" error recovers by switching to `--resume`.
        const attempts: Array<"session-id" | "resume"> = context.qoderSessionCreated
          ? ["resume"]
          : ["session-id", "resume"];

        let outcome: TurnAttemptOutcome | null = null;
        for (const attempt of attempts) {
          const attemptOutcome = yield* runAttempt(attempt);
          outcome = attemptOutcome;
          if (attemptOutcome.terminal?.ok) {
            context.qoderSessionCreated = true;
            break;
          }
          if (context.turnInterrupted || !attemptOutcome.sessionIdInUse) {
            break;
          }
          context.qoderSessionCreated = true;
        }

        const finalOutcome = outcome;
        if (finalOutcome?.terminal?.ok) {
          yield* emit({
            eventId: asEventId(`turn-completed-${String(turnId)}`),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            createdAt: yield* nowIso(),
            type: "turn.completed",
            payload: { state: "completed" },
          });
        } else if (context.turnInterrupted) {
          yield* emit({
            eventId: asEventId(`turn-aborted-${String(turnId)}`),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            createdAt: yield* nowIso(),
            type: "turn.aborted",
            payload: { reason: "interrupted" },
          });
        } else {
          yield* emit({
            eventId: asEventId(`turn-completed-error-${String(turnId)}`),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            createdAt: yield* nowIso(),
            type: "turn.completed",
            payload: {
              state: "failed",
              errorMessage:
                finalOutcome?.terminal?.errorMessage ??
                (finalOutcome && finalOutcome.stderrTail.length > 0
                  ? finalOutcome.stderrTail
                  : `Qoder CLI exited with code ${finalOutcome?.exitCode ?? "unknown"} without a result`),
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
        Effect.catchTag("CommandResolutionError", (error) =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: `Qoder CLI not found: ${error.command}`,
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

        context.turnInterrupted = true;
        const process = context.activeProcess;
        if (process) {
          const running = yield* process.isRunning.pipe(
            Effect.ignore,
            Effect.orElseSucceed(() => false),
          );
          if (running) {
            // SIGINT lets the CLI persist the session so the next turn can resume it.
            yield* process
              .kill({ killSignal: "SIGINT", forceKillAfter: "5 seconds" })
              .pipe(Effect.ignore);
          }
        }
        // The terminal turn.aborted is emitted by sendTurn once the process ends.
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
        context.turnInterrupted = true;
        const process = context.activeProcess;
        if (process) {
          const running = yield* process.isRunning.pipe(
            Effect.ignore,
            Effect.orElseSucceed(() => false),
          );
          if (running) {
            yield* process
              .kill({ killSignal: "SIGINT", forceKillAfter: "5 seconds" })
              .pipe(Effect.ignore);
          }
        }

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
