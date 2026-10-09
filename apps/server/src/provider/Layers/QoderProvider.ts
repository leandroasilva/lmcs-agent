import {
  type CustomModelSetting,
  type ModelCapabilities,
  type QoderSettings,
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
import * as NodeOS from "node:os";
import { createModelCapabilities } from "@lmcstools/core/model";
import { resolveSpawnCommand } from "@lmcstools/core/shell";

import {
  BUNDLED_QODER_MODEL_CATALOG,
  parseQoderModelsOutput,
  type QoderModelCatalog,
  scopeQoderModelCatalog,
} from "../QoderModelCatalog.ts";
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
const MODELS_PROBE_TIMEOUT_MS = 15_000;
const QODER_PAT_ENV = "QODER_PERSONAL_ACCESS_TOKEN";
const QODER_AUTH_FILE = ".qoder/.auth/user";

const QODER_PRESENTATION = {
  displayName: "Qoder",
  supportsConversationRollback: false,
  badgeLabel: "CLI",
  showInteractionModeToggle: false,
  reportsContextWindow: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/**
 * Fetch available models from Qoder CLI via `qoder --list-models`.
 * Falls back to built-in catalog on failure.
 */
function fetchQoderModels(
  qoderSettings: QoderSettings,
  environment: NodeJS.ProcessEnv,
  catalog: QoderModelCatalog,
): Effect.Effect<
  ReadonlyArray<ServerProviderModel>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const modelsResult = yield* runQoderCliCommand(
      qoderSettings,
      ["--list-models"],
      environment,
    ).pipe(Effect.timeoutOption(MODELS_PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(modelsResult) || Option.isNone(modelsResult.success)) {
      yield* Effect.logWarning("Failed to fetch Qoder models from CLI, using built-in catalog.");
      return scopeQoderModelCatalog(catalog, qoderSettings.customModels);
    }

    const output = modelsResult.success.value;
    if (output.code !== 0) {
      yield* Effect.logWarning("Qoder --list-models exited with non-zero status.", {
        exitCode: output.code,
      });
      return scopeQoderModelCatalog(catalog, qoderSettings.customModels);
    }

    const modelSlugs = parseQoderModelsOutput(output.stdout);
    if (modelSlugs.length === 0) {
      return scopeQoderModelCatalog(catalog, qoderSettings.customModels);
    }

    // Build models list from CLI output, matching against catalog for metadata
    const models: ServerProviderModel[] = [];
    for (const slug of modelSlugs) {
      const catalogEntry = catalog.models.find((m) => m.model.slug === slug);
      if (catalogEntry) {
        models.push(catalogEntry.model);
      } else {
        // Unknown model from CLI - add with default capabilities
        models.push({
          slug,
          name: formatModelName(slug),
          isCustom: false,
          capabilities: EMPTY_CAPABILITIES,
        });
      }
    }

    return providerModelsFromSettings(models, qoderSettings.customModels, EMPTY_CAPABILITIES);
  });
}

/**
 * Format a model slug into a display name.
 * e.g., "qwen3.8-max" -> "Qwen 3.8 Max"
 */
function formatModelName(slug: string): string {
  return slug
    .split(/[-_.]/)
    .map((part) => {
      if (part.length === 0) return "";
      return part[0]!.toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function buildInitialQoderProviderSnapshot(
  qoderSettings: QoderSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ServerProviderDraft, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    // Use built-in catalog for initial snapshot (fast, no CLI call)
    const models = scopeQoderModelCatalog(BUNDLED_QODER_MODEL_CATALOG, qoderSettings.customModels);

    if (!qoderSettings.enabled) {
      return buildServerProvider({
        presentation: QODER_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Qoder is disabled in LMCS Code settings.",
        },
      });
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDir = environment.HOME ?? NodeOS.homedir();
    const authFilePath = path.join(homeDir, QODER_AUTH_FILE);
    const hasCliAuth = yield* fs.stat(authFilePath).pipe(
      Effect.map((stat) => stat.size > 0),
      Effect.orElseSucceed(() => false),
    );

    const authStatus = qoderSettings.personalAccessToken
      ? {
          status: "authenticated" as const,
          type: "api_key" as const,
          label: "Qoder PAT",
        }
      : hasCliAuth
        ? {
            status: "authenticated" as const,
            type: "cached_token" as const,
            label: "Qoder account",
          }
        : { status: "unauthenticated" as const };

    return buildServerProvider({
      presentation: QODER_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: authStatus.status === "authenticated" ? "ready" : "error",
        auth: authStatus,
        message:
          authStatus.status === "authenticated"
            ? "Qoder is ready."
            : "Qoder CLI is installed but not authenticated. Run `qoder login` or set personalAccessToken in settings.",
      },
    });
  });
}

