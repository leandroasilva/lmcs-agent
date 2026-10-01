import {
  DEFAULT_SERVER_SETTINGS,
  PROJECT_FILE_BACKED_SETTINGS,
  type ProjectFileBackedSettingKey,
  resolveEnvironmentMachineKind,
  type ServerSettings,
  type WorktreeSubmodules,
} from "@lmcstools/core";
import { CheckIcon, LayersIcon } from "lucide-react";
import * as Equal from "effect/Equal";
import { useTranslation } from "react-i18next";

import { translateDynamic } from "../../../i18n";
import { cn } from "../../../lib/utils";
import type { EnvironmentPresentation } from "../../../state/environments";
import { EnvironmentMachineIcon } from "../../shared/EnvironmentMachineIcon";
import { resolveEnvModeLabel, WORKTREE_SUBMODULES_LABELS } from "../../layout/BranchToolbar.logic";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "../pullRequest/pullRequestDetail.logic";
import { Button, InlineButton } from "../../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import type { ProjectOverrideEntry, ScopedSettingsTarget } from "./scopedSettings";
import { isProjectScopedSettingKey } from "./scopedSettings";

interface InheritanceLayer {
  readonly key: "project" | "environment" | "lmcs.json" | "built-in";
  readonly label: string;
  readonly value: string;
  readonly effective: boolean;
  readonly set: boolean;
}

const WRITING_STYLE_LABEL_KEYS: Record<string, string> = {
  repo_conventions: "repoConventions",
  conventional_commits: "conventionalCommits",
  custom: "custom",
};

function writingStyleLabel(mode: string): string {
  const key = WRITING_STYLE_LABEL_KEYS[mode];
  return key
    ? translateDynamic(`settings.inheritance.writingStyle.${key}`, WRITING_STYLE_FALLBACKS[key]!)
    : mode;
}

const WRITING_STYLE_FALLBACKS: Record<string, string> = {
  repoConventions: "Repository conventions",
  conventionalCommits: "Conventional Commits",
  custom: "Custom instructions",
};

/** Human labels for the values the chain can show; falls back to a type summary. */
function formatValue(key: keyof ServerSettings, value: unknown): string {
  if (value === null || value === undefined) {
    return key === "pullRequestMergeMethod"
      ? translateDynamic("settings.inheritance.value.lastSelected", "Last selected")
      : key === "sidebarAutoSettleAfterDays"
        ? translateDynamic("settings.inheritance.value.never", "Never")
        : key === "defaultModelSelection"
          ? translateDynamic("settings.inheritance.value.automatic", "Automatic")
          : key === "sourceControlWriterModelSelection"
            ? translateDynamic(
                "settings.inheritance.value.textGenerationModel",
                "Text generation model",
              )
            : key === "defaultThreadEnvMode" || key === "worktreeSubmodules"
              ? translateDynamic("settings.inheritance.value.inherit", "Inherit")
              : translateDynamic("settings.inheritance.value.notSet", "Not set");
  }
  if (typeof value === "boolean")
    return value
      ? translateDynamic("settings.inheritance.value.on", "On")
      : translateDynamic("settings.inheritance.value.off", "Off");
  if (typeof value === "number") {
    return key === "sidebarAutoSettleAfterDays"
      ? translateDynamic(
          "settings.inheritance.value.dayCount",
          `${value} ${value === 1 ? "day" : "days"}`,
          { count: value },
        )
      : String(value);
  }
  if (typeof value === "string") {
    if (key === "defaultThreadEnvMode" && (value === "local" || value === "worktree")) {
      return resolveEnvModeLabel(value);
    }
    if (key === "worktreeSubmodules" && value in WORKTREE_SUBMODULES_LABELS) {
      return WORKTREE_SUBMODULES_LABELS[value as WorktreeSubmodules];
    }
    if (key === "pullRequestMergeMethod" && value in PULL_REQUEST_MERGE_METHOD_LABELS) {
      return PULL_REQUEST_MERGE_METHOD_LABELS[
        value as keyof typeof PULL_REQUEST_MERGE_METHOD_LABELS
      ];
    }
    return value === "" ? translateDynamic("settings.inheritance.value.empty", "Empty") : value;
  }
  if (Array.isArray(value))
    return translateDynamic(
      "settings.inheritance.value.itemCount",
      `${value.length} ${value.length === 1 ? "item" : "items"}`,
      { count: value.length },
    );
  if (typeof value === "object") {
    if ("model" in value && typeof value.model === "string") return value.model;
    if ("mode" in value && typeof value.mode === "string") {
      return writingStyleLabel(value.mode);
    }
  }
  return translateDynamic("settings.inheritance.value.custom", "Custom");
}

