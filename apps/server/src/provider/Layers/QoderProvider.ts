import {
  type CustomModelSetting,
  type ModelCapabilities,
  type QoderSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@lmcstools/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { createModelCapabilities } from "@lmcstools/core/model";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

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
): Effect.Effect<ServerProviderDraft> {
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

    return buildServerProvider({
      presentation: QODER_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "ready",
        auth: qoderSettings.personalAccessToken
          ? { status: "authenticated" }
          : { status: "unauthenticated" },
        message: qoderSettings.personalAccessToken
          ? "Qoder is ready."
          : "Qoder PAT not configured. Set personalAccessToken in settings.",
      },
    });
  });
}

export function checkQoderProviderStatus(
  qoderSettings: QoderSettings,
  _env: NodeJS.ProcessEnv | undefined,
  _cwd: string,
): Effect.Effect<ServerProviderDraft> {
  return buildInitialQoderProviderSnapshot(qoderSettings);
}

export function enrichQoderSnapshot(input: {
  snapshot: ServerProvider;
  maintenanceCapabilities: unknown;
  enableProviderUpdateChecks: boolean;
  publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<ServerProvider> {
  return Effect.succeed(input.snapshot);
}
