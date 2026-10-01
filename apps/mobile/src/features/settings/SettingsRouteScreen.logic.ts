import { translateDynamic } from "../../i18n";

export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios" || platform === "android"
    ? { supported: true, subtitle: undefined }
    : {
        supported: false,
        subtitle: translateDynamic(
          "settings.notifications.unavailableOnPlatform",
          "Unavailable on this platform",
        ),
      };
}
