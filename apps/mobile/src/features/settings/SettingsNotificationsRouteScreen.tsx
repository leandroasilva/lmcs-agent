import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useAuth } from "@clerk/expo";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Notifications from "expo-notifications";
import { useNavigation } from "@react-navigation/native";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AppState, Linking, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";

import { AppText as Text } from "../../components/AppText";
import {
  isAtomCommandInterrupted,
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@lmcstools/client/state/runtime";
import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";
import {
  openAndroidLiveUpdateSettings,
  supportsAndroidLiveUpdateSettings,
} from "../agent-awareness/androidNotifications";
import { setLiveActivityUpdatesEnabled } from "../agent-awareness/liveActivityPreferences";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import {
  getAgentAwarenessRegistrationStatus,
  refreshAgentAwarenessRegistration,
  subscribeAgentAwarenessRegistrationStatus,
} from "../agent-awareness/remoteRegistration";
import { refreshManagedRelayEnvironments } from "../cloud/managedRelayState";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { resolveAgentAwarenessPlatformPresentation } from "./SettingsRouteScreen.logic";

type NotificationStatus = "checking" | "enabled" | "disabled" | "unsupported";
type LiveActivityStatus = "checking" | "enabled" | "disabled" | "signed-out" | "linking";

// Reflects whether the relay actually accepted this device's registration.
// The notification and Live Activity switches are gated on this so they can
// never read as enabled when the device cannot receive anything (e.g. the
// registration request timed out).
function useDeviceRegistered(): boolean {
  const status = useSyncExternalStore(
    subscribeAgentAwarenessRegistrationStatus,
    getAgentAwarenessRegistrationStatus,
    () => "unknown" as const,
  );
  return status === "registered";
}

export function SettingsNotificationsRouteScreen() {
  const { t } = useTranslation();
  if (!hasCloudPublicConfig()) {
    return (
      <SettingsScreen title={t("nav.notifications")}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5 pt-4"
        >
          <Text className="text-base text-foreground-muted">
            {t("settings.notifications.requiresConnect")}
          </Text>
        </ScrollView>
      </SettingsScreen>
    );
  }

  return <ConfiguredSettingsNotificationsRouteScreen />;
}

function ConfiguredSettingsNotificationsRouteScreen() {
  const { t } = useTranslation();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const agentAwarenessPushAvailable = supportsAgentAwarenessPush();
  const agentAwarenessPlatform = resolveAgentAwarenessPlatformPresentation(Platform.OS);
  const agentAwarenessSubtitle =
    Platform.OS === "android" && !agentAwarenessPushAvailable
      ? t("settings.notifications.installNewerBuild")
      : agentAwarenessPlatform.subtitle;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { getToken, isLoaded, isSignedIn } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>("checking");
  const [liveActivityStatus, setLiveActivityStatus] = useState<LiveActivityStatus>("checking");
  const liveActivityWriteInFlight = useRef(false);
  const deviceRegistered = useDeviceRegistered();
  const liveActivitiesPreferenceEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.liveActivitiesEnabled !== false
    : true;
  const canClearLiveActivitiesPreference =
    AsyncResult.isSuccess(preferencesResult) &&
    preferencesResult.value.liveActivitiesEnabled !== false;

  const connections = useMemo(() => Object.values(savedConnectionsById), [savedConnectionsById]);
  const environmentCount = connections.length;

  const refreshNotifications = useCallback(async () => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      setNotificationStatus("unsupported");
      return;
    }
    const result = await settlePromise(() => Notifications.getPermissionsAsync());
    if (result._tag === "Failure") {
      reportAtomCommandResult(result, {
        label: "notification permission refresh",
      });
      setNotificationStatus("disabled");
      return;
    }
    setNotificationStatus(result.value.granted ? "enabled" : "disabled");
  }, []);

  useEffect(() => {
    void refreshNotifications();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshNotifications();
    });
    return () => subscription.remove();
  }, [refreshNotifications]);

  useEffect(() => {
    if (!isLoaded) {
      setLiveActivityStatus("checking");
      return;
    }
    if (!isSignedIn) {
      setLiveActivityStatus("signed-out");
      return;
    }
    if (!AsyncResult.isSuccess(preferencesResult)) {
      if (AsyncResult.isFailure(preferencesResult)) {
        reportAtomCommandResult(preferencesResult, {
          label: "live activity preference load",
        });
        setLiveActivityStatus("enabled");
      } else {
        setLiveActivityStatus("checking");
      }
      return;
    }
    setLiveActivityStatus(
      preferencesResult.value.liveActivitiesEnabled === false ? "disabled" : "enabled",
    );
  }, [isLoaded, isSignedIn, preferencesResult]);

  const requestNotifications = useCallback(async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        requestAgentNotificationPermission.pipe(
          Effect.tap((permission) =>
            permission.type === "granted" ? refreshAgentAwarenessRegistration() : Effect.void,
          ),
        ),
      ),
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          t("settings.notifications.alertUnavailableTitle"),
          error instanceof Error
            ? error.message
            : t("settings.notifications.alertRequestPermissionFailed"),
        );
      }
      return;
    }
    if (result.value.type === "granted") {
      setNotificationStatus("enabled");
      // Permission alone is not enough: the switch stays off until the relay
      // registration succeeds, so tell the user the truth about which happened.
      if (getAgentAwarenessRegistrationStatus() === "registered") {
        Alert.alert(
          t("settings.notifications.alertEnabledTitle"),
          t("settings.notifications.alertEnabledBody"),
        );
      } else {
        Alert.alert(
          t("settings.notifications.alertFinishEnableTitle"),
          t("settings.notifications.alertFinishEnableBody"),
        );
      }
      return;
    }
    if (result.value.type === "unsupported") {
      setNotificationStatus("unsupported");
      Alert.alert(
        t("settings.notifications.alertUnavailableTitle"),
        t("settings.notifications.alertUnavailablePlatformBody"),
      );
      return;
    }
    setNotificationStatus("disabled");
    if (result.value.canAskAgain) {
      Alert.alert(
        t("settings.notifications.alertDisabledTitle"),
        t("settings.notifications.alertNotEnabledBody"),
      );
      return;
    }
    Alert.alert(
      t("settings.notifications.alertDisabledTitle"),
      t("settings.notifications.alertDeniedBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("settings.notifications.alertOpenSettings"),
          onPress: () => void Linking.openSettings(),
        },
      ],
    );
  }, [t]);

  const promptSignIn = useCallback(() => {
    Alert.alert(
      t("settings.notifications.alertSignInTitle"),
      t("settings.notifications.alertSignInBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.continue"),
          onPress: () => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" }),
        },
      ],
    );
  }, [navigation, t]);

  const linkEnvironments = useCallback(async () => {
    if (!isSignedIn) {
      promptSignIn();
      return;
    }

    setLiveActivityStatus("linking");
    if (Platform.OS === "android") {
      const permission = await settleAsyncResult(() =>
        runtime.runPromiseExit(requestAgentNotificationPermission),
      );
      if (permission._tag === "Failure") {
        setLiveActivityStatus("disabled");
        const error = squashAtomCommandFailure(permission);
        Alert.alert(
          t("settings.notifications.alertOngoingUnavailable"),
          error instanceof Error
            ? error.message
            : t("settings.notifications.alertEnableAgentFailed"),
        );
        return;
      }
      if (permission.value.type !== "granted") {
        setLiveActivityStatus("disabled");
        Alert.alert(
          t("settings.notifications.alertPermissionNeededTitle"),
          t("settings.notifications.alertPermissionNeededBody"),
          [
            { text: t("common.cancel"), style: "cancel" },
            {
              text: t("settings.notifications.alertOpenSettings"),
              onPress: () => void Linking.openSettings(),
            },
          ],
        );
        return;
      }
      setNotificationStatus("enabled");
    }
    const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    if (tokenResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      const error = squashAtomCommandFailure(tokenResult);
      Alert.alert(
        Platform.OS === "android"
          ? t("settings.notifications.alertOngoingUnavailable")
          : t("settings.notifications.alertLiveActivitiesUnavailable"),
        error instanceof Error
          ? error.message
          : t("settings.notifications.alertEnableActivityFailed"),
      );
      return;
    }
    if (!tokenResult.value) {
      promptSignIn();
      setLiveActivityStatus("signed-out");
      return;
    }

    const updateResult = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        setLiveActivityUpdatesEnabled({
          enabled: true,
          previousEnabled: liveActivitiesPreferenceEnabled,
          clerkToken: tokenResult.value,
          connections,
        }),
      ),
    );
    if (updateResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      if (!isAtomCommandInterrupted(updateResult)) {
        const error = squashAtomCommandFailure(updateResult);
        Alert.alert(
          Platform.OS === "android"
            ? t("settings.notifications.alertOngoingUnavailable")
            : t("settings.notifications.alertLiveActivitiesUnavailable"),
          error instanceof Error
            ? error.message
            : t("settings.notifications.alertEnableActivityFailed"),
        );
      }
      return;
    }

    savePreferences({ liveActivitiesEnabled: true });
    refreshManagedRelayEnvironments();
    setLiveActivityStatus("enabled");
    // The environment link can succeed while this device's own registration
    // (the push-to-start token the relay needs) has not — don't claim Live
    // Activities are live until the device is actually registered.
    if (getAgentAwarenessRegistrationStatus() === "registered") {
      Alert.alert(
        Platform.OS === "android"
          ? t("settings.notifications.alertOngoingEnabled")
          : t("settings.notifications.alertLiveActivitiesEnabled"),
        environmentCount > 0
          ? environmentCount === 1
            ? t("settings.notifications.alertLinkedOne", {
                total: environmentCount,
              })
            : t("settings.notifications.alertLinkedMany", {
                total: environmentCount,
              })
          : t("settings.notifications.alertActivityEnabledAddEnvironment"),
      );
    } else {
      Alert.alert(
        t("settings.notifications.alertFinishEnableUpdatesTitle"),
        t("settings.notifications.alertFinishEnableUpdatesBody"),
      );
    }
  }, [
    connections,
    environmentCount,
    getToken,
    isSignedIn,
    liveActivitiesPreferenceEnabled,
    promptSignIn,
    savePreferences,
    t,
  ]);

  const handleDeviceNotificationsChange = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        if (!isSignedIn) {
          promptSignIn();
          return;
        }
        void requestNotifications();
        return;
      }

      Alert.alert(
        t("settings.notifications.alertDisableNotificationsTitle"),
        t("settings.notifications.alertDisableNotificationsBody"),
        [
          { text: t("common.cancel"), style: "cancel" },
          {
            text: t("settings.notifications.alertOpenSettings"),
            onPress: () => void Linking.openSettings(),
          },
        ],
      );
    },
    [isSignedIn, promptSignIn, requestNotifications, t],
  );

  const handleLiveActivitiesChange = useCallback(
    (enabled: boolean) => {
      if (liveActivityWriteInFlight.current) return;
      if (!enabled) {
        liveActivityWriteInFlight.current = true;
        setLiveActivityStatus("linking");
        void (async () => {
          try {
            let token: string | null = null;
            if (isSignedIn) {
              const tokenResult = await settlePromise(() =>
                getToken(resolveRelayClerkTokenOptions()),
              );
              if (tokenResult._tag === "Failure") {
                setLiveActivityStatus("enabled");
                reportAtomCommandResult(tokenResult, {
                  label: "live activity disable token lookup",
                });
                return;
              }
              token = tokenResult.value;
            }

            const updateResult = await settleAsyncResult(() =>
              runtime.runPromiseExit(
                setLiveActivityUpdatesEnabled({
                  enabled: false,
                  previousEnabled: liveActivitiesPreferenceEnabled,
                  clerkToken: token,
                  connections,
                }),
              ),
            );
            if (updateResult._tag === "Failure") {
              setLiveActivityStatus(isSignedIn ? "enabled" : "signed-out");
              reportAtomCommandResult(updateResult, {
                label: "live activity disable",
              });
              return;
            }
            savePreferences({ liveActivitiesEnabled: false });
            refreshManagedRelayEnvironments();
            setLiveActivityStatus("disabled");
          } finally {
            liveActivityWriteInFlight.current = false;
          }
        })();
        return;
      }

      if (!isSignedIn) {
        promptSignIn();
        return;
      }

      liveActivityWriteInFlight.current = true;
      void linkEnvironments().finally(() => {
        liveActivityWriteInFlight.current = false;
      });
    },
    [
      connections,
      getToken,
      isSignedIn,
      linkEnvironments,
      liveActivitiesPreferenceEnabled,
      promptSignIn,
      savePreferences,
    ],
  );

  return (
    <SettingsScreen title={t("nav.notifications")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title={t("settings.notifications.agentActivity")}>
          <SettingsSwitchRow
            icon="bell.badge"
            label={t("settings.notifications.deviceNotifications")}
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              notificationStatus === "checking" ||
              notificationStatus === "unsupported"
            }
            subtitle={agentAwarenessSubtitle}
            // Only reads as on when this device is actually registered with the
            // relay; otherwise notifications cannot be delivered regardless of
            // the local iOS permission.
            value={
              agentAwarenessPushAvailable && notificationStatus === "enabled" && deviceRegistered
            }
            onValueChange={handleDeviceNotificationsChange}
          />
          <SettingsSwitchRow
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              !isLoaded ||
              liveActivityStatus === "checking" ||
              liveActivityStatus === "linking"
            }
            icon="bolt.circle"
            label={
              Platform.OS === "android"
                ? supportsAndroidLiveUpdateSettings()
                  ? t("settings.notifications.agentLiveUpdates")
                  : t("settings.notifications.ongoingAgentActivity")
                : t("settings.notifications.liveActivityUpdates")
            }
            subtitle={agentAwarenessSubtitle}
            // Same gate: a saved preference is meaningless until the device
            // registration the relay needs to push updates has succeeded.
            value={
              agentAwarenessPushAvailable &&
              (liveActivityStatus === "enabled" || liveActivityStatus === "linking") &&
              deviceRegistered
            }
            onValueChange={handleLiveActivitiesChange}
          />
          {liveActivityStatus === "signed-out" && canClearLiveActivitiesPreference ? (
            <SettingsRow
              icon="bolt.circle"
              label={t("settings.notifications.turnOffPreference")}
              onPress={() => handleLiveActivitiesChange(false)}
            />
          ) : null}
          {supportsAndroidLiveUpdateSettings() ? (
            <SettingsRow
              icon="bolt.circle"
              label={t("settings.notifications.liveUpdateSettings")}
              onPress={() => {
                void openAndroidLiveUpdateSettings().catch(() => {
                  Alert.alert(
                    t("settings.notifications.alertCouldNotOpenSettingsTitle"),
                    t("settings.notifications.alertCouldNotOpenSettingsBody"),
                  );
                });
              }}
            />
          ) : null}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
