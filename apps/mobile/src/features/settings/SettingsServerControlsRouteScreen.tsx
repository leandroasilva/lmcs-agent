import { useNavigation } from "@react-navigation/native";
import { SettingsRow } from "./components/SettingsRow";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import {
  type ResponseStreamingMode,
  type ServerSettings,
  type ServerSettingsPatch,
  type ThreadEnvMode,
  type WorktreeSubmodules,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectScopedServerSettingKey,
} from "@lmcstools/core";
import { useRef, useState, type ComponentProps } from "react";
import { Alert, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";

import { RUNTIME_MODE_CHOICES } from "../threads/thread-settings-options";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsControlRow } from "./components/SettingsControlRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsProjectOverridesSection } from "./components/SettingsProjectOverridesSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";

type SettingsPage = "new-threads" | "source-control" | "agent-behavior" | "maintenance";

const PAGE_TITLE_KEYS: Record<
  SettingsPage,
  "newThreads" | "sourceControl" | "agentBehavior" | "maintenance"
> = {
  "new-threads": "newThreads",
  "source-control": "sourceControl",
  "agent-behavior": "agentBehavior",
  maintenance: "maintenance",
};

const PAGE_PROJECT_KEYS: Record<SettingsPage, readonly ProjectScopedServerSettingKey[]> = {
  "new-threads": ["defaultThreadEnvMode", "worktreeSubmodules", "defaultRuntimeMode"],
  "source-control": ["defaultAutoPull", "newWorktreesStartFromOrigin"],
  "agent-behavior": ["responseStreamingMode", "enableAgentBrowserAccess"],
  maintenance: ["continueThreadsAfterServerUpdate"],
};

const SUBMODULE_CHOICES: ReadonlyArray<{
  readonly mode: WorktreeSubmodules | null;
  readonly labelKey: "inherit" | "recursive" | "topLevelOnly" | "skip";
  readonly descriptionKey:
    | "inheritSubmoduleDescription"
    | "recursiveDescription"
    | "topLevelOnlyDescription"
    | "skipDescription";
}> = [
  // Only offered at environment scope; a project falls back through "Use defaults".
  {
    mode: null,
    labelKey: "inherit",
    descriptionKey: "inheritSubmoduleDescription",
  },
  {
    mode: "recursive",
    labelKey: "recursive",
    descriptionKey: "recursiveDescription",
  },
  {
    mode: "top-level",
    labelKey: "topLevelOnly",
    descriptionKey: "topLevelOnlyDescription",
  },
  { mode: "none", labelKey: "skip", descriptionKey: "skipDescription" },
];

const WORKSPACE_CHOICES: ReadonlyArray<{
  readonly mode: ThreadEnvMode | null;
  readonly labelKey: "inherit" | "currentCheckout" | "newWorktree";
  readonly descriptionKey:
    | "inheritWorkspaceDescription"
    | "currentCheckoutDescription"
    | "newWorktreeDescription";
}> = [
  // Only offered at environment scope; a project falls back through "Use defaults".
  {
    mode: null,
    labelKey: "inherit",
    descriptionKey: "inheritWorkspaceDescription",
  },
  {
    mode: "local",
    labelKey: "currentCheckout",
    descriptionKey: "currentCheckoutDescription",
  },
  {
    mode: "worktree",
    labelKey: "newWorktree",
    descriptionKey: "newWorktreeDescription",
  },
];

const STREAMING_CHOICES: ReadonlyArray<{
  readonly mode: ResponseStreamingMode;
  readonly labelKey: "afterTheTurn" | "finishedParagraphs" | "tokenByToken";
  readonly descriptionKey:
    | "afterTheTurnDescription"
    | "finishedParagraphsDescription"
    | "tokenByTokenDescription";
}> = [
  {
    mode: "turn",
    labelKey: "afterTheTurn",
    descriptionKey: "afterTheTurnDescription",
  },
  {
    mode: "paragraph",
    labelKey: "finishedParagraphs",
    descriptionKey: "finishedParagraphsDescription",
  },
  {
    mode: "token",
    labelKey: "tokenByToken",
    descriptionKey: "tokenByTokenDescription",
  },
];

export function SettingsEnvironmentNewThreadsRouteScreen() {
  return <ServerSettingsDetail page="new-threads" />;
}

export function SettingsEnvironmentSourceControlRouteScreen() {
  return <ServerSettingsDetail page="source-control" />;
}

export function SettingsEnvironmentAgentBehaviorRouteScreen() {
  return <ServerSettingsDetail page="agent-behavior" />;
}

