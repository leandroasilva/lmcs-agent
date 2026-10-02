/**
 * CommandCodeDriver — `ProviderDriver` for the Command Code runtime.
 *
 * Mirrors the Qoder driver pattern: a plain value whose `create()` bundles
 * `snapshot` / `adapter` / `textGeneration` closures over the per-instance
 * `CommandCodeSettings`.
 *
 * @module provider/Drivers/CommandCodeDriver
 */
import { CommandCodeSettings, ProviderDriverKind, TextGenerationError } from "@lmcstools/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCommandCodeAdapter } from "../Layers/CommandCodeAdapter.ts";
import {
  buildInitialCommandCodeProviderSnapshot,
  checkCommandCodeProviderStatus,
  enrichCommandCodeSnapshot,
} from "../Layers/CommandCodeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeCommandCodeSettings = Schema.decodeSync(CommandCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("commandcode");

export type CommandCodeDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const CommandCodeDriver: ProviderDriver<CommandCodeSettings, CommandCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Command Code",
    supportsMultipleInstances: true,
  },
  configSchema: CommandCodeSettings,
  defaultConfig: (): CommandCodeSettings => decodeCommandCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const { cwd } = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies CommandCodeSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: "command-code",
          }),
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const adapter = yield* makeCommandCodeAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });

      const textGeneration: TextGeneration.TextGeneration["Service"] = {
        generateThreadTitle: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "Command Code text generation is not yet implemented.",
            }),
          ),
        generateCommitMessage: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateCommitMessage",
              detail: "Command Code text generation is not yet implemented.",
            }),
          ),
        generateBranchName: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateBranchName",
              detail: "Command Code text generation is not yet implemented.",
            }),
          ),
        generatePrContent: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generatePrContent",
              detail: "Command Code text generation is not yet implemented.",
            }),
          ),
      };

      const checkProvider = checkCommandCodeProviderStatus(effectiveConfig, processEnv, cwd).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<CommandCodeSettings>
      >({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialCommandCodeProviderSnapshot(settings.provider, processEnv).pipe(
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichCommandCodeSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot,
              }),
            ),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Command Code snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
