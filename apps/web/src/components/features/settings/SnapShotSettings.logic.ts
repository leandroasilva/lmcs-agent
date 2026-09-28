import type { ClientSettingsPatch, DesktopSnapShotState, SnapShotSound } from "@lmcstools/core";

import { translateDynamic } from "../../../i18n";
import {
  captureSetupBackend,
  captureSetupDesktopName,
  captureSetupAccessReady,
  captureSetupMacPermissionsReady,
} from "./SnapShotSetupDialog.logic";

export function snapShotStatus(state: DesktopSnapShotState | null, enabled: boolean): string {
  if (!state) return translateDynamic("settings.snapshot.status.checking", "Checking snapshots…");
  if (state.mode === "unavailable")
    return (
      state.message ??
      translateDynamic("settings.snapshot.status.unsupported", "Not supported on this platform.")
    );
  if (!enabled)
    return translateDynamic("settings.snapshot.status.turnOn", "Turn this on to set up snapshots.");
  return snapShotSetupSummary(state, enabled);
}

export function snapShotSetupSummary(state: DesktopSnapShotState, enabled: boolean): string {
  if (state.message)
    return translateDynamic("settings.snapshot.summary.needsAttention", "Capture needs attention");
  if (state.linuxBackend === "hyprland" && state.hyprlandHelper?.status !== "ready")
    return state.hyprlandHelper?.status === "error"
      ? translateDynamic("settings.snapshot.summary.checkAccess", "Check capture access in setup")
      : translateDynamic(
          "settings.snapshot.summary.installHelper",
          "Install the capture helper to continue",
        );
  if (captureSetupBackend(state) === "gnome" && state.gnomeExtension?.status !== "enabled")
    return translateDynamic(
      "settings.snapshot.summary.setupActiveWindow",
      "Set up active-window snapshots",
    );
  if (captureSetupBackend(state) === "kde" && state.kdeHelper?.status !== "ready")
    return state.kdeHelper?.status === "error"
      ? translateDynamic("settings.snapshot.summary.checkAccess", "Check capture access in setup")
      : translateDynamic(
          "settings.snapshot.summary.installHelper",
          "Install the capture helper to continue",
        );
  if (captureSetupBackend(state) === "picker")
    return translateDynamic(
      "settings.snapshot.summary.manualOnly",
      "Manual capture only — you'll choose a window each time",
    );
  if (!enabled)
    return translateDynamic(
      "settings.snapshot.summary.enableCapture",
      "Enable capture to continue",
    );
  if (state.shortcutPending)
    return state.linuxBackend === "hyprland"
      ? translateDynamic(
          "settings.snapshot.summary.connectingShortcut",
          "Connecting your shortcut…",
        )
      : translateDynamic(
          "settings.snapshot.summary.waitingPermission",
          "Waiting for shortcut permission",
        );
  if (state.shortcutVerified)
    return translateDynamic("settings.snapshot.summary.ready", "Ready to capture");
  if (state.linuxBackend === "niri" && state.shortcutBinding)
    return translateDynamic(
      "settings.snapshot.summary.useFromOtherApp",
      "Use your shortcut from another app",
    );
  if (state.linuxBackend === "hyprland" && state.shortcutActionRegistered)
    return translateDynamic(
      "settings.snapshot.summary.useFromOtherApp",
      "Use your shortcut from another app",
    );
  if (state.shortcutRegistered)
    return state.shortcutLabel
      ? translateDynamic("settings.snapshot.summary.ready", "Ready to capture")
      : translateDynamic("settings.snapshot.summary.shortcutSaved", "Shortcut saved");
  return translateDynamic("settings.snapshot.summary.finishSetup", "Finish shortcut setup");
}

export function snapShotShortcutStatus(state: DesktopSnapShotState | null): string | null {
  if (!state) return null;
  if (state.linuxBackend === "hyprland") return state.shortcutMessage;
  if (state.shortcutPending)
    return translateDynamic(
      "settings.snapshot.shortcutStatus.approvePrompt",
      "Approve the shortcut permission prompt to continue.",
    );
  if (state.shortcutRegistered)
    return state.mode === "portal"
      ? null
      : translateDynamic("settings.snapshot.shortcutStatus.saved", "Shortcut saved.");
  return state.shortcutMessage;
}

