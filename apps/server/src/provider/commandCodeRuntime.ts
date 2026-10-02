/**
 * Command Code runtime — CLI helpers for the Command Code provider.
 *
 * Command Code (`cmd`) is a CLI-only coding agent. Unlike OpenCode there is
 * no long-running server or SDK; every interaction goes through a spawned
 * subprocess. The headless mode (`cmd -p "…" --output-format json`) emits
 * newline-delimited JSON events that the adapter maps onto the LMCS Code
 * `ProviderRuntimeEvent` protocol.
 *
 * @module provider/commandCodeRuntime
 */
import type { CommandCodeSettings } from "@lmcstools/core";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveSpawnCommand } from "@lmcstools/core/shell";
import { spawnAndCollect } from "./providerSnapshot.ts";

const COMMANDCODE_RUNTIME_ERROR_TAG = "CommandCodeRuntimeError";
export class CommandCodeRuntimeError extends Data.TaggedError(COMMANDCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is CommandCodeRuntimeError =>
    P.isTagged(u, COMMANDCODE_RUNTIME_ERROR_TAG);
}

export function commandCodeRuntimeErrorDetail(cause: unknown): string {
  if (CommandCodeRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  return String(cause);
}

function ensureRuntimeError(
  operation: string,
  detail: string,
  cause: unknown,
): CommandCodeRuntimeError {
  return CommandCodeRuntimeError.is(cause)
    ? cause
    : new CommandCodeRuntimeError({ operation, detail, cause });
}

export interface CommandCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * Run a single Command Code CLI command and collect its output.
 */
export const runCommandCodeCommand = (input: {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}): Effect.Effect<
  CommandCodeCommandResult,
  CommandCodeRuntimeError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const command = input.binaryPath || "cmd";
    const spawnCommand = yield* resolveSpawnCommand(command, input.args, {
      env: input.environment ?? process.env,
    }).pipe(
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "runCommandCodeCommand",
          `Failed to resolve command '${command}': ${commandCodeRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );
    const result = yield* Effect.scoped(
      spawnAndCollect(
        command,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: input.environment ?? process.env,
          shell: spawnCommand.shell,
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        }),
      ),
    ).pipe(
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "runCommandCodeCommand",
          `Failed to spawn command '${command}': ${commandCodeRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );
    return result;
  }).pipe(Effect.withSpan("commandcode.runCommand"));

/**
 * Parse the version from `cmd --version` output.
 * The CLI prints something like "Command Code v1.74.0" or just "1.74.0".
 */
export function parseCommandCodeVersion(output: string): string | null {
  const match = output.match(/(?:v\s*)?(\d+\.\d+\.\d+)/i);
  return match?.[1] ?? null;
}

/**
 * Parse model slugs from `cmd --list-models` output.
 *
 * The CLI prints a header, then category sections, then lines of the form:
 *   deepseek/deepseek-v4-flash   fast hybrid-attention reasoning (default)
 *
 * We extract the leading slug (anything matching `word/word` at the start of
 * a line, ignoring blank and header lines).
 */
export function parseCommandCodeModelsOutput(stdout: string): ReadonlyArray<string> {
  const slugs: Array<string> = [];
  const seen = new Set<string>();
  const slugRe = /^(\S+\/\S+)/;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("Available models")) continue;
    if (!trimmed.includes("/")) continue;

    const match = slugRe.exec(trimmed);
    if (match && !seen.has(match[1]!)) {
      seen.add(match[1]!);
      slugs.push(match[1]!);
    }
  }
  return slugs;
}

/**
 * Parsed Command Code status from `cmd status --json`.
 */
export interface CommandCodeStatus {
  readonly authenticated: boolean;
  readonly version: string | null;
  readonly user: string | null;
  readonly model: string | null;
  readonly contextWindow: number | null;
}

