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
import {
  mergeQoderEnv,
  QODER_AUTH_FILE,
  QODER_PAT_ENV,
  qoderPatRejectionDetail,
  resolveQoderPat,
} from "../qoderRuntime.ts";

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODELS_PROBE_TIMEOUT_MS = 15_000;

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

/** Outcome of the `qoder --list-models` probe: models plus any PAT verdict. */
interface QoderModelProbe {
  readonly models: ReadonlyArray<ServerProviderModel>;
  /** The CLI's own explanation of a rejected PAT, or null. */
  readonly patRejection: string | null;
}

/**
 * Fetch available models from Qoder CLI via `qoder --list-models`.
 * Falls back to built-in catalog on failure.
 *
 * Also reports whether the CLI refused a configured PAT: `--list-models` is the
 * cheapest Qoder command that actually authenticates, and the models are needed
 * anyway, so one call settles both model discovery and credential validation.
 */
function fetchQoderModels(
  qoderSettings: QoderSettings,
  environment: NodeJS.ProcessEnv,
  catalog: QoderModelCatalog,
): Effect.Effect<QoderModelProbe, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const fallback = scopeQoderModelCatalog(catalog, qoderSettings.customModels);
    const modelsResult = yield* runQoderCliCommand(
      qoderSettings,
      ["--list-models"],
      environment,
    ).pipe(Effect.timeoutOption(MODELS_PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(modelsResult) || Option.isNone(modelsResult.success)) {
      yield* Effect.logWarning("Failed to fetch Qoder models from CLI, using built-in catalog.");
      return { models: fallback, patRejection: null };
    }

    const output = modelsResult.success.value;
    if (output.code !== 0) {
      yield* Effect.logWarning("Qoder --list-models exited with non-zero status.", {
        exitCode: output.code,
      });
      return {
        models: fallback,
        patRejection: qoderPatRejectionDetail(`${output.stdout}\n${output.stderr}`),
      };
    }

    const modelSlugs = parseQoderModelsOutput(output.stdout);
    if (modelSlugs.length === 0) {
      return { models: fallback, patRejection: null };
    }

    // Build models list from CLI output, matching against catalog for metadata.
    // The match is case-insensitive so a catalog slug keeps supplying pricing and
    // context window even if the CLI respells the model, while the slug pushed to
    // the UI stays the CLI's own spelling (which is what `qoder -m` requires).
    const models: ServerProviderModel[] = [];
    for (const slug of modelSlugs) {
      const catalogEntry = catalog.models.find(
        (m) => m.model.slug.toLowerCase() === slug.toLowerCase(),
      );
      if (catalogEntry) {
        models.push({ ...catalogEntry.model, slug });
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

    return {
      models: providerModelsFromSettings(models, qoderSettings.customModels, EMPTY_CAPABILITIES),
      patRejection: null,
    };
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

    // Nothing here can validate a credential without spawning the CLI, which
    // the initial snapshot deliberately avoids. A configured PAT is therefore
    // reported as unverified rather than authenticated: a rejected PAT overrides
    // a working browser login, so claiming "authenticated" from its mere presence
    // is what let a broken configuration look healthy until a turn failed.
    // checkQoderProviderStatus resolves it right after.
    const authStatus = resolveQoderPat(qoderSettings, environment)
      ? { status: "unknown" as const }
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
        status: authStatus.status === "unauthenticated" ? "error" : "ready",
        auth: authStatus,
        message:
          authStatus.status === "authenticated"
            ? "Qoder is ready."
            : authStatus.status === "unknown"
              ? "Qoder credentials are being verified."
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
    // Probes must run with the same credential the turns use, otherwise the
    // health check validates one identity while `sendTurn` runs with another.
    const env = mergeQoderEnv(environment, qoderSettings);
    const spawnCommand = yield* resolveSpawnCommand(command, args, {
      env,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
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

  const configuredPat = resolveQoderPat(qoderSettings, environment);

  // A configured PAT has to be validated, not merely noticed. `qoder --version`
  // succeeds whatever the token says, and a rejected PAT *overrides* a working
  // browser login, so the old presence check reported "Qoder PAT" and "ready"
  // for a configuration that failed every turn with QoderAuthError.
  // `--list-models` is the cheapest command that authenticates, and its models
  // are needed anyway, so one call settles both.
  const patProbe = configuredPat
    ? yield* fetchQoderModels(qoderSettings, environment, BUNDLED_QODER_MODEL_CATALOG)
    : null;
  const patRejection = patProbe?.patRejection ?? null;

  const auth: ServerProviderAuth = patRejection
    ? { status: "unauthenticated" }
    : configuredPat
      ? {
          status: "authenticated",
          type: "api_key",
          label: environment[QODER_PAT_ENV]?.trim() ? "Qoder PAT (env)" : "Qoder PAT",
        }
      : hasCliAuth
        ? {
            status: "authenticated",
            type: "cached_token",
            label: "Qoder account",
          }
        : { status: "unauthenticated" };

  if (auth.status !== "authenticated") {
    const models =
      patProbe?.models ??
      scopeQoderModelCatalog(BUNDLED_QODER_MODEL_CATALOG, qoderSettings.customModels);
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
        // The CLI's own wording already says how to recover, so do not paraphrase
        // it into something longer and less precise.
        message: patRejection
          ? `Qoder refused the configured personal access token, so every turn would fail: ${patRejection}`
          : "Qoder CLI is installed but not authenticated. Run `qoder login` in a terminal, or set personalAccessToken in settings.",
      },
    });
  }

  // Authenticated. Models were already fetched when a PAT needed validating;
  // only the browser-login path has to ask the CLI now.
  const models =
    patProbe?.models ??
    (yield* fetchQoderModels(qoderSettings, environment, BUNDLED_QODER_MODEL_CATALOG)).models;

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
