import { useAtomValue } from "@effect/atom-react";
import { resolveEnvironmentMachineKind } from "@lmcstools/core";
import {
  gitHubRoutingConnectionKey,
  gitHubRoutingPermissionFor,
  type GitHubRoutingPermission,
} from "@lmcstools/client/connection";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { translateDynamic } from "../../../i18n";
import { environmentCatalog } from "~/connection/catalog";
import type { EnvironmentPresentation } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { toastManager } from "../../ui/toast";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { searchableSetting } from "./settingsSearch";

const options = [
  { value: "off", key: "off", fallback: "Off" },
  { value: "read", key: "read", fallback: "Read PRs" },
  { value: "read-write", key: "readWrite", fallback: "Read and act" },
] as const satisfies ReadonlyArray<{
  value: GitHubRoutingPermission;
  key: string;
  fallback: string;
}>;

function optionLabel(option: (typeof options)[number]): string {
  return translateDynamic(`settings.githubRouting.option.${option.key}`, option.fallback);
}

const summaryLabels = {
  "read-write": { key: "readWrite", fallback: "read and act" },
  read: { key: "read", fallback: "read PRs" },
} as const;

function summaryLabel(permission: keyof typeof summaryLabels): string {
  const entry = summaryLabels[permission];
  return translateDynamic(`settings.githubRouting.summary.${entry.key}`, entry.fallback);
}

/**
 * Closed-header summary: the machines that share, grouped by permission.
 * Null when nothing is shared.
 */
export function summarizeGitHubRouting(
  entries: ReadonlyArray<{
    readonly label: string;
    readonly permission: GitHubRoutingPermission;
  }>,
): string | null {
  const groups = (["read-write", "read"] as const).flatMap((permission) => {
    const labels = entries.filter((entry) => entry.permission === permission);
    return labels.length === 0
      ? []
      : [`${labels.map((entry) => entry.label).join(", ")} ${summaryLabel(permission)}`];
  });
  return groups.length === 0 ? null : groups.join(" · ");
}

/**
 * Folded section under the environments list. One row per switched-on machine
 * with how much of its GitHub access the other machines may use. The trust
 * warning is the first line of the body so it sits next to the control.
 * Rendered only when two or more machines are on.
 */
export function GitHubRoutingSettings({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const { t } = useTranslation();
  const permissions = useAtomValue(environmentCatalog.githubRoutingPermissionsValueAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const update = useAtomCommand(environmentCatalog.setGitHubRoutingPermission);
  const [saving, setSaving] = useState(false);

  if (environments.length < 2) return null;

  const { id, title } = searchableSetting("github-routing");
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={
        summarizeGitHubRouting(
          environments.map((environment) => ({
            label: environment.label,
            permission: gitHubRoutingPermissionFor(environment.entry, permissions),
          })),
        ) ?? t("settings.githubRouting.off")
      }
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        {t("settings.githubRouting.description")}
      </p>
      {environments.map((environment) => (
        <EnvironmentRow
          key={environment.environmentId}
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          label={environment.label}
          subtitle={environmentTransportLabel(environment)}
        >
          <Select
            value={gitHubRoutingPermissionFor(environment.entry, permissions)}
            disabled={
              !catalog.isReady || saving || gitHubRoutingConnectionKey(environment.entry) === null
            }
            onValueChange={(permission) => {
              if (permission === null) return;
              setSaving(true);
              void update({
                environmentId: environment.environmentId,
                permission,
              }).then((result) => {
                setSaving(false);
                if (result._tag === "Failure")
                  toastManager.add({
                    type: "error",
                    title: "Could not save GitHub routing permission",
                  });
              });
            }}
          >
            <SelectTrigger
              size="xs"
              className="w-32"
              aria-label={t("settings.githubRouting.routingAria", {
                label: environment.label,
              })}
            >
              <SelectValue>
                {optionLabel(
                  options.find(
                    (option) =>
                      option.value === gitHubRoutingPermissionFor(environment.entry, permissions),
                  ) ?? options[0],
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {optionLabel(option)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </EnvironmentRow>
      ))}
    </FoldedSettingsSection>
  );
}
