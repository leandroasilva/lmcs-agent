/**
 * CommandCodeProvider — snapshot/probe layer for the Command Code provider.
 *
 * Probes `cmd --version` to verify CLI availability and validates the
 * configured credential with `cmd whoami`, the only Command Code check that
 * actually reaches the API.
 *
 * @module CommandCodeProvider
 */
import {
  type CommandCodeSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@lmcstools/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@lmcstools/core/model";
import { resolveSpawnCommand } from "@lmcstools/core/shell";

import {
  COMMAND_CODE_API_KEY_ENV,
  type CommandCodeAuthProbe,
  mergeCommandCodeEnv,
  probeCommandCodeAuth,
} from "../commandCodeRuntime.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeUnavailableUsageLimits } from "../providerUsageLimits.ts";

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODELS_PROBE_TIMEOUT_MS = 8_000;
const AUTH_PROBE_TIMEOUT_MS = 10_000;

/** Section headers in `cmd --list-models` output — not model lines. */
const COMMANDCODE_SECTION_HEADERS = new Set([
  "Open Source",
  "Stealth",
  "Anthropic",
  "OpenAI",
  "Google",
  "Sakana",
  "Meta",
  "xAI",
]);

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const COMMANDCODE_PRESENTATION = {
  displayName: "Command Code",
  supportsConversationRollback: false,
  badgeLabel: "CLI",
  showInteractionModeToggle: false,
  reportsContextWindow: false,
} as const;

/**
 * Built-in model catalog for Command Code.
 * Used as fallback when `cmd --list-models` is unavailable.
 */
const BUILTIN_COMMANDCODE_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gpt-4.1",
    name: "GPT-4.1",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/**
 * Parse model slugs from `cmd --list-models` output.
 *
 * Output format:
 *   Available models  ·  N models
 *
 *   <Section Header>
 *
 *   <slug>               <description>
 *   <slug>               <description>
 *
 *   Pass the full id, or just the short name...
 *
 * Lines are either the header, section headers, model rows (slug + padded
 * description), or footer instructions. Model rows are identified by a
 * non-empty first token that contains no spaces and is not a section header.
 */
function parseCommandCodeModelsOutput(output: string): ReadonlyArray<string> {
  const slugs: string[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    // Skip empty lines, header, and footer
    if (!line) continue;
    if (line.startsWith("Available models")) continue;
    if (line.startsWith("Pass the full id")) break;
    if (line.startsWith("Decision models")) break;
    // Skip section headers (known multi-word headers)
    if (COMMANDCODE_SECTION_HEADERS.has(line)) continue;
    // Model rows: first whitespace-delimited token is the slug
    const parts = line.split(/\s+/);
    if (parts.length < 1) continue;
    const slug = parts[0]!;
    // Skip if slug looks like a section header or instruction
    if (slug.includes(" ") || slug === "Docs:") continue;
    slugs.push(slug);
  }
  return slugs;
}

/**
 * Format a model slug into a display name.
 * e.g. "claude-sonnet-5-5" -> "Claude Sonnet 5.5"
 *      "deepseek/deepseek-v4-pro" -> "Deepseek V4 Pro"
 */
function formatCommandCodeModelName(slug: string): string {
  const short = slug.includes("/") ? (slug.split("/").pop() ?? slug) : slug;
  return short
    .split(/[-_.]/)
    .map((part) => {
      if (part.length === 0) return "";
      return part[0]!.toUpperCase() + part.slice(1);
    })
    .join(" ");
}

/**
 * Fetch available models from Command Code CLI via `cmd --list-models`.
 * Falls back to the built-in catalog on failure.
 */
function fetchCommandCodeModels(
  cmdSettings: CommandCodeSettings,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<
  ReadonlyArray<ServerProviderModel>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const modelsResult = yield* runCmdCliCommand(cmdSettings, ["--list-models"], environment).pipe(
      Effect.timeoutOption(MODELS_PROBE_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(modelsResult) || Option.isNone(modelsResult.success)) {
      yield* Effect.logWarning(
        "Failed to fetch Command Code models from CLI, using built-in catalog.",
      );
      return BUILTIN_COMMANDCODE_MODELS;
    }

    const output = modelsResult.success.value;
    if (output.code !== 0) {
      yield* Effect.logWarning("cmd --list-models exited with non-zero status.", {
        exitCode: output.code,
      });
      return BUILTIN_COMMANDCODE_MODELS;
    }

    const slugs = parseCommandCodeModelsOutput(output.stdout);
    if (slugs.length === 0) {
      yield* Effect.logWarning(
        "cmd --list-models returned no parseable models, using built-in catalog.",
      );
      return BUILTIN_COMMANDCODE_MODELS;
    }

    return slugs.map((slug) => ({
      slug,
      name: formatCommandCodeModelName(slug),
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    }));
  });
}

function scopeCommandCodeModelCatalog(
  customModels: CommandCodeSettings["customModels"],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(BUILTIN_COMMANDCODE_MODELS, customModels, EMPTY_CAPABILITIES);
}

const runCmdCliCommand = (
  cmdSettings: CommandCodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const binaryPath = cmdSettings.binaryPath || "cmd";
    // Probes must run with the same credential the turns use, otherwise the
    // health check validates one identity while `sendTurn` runs with another.
    const env = mergeCommandCodeEnv(environment, cmdSettings);
    const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, {
      env,
    });
    return yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
        shell: spawnCommand.shell,
      }),
    );
  });