export const CommandCodeStatusSchema = Schema.Struct({
  authenticated: Schema.Boolean,
  version: Schema.optionalKey(Schema.NullOr(Schema.String)),
  user: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  context_window: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export const decodeCommandCodeStatus = Schema.decodeUnknownSync(CommandCodeStatusSchema);

/**
 * Fetch the Command Code CLI status via `cmd status --json`.
 */
export const fetchCommandCodeStatus = (input: {
  readonly binaryPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}): Effect.Effect<
  CommandCodeStatus,
  CommandCodeRuntimeError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const result = yield* runCommandCodeCommand({
      binaryPath: input.binaryPath,
      args: ["status", "--json"],
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    });

    if (result.code !== 0) {
      return yield* new CommandCodeRuntimeError({
        operation: "fetchCommandCodeStatus",
        detail: `cmd status --json exited with code ${result.code}.`,
      });
    }

    const trimmed = result.stdout.trim();
    if (trimmed.length === 0) {
      return yield* new CommandCodeRuntimeError({
        operation: "fetchCommandCodeStatus",
        detail: "cmd status --json produced empty output.",
      });
    }

    const decoded = yield* Effect.try({
      try: () => decodeCommandCodeStatus(trimmed),
      catch: (cause) =>
        new CommandCodeRuntimeError({
          operation: "fetchCommandCodeStatus",
          detail: `Failed to decode cmd status output: ${String(cause)}`,
          cause,
        }),
    });

    return {
      authenticated: decoded.authenticated,
      version: decoded.version ?? null,
      user: decoded.user ?? null,
      model: decoded.model ?? null,
      contextWindow: decoded.context_window ?? null,
    } satisfies CommandCodeStatus;
  }).pipe(Effect.withSpan("commandcode.fetchStatus"));

/**
 * Headless-mode NDJSON event types emitted by `cmd -p … --output-format json`.
 *
 * Each line is a JSON object with `{ type: "event", event: { type: <kind>, … } }`
 * except the final line which has `{ type: "result", … }`.
 */
export interface CommandCodeHeadlessEvent {
  readonly type: "event";
  readonly event: CommandCodeEventPayload;
}

export type CommandCodeEventPayload =
  | { readonly type: "run_start"; readonly sessionId: string }
  | { readonly type: "turn_start"; readonly turnNumber: number }
  | { readonly type: "message_start" }
  | { readonly type: "model_request_start"; readonly model: string }
  | { readonly type: "model_trace"; readonly traceId: string }
  | { readonly type: "text_delta"; readonly delta: string }
  | {
      readonly type: "message_update";
      readonly content: ReadonlyArray<{ readonly type: string; readonly [key: string]: unknown }>;
    }
  | {
      readonly type: "model_request_end";
      readonly model: string;
      readonly usage?: CommandCodeUsage;
      readonly stopReason?: string;
    }
  | {
      readonly type: "message_end";
      readonly content: ReadonlyArray<{ readonly type: string; readonly [key: string]: unknown }>;
    }
  | {
      readonly type: "turn_end";
      readonly turnNumber: number;
      readonly hadToolCalls: boolean;
      readonly usage?: CommandCodeUsage;
    }
  | {
      readonly type: "run_end";
      readonly result: {
        readonly finalText: string;
        readonly stopReason: string;
        readonly turnCount: number;
        readonly usage?: CommandCodeUsage;
      };
    }
  | { readonly type: string; readonly [key: string]: unknown };

export interface CommandCodeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface CommandCodeHeadlessResult {
  readonly type: "result";
  readonly subtype: string;
  readonly sessionId: string;
  readonly stopReason: string;
  readonly usage?: CommandCodeUsage;
  readonly durationMs: number;
  readonly finalText: string;
}

export type CommandCodeNdjsonLine = CommandCodeHeadlessEvent | CommandCodeHeadlessResult;

/**
 * Parse a single NDJSON line from Command Code headless output.
 * Returns `null` for lines that cannot be decoded.
 */
export function parseCommandCodeNdjsonLine(line: string): CommandCodeNdjsonLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.type === "event" && parsed.event && typeof parsed.event === "object") {
      return parsed as unknown as CommandCodeHeadlessEvent;
    }
    if (parsed.type === "result") {
      return parsed as unknown as CommandCodeHeadlessResult;
    }
    return parsed as unknown as CommandCodeNdjsonLine;
  } catch {
    return null;
  }
}

/**
 * Format a model slug into a display name.
 * e.g., "deepseek/deepseek-v4-flash" -> "Deepseek V4 Flash"
 */
export function formatCommandCodeModelName(slug: string): string {
  const parts = slug.split("/");
  const modelName = parts.length > 1 ? parts.slice(1).join("/") : slug;
  return modelName
    .split(/[-_.]/)
    .map((part) => {
      if (part.length === 0) return "";
      return part[0]!.toUpperCase() + part.slice(1);
    })
    .join(" ");
}
