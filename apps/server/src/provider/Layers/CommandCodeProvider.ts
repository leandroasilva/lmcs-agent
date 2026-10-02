import {
  type CommandCodeSettings,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@lmcstools/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner, ChildProcess } from "effect/unstable/process";

import { createModelCapabilities } from "@lmcstools/core/model";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { resolveSpawnCommand } from "@lmcstools/core/shell";
import {
  formatCommandCodeModelName,
  parseCommandCodeModelsOutput,
  CommandCodeStatusSchema,
} from "../commandCodeRuntime.ts";

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODELS_PROBE_TIMEOUT_MS = 5_000;

const COMMANDCODE_PRESENTATION = {
  displayName: "Command Code",
  supportsConversationRollback: false,
  showInteractionModeToggle: false,
} as const;

const EMPTY_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [],
});

const runCommandCodeCli = (
  binaryPath: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = binaryPath || "cmd";
    const spawnCommand = yield* resolveSpawnCommand(command, args, {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Fetch available models from Command Code CLI via `cmd --list-models`.
 */
function fetchCommandCodeModels(
  settings: CommandCodeSettings,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<
  ReadonlyArray<ServerProviderModel>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const modelsResult = yield* runCommandCodeCli(
      settings.binaryPath,
      ["--list-models"],
      environment,
    ).pipe(Effect.timeoutOption(MODELS_PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(modelsResult) || Option.isNone(modelsResult.success)) {
      yield* Effect.logWarning("Failed to fetch Command Code models from CLI, using empty list.");
      return providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
    }

    const output = modelsResult.success.value;
    if (output.code !== 0) {
      return providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
    }

    const slugs = parseCommandCodeModelsOutput(output.stdout);
    if (slugs.length === 0) {
      return providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
    }

    const models: ServerProviderModel[] = slugs.map((slug) => ({
      slug,
      name: formatCommandCodeModelName(slug),
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    }));

    return providerModelsFromSettings(models, settings.customModels, EMPTY_CAPABILITIES);
  });
}

export function buildInitialCommandCodeProviderSnapshot(
  settings: CommandCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ServerProviderDraft, never> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);

    if (!settings.enabled) {
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
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Command Code provider status has not been checked in this session yet.",
      },
    });
  });
}

export const checkCommandCodeProviderStatus = Effect.fn("checkCommandCodeProviderStatus")(
  function* (
    settings: CommandCodeSettings,
    environment: NodeJS.ProcessEnv = process.env,
    _cwd?: string,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);

    if (!settings.enabled) {
      const models = providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
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

    const versionResult = yield* runCommandCodeCli(
      settings.binaryPath,
      ["--version"],
      environment,
    ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      const models = providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: settings.enabled,
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
      const models = providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: settings.enabled,
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
      const models = providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: settings.enabled,
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

    // Check auth status via `cmd status --json`
    const statusResult = yield* runCommandCodeCli(
      settings.binaryPath,
      ["status", "--json"],
      environment,
    ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

    let auth: ServerProviderAuth = { status: "unauthenticated" };
    if (Result.isSuccess(statusResult) && Option.isSome(statusResult.success)) {
      const statusOutput = statusResult.success.value;
      if (statusOutput.code === 0) {
        const parsed = yield* Schema.decodeUnknownEffect(CommandCodeStatusSchema)(
          statusOutput.stdout.trim(),
        ).pipe(Effect.orElseSucceed(() => null));
        if (parsed && parsed.authenticated === true) {
          auth = {
            status: "authenticated",
            type: "commandcode",
            label:
              typeof parsed.user === "string" ? `Command Code (${parsed.user})` : "Command Code",
          };
        }
      }
    }

    if (auth.status === "unauthenticated") {
      const models = providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version,
          status: "error",
          auth,
          message: "Command Code CLI is installed but not authenticated. Run `cmd login`.",
        },
      });
    }

    // Fetch models from CLI
    const models = yield* fetchCommandCodeModels(settings, environment);

    return buildServerProvider({
      presentation: COMMANDCODE_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth,
        message: "Command Code is ready.",
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
