import { useNavigation } from "@react-navigation/native";
import { Platform, Pressable } from "react-native";
import { useTranslation } from "react-i18next";

import { ControlPillMenu } from "../../../components/ControlPill";
import { SymbolView } from "../../../components/AppSymbol";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { withNativeGlassHeaderItem } from "../../layout/native-glass-header-items";
import { useAdaptiveWorkspaceLayout } from "../../layout/AdaptiveWorkspaceLayout";
import { useSettingsEnvironmentFilter } from "../settings-environment-filter";

export function SettingsEnvironmentFilterHeader(props: { readonly closeSettings?: boolean }) {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();
  const closeSettings = props.closeSettings === true && !layout.usesSplitView;
  const {
    availableTargets,
    selectedTargets,
    selectedIds,
    selectAll,
    toggleEnvironment,
    selectableProjectGroups,
    selectedProjectKey,
    selectProject,
  } = useSettingsEnvironmentFilter();
  if (Platform.OS !== "ios") return null;

  const filterIcon =
    selectedIds === null && selectedProjectKey === null
      ? "line.3.horizontal.decrease"
      : "line.3.horizontal.decrease.circle.fill";
  const filterVersion = JSON.stringify({
    closeSettings,
    selection: selectedIds === null ? null : [...selectedIds].sort(),
    targets: availableTargets.map((entry) => [entry.environmentId, entry.label, entry.displayUrl]),
    project: selectedProjectKey,
    projects: selectableProjectGroups.map((group) => [group.key, group.label]),
  });

  return (
    <NativeStackScreenOptions
      optionsVersion={filterVersion}
      options={{
        unstable_headerRightItems: () => [
          withNativeGlassHeaderItem({
            accessibilityLabel: t("settings.scope.filterAria"),
            icon: { name: filterIcon, type: "sfSymbol" },
            label: "",
            type: "menu",
            menu: {
              title: t("settings.scope.title"),
              items: [
                {
                  type: "submenu",
                  label:
                    selectedIds === null
                      ? t("settings.scope.allEnvironments")
                      : t(
                          selectedTargets.length === 1
                            ? "settings.scope.selectedEnvironmentCount"
                            : "settings.scope.selectedEnvironmentsCount",
                          { total: selectedTargets.length },
                        ),
                  items: [
                    {
                      type: "action",
                      label: t("settings.scope.allConnectedEnvironments"),
                      state: selectedIds === null ? "on" : undefined,
                      onPress: selectAll,
                    },
                    ...availableTargets.map((entry) => ({
                      type: "action" as const,
                      label: entry.label,
                      description: entry.displayUrl ?? undefined,
                      state:
                        selectedIds === null || selectedIds.has(entry.environmentId)
                          ? ("on" as const)
                          : undefined,
                      onPress: () => toggleEnvironment(entry.environmentId),
                    })),
                  ],
                },
                {
                  type: "submenu",
                  label:
                    selectableProjectGroups.find((group) => group.key === selectedProjectKey)
                      ?.label ??
                    (selectedProjectKey === null
                      ? t("settings.scope.allProjects")
                      : t("settings.scope.unavailableProject")),
                  items: [
                    {
                      type: "action",
                      label: t("settings.scope.allProjects"),
                      state: selectedProjectKey === null ? "on" : undefined,
                      onPress: () => selectProject(null),
                    },
                    ...selectableProjectGroups.map((group) => ({
                      type: "action" as const,
                      label: group.label,
                      state: selectedProjectKey === group.key ? ("on" as const) : undefined,
                      onPress: () => selectProject(group.key),
                    })),
                  ],
                },
              ],
            },
          }),
          ...(closeSettings
            ? [
                withNativeGlassHeaderItem({
                  accessibilityLabel: t("settings.scope.closeSettings"),
                  icon: { name: "xmark", type: "sfSymbol" },
                  identifier: "settings-close",
                  label: "",
                  onPress: () => navigation.goBack(),
                  type: "button",
                }),
              ]
            : []),
        ],
      }}
    />
  );
}

export function AndroidSettingsEnvironmentFilter() {
  const { t } = useTranslation();
  const {
    availableTargets,
    selectedIds,
    selectAll,
    toggleEnvironment,
    selectableProjectGroups,
    selectedProjectKey,
    selectProject,
  } = useSettingsEnvironmentFilter();
  const filterIcon =
    selectedIds === null && selectedProjectKey === null
      ? "line.3.horizontal.decrease"
      : "line.3.horizontal.decrease.circle.fill";

  return (
    <ControlPillMenu
      accessible
      accessibilityRole="button"
      accessibilityLabel={t("settings.scope.filterAria")}
      title={t("settings.scope.title")}
      actions={[
        {
          id: "all",
          title: t("settings.scope.allConnectedEnvironments"),
          state: selectedIds === null ? ("on" as const) : ("off" as const),
        },
        ...availableTargets.map((entry) => ({
          id: `environment:${entry.environmentId}`,
          title: t("settings.scope.environmentEntry", { label: entry.label }),
          subtitle: entry.displayUrl ?? undefined,
          state:
            selectedIds === null || selectedIds.has(entry.environmentId)
              ? ("on" as const)
              : ("off" as const),
        })),
        {
          id: "project:all",
          title: t("settings.scope.allProjects"),
          state: selectedProjectKey === null ? ("on" as const) : ("off" as const),
        },
        ...selectableProjectGroups.map((group) => ({
          id: `project:${group.key}`,
          title: t("settings.scope.projectEntry", { label: group.label }),
          state: selectedProjectKey === group.key ? ("on" as const) : ("off" as const),
        })),
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "all") selectAll();
        else if (nativeEvent.event === "project:all") selectProject(null);
        else if (nativeEvent.event.startsWith("project:")) {
          const group = selectableProjectGroups.find(
            (entry) => `project:${entry.key}` === nativeEvent.event,
          );
          if (group) selectProject(group.key);
        } else {
          const target = availableTargets.find(
            (entry) => `environment:${entry.environmentId}` === nativeEvent.event,
          );
          if (target) toggleEnvironment(target.environmentId);
        }
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("settings.scope.filterAria")}
        className="size-11 items-center justify-center rounded-full"
      >
        <SymbolView name={filterIcon} size={22} tintColorClassName="accent-icon" />
      </Pressable>
    </ControlPillMenu>
  );
}
