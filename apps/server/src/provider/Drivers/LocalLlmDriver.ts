import {
  type CustomModelSetting,
  LocalLlmSettings,
  ProviderDriverKind,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderState,
} from "@lmcstools/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProviderDriverError } from "../Errors.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  buildServerProvider,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeLocalLlmTextGeneration } from "./textGeneration.ts";
import { fetchModels, type LocalLlmClientConfig } from "./httpClient.ts";

const decodeLocalLlmSettings = Schema.decodeSync(LocalLlmSettings);

const DRIVER_KIND = ProviderDriverKind.make("localLlm");

export type LocalLlmDriverEnv = ServerSettingsService;

const LOCAL_LLM_PRESENTATION = {
  displayName: "Local LLM",
  supportsConversationRollback: false,
  reportsContextWindow: false,
} as const;

const EMPTY_CAPABILITIES = {
  toolCall: false,
  imageInput: false,
  reasoning: false,
  streaming: true,
} as const;

function localLlmModelsFromConfig(
  config: LocalLlmClientConfig,
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  discoveredModels: ReadonlyArray<{ id: string }> = [],
): ReadonlyArray<ServerProviderModel> {
  const models: ServerProviderModel[] = [];

  if (config.model.length > 0) {
    models.push({
      slug: config.model,
      name: config.model,
      capabilities: EMPTY_CAPABILITIES,
    });
  }

  for (const m of discoveredModels) {
    if (m.id !== config.model && !models.some((existing) => existing.slug === m.id)) {
      models.push({
        slug: m.id,
        name: m.id,
        capabilities: EMPTY_CAPABILITIES,
      });
    }
  }

  if (customModels) {
    for (const custom of customModels) {
      if (!models.some((existing) => existing.slug === custom.slug)) {
        models.push({
          slug: custom.slug,
          name: custom.name || custom.slug,
          isCustom: true,
          capabilities: custom.capabilities ?? EMPTY_CAPABILITIES,
        });
      }
    }
  }

  return models;
}

function buildInitialLocalLlmSnapshot(
  settings: LocalLlmSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const config: LocalLlmClientConfig = {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      apiFormat: settings.apiFormat,
    };
    const models = localLlmModelsFromConfig(config, settings.customModels);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: LOCAL_LLM_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Local LLM is disabled in LMCS Code settings.",
        },
      });
    }

    if (!settings.baseUrl) {
      return buildServerProvider({
        presentation: LOCAL_LLM_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Base URL is not configured.",
        },
      });
    }

    return buildServerProvider({
      presentation: LOCAL_LLM_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking local LLM server...",
      },
    });
  });
}

function checkLocalLlmStatus(
  config: LocalLlmClientConfig,
  settings: LocalLlmSettings,
): Effect.Effect<ServerProviderDraft, never, typeof DateTime.currentTimeMillis> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: LOCAL_LLM_PRESENTATION,
        enabled: false,
        checkedAt,
        models: localLlmModelsFromConfig(config, settings.customModels),
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Local LLM is disabled.",
        },
      });
    }

    const probeResult = yield* fetchModels(config).pipe(
      Effect.map((models): ProviderProbeResult => {
        const allModels = localLlmModelsFromConfig(config, settings.customModels, models);
        return {
          installed: true,
          version: null,
          status: "ready" as ServerProviderState,
          auth: { status: "authenticated" as const } as ServerProviderAuth,
          message: undefined,
        };
      }),
      Effect.mapBoth({
        onSuccess: (result) => result,
        onFailure: (error): ProviderProbeResult => ({
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: error instanceof Error ? error.message : "Connection failed",
        }),
      }),
    );

    return buildServerProvider({
      presentation: LOCAL_LLM_PRESENTATION,
      enabled: true,
      checkedAt,
      models: localLlmModelsFromConfig(config, settings.customModels),
      probe: probeResult,
    });
  });
}

export const LocalLlmDriver: ProviderDriver<LocalLlmSettings, LocalLlmDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Local LLM",
    supportsMultipleInstances: true,
  },
  configSchema: LocalLlmSettings,
  defaultConfig: (): LocalLlmSettings => decodeLocalLlmSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });

      const effectiveConfig = {
        ...config,
        enabled,
      } satisfies LocalLlmSettings;

      const clientConfig: LocalLlmClientConfig = {
        baseUrl: effectiveConfig.baseUrl,
        apiKey: effectiveConfig.apiKey,
        model: effectiveConfig.model,
        apiFormat: effectiveConfig.apiFormat,
      };

      const textGeneration = makeLocalLlmTextGeneration(effectiveConfig);

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);

      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<LocalLlmSettings>>(
        {
          resolveMaintenance: Effect.succeed({
            provider: DRIVER_KIND,
            canCheck: false,
            canUpdate: false,
            canInstall: false,
            updateSource: null,
            installedVersion: null,
            latestVersion: null,
            installerKind: null,
          }),
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: () => buildInitialLocalLlmSnapshot(effectiveConfig),
          checkProvider: checkLocalLlmStatus(clientConfig, effectiveConfig),
          enrichSnapshot: ({ snapshot: current, publishSnapshot }) =>
            Effect.succeed(publishSnapshot(current)),
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Local LLM snapshot: ${cause.message ?? String(cause)}`,
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
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
