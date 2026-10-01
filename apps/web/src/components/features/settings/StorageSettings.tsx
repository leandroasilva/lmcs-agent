import type { StorageCleanupSettings, WorktreeCleanupRules } from "@lmcstools/core";
import { resolveWorktreeCleanup } from "@lmcstools/core/projectSettings";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../../ui/number-field";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import type { ScopedSettingsTarget } from "./scopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useClearScopedSettings,
  useScopedSettings,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function RetentionControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
  }

  return (
    <div className="flex items-center gap-3">
      {value !== null ? (
        <NumberField
          value={draft}
          min={1}
          max={3650}
          step={1}
          size="sm"
          className="w-auto"
          onValueChange={setDraft}
          onValueCommitted={(next) => {
            if (next === null) setDraft(value);
            else {
              const days = Math.min(3650, Math.max(1, Math.round(next)));
              setDraft(days);
              onChange(days);
            }
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement
              aria-label={t("settings.storage.retention.decreaseAria", {
                label,
              })}
            />
            <NumberFieldInput
              aria-label={t("settings.storage.retention.inputAria", { label })}
              size={new Intl.NumberFormat().format(draft ?? value).length}
              className="field-sizing-content w-auto min-w-[1ch] grow-0 text-right"
            />
            <span aria-hidden="true" className="self-center pr-2 text-xs">
              {t("settings.storage.retention.days")}
            </span>
            <NumberFieldIncrement
              aria-label={t("settings.storage.retention.increaseAria", {
                label,
              })}
            />
          </NumberFieldGroup>
        </NumberField>
      ) : (
        <span className="text-xs text-muted-foreground">{t("settings.storage.retention.off")}</span>
      )}
      <Switch
        aria-label={label}
        checked={value !== null}
        onCheckedChange={(enabled) => onChange(enabled ? 8 : null)}
      />
    </div>
  );
}

export function StorageSettingsPanel() {
  const { t } = useTranslation();
  const { scope, connectedEnvironments, targets, target } = useSettingsScope();
  const scopedSettings = useScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const settings = {
    ...scopedSettings.storageCleanup,
    ...resolveWorktreeCleanup(scopedSettings, null),
  };
  const projectMode = (entry: ScopedSettingsTarget | null) =>
    entry?.sources.worktreeCleanup === "project"
      ? (entry.settings.worktreeCleanup?.mode ?? "inherit")
      : "inherit";
  const mode = projectMode(target);
  const mixedModes = targets.some((entry) => projectMode(entry) !== mode);
  const updateSettings = useUpdateScopedSettings();
  const clearSettings = useClearScopedSettings();
  const ruleStatus = (key: keyof StorageCleanupSettings) =>
    targets.some(
      (target) =>
        ({
          ...target.settings.storageCleanup,
          ...resolveWorktreeCleanup(target.settings, null),
        })[key] !== settings[key],
    )
      ? t("settings.storage.mixedAcross")
      : undefined;
  const update = (patch: Partial<StorageCleanupSettings>) =>
    updateSettings({ storageCleanup: patch });
  const updateWorktree = (patch: Partial<WorktreeCleanupRules>) =>
    isProjectScope
      ? updateSettings({ worktreeCleanup: { mode: "custom", rules: patch } })
      : update(patch);

  if (
    isProjectScope &&
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.projectWorktreeCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice target="all">
        {t("settings.storage.updateMachinesNotice")}
      </SettingsScopeNotice>
    );
  }

  if (
    connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.storageCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        eligibleEnvironmentIds={connectedEnvironments
          .filter(
            (environment) =>
              environment.serverConfig?.environment.capabilities.storageCleanup === true,
          )
          .map((environment) => environment.environmentId)}
      >
        {t("settings.storage.updateEnvironmentsNotice")}
      </SettingsScopeNotice>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection id="storage-worktrees" title={t("settings.storage.sections.worktrees")}>
        {isProjectScope && (
          <SettingsRow
            title={t("settings.storage.worktreeCleanup.title")}
            description={
              mode === "off"
                ? t("settings.storage.worktreeCleanup.descriptionOff")
                : mode === "custom"
                  ? t("settings.storage.worktreeCleanup.descriptionCustom")
                  : t("settings.storage.worktreeCleanup.descriptionInherit")
            }
            serverScoped
            settingKeys={["worktreeCleanup"]}
            mixed={mixedModes}
            control={
              <Select
                value={mixedModes ? null : mode}
                onValueChange={(next) => {
                  if (next === "inherit") clearSettings(["worktreeCleanup"]);
                  else if (next === "off") updateSettings({ worktreeCleanup: { mode: "off" } });
                  else if (next === "custom")
                    updateSettings({
                      worktreeCleanup: { mode: "custom", rules: {} },
                    });
                }}
              >
                <SelectTrigger size="sm" aria-label={t("settings.storage.worktreeCleanup.aria")}>
                  <SelectValue>
                    {mixedModes
                      ? t("common.mixed")
                      : t(`settings.storage.worktreeCleanup.modes.${mode}`)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="inherit">
                    {t("settings.storage.worktreeCleanup.modes.inherit")}
                  </SelectItem>
                  <SelectItem value="off">
                    {t("settings.storage.worktreeCleanup.modes.off")}
                  </SelectItem>
                  <SelectItem value="custom">
                    {t("settings.storage.worktreeCleanup.modes.custom")}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        )}
        {(!isProjectScope || (!mixedModes && mode === "custom")) && (
          <>
            <SettingsRow
              title={t("settings.storage.worktreeOnDelete.title")}
              status={ruleStatus("worktreeOnDelete")}
              description={t("settings.storage.worktreeOnDelete.description")}
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={t("settings.storage.worktreeOnDelete.aria")}
                  checked={settings.worktreeOnDelete}
                  onCheckedChange={(worktreeOnDelete) => updateWorktree({ worktreeOnDelete })}
                />
              }
            />
            <SettingsRow
              title={t("settings.storage.worktreeAfterDays.title")}
              status={ruleStatus("worktreeAfterDays")}
              description={t("settings.storage.worktreeAfterDays.description")}
              serverScoped={!isProjectScope}
              control={
                <RetentionControl
                  label={t("settings.storage.worktreeAfterDays.label")}
                  value={settings.worktreeAfterDays}
                  onChange={(worktreeAfterDays) => updateWorktree({ worktreeAfterDays })}
                />
              }
            />
            <SettingsRow
              title={t("settings.storage.worktreeOnMerge.title")}
              status={ruleStatus("worktreeOnMerge")}
              description={t("settings.storage.worktreeOnMerge.description")}
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={t("settings.storage.worktreeOnMerge.aria")}
                  checked={settings.worktreeOnMerge}
                  onCheckedChange={(worktreeOnMerge) => updateWorktree({ worktreeOnMerge })}
                />
              }
            />
            <SettingsRow
              title={t("settings.storage.worktreeUnchanged.title")}
              status={ruleStatus("worktreeUnchanged")}
              description={t("settings.storage.worktreeUnchanged.description")}
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={t("settings.storage.worktreeUnchanged.aria")}
                  checked={settings.worktreeUnchanged}
                  onCheckedChange={(worktreeUnchanged) => updateWorktree({ worktreeUnchanged })}
                />
              }
            />
          </>
        )}
      </SettingsSection>

      {!isProjectScope && (
        <SettingsSection id="storage-artifacts" title={t("settings.storage.sections.artifacts")}>
          <SettingsRow
            title={t("settings.storage.browserArtifacts.title")}
            status={ruleStatus("browserArtifactsAfterDays")}
            description={t("settings.storage.browserArtifacts.description")}
            serverScoped
            control={
              <RetentionControl
                label={t("settings.storage.browserArtifacts.label")}
                value={settings.browserArtifactsAfterDays}
                onChange={(browserArtifactsAfterDays) => update({ browserArtifactsAfterDays })}
              />
            }
          />
          <SettingsRow
            title={t("settings.storage.rotatedLogs.title")}
            status={ruleStatus("logsAfterDays")}
            description={t("settings.storage.rotatedLogs.description")}
            serverScoped
            control={
              <RetentionControl
                label={t("settings.storage.rotatedLogs.label")}
                value={settings.logsAfterDays}
                onChange={(logsAfterDays) => update({ logsAfterDays })}
              />
            }
          />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
