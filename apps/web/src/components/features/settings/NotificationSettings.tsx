import { useState } from "react";
import { useTranslation } from "react-i18next";

import { translateDynamic } from "../../../i18n";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  unlockNotificationAudio,
} from "../../../threadNotifications";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

// The label map stays in English as catalog fallback; the resolver returns the
// active locale at render time.
function notificationModeLabel(mode: keyof typeof NOTIFICATION_MODE_LABELS): string {
  return translateDynamic(`settings.notifications.modes.${mode}`, NOTIFICATION_MODE_LABELS[mode]);
}

export function NotificationSettings() {
  const { t } = useTranslation();
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <SettingsRow
      {...searchableSetting("thread-notifications")}
      description={permissionMessage ?? t("settings.notifications.description")}
      control={
        <Select
          value={mode}
          disabled={requesting}
          onValueChange={async (value) => {
            if (
              value !== "off" &&
              value !== "notifications" &&
              value !== "sound" &&
              value !== "notifications-and-sound"
            )
              return;
            setPermissionMessage(null);
            if (hasNotificationSound(value)) unlockNotificationAudio();
            if (hasDesktopNotifications(value)) {
              if (typeof Notification === "undefined" || !window.isSecureContext) {
                setPermissionMessage(t("settings.notifications.permissionUnsupported"));
                return;
              }
              setRequesting(true);
              try {
                const permission = await Notification.requestPermission();
                if (permission !== "granted") {
                  setPermissionMessage(t("settings.notifications.permissionDenied"));
                  return;
                }
              } catch {
                setPermissionMessage(t("settings.notifications.permissionUnavailable"));
                return;
              } finally {
                setRequesting(false);
              }
            }
            updateSettings({ notificationMode: value });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-56"
            aria-label={t("settings.notifications.aria")}
          >
            <SelectValue>{notificationModeLabel(mode)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.keys(NOTIFICATION_MODE_LABELS).map((value) => (
              <SelectItem key={value} hideIndicator value={value}>
                {notificationModeLabel(value as keyof typeof NOTIFICATION_MODE_LABELS)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
