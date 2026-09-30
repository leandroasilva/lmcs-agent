/**
 * Qoder usage limits tracking.
 *
 * @module provider/Layers/qoderUsageLimits
 */
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@lmcstools/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

/**
 * Qoder usage response shape (from SDK or CLI).
 */
export interface QoderUsageResponse {
  readonly plan?: string;
  readonly quota?: {
    readonly total?: number;
    readonly used?: number;
    readonly remaining?: number;
  };
  readonly session?: {
    readonly tokens?: {
      readonly input?: number;
      readonly output?: number;
      readonly total?: number;
    };
    readonly duration?: number;
  };
}

/**
 * Convert Qoder usage response to ServerProviderUsageLimits.
 */
export function qoderUsageResponseToLimits(input: {
  readonly response: QoderUsageResponse | null;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const { response, checkedAt } = input;

  if (!response) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }

  const windows: ServerProviderUsageWindow[] = [];

  // Quota window (if available)
  if (response.quota) {
    const { total, used } = response.quota;
    if (total !== undefined && total > 0) {
      const usedAmount = used ?? 0;
      const usedPercent = clampPercent((usedAmount / total) * 100);

      windows.push({
        id: "quota",
        kind: "other",
        label: response.plan ? `${response.plan} Quota` : "Quota",
        usedPercent,
      });
    }
  }

  if (windows.length === 0) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }

  return makeUsageLimits({ checkedAt, windows });
}

/**
 * Record Qoder usage response and update the Ref.
 */
export function recordQoderUsageResponse(
  limitsRef: Ref.Ref<ServerProviderUsageLimits>,
): (input: {
  readonly response: QoderUsageResponse | null;
  readonly checkedAt: string;
}) => Effect.Effect<ServerProviderUsageLimits> {
  return (input) => {
    const limits = qoderUsageResponseToLimits(input);
    return Ref.set(limitsRef, limits).pipe(Effect.as(limits));
  };
}

/**
 * Create a Ref for tracking Qoder usage limits.
 */
export function makeQoderUsageLimitsRef(): Effect.Effect<
  Ref.Ref<ServerProviderUsageLimits>
> {
  return Effect.gen(function* () {
    const now = yield* DateTime.now;
    return yield* Ref.make(
      makeUnavailableUsageLimits({
        checkedAt: DateTime.formatIso(now),
        reason: "unsupported",
      }),
    );
  });
}

/**
 * Token usage snapshot for a turn.
 */
export interface QoderTurnTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly model?: string;
  readonly cost?: number;
}

/**
 * Calculate cost for token usage based on model pricing.
 */
export function calculateTurnCost(
  usage: QoderTurnTokenUsage,
  pricing: { inputPricePerMTokens: number; outputPricePerMTokens: number },
): number {
  const inputCost =
    (usage.inputTokens / 1_000_000) * pricing.inputPricePerMTokens;
  const outputCost =
    (usage.outputTokens / 1_000_000) * pricing.outputPricePerMTokens;
  return inputCost + outputCost;
}