/**
 * The layers a setting resolves through for one target, top-down: the
 * project override when the target is a project, the environment's value,
 * the checkout's lmcs.json for file-backed keys, and the built-in default. The
 * first layer that is set wins. Same order as `resolveProjectSettings`.
 */
export function settingInheritanceLayers(
  target: ScopedSettingsTarget,
  environmentSettings: ServerSettings,
  key: keyof ServerSettings,
): readonly InheritanceLayer[] {
  const environmentValue = environmentSettings[key];
  const source = isProjectScopedSettingKey(key) ? target.sources[key] : "environment";
  const environmentSet = !Equal.equals(environmentValue, DEFAULT_SERVER_SETTINGS[key]);
  const fileBacked = isProjectFileBackedSettingKey(key);
  const layers: InheritanceLayer[] = [];
  const inheritsLabel = translateDynamic("settings.inheritance.inherits", "Inherits");
  if (target.projectId !== null && isProjectScopedSettingKey(key)) {
    layers.push({
      key: "project",
      label: translateDynamic("settings.inheritance.layer.project", "Project"),
      value: source === "project" ? formatValue(key, target.settings[key]) : inheritsLabel,
      effective: source === "project",
      set: source === "project",
    });
  }
  layers.push({
    key: "environment",
    label: target.label,
    value: environmentSet ? formatValue(key, environmentValue) : inheritsLabel,
    effective: source === "environment" && environmentSet,
    set: environmentSet,
  });
  if (fileBacked && target.projectId !== null) {
    layers.push({
      key: "lmcs.json",
      label: "lmcs.json",
      value: source === "lmcs.json" ? formatValue(key, target.settings[key]) : inheritsLabel,
      effective: source === "lmcs.json",
      set: source === "lmcs.json",
    });
  }
  // For a file-backed key the built-in is what the resolver produced with
  // nothing set, not the null the schema decodes to.
  const builtIn = fileBacked
    ? PROJECT_FILE_BACKED_SETTINGS[key].builtIn
    : DEFAULT_SERVER_SETTINGS[key];
  layers.push({
    key: "built-in",
    label: translateDynamic("settings.inheritance.layer.default", "Default"),
    value: formatValue(key, builtIn),
    effective: source === "environment" && !environmentSet,
    set: true,
  });
  return layers;
}

function isProjectFileBackedSettingKey(
  key: keyof ServerSettings,
): key is ProjectFileBackedSettingKey {
  return Object.hasOwn(PROJECT_FILE_BACKED_SETTINGS, key);
}

export type SettingInheritanceState =
  | "default"
  | "environment"
  | "inherited"
  | "overridden"
  | "mixed";

/**
 * A small indicator beside a row's title that opens a top-down view of where
 * the setting's value comes from on each selected target. It sits inline so
 * narrowing to a project does not add a caption line to every row.
 */
export interface SettingOverridingProject extends ProjectOverrideEntry {
  readonly label: string;
  /** Jumps the breadcrumb to this project so its override can be edited. */
  readonly open: () => void;
}

