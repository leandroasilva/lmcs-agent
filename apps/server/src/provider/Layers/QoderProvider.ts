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
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createModelCapabilities } from "@lmcstools/core/model";
import { resolveSpawnCommand } from "@lmcstools/core/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const QODER_PAT_ENV = "QODER_PERSONAL_ACCESS_TOKEN";
const QODER_AUTH_FILE = ".qoder/.auth/user";

const QODER_PRESENTATION = {
  displayName: "Qoder",
  supportsConversationRollback: false,
  badgeLabel: "SDK",
  showInteractionModeToggle: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const QODER_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "qoder-default",
    name: "Qoder Agent",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function qoderModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting>,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(QODER_BUILT_IN_MODELS, customModels, EMPTY_CAPABILITIES);
}

export function buildInitialQoderProviderSnapshot(
  qoderSettings: QoderSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ServerProviderDraft, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = qoderModelsFromSettings(qoderSettings.customModels);

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
    const homeDir = environment.HOME ?? NodeOS.homedir();
    const authFilePath = NodePath.join(homeDir, QODER_AUTH_FILE);
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
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = qoderModelsFromSettings(qoderSettings.customModels);

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

  const versionResult = yield* runQoderCliCommand(qoderSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Qoder CLI health check failed.", {
      errorTag: error._tag,
    });
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
  const homeDir = environment.HOME ?? NodeOS.homedir();
  const authFilePath = NodePath.join(homeDir, QODER_AUTH_FILE);
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
