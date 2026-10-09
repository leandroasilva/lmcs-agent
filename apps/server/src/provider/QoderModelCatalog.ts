import {
  type CustomModelSetting,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@lmcstools/core";
import { createModelCapabilities } from "@lmcstools/core/model";

import { providerModelsFromSettings } from "./providerSnapshot.ts";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/**
 * Built-in Qoder models with metadata.
 * Pricing is per 1M tokens (USD) - approximate values based on public pricing.
 */
export interface QoderCatalogModel {
  readonly model: ServerProviderModel;
  readonly contextWindow: number;
  readonly inputPricePerMTokens: number;
  readonly outputPricePerMTokens: number;
}

const QODER_BUILT_IN_MODELS: ReadonlyArray<QoderCatalogModel> = [
  {
    model: {
      slug: "Auto",
      name: "Auto",
      isCustom: false,
      isDefault: true,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 200_000,
    inputPricePerMTokens: 0,
    outputPricePerMTokens: 0,
  },
  {
    model: {
      slug: "Ultimate",
      name: "Ultimate",
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 200_000,
    inputPricePerMTokens: 15,
    outputPricePerMTokens: 75,
  },
  {
    model: {
      slug: "Performance",
      name: "Performance",
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 200_000,
    inputPricePerMTokens: 10,
    outputPricePerMTokens: 50,
  },
  {
    model: {
      slug: "Efficient",
      name: "Efficient",
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 200_000,
    inputPricePerMTokens: 5,
    outputPricePerMTokens: 25,
  },
  {
    model: {
      slug: "Sonus",
      name: "Sonus",
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 200_000,
    inputPricePerMTokens: 8,
    outputPricePerMTokens: 40,
  },
  {
    model: {
      slug: "Cantus",
      name: "Cantus",
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 200_000,
    inputPricePerMTokens: 6,
    outputPricePerMTokens: 30,
  },
  {
    model: {
      slug: "Qwen3.8-Max",
      name: "Qwen 3.8 Max",
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 131_072,
    inputPricePerMTokens: 4,
    outputPricePerMTokens: 20,
  },
  {
    model: {
      slug: "Qwen3.8-Flash",
      name: "Qwen 3.8 Flash",
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 131_072,
    inputPricePerMTokens: 2,
    outputPricePerMTokens: 10,
  },
  {
    model: {
      slug: "Qwen3.7-Max",
      name: "Qwen 3.7 Max",
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 131_072,
    inputPricePerMTokens: 4,
    outputPricePerMTokens: 20,
  },
  {
    model: {
      slug: "Qwen3.7-Plus",
      name: "Qwen 3.7 Plus",
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 131_072,
    inputPricePerMTokens: 3,
    outputPricePerMTokens: 15,
  },
  {
    model: {
      slug: "Kimi-K3",
      name: "Kimi K3",
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 131_072,
    inputPricePerMTokens: 3,
    outputPricePerMTokens: 15,
  },
  {
    model: {
      slug: "Kimi-K2.8-Preview",
      name: "Kimi K2.8 Preview",
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 131_072,
    inputPricePerMTokens: 2,
    outputPricePerMTokens: 10,
  },
  {
    model: {
      slug: "GLM-5.3",
      name: "GLM 5.3",
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 131_072,
    inputPricePerMTokens: 3,
    outputPricePerMTokens: 15,
  },
  {
    model: {
      slug: "GLM-5.3-Flash",
      name: "GLM 5.3 Flash",
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 131_072,
    inputPricePerMTokens: 1.5,
    outputPricePerMTokens: 7.5,
  },
  {
    model: {
      slug: "DeepSeek-V4-Pro",
      name: "DeepSeek V4 Pro",
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 131_072,
    inputPricePerMTokens: 2,
    outputPricePerMTokens: 10,
  },
  {
    model: {
      slug: "DeepSeek-Flash",
      name: "DeepSeek Flash",
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 131_072,
    inputPricePerMTokens: 1,
    outputPricePerMTokens: 5,
  },
  {
    model: {
      slug: "MiniMax-M3",
      name: "MiniMax M3",
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    },
    contextWindow: 131_072,
    inputPricePerMTokens: 1.5,
    outputPricePerMTokens: 7.5,
  },
];

export interface QoderModelCatalog {
  readonly models: ReadonlyArray<QoderCatalogModel>;
}

export const BUNDLED_QODER_MODEL_CATALOG: QoderModelCatalog = {
  models: QODER_BUILT_IN_MODELS,
};

/**
 * Parse model names from `qoder --list-models` output.
 * Output format is one model name per line, prefixed with "MODEL" header.
 *
 * The CLI spelling is preserved verbatim: `qoder -m` is case-sensitive and
 * silently falls back to Auto for a name it does not recognise, so lowercasing
 * here would make every selected model unusable.
 */
export function parseQoderModelsOutput(output: string): ReadonlyArray<string> {
  const models: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toUpperCase() === "MODEL") continue;
    models.push(trimmed);
  }
  return models;
}

/**
 * Map a stored model slug back to the spelling `qoder -m` accepts.
 *
 * Slugs persisted before the catalog carried canonical casing (and any custom
 * model the user typed) may not match what the CLI expects, so look the slug up
 * case-insensitively and return the catalog spelling. Unknown slugs are passed
 * through untouched: the CLI knows models this bundled catalog does not.
 */
export function resolveQoderCliModelName(catalog: QoderModelCatalog, slug: string): string {
  const trimmed = slug.trim();
  if (trimmed.length === 0) {
    return slug;
  }
  const match = catalog.models.find((m) => m.model.slug.toLowerCase() === trimmed.toLowerCase());
  return match ? match.model.slug : trimmed;
}

/**
 * Scope the catalog to one instance's settings: custom model slugs shadow
 * built-ins with the same alias, and custom entries are appended.
 */
export function scopeQoderModelCatalog(
  catalog: QoderModelCatalog,
  customModels: ReadonlyArray<CustomModelSetting>,
): ReadonlyArray<ServerProviderModel> {
  const builtInModels = catalog.models.map((entry) => entry.model);
  return providerModelsFromSettings(builtInModels, customModels, EMPTY_CAPABILITIES);
}

/**
 * Get pricing info for a model slug.
 */
export function getQoderModelPricing(
  catalog: QoderModelCatalog,
  slug: string,
): { inputPricePerMTokens: number; outputPricePerMTokens: number } | null {
  const entry = catalog.models.find((m) => m.model.slug.toLowerCase() === slug.toLowerCase());
  if (!entry) return null;
  return {
    inputPricePerMTokens: entry.inputPricePerMTokens,
    outputPricePerMTokens: entry.outputPricePerMTokens,
  };
}

/**
 * Calculate cost for a given token usage.
 */
export function calculateQoderCost(
  catalog: QoderModelCatalog,
  slug: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = getQoderModelPricing(catalog, slug);
  if (!pricing) return null;
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPricePerMTokens;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPricePerMTokens;
  return inputCost + outputCost;
}