export function SettingInheritance({
  state,
  summary,
  targets,
  environments,
  keys,
  overridingProjects = [],
  onClearOverrides,
}: {
  state: SettingInheritanceState;
  summary: string;
  targets: readonly ScopedSettingsTarget[];
  environments: readonly Pick<EnvironmentPresentation, "environmentId" | "serverConfig">[];
  keys: readonly (keyof ServerSettings)[];
  /** At environment scope: projects whose own value hides the environment's. */
  overridingProjects?: readonly SettingOverridingProject[];
  onClearOverrides?: (entries: readonly ProjectOverrideEntry[]) => void;
}) {
  const { t } = useTranslation();
  const key = keys[0];
  if (!key || targets.length === 0) return null;
  const overrideSummary =
    overridingProjects.length > 0
      ? `${summary} · ${t("settings.inheritance.overrideCount", { count: overridingProjects.length })}`
      : summary;
  const chains = targets.flatMap((target) => {
    const environment = environments.find(
      (candidate) => candidate.environmentId === target.environmentId,
    );
    if (!environment?.serverConfig) return [];
    return [
      {
        target,
        environment: { ...environment, serverConfig: environment.serverConfig },
        machine: resolveEnvironmentMachineKind(environment.serverConfig),
        layers: settingInheritanceLayers(target, environment.serverConfig.settings, key),
      },
    ];
  });
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label={t("settings.inheritance.showSourceAria", {
                    summary: overrideSummary,
                  })}
                />
              }
            />
          }
        >
          <LayersIcon
            className={cn(
              "size-3",
              state === "overridden" && "text-primary",
              state === "mixed" && "text-warning",
            )}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{overrideSummary}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" width="md" padding="none">
        <div className="divide-y divide-border/60">
          {chains.map(({ target, environment, machine, layers }) => (
            <section
              key={`${target.environmentId}:${target.projectId ?? ""}`}
              className="px-3 py-2.5"
            >
              <h4 className="flex items-center gap-1.5 pb-1.5 text-xs font-medium text-muted-foreground">
                <EnvironmentMachineIcon aria-hidden kind={machine} className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{target.label}</span>
              </h4>
              <ol role="list" className="text-sm">
                {layers.map((layer) => (
                  <li
                    key={layer.key}
                    className={cn(
                      "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1",
                      layer.effective && "bg-foreground/[0.06]",
                    )}
                  >
                    <span
                      className={cn(
                        "min-w-0 truncate",
                        layer.effective ? "font-medium text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {layer.key === "environment"
                        ? t("settings.inheritance.layer.environment")
                        : layer.label}
                    </span>
                    <span
                      className={cn(
                        "flex items-center gap-1.5 tabular-nums",
                        layer.effective
                          ? "text-foreground"
                          : layer.set
                            ? "text-muted-foreground"
                            : "text-muted-foreground/60",
                      )}
                    >
                      <span className="max-w-32 truncate">{layer.value}</span>
                      {layer.effective ? (
                        <CheckIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
                      ) : (
                        <span aria-hidden className="size-3.5 shrink-0" />
                      )}
                    </span>
                  </li>
                ))}
              </ol>
              {(() => {
                const overriding = overridingProjects.filter(
                  (project) => project.environmentId === target.environmentId,
                );
                if (overriding.length === 0) return null;
                const overrides = environment.serverConfig.settings.projectSettingsOverrides;
                return (
                  <div className="mt-2 border-t border-border/60 pt-2">
                    <div className="flex items-center justify-between gap-3 px-2 text-xs text-muted-foreground">
                      <span>{t("settings.inheritance.overriddenBy")}</span>
                      {onClearOverrides ? (
                        <InlineButton onClick={() => onClearOverrides(overriding)}>
                          {overriding.length === 1
                            ? t("settings.inheritance.resetIt")
                            : t("settings.inheritance.resetAll")}
                        </InlineButton>
                      ) : null}
                    </div>
                    <ul role="list" className="mt-0.5 text-sm">
                      {overriding.map((project) => (
                        <li
                          key={project.projectId}
                          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-2 py-1"
                        >
                          <InlineButton className="min-w-0 justify-start" onClick={project.open}>
                            <span className="truncate">{project.label}</span>
                          </InlineButton>
                          <span className="max-w-32 truncate text-muted-foreground tabular-nums">
                            {isProjectScopedSettingKey(key)
                              ? formatValue(key, overrides[project.projectId]?.[key])
                              : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })()}
            </section>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