export function SettingsEnvironmentMaintenanceRouteScreen() {
  return <ServerSettingsDetail page="maintenance" />;
}

function ServerSettingsDetail(props: { readonly page: SettingsPage }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const projectSelected = selectedProjectKey !== null;
  const targets = resolveMobileSettingsTargets(
    selectedTargets,
    projectSelected ? (selectedProject?.members.map((member) => member.project) ?? []) : null,
  );
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  const [pendingTargets, setPendingTargets] = useState<
    readonly ScopedMobileSettingsTarget[] | null
  >(null);
  const displayTargets = pendingWrites > 0 && pendingTargets !== null ? pendingTargets : targets;
  const hasConnectedSelection = targets.length > 0;
  const reference = displayTargets[0] ?? null;
  const uniform = <K extends keyof ServerSettings>(key: K): ServerSettings[K] | null => {
    if (reference === null) return null;
    const value = reference.settings[key];
    return displayTargets.every((entry) => entry.settings[key] === value) ? value : null;
  };
  // `uniform` folds a real null into "mixed"; nullable keys need the distinction.
  const isMixed = (key: keyof ServerSettings) =>
    reference === null ||
    displayTargets.some((entry) => entry.settings[key] !== reference.settings[key]);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "environment settings update",
    reportFailure: true,
  });
  const write = (patch: ServerSettingsPatch) => {
    if (writeInFlight.current || !hasConnectedSelection) return;
    const writes = planMobileScopedSettingsPatch(targets, projectSelected, patch);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(targets);
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({
          environmentId: entry.environmentId,
          input: { patch: entry.patch },
        }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };
  const clearProjectOverrides = () => {
    if (writeInFlight.current) return;
    const writes = planMobileScopedSettingsClear(targets, PAGE_PROJECT_KEYS[props.page]);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(targets);
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({
          environmentId: entry.environmentId,
          input: { patch: entry.patch },
        }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };
  const supportsProjectOverrides = targets.every(
    (target) =>
      target.environment.serverConfig.environment.capabilities.projectSettingsOverrides === true,
  );
  const disabled =
    pendingWrites > 0 || !hasConnectedSelection || (projectSelected && !supportsProjectOverrides);
  const supportsContinuation = targets.every(
    (target) =>
      target.environment.serverConfig.environment.capabilities.threadRestartContinuation === true,
  );
  const disabledFor = (key: string) =>
    disabled ||
    (projectSelected &&
      !PROJECT_SCOPED_SERVER_SETTING_KEYS.includes(
        key as (typeof PROJECT_SCOPED_SERVER_SETTING_KEYS)[number],
      ));

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen
        title={t(`nav.${PAGE_TITLE_KEYS[props.page]}`)}
        trailing={<AndroidSettingsEnvironmentFilter />}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom, 18) + 18,
          }}
        >
          {!hasConnectedSelection || reference === null ? (
            <Text className="px-2 text-base text-foreground-muted">
              {projectSelected
                ? t("settings.serverControls.emptyProject")
                : t("settings.serverControls.emptyEnvironment")}
            </Text>
          ) : (
            <>
              {projectSelected ? (
                <SettingsProjectOverridesSection
                  projectLabel={
                    selectedProject?.label ?? t("settings.serverControls.unavailableProject")
                  }
                  hasOverrides={targets.some((target) =>
                    PAGE_PROJECT_KEYS[props.page].some((key) => target.sources[key] === "project"),
                  )}
                  supportsOverrides={supportsProjectOverrides}
                  pending={pendingWrites > 0}
                  onClear={clearProjectOverrides}
                />
              ) : null}
              {props.page === "new-threads" ? (
                <>
                  <SettingsSection
                    title={t("settings.serverControls.defaultWorkspace")}
                    trailing={
                      pendingWrites === 0 && isMixed("defaultThreadEnvMode") ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {WORKSPACE_CHOICES.filter(
                      (choice) => choice.mode !== null || !projectSelected,
                    ).map((choice, index) => (
                      <ChoiceRow
                        key={choice.mode ?? "inherit"}
                        label={t(`settings.serverControls.${choice.labelKey}`)}
                        description={t(`settings.serverControls.${choice.descriptionKey}`)}
                        selected={
                          !isMixed("defaultThreadEnvMode") &&
                          uniform("defaultThreadEnvMode") === choice.mode
                        }
                        separated={index > 0}
                        disabled={disabledFor("defaultThreadEnvMode")}
                        onPress={() => write({ defaultThreadEnvMode: choice.mode })}
                      />
                    ))}
                  </SettingsSection>
                  <SettingsSection
                    title={t("settings.serverControls.worktreeSubmodules")}
                    trailing={
                      pendingWrites === 0 && isMixed("worktreeSubmodules") ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {SUBMODULE_CHOICES.filter(
                      (choice) => choice.mode !== null || !projectSelected,
                    ).map((choice, index) => (
                      <ChoiceRow
                        key={choice.mode ?? "inherit"}
                        label={t(`settings.serverControls.${choice.labelKey}`)}
                        description={t(`settings.serverControls.${choice.descriptionKey}`)}
                        selected={
                          !isMixed("worktreeSubmodules") &&
                          uniform("worktreeSubmodules") === choice.mode
                        }
                        separated={index > 0}
                        disabled={disabledFor("worktreeSubmodules")}
                        onPress={() => write({ worktreeSubmodules: choice.mode })}
                      />
                    ))}
                  </SettingsSection>
                  <SettingsSection
                    title={t("settings.serverControls.defaultPermissions")}
                    trailing={
                      pendingWrites === 0 && uniform("defaultRuntimeMode") === null ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {RUNTIME_MODE_CHOICES.map((choice, index) => (
                      <ChoiceRow
                        key={choice.mode}
                        label={choice.label}
                        description={choice.description}
                        selected={uniform("defaultRuntimeMode") === choice.mode}
                        separated={index > 0}
                        disabled={disabledFor("defaultRuntimeMode")}
                        onPress={() => write({ defaultRuntimeMode: choice.mode })}
                      />
                    ))}
                  </SettingsSection>
                </>
              ) : null}

              {props.page === "source-control" ? (
                <>
                  <SettingsSection title={t("settings.serverControls.defaultBranch")}>
                    <FanoutSwitchRow
                      icon="arrow.down.circle"
                      label={t("settings.serverControls.automaticallyPull")}
                      subtitle={t("settings.serverControls.automaticallyPullSubtitle")}
                      value={uniform("defaultAutoPull")}
                      disabled={disabledFor("defaultAutoPull")}
                      onValueChange={(value) => write({ defaultAutoPull: value })}
                    />
                  </SettingsSection>
                  <SettingsSection title={t("settings.serverControls.worktrees")}>
                    <FanoutSwitchRow
                      icon="arrow.triangle.branch"
                      label={t("settings.serverControls.startFromOrigin")}
                      subtitle={t("settings.serverControls.startFromOriginSubtitle")}
                      value={uniform("newWorktreesStartFromOrigin")}
                      disabled={disabledFor("newWorktreesStartFromOrigin")}
                      onValueChange={(value) => write({ newWorktreesStartFromOrigin: value })}
                    />
                  </SettingsSection>
                </>
              ) : null}

              {props.page === "agent-behavior" ? (
                <>
                  <SettingsSection
                    title={t("settings.serverControls.responseStreaming")}
                    trailing={
                      pendingWrites === 0 && uniform("responseStreamingMode") === null ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {STREAMING_CHOICES.map((choice, index) => (
                      <ChoiceRow
                        key={choice.mode}
                        label={t(`settings.serverControls.${choice.labelKey}`)}
                        description={t(`settings.serverControls.${choice.descriptionKey}`)}
                        selected={uniform("responseStreamingMode") === choice.mode}
                        separated={index > 0}
                        disabled={disabledFor("responseStreamingMode")}
                        onPress={() => {
                          if (choice.mode !== "token") {
                            write({ responseStreamingMode: choice.mode });
                            return;
                          }
                          Alert.alert(
                            t("settings.serverControls.legacyAlertTitle"),
                            t("settings.serverControls.legacyAlertBody"),
                            [
                              { text: t("common.cancel"), style: "cancel" },
                              {
                                text: t("settings.serverControls.legacyAlertConfirm"),
                                onPress: () => write({ responseStreamingMode: "token" }),
                              },
                            ],
                          );
                        }}
                      />
                    ))}
                  </SettingsSection>
                  <SettingsSection title={t("settings.serverControls.previewBrowser")}>
                    <FanoutSwitchRow
                      icon="globe"
                      label={t("settings.serverControls.agentBrowserAccess")}
                      subtitle={t("settings.serverControls.agentBrowserAccessSubtitle")}
                      value={uniform("enableAgentBrowserAccess")}
                      disabled={disabledFor("enableAgentBrowserAccess")}
                      onValueChange={(value) => write({ enableAgentBrowserAccess: value })}
                    />
                  </SettingsSection>
                </>
              ) : null}

              {props.page === "maintenance" ? (
                <>
                  {!projectSelected ? (
                    <SettingsSection title={t("settings.serverControls.manageEnvironments")}>
                      {selectedTargets.map((target) => (
                        <SettingsRow
                          key={target.environmentId}
                          icon="server.rack"
                          label={target.label}
                          value={t("settings.serverControls.serverAndProviderUpdates")}
                          onPress={() =>
                            navigation.navigate("SettingsSheet", {
                              screen: "SettingsContent",
                              params: {
                                screen: "SettingsEnvironmentDetail",
                                params: { environmentId: target.environmentId },
                              },
                            })
                          }
                        />
                      ))}
                    </SettingsSection>
                  ) : null}
                  <SettingsSection title={t("settings.serverControls.updates")}>
                    <FanoutSwitchRow
                      icon="arrow.clockwise"
                      label={t("settings.serverControls.checkProviderUpdates")}
                      subtitle={
                        projectSelected
                          ? t("settings.serverControls.checkProviderUpdatesProjectScoped")
                          : t("settings.serverControls.checkProviderUpdatesSubtitle")
                      }
                      value={uniform("enableProviderUpdateChecks")}
                      disabled={disabledFor("enableProviderUpdateChecks")}
                      onValueChange={(value) => write({ enableProviderUpdateChecks: value })}
                    />
                    <View className="border-t border-border-subtle">
                      <FanoutSwitchRow
                        icon="arrow.uturn.forward"
                        label={t("settings.serverControls.continueAfterRestart")}
                        subtitle={
                          supportsContinuation
                            ? t("settings.serverControls.continueAfterRestartSubtitle")
                            : t("settings.serverControls.continueAfterRestartUnavailable")
                        }
                        value={uniform("continueThreadsAfterServerUpdate")}
                        disabled={
                          disabledFor("continueThreadsAfterServerUpdate") || !supportsContinuation
                        }
                        onValueChange={(value) =>
                          write({ continueThreadsAfterServerUpdate: value })
                        }
                      />
                    </View>
                  </SettingsSection>
                </>
              ) : null}
            </>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function ChoiceRow(props: {
  readonly label: string;
  readonly description: string;
  readonly selected: boolean;
  readonly separated: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      className={
        props.separated
          ? "flex-row items-center gap-4 border-t border-border-subtle p-4 active:opacity-70"
          : "flex-row items-center gap-4 p-4 active:opacity-70"
      }
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <View className="min-w-0 flex-1 gap-1">
        <Text
          className={
            Platform.OS === "android" ? "text-base text-foreground" : "text-lg text-foreground"
          }
        >
          {props.label}
        </Text>
        <Text className="text-sm leading-normal text-foreground-muted">{props.description}</Text>
      </View>
      {props.selected ? (
        <SymbolView
          name="checkmark"
          size={18}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}

function MixedValuesLabel(props: { readonly projectSelected: boolean }) {
  const { t } = useTranslation();
  return (
    <Text
      accessibilityLabel={
        props.projectSelected
          ? t("settings.serverControls.mixedProjectAria")
          : t("settings.serverControls.mixedEnvironmentAria")
      }
      className="px-2 text-sm text-foreground-muted android:px-4"
    >
      {t("settings.serverControls.mixed")}
    </Text>
  );
}

function FanoutSwitchRow(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly subtitle: string;
  readonly value: boolean | null;
  readonly disabled: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  if (props.value !== null) {
    return (
      <SettingsSwitchRow
        icon={props.icon}
        label={props.label}
        subtitle={props.subtitle}
        value={props.value}
        disabled={props.disabled}
        onValueChange={props.onValueChange}
      />
    );
  }

  return (
    <SettingsControlRow
      disabled={props.disabled}
      icon={props.icon}
      label={props.label}
      subtitle={props.subtitle}
    >
      <Pressable
        accessibilityLabel={t("settings.serverControls.mixedSetOnAria", {
          label: props.label,
        })}
        accessibilityRole="button"
        disabled={props.disabled}
        className="rounded-full bg-subtle px-3 py-2 active:opacity-70"
        onPress={() => props.onValueChange(true)}
      >
        <Text className="text-sm font-t3-medium text-foreground">
          {t("settings.serverControls.mixedSetOn")}
        </Text>
      </Pressable>
    </SettingsControlRow>
  );
}