export function buildInitialCommandCodeProviderSnapshot(
  cmdSettings: CommandCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = scopeCommandCodeModelCatalog(cmdSettings.customModels);

    if (!cmdSettings.enabled) {
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Command Code is disabled in LMCS Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: COMMANDCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "unknown" },
        message: "Command Code provider is ready.",
      },
    });
  });
}

/**
 * User-facing reason an authentication probe did not succeed.
 *
 * An exhaustive switch keeps the union narrowed per branch, so `detail` is only
 * read where the CLI actually supplied one.
 */
function commandCodeAuthFailureMessage(probe: CommandCodeAuthProbe): string {
  switch (probe.status) {
    case "rejected":
      return `Command Code rejected the configured API key (${probe.detail}). Clear apiKey in settings, or run \`cmd login\` in a terminal.`;
    case "missing":
      return "Command Code is not signed in. Run `cmd login` in a terminal, or set apiKey in settings.";
    case "unknown":
      return `Could not verify Command Code authentication: ${probe.detail}`;
    case "authenticated":
      return "Command Code is ready.";
  }
}

export const checkCommandCodeProviderStatus = Effect.fn("checkCommandCodeProviderStatus")(
  function* (
    cmdSettings: CommandCodeSettings,
    environment: NodeJS.ProcessEnv = process.env,
    _cwd?: string,
  ): Effect.fn.Return<
    ServerProviderDraft,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);

    if (!cmdSettings.enabled) {
      const models = scopeCommandCodeModelCatalog(cmdSettings.customModels);
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Command Code is disabled in LMCS Code settings.",
        },
      });
    }

    const versionResult = yield* runCmdCliCommand(cmdSettings, ["--version"], environment).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      yield* Effect.logWarning("Command Code CLI health check failed.", {
        errorTag: error._tag,
      });
      const models = scopeCommandCodeModelCatalog(cmdSettings.customModels);
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: cmdSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Command Code CLI (`cmd`) is not installed or not on PATH."
            : "Failed to execute Command Code CLI health check.",
        },
      });
    }

    if (Option.isNone(versionResult.success)) {
      const models = scopeCommandCodeModelCatalog(cmdSettings.customModels);
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: cmdSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Command Code CLI is installed but timed out while running `cmd --version`.",
        },
      });
    }

    const versionOutput = versionResult.success.value;
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);

    if (versionOutput.code !== 0) {
      yield* Effect.logWarning("Command Code CLI version probe exited with a non-zero status.", {
        exitCode: versionOutput.code,
      });
      const models = scopeCommandCodeModelCatalog(cmdSettings.customModels);
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: cmdSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "Command Code CLI is installed but failed to run.",
        },
      });
    }

    // Having a credential proves nothing. `cmd status` answers "Authentication
    // verified" for a key the API rejects with 401, and `cmd --list-models`
    // succeeds with no credentials at all, so both used to report a healthy
    // provider whose every turn failed with "Authentication failed". Only
    // `cmd whoami` asks the server whether the credential is actually accepted.
    const authProbe = yield* probeCommandCodeAuth({
      settings: cmdSettings,
      environment,
    }).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS));
    const probe: CommandCodeAuthProbe = Option.isSome(authProbe)
      ? authProbe.value
      : { status: "unknown", detail: "`cmd whoami` timed out." };

    const auth: ServerProviderAuth =
      probe.status === "authenticated"
        ? environment[COMMAND_CODE_API_KEY_ENV]?.trim()
          ? {
              status: "authenticated",
              type: "api_key",
              label: "Command Code API Key (env)",
            }
          : cmdSettings.apiKey?.trim()
            ? {
                status: "authenticated",
                type: "api_key",
                label: "Command Code API Key",
              }
            : {
                // Signed in through `cmd login`; the credential lives in the
                // CLI's own auth file and no API key is configured here.
                status: "authenticated",
                type: "cached_token",
                label: "Command Code account",
              }
        : probe.status === "unknown"
          ? { status: "unknown" }
          : { status: "unauthenticated" };

    if (auth.status !== "authenticated") {
      const models = scopeCommandCodeModelCatalog(cmdSettings.customModels);
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: cmdSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version,
          // A refused credential is a hard error. An unverifiable one is not
          // the user's fault and must not read as a broken installation.
          status: probe.status === "unknown" ? "warning" : "error",
          auth,
          message: commandCodeAuthFailureMessage(probe),
        },
      });
    }

    const usageLimits = makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
    });

    // Fetch models dynamically from CLI; fall back to built-in on failure.
    const models = yield* fetchCommandCodeModels(cmdSettings, environment);

    return buildServerProvider({
      presentation: COMMANDCODE_PRESENTATION,
      enabled: cmdSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings(models, cmdSettings.customModels, EMPTY_CAPABILITIES),
      probe: {
        installed: true,
        version,
        status: "ready",
        auth,
        message: "Command Code is ready.",
        usageLimits,
      },
    });
  },
);

export function enrichCommandCodeSnapshot(input: {
  snapshot: ServerProvider;
  maintenanceCapabilities: unknown;
  enableProviderUpdateChecks: boolean;
  publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<ServerProvider> {
  return Effect.succeed(input.snapshot);
}
