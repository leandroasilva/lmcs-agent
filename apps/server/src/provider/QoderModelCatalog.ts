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
      slug: "auto",
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
      slug: "ultimate",
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
      slug: "performance",
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
      slug: "efficient",
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
      slug: "sonus",
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
      slug: "cantus",
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
      slug: "qwen3.8-max",
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
      slug: "qwen3.8-flash",
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
      slug: "qwen3.7-max",
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
      slug: "qwen3.7-plus",
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
      slug: "kimi-k3",
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
      slug: "kimi-k2.8-preview",
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
      slug: "glm-5.3",
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
      slug: "glm-5.3-flash",
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
      slug: "deepseek-v4-pro",
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
      slug: "deepseek-flash",
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
      slug: "minimax-m3",
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
 */
export function parseQoderModelsOutput(output: string): ReadonlyArray<string> {
  const models: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toUpperCase() === "MODEL") continue;
    models.push(trimmed.toLowerCase());
  }
  return models;
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
  return providerModelsFromSettings(
    builtInModels,
    customModels,
    EMPTY_CAPABILITIES,
  );
}

/**
 * Get pricing info for a model slug.
 */
export function getQoderModelPricing(
  catalog: QoderModelCatalog,
  slug: string,
): { inputPricePerMTokens: number; outputPricePerMTokens: number } | null {
  const entry = catalog.models.find((m) => m.model.slug === slug.toLowerCase());
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