const runQoderCliCommand = (
  qoderSettings: QoderSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = qoderSettings.binaryPath || "qoder";
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

export const checkQoderProviderStatus = Effect.fn("checkQoderProviderStatus")(function* (
  qoderSettings: QoderSettings,
  environment: NodeJS.ProcessEnv = process.env,
  _cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);

  if (!qoderSettings.enabled) {
    const models = scopeQoderModelCatalog(BUNDLED_QODER_MODEL_CATALOG, qoderSettings.customModels);
    return buildServerProvider({
      presentation: QODER_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Qoder is disabled in LMCS Code settings.",
      },
    });
  }

  const versionResult = yield* runQoderCliCommand(qoderSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Qoder CLI health check failed.", {
      errorTag: error._tag,
    });
    const models = scopeQoderModelCatalog(BUNDLED_QODER_MODEL_CATALOG, qoderSettings.customModels);
    return buildServerProvider({
      presentation: QODER_PRESENTATION,
      enabled: qoderSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Qoder CLI (`qoder`) is not installed or not on PATH."
          : "Failed to execute Qoder CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    const models = scopeQoderModelCatalog(BUNDLED_QODER_MODEL_CATALOG, qoderSettings.customModels);
    return buildServerProvider({
      presentation: QODER_PRESENTATION,
      enabled: qoderSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Qoder CLI is installed but timed out while running `qoder --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Qoder CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    const models = scopeQoderModelCatalog(BUNDLED_QODER_MODEL_CATALOG, qoderSettings.customModels);
    return buildServerProvider({
      presentation: QODER_PRESENTATION,
      enabled: qoderSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Qoder CLI is installed but failed to run.",
      },
    });
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDir = environment.HOME ?? NodeOS.homedir();
  const authFilePath = path.join(homeDir, QODER_AUTH_FILE);
  const hasCliAuth = yield* fs.stat(authFilePath).pipe(
    Effect.map((stat) => stat.size > 0),
    Effect.orElseSucceed(() => false),
  );

  const auth: ServerProviderAuth = environment[QODER_PAT_ENV]?.trim()
    ? { status: "authenticated", type: "api_key", label: "Qoder PAT (env)" }
    : qoderSettings.personalAccessToken
      ? { status: "authenticated", type: "api_key", label: "Qoder PAT" }
      : hasCliAuth
        ? {
            status: "authenticated",
            type: "cached_token",
            label: "Qoder account",
          }
        : { status: "unauthenticated" };

  if (auth.status === "unauthenticated") {
    const models = scopeQoderModelCatalog(BUNDLED_QODER_MODEL_CATALOG, qoderSettings.customModels);
    return buildServerProvider({
      presentation: QODER_PRESENTATION,
      enabled: qoderSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message:
          "Qoder CLI is installed but not authenticated. Set personalAccessToken in settings or QODER_PERSONAL_ACCESS_TOKEN env.",
      },
    });
  }

  // Fetch models from CLI (this is the key change - real model discovery)
  const models = yield* fetchQoderModels(qoderSettings, environment, BUNDLED_QODER_MODEL_CATALOG);

  // Usage limits will be populated when SDK integration is complete
  const usageLimits = makeUnavailableUsageLimits({
    checkedAt,
    reason: "unsupported",
  });

  return buildServerProvider({
    presentation: QODER_PRESENTATION,
    enabled: qoderSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
      message: "Qoder is ready.",
      usageLimits,
    },
  });
});

export function enrichQoderSnapshot(input: {
  snapshot: ServerProvider;
  maintenanceCapabilities: unknown;
  enableProviderUpdateChecks: boolean;
  publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<ServerProvider> {
  return Effect.succeed(input.snapshot);
}
