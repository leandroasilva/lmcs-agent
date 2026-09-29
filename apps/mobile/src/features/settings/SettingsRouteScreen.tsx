import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useAuth, useUser } from "@clerk/expo";
import { useNavigation } from "@react-navigation/native";
import { Platform, View } from "react-native";
import { useTranslation } from "react-i18next";
import { deriveProjectGroupLabel } from "@lmcstools/client/state/project-grouping";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import "../../i18n";

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsRouteScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();
  const content = hasCloudPublicConfig() ? (
    <ConfiguredSettingsRouteScreen />
  ) : (
    <LocalSettingsRouteScreen />
  );

  return (
    <>
      {Platform.OS === "ios" && layout.usesSplitView ? (
        <NativeHeaderToolbar placement="left">
          <NativeHeaderToolbar.Button
            accessibilityLabel={t("common.goBack")}
            icon="chevron.left"
            onPress={() => navigation.goBack()}
          />
        </NativeHeaderToolbar>
      ) : null}
      <SettingsEnvironmentFilterHeader closeSettings />
      {Platform.OS === "android" ? (
        <SettingsScreen
          title={t("common.settings")}
          trailing={<AndroidSettingsEnvironmentFilter />}
        >
          {content}
        </SettingsScreen>
      ) : (
        content
      )}
    </>
  );
}

function ConfiguredSettingsRouteScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const accountLabel = !isLoaded
    ? t("settings.index.accountChecking")
    : !isSignedIn
      ? t("settings.index.signIn")
      : (user?.primaryEmailAddress?.emailAddress ?? t("settings.index.signedIn"));

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title={t("settings.section.connections")}>
          <SettingsRow
            icon="person.crop.circle"
            label={t("settings.index.account")}
            value={accountLabel}
            disabled={!isLoaded}
            onPress={() => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" })}
          />
          <SettingsRow
            icon="desktopcomputer"
            label={t("settings.index.environments")}
            value={`${Object.keys(savedConnectionsById).length}`}
            valuePosition="trailing"
            target="SettingsEnvironments"
          />
          <SettingsRow
            icon="bell.badge"
            label={t("settings.index.notifications")}
            target="SettingsNotifications"
          />
        </SettingsSection>

        <SettingsIndexSections />
      </ScrollView>
    </View>
  );
}

function LocalSettingsRouteScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentCount = Object.keys(savedConnectionsById).length;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title={t("settings.section.connections")}>
          <SettingsRow
            icon="desktopcomputer"
            label={t("settings.index.environments")}
            value={`${environmentCount}`}
            valuePosition="trailing"
            target="SettingsEnvironments"
          />
        </SettingsSection>

        <SettingsIndexSections />
      </ScrollView>
    </View>
  );
}

function SettingsIndexSections() {
  const { t } = useTranslation();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const noServerTargets = selectedTargets.length === 0;
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const scopedProjectMembers =
    selectedProject?.members
      .map((member) => member.project)
      .filter((project) =>
        selectedTargets.some((target) => target.environmentId === project.environmentId),
      ) ?? [];
  const projectLabel =
    scopedProjectMembers.length > 0
      ? deriveProjectGroupLabel({
          representative: scopedProjectMembers[0]!,
          members: scopedProjectMembers,
        })
      : (selectedProject?.label ?? t("settings.index.unavailableProject"));
  return (
    <>
      <SettingsSection title={t("settings.section.interface")}>
        <SettingsRow
          icon="paintbrush"
          label={t("settings.index.appearance")}
          target="SettingsAppearance"
        />
        <SettingsRow icon="globe" label={t("settings.index.language")} target="SettingsLanguage" />
        {Platform.OS === "ios" ? (
          <SettingsRow
            icon="keyboard"
            label={t("settings.index.keyboard")}
            target="SettingsKeyboard"
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title={t("settings.section.projectsAndThreads")}>
        {selectedProjectKey !== null ? (
          <SettingsRow
            icon="folder"
            label={t("settings.index.overview")}
            value={projectLabel}
            target="SettingsProjectOverview"
          />
        ) : null}
        <SettingsRow
          icon="folder"
          label={t("settings.index.organization")}
          target="SettingsOrganization"
        />
        <SettingsRow
          icon="text.bubble"
          label={t("settings.index.threadBehavior")}
          target="SettingsThreads"
        />
        <SettingsRow
          icon="archivebox"
          label={t("settings.index.archivedThreads")}
          target="SettingsArchive"
        />
      </SettingsSection>

      <SettingsSection title={t("settings.section.server")}>
        <SettingsRow
          icon="text.bubble"
          label={t("settings.index.newThreads")}
          target="SettingsEnvironmentNewThreads"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="arrow.triangle.branch"
          label={t("settings.index.sourceControl")}
          target="SettingsEnvironmentSourceControl"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="text.alignleft"
          label={t("settings.index.agentBehavior")}
          target="SettingsEnvironmentAgentBehavior"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="arrow.clockwise"
          label={t("settings.index.maintenance")}
          target="SettingsEnvironmentMaintenance"
          disabled={noServerTargets}
        />
      </SettingsSection>

      <SettingsSection title={t("settings.section.app")}>
        <SettingsRow
          icon="chart.bar.xaxis"
          label={t("settings.index.usage")}
          target="SettingsUsage"
        />
        <SettingsRow icon="info.circle" label={t("settings.index.about")} target="SettingsAbout" />
      </SettingsSection>
    </>
  );
}
