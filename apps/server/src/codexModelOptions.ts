import type { ModelSelection } from "@lmcstools/core";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@lmcstools/core/model";

export function getCodexServiceTierOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  return (
    getModelSelectionStringOptionValue(modelSelection, "serviceTier") ??
    (getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true ? "fast" : undefined)
  );
}
