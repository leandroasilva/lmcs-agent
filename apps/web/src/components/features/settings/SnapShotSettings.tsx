import { useAtomValue } from "@effect/atom-react";
import {
  isModifierPairShortcut,
  type ClientSettingsPatch,
  type DesktopSnapShotShortcutAvailability,
  type DesktopSnapShotState,
  type DesktopSnapShotSetupAction,
  type SnapShotShortcut,
} from "@lmcstools/core";
import { PlayIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useClientSettings, useUpdateClientSettings } from "../../../hooks/useSettings";
import { getDesktopSnapShotBridge } from "../../../lib/desktopSnapShot";
import {
  readSnapShotSetupResume,
  saveSnapShotSetupResume,
  clearSnapShotSetupResume,
} from "../../../lib/snapShotSetupResume";
import { sameSnapShotShortcut, snapShotKeybindingConflict } from "../../../lib/snapShotShortcut";
import { playSnapShotSound } from "../../../lib/snapShotSound";
import { translateDynamic } from "../../../i18n";
import { primaryServerKeybindingsAtom } from "../../../state/server";
import { translatedCommandLabel } from "./KeybindingsSettings.logic";
import {
  snapShotStatus,
  snapShotShortcutStatus,
  snapShotSetupButtonLabel,
  snapShotUnavailableMessage,
  snapShotSoundPatch,
  snapShotFeedbackUnavailableMessage,
  snapShotDescription,
  snapShotAccessibilityUnavailableMessage,
  snapShotSetupComplete,
  type SnapShotSoundSelection,
} from "./SnapShotSettings.logic";
import {
  SettingsUnavailableGroup,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Button } from "../../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../../ui/menu";
import { SelectButton } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";
import { SnapShotSetupDialog } from "./SnapShotSetupDialog";
import { useSnapShotShortcutRecorder } from "./useSnapShotShortcutRecorder";
import {
  captureSetupAccessReady,
  captureSetupInitialStep,
  captureSetupShouldDisableOnClose,
  type CaptureSetupStep,
} from "./SnapShotSetupDialog.logic";

const soundOptionRowClassName = "grid grid-cols-[1fr_auto]";

function captureSettingsError(title: string, error: unknown) {
  return {
    title,
    message:
      error instanceof Error ? error.message : translateDynamic("common.tryAgain", "Try again."),
  };
}

type ShortcutCheck =
  | { readonly status: "idle"; readonly availability: null }
  | { readonly status: "checking"; readonly availability: null }
  | {
      readonly status: "checked";
      readonly availability: DesktopSnapShotShortcutAvailability;
    };