export function snapShotSetupButtonLabel(state: DesktopSnapShotState | null): string {
  if (!state) return translateDynamic("settings.snapshot.setupButton.continue", "Continue setup");
  if (captureSetupAccessReady(state))
    return translateDynamic("settings.snapshot.setupButton.manage", "Manage capture");
  const desktop = captureSetupDesktopName(state);
  return desktop
    ? translateDynamic("settings.snapshot.setupButton.setupDesktop", `Set up ${desktop} capture`, {
        desktop,
      })
    : translateDynamic("settings.snapshot.setupButton.continue", "Continue setup");
}

// Windows needs no permissions or setup: turning capture on is enough. macOS setup
// has nothing left to manage once permissions and the shortcut are in place; the
// shortcut row stays editable inline. Revoking a permission brings the button back
// as "Continue setup" through the state message.
export function snapShotSetupComplete(
  state: DesktopSnapShotState | null,
  includeAccessibility: boolean,
): boolean {
  if (state?.windows) return true;
  return (
    state?.macPermissions !== undefined &&
    captureSetupAccessReady(state) &&
    captureSetupMacPermissionsReady(state, includeAccessibility) &&
    state.shortcutRegistered
  );
}

export type SnapShotSoundSelection = SnapShotSound | "off";

export function snapShotFeedbackUnavailableMessage(
  state: DesktopSnapShotState | null,
): string | undefined {
  if (state?.mode !== "portal" || state.linuxFeedbackAvailable) return undefined;
  if (state.linuxBackend === "hyprland")
    return state.hyprlandHelper?.status === "ready"
      ? translateDynamic(
          "settings.snapshot.feedback.unavailableDesktop",
          "Capture effects aren't available on this desktop.",
        )
      : translateDynamic(
          "settings.snapshot.feedback.installHelper",
          "Install or update the capture helper to enable effects.",
        );
  if (state.linuxBackend === "niri")
    return translateDynamic(
      "settings.snapshot.feedback.unavailableNiri",
      "Capture effects aren't available on Niri.",
    );
  if (state.linuxBackend === "kde")
    return state.kdeHelper?.status === "ready"
      ? translateDynamic(
          "settings.snapshot.feedback.unavailableDesktop",
          "Capture effects aren't available on this desktop.",
        )
      : translateDynamic(
          "settings.snapshot.feedback.installHelper",
          "Install or update the capture helper to enable effects.",
        );
  return state.linuxBackend === "gnome-extension"
    ? translateDynamic(
        "settings.snapshot.feedback.updateGnome",
        "Update the GNOME extension, then sign out and back in to enable effects.",
      )
    : captureSetupBackend(state) === "gnome"
      ? translateDynamic(
          "settings.snapshot.feedback.finishExtension",
          "Finish extension setup to enable effects.",
        )
      : translateDynamic(
          "settings.snapshot.feedback.unavailableDesktop",
          "Capture effects aren't available on this desktop.",
        );
}

export function snapShotDescription(state: DesktopSnapShotState | null): string {
  return state?.mode === "portal" && captureSetupBackend(state) === "picker"
    ? translateDynamic(
        "settings.snapshot.description.picker",
        "Automatic capture isn't available here. Choose a window instead.",
      )
    : translateDynamic(
        "settings.snapshot.description.default",
        "Capture a window and attach it to your current draft.",
      );
}

export function snapShotAccessibilityUnavailableMessage(
  state: DesktopSnapShotState | null,
): string | undefined {
  if (state?.mode !== "portal") return undefined;
  if (state.linuxBackend === "picker" || state.linuxBackend === "screenshot-portal")
    return translateDynamic(
      "settings.snapshot.accessibility.screenshotOnly",
      "This desktop only provides a screenshot.",
    );
  return undefined;
}

export function snapShotUnavailableMessage(hasBridge: boolean): string | undefined {
  if (hasBridge) return undefined;
  return typeof window !== "undefined" && window.desktopBridge
    ? translateDynamic(
        "settings.snapshot.unavailable.updateDesktop",
        "Update the desktop app to use snapshots.",
      )
    : translateDynamic(
        "settings.snapshot.unavailable.desktopOnly",
        "Only available in the desktop app.",
      );
}

export function snapShotSoundPatch(sound: SnapShotSoundSelection): ClientSettingsPatch {
  return sound === "off"
    ? { snapShotPlaySound: false }
    : { snapShotPlaySound: true, snapShotSound: sound };
}

export function createRecordingRequestTracker() {
  let currentRequest: symbol | null = null;

  return {
    tryBegin() {
      if (currentRequest) return null;
      currentRequest = Symbol();
      return currentRequest;
    },
    clear() {
      currentRequest = null;
    },
    owns(request: symbol) {
      return currentRequest === request;
    },
  };
}