export function SnapShotSettings() {
  const { t } = useTranslation();
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const bridge = getDesktopSnapShotBridge();
  const [state, setState] = useState<DesktopSnapShotState | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<ReturnType<typeof captureSettingsError> | null>(
    null,
  );
  const [wizard, setWizard] = useState<{
    initialStep: CaptureSetupStep;
    wasEnabled: boolean;
  } | null>(null);
  const [candidate, setCandidate] = useState<SnapShotShortcut>(settings.snapShotShortcut);
  const [shortcutCheck, setShortcutCheck] = useState<ShortcutCheck>({
    status: "idle",
    availability: null,
  });
  const shortcutCheckIdRef = useRef(0);
  const stateRequestIdRef = useRef(0);
  const unavailableMessage = snapShotUnavailableMessage(Boolean(bridge));
  const captureAvailable = Boolean(bridge) && state !== null && state.mode !== "unavailable";
  const feedbackUnavailable = snapShotFeedbackUnavailableMessage(state);
  const savedShortcut = settings.snapShotShortcut;
  const managedShortcut = state?.linuxBackend === "niri" || state?.linuxBackend === "hyprland";
  const shortcutChanged = !managedShortcut && !sameSnapShotShortcut(candidate, savedShortcut);
  const displayShortcut = shortcutChanged ? candidate : (state?.shortcut ?? savedShortcut);
  const candidateConflict = shortcutChanged
    ? snapShotKeybindingConflict(candidate, keybindings)
    : null;
  const canSaveShortcut =
    shortcutChanged && candidateConflict === null && shortcutCheck.availability?.available === true;
  const soundSelection = settings.snapShotPlaySound ? settings.snapShotSound : "off";
  const soundLabel =
    soundSelection === "off"
      ? t("settings.snapshot.sound.off")
      : soundSelection === "soft-pop"
        ? t("settings.snapshot.sound.whooshDefault")
        : t("settings.snapshot.sound.click");

  const refreshState = useCallback(async () => {
    const requestId = ++stateRequestIdRef.current;
    try {
      if (bridge) {
        const nextState = await bridge.getSnapShotState();
        if (requestId === stateRequestIdRef.current) setState(nextState);
        return nextState;
      }
    } catch (error) {
      if (requestId === stateRequestIdRef.current)
        setSetupError(captureSettingsError(t("settings.snapshot.errors.checkSetup"), error));
    }
  }, [bridge, t]);

  const setup = useCallback(
    async (action: DesktopSnapShotSetupAction) => {
      if (!bridge?.setupSnapShot || setupBusy) return;
      setSetupBusy(true);
      setSetupError(null);
      try {
        if (
          state?.macPermissions &&
          wizard &&
          (action === "allow-screen-recording" || action === "allow-accessibility")
        ) {
          // macOS can quit the app from its permission prompt.
          saveSnapShotSetupResume(wizard.wasEnabled);
        }
        await bridge.setupSnapShot(action);
        await refreshState();
      } catch (error) {
        setSetupError(
          captureSettingsError(
            action === "retry-shortcut"
              ? t("settings.snapshot.errors.openShortcutPermissions")
              : t("settings.snapshot.errors.completeSetup"),
            error,
          ),
        );
      } finally {
        setSetupBusy(false);
      }
    },
    [bridge, refreshState, setupBusy, state, wizard, t],
  );

  useEffect(() => {
    if (!setupError || wizard) return;
    toastManager.add({
      type: "error",
      title: setupError.title,
      description: setupError.message,
    });
    setSetupError(null);
  }, [setupError, wizard]);

  useEffect(() => {
    let cancelled = false;
    void refreshState().then((current) => {
      const resume = readSnapShotSetupResume();
      if (!cancelled && current?.macPermissions && resume) {
        setWizard({ initialStep: "access", wasEnabled: resume.wasEnabled });
      }
    });
    window.addEventListener("focus", refreshState);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshState);
    };
  }, [refreshState]);

  useEffect(
    () =>
      bridge?.onSnapShotEvent((event) => {
        if (event.type === "shortcut-changed") void refreshState();
      }),
    [bridge, refreshState],
  );

  useEffect(() => {
    shortcutCheckIdRef.current++;
    setCandidate(savedShortcut);
    setShortcutCheck({ status: "idle", availability: null });
  }, [savedShortcut]);

  const save = useCallback(
    async (patch: ClientSettingsPatch) => {
      setSetupError(null);
      try {
        await updateSettings(patch);
        return await refreshState();
      } catch (error) {
        setSetupError(captureSettingsError(t("settings.snapshot.errors.saveSettings"), error));
      }
    },
    [refreshState, updateSettings, t],
  );

  const saveIncludeAccessibility = useCallback(
    async (includeAccessibility: boolean) => {
      try {
        if (includeAccessibility && settings.snapShotEnabled)
          await bridge?.requestSnapShotPermissions(true);
        await save({ snapShotIncludeAccessibility: includeAccessibility });
      } catch (error) {
        setSetupError(captureSettingsError(t("settings.snapshot.errors.allowTextCapture"), error));
      }
    },
    [bridge, save, settings.snapShotEnabled, t],
  );

  const checkShortcut = useCallback(
    async (shortcut: SnapShotShortcut) => {
      const checkId = ++shortcutCheckIdRef.current;
      setCandidate(shortcut);
      const conflict = snapShotKeybindingConflict(shortcut, keybindings);
      if (conflict || !bridge) return;
      setShortcutCheck({ status: "checking", availability: null });
      try {
        const availability = await bridge.checkSnapShotShortcut(shortcut);
        if (checkId === shortcutCheckIdRef.current) {
          setShortcutCheck({ status: "checked", availability });
        }
      } catch (error) {
        if (checkId !== shortcutCheckIdRef.current) return;
        setShortcutCheck({
          status: "checked",
          availability: {
            available: false,
            message:
              error instanceof Error ? error.message : t("settings.snapshot.errors.checkShortcut"),
          },
        });
      }
    },
    [bridge, keybindings, t],
  );

  const {
    recording,
    stopRecording,
    input: shortcutInput,
  } = useSnapShotShortcutRecorder({
    shortcut: displayShortcut,
    shortcutLabel: !shortcutChanged ? state?.shortcutLabel : undefined,
    disabled: setupBusy,
    allowModifierPairs: state?.mode !== "portal",
    onRecord: (shortcut) => void checkShortcut(shortcut),
    onStart: () => {
      shortcutCheckIdRef.current++;
      setShortcutCheck({ status: "idle", availability: null });
    },
    onError: (message) =>
      setShortcutCheck({
        status: "checked",
        availability: { available: false, message },
      }),
  });

  const shortcutStatus = recording
    ? t("settings.snapshot.shortcut.press")
    : candidateConflict
      ? t("settings.snapshot.shortcut.conflict", {
          command: translatedCommandLabel(candidateConflict),
        })
      : shortcutCheck.status === "checking"
        ? t("settings.snapshot.shortcut.checking")
        : shortcutCheck.availability
          ? shortcutCheck.availability.available
            ? t("settings.snapshot.shortcut.readyToSave")
            : shortcutCheck.availability.message
          : state?.mode === "portal" &&
              !state.shortcutLabel &&
              isModifierPairShortcut(displayShortcut)
            ? t("settings.snapshot.shortcut.tryModifier")
            : snapShotShortcutStatus(state);

  const openSetup = async (requested: CaptureSetupStep | "resume" = "resume") => {
    if (!state || setupBusy) return;
    stopRecording();
    shortcutCheckIdRef.current++;
    setCandidate(savedShortcut);
    setShortcutCheck({ status: "idle", availability: null });
    setSetupError(null);
    setSetupBusy(true);
    try {
      let current = await refreshState();
      if (!current) return;
      if (current.macPermissions) requested = "access";
      if (!settings.snapShotEnabled && captureSetupInitialStep(current, requested) !== "access") {
        // Opening setup is the opt-in. Restore registration before resuming a
        // later step, just as Continue does on the access step.
        current = await save({ snapShotEnabled: true });
        if (!current) {
          // A settings write can succeed even if the following status check
          // fails. Keep Finish later available to turn capture back off.
          setWizard({ initialStep: "access", wasEnabled: false });
          return;
        }
      }
      setWizard({
        initialStep: captureSetupInitialStep(current, requested),
        wasEnabled: settings.snapShotEnabled,
      });
    } finally {
      setSetupBusy(false);
    }
  };

  const enableForSetup = async () => {
    if (setupBusy) return false;
    setSetupBusy(true);
    setSetupError(null);
    try {
      if (state?.macPermissions) {
        saveSnapShotSetupResume(wizard?.wasEnabled ?? settings.snapShotEnabled);
        if (!bridge?.setupSnapShot) throw new Error(t("settings.snapshot.errors.restartToFinish"));
        await bridge.setupSnapShot("test-mac-capture");
      }
      if (state?.mode === "direct")
        await bridge?.requestSnapShotPermissions(settings.snapShotIncludeAccessibility);
      const nextState =
        settings.snapShotEnabled && !state?.message
          ? await refreshState()
          : await save({ snapShotEnabled: true });
      return nextState !== undefined && captureSetupAccessReady(nextState);
    } catch (error) {
      setSetupError(captureSettingsError(t("settings.snapshot.errors.verifyAccess"), error));
      return false;
    } finally {
      setSetupBusy(false);
    }
  };

  const closeSetup = async (completed: boolean) => {
    if (!wizard || setupBusy) return;
    setSetupBusy(true);
    try {
      if (
        settings.snapShotEnabled &&
        captureSetupShouldDisableOnClose(wizard.wasEnabled, completed)
      ) {
        if (!(await save({ snapShotEnabled: false }))) return;
      }
      stopRecording();
      setSetupError(null);
      clearSnapShotSetupResume();
      setWizard(null);
    } catch (error) {
      setSetupError(captureSettingsError(t("settings.snapshot.errors.closeSetup"), error));
    } finally {
      setSetupBusy(false);
    }
  };

  const saveShortcut = async () => {
    if (!canSaveShortcut || setupBusy) return false;
    setSetupBusy(true);
    try {
      const saved = await save({ snapShotShortcut: candidate });
      return Boolean(saved?.shortcutRegistered || saved?.shortcutPending);
    } finally {
      setSetupBusy(false);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection id="snap-shot" title={t("settings.sections.snap-shot")}>
        <SettingsUnavailableGroup message={unavailableMessage}>
          <SettingsRow
            {...searchableSetting("snap-shot-enabled")}
            description={snapShotDescription(state)}
            status={
              bridge
                ? setupBusy && !wizard
                  ? t("settings.snapshot.updating")
                  : snapShotStatus(state, settings.snapShotEnabled)
                : undefined
            }
            control={
              <>
                {settings.snapShotEnabled &&
                !snapShotSetupComplete(state, settings.snapShotIncludeAccessibility) ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={setupBusy}
                    onClick={() => void openSetup()}
                  >
                    {snapShotSetupButtonLabel(state)}
                  </Button>
                ) : null}
                <Switch
                  checked={settings.snapShotEnabled || Boolean(wizard)}
                  disabled={!captureAvailable || setupBusy}
                  aria-label={t("settings.snapshot.enableAria")}
                  onCheckedChange={(checked) => {
                    if (!checked) void save({ snapShotEnabled: false });
                    else if (state?.windows) void save({ snapShotEnabled: true });
                    else void openSetup();
                  }}
                />
              </>
            }
          />
          {settings.snapShotEnabled && captureAvailable ? (
            <>
              <SettingsRow
                {...searchableSetting("snap-shot-accessibility")}
                description={t("settings.snapshot.accessibility.description")}
                status={snapShotAccessibilityUnavailableMessage(state)}
                control={
                  <Switch
                    checked={
                      !snapShotAccessibilityUnavailableMessage(state) &&
                      settings.snapShotIncludeAccessibility
                    }
                    disabled={
                      !captureAvailable || Boolean(snapShotAccessibilityUnavailableMessage(state))
                    }
                    aria-label={t("settings.snapshot.accessibility.aria")}
                    onCheckedChange={(checked) => void saveIncludeAccessibility(checked)}
                  />
                }
              />
              <SettingsRow
                {...searchableSetting("snap-shot-shortcut")}
                description={
                  state?.linuxBackend === "picker"
                    ? t("settings.snapshot.shortcut.descriptionPicker")
                    : t("settings.snapshot.shortcut.descriptionDefault")
                }
                status={managedShortcut ? undefined : shortcutStatus}
                control={
                  managedShortcut ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={setupBusy}
                      onClick={() => void openSetup("shortcut")}
                    >
                      {t("settings.snapshot.shortcut.change")}
                    </Button>
                  ) : (
                    <>
                      {shortcutInput}
                      {shortcutChanged ? (
                        <>
                          <Button
                            size="xs"
                            disabled={!canSaveShortcut || setupBusy}
                            onClick={() => void saveShortcut()}
                          >
                            {setupBusy
                              ? t("settings.snapshot.saving")
                              : t("settings.snapshot.save")}
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={setupBusy}
                            onClick={() => {
                              stopRecording();
                              shortcutCheckIdRef.current++;
                              setCandidate(savedShortcut);
                              setShortcutCheck({
                                status: "idle",
                                availability: null,
                              });
                            }}
                          >
                            {t("common.cancel")}
                          </Button>
                        </>
                      ) : state?.mode === "portal" &&
                        state.shortcutCanRetry !== false &&
                        !isModifierPairShortcut(savedShortcut) ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={setupBusy || state.shortcutPending}
                          onClick={() => void setup("retry-shortcut")}
                        >
                          {t("settings.snapshot.shortcut.permissions")}
                        </Button>
                      ) : null}
                    </>
                  )
                }
              />
              <SettingsRow
                {...searchableSetting("snap-shot-sound")}
                description={t("settings.snapshot.sound.description")}
                control={
                  <Menu>
                    <MenuTrigger
                      aria-label={t("settings.snapshot.sound.aria", {
                        label: soundLabel,
                      })}
                      render={<SelectButton size="sm" />}
                      className="w-auto min-w-0"
                      disabled={!captureAvailable}
                    >
                      {soundSelection === "off" ? (
                        t("settings.snapshot.sound.off")
                      ) : soundSelection === "soft-pop" ? (
                        <>
                          {t("settings.snapshot.sound.whoosh")}{" "}
                          <span className="text-muted-foreground">
                            {t("settings.snapshot.sound.defaultSuffix")}
                          </span>
                        </>
                      ) : (
                        t("settings.snapshot.sound.click")
                      )}
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuRadioGroup
                        onValueChange={(value) =>
                          void save(snapShotSoundPatch(value as SnapShotSoundSelection))
                        }
                        value={soundSelection}
                      >
                        <MenuRadioItem closeOnClick value="off">
                          {t("settings.snapshot.sound.off")}
                        </MenuRadioItem>
                        <div className={soundOptionRowClassName}>
                          <MenuRadioItem closeOnClick value="soft-pop">
                            {t("settings.snapshot.sound.whoosh")}{" "}
                            <span className="text-muted-foreground">
                              {t("settings.snapshot.sound.defaultSuffix")}
                            </span>
                          </MenuRadioItem>
                          <MenuItem
                            aria-label={t("settings.snapshot.sound.playWhoosh")}
                            closeOnClick={false}
                            onClick={() => playSnapShotSound("soft-pop")}
                          >
                            <PlayIcon />
                          </MenuItem>
                        </div>
                        <div className={soundOptionRowClassName}>
                          <MenuRadioItem closeOnClick value="camera-shutter">
                            {t("settings.snapshot.sound.click")}
                          </MenuRadioItem>
                          <MenuItem
                            aria-label={t("settings.snapshot.sound.playClick")}
                            closeOnClick={false}
                            onClick={() => playSnapShotSound("camera-shutter")}
                          >
                            <PlayIcon />
                          </MenuItem>
                        </div>
                      </MenuRadioGroup>
                    </MenuPopup>
                  </Menu>
                }
              />
              <SettingsRow
                {...searchableSetting("snap-shot-flash")}
                description={t("settings.snapshot.flash.description")}
                status={feedbackUnavailable}
                control={
                  <Switch
                    checked={!feedbackUnavailable && settings.snapShotFlash}
                    disabled={!captureAvailable || Boolean(feedbackUnavailable)}
                    aria-label={t("settings.snapshot.flash.aria")}
                    onCheckedChange={(checked) => void save({ snapShotFlash: checked })}
                  />
                }
              />
              <SettingsRow
                {...searchableSetting("snap-shot-animations")}
                description={t("settings.snapshot.animations.description")}
                status={feedbackUnavailable}
                control={
                  <Switch
                    checked={!feedbackUnavailable && settings.snapShotAnimations}
                    disabled={!captureAvailable || Boolean(feedbackUnavailable)}
                    aria-label={t("settings.snapshot.animations.aria")}
                    onCheckedChange={(checked) => void save({ snapShotAnimations: checked })}
                  />
                }
              />
            </>
          ) : null}
        </SettingsUnavailableGroup>
      </SettingsSection>
      {wizard && state ? (
        <SnapShotSetupDialog
          state={state}
          initialStep={wizard.initialStep}
          wasEnabled={wizard.wasEnabled}
          includeAccessibility={settings.snapShotIncludeAccessibility}
          busy={setupBusy}
          error={setupError?.message ?? null}
          shortcutInput={shortcutInput}
          shortcutStatus={shortcutStatus}
          shortcutChanged={shortcutChanged}
          canSaveShortcut={canSaveShortcut}
          onSaveShortcut={saveShortcut}
          onEnable={enableForSetup}
          onAction={setup}
          onRefresh={refreshState}
          onClose={closeSetup}
          onLeaveStep={stopRecording}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
