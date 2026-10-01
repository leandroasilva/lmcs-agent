import { PermissionChecklist, PermissionContinueButton } from "../permissions/PermissionChecklist";
import { usePermissionStatus } from "../permissions/usePermissionStatus";
import {
  isModifierPairShortcut,
  type DesktopSnapShotSetupAction,
  type DesktopSnapShotState,
} from "@lmcstools/core";
import { useState, type ReactNode } from "react";
import { MacAccessibilityIcon, MacScreenRecordingIcon } from "../../shared/Icons";
import { CaptureShortcutConfig } from "./CaptureShortcutConfig";
import { Button } from "../../ui/button";
import { Dialog, DialogDescription } from "../../ui/dialog";
import { WizardSteps, WizardPopup, WizardHeader, WizardPanel, WizardFooter } from "../../ui/wizard";
import {
  captureSetupAccessReady,
  captureSetupBackend,
  captureSetupCheckMessage,
  captureSetupDesktopName,
  captureSetupInitialStep,
  captureSetupShortcutReady,
  type CaptureSetupStep,
} from "./SnapShotSetupDialog.logic";
import { useTranslation } from "react-i18next";
import "../../../i18n";

const SETUP_STEPS = [{ id: "access" }, { id: "shortcut" }] as const;

export function SnapShotSetupDialog({
  state,
  initialStep,
  wasEnabled,
  includeAccessibility,
  busy: actionBusy,
  error,
  shortcutInput,
  shortcutStatus,
  shortcutChanged,
  canSaveShortcut,
  onSaveShortcut,
  onEnable,
  onAction,
  onRefresh,
  onClose,
  onLeaveStep,
}: {
  state: DesktopSnapShotState;
  initialStep: CaptureSetupStep;
  wasEnabled: boolean;
  includeAccessibility: boolean;
  busy: boolean;
  error: string | null;
  shortcutInput: ReactNode;
  shortcutStatus: string | null | undefined;
  shortcutChanged: boolean;
  canSaveShortcut: boolean;
  onSaveShortcut: () => Promise<boolean>;
  onEnable: () => Promise<boolean>;
  onAction: (action: DesktopSnapShotSetupAction) => Promise<void>;
  onRefresh: () => Promise<DesktopSnapShotState | undefined>;
  onClose: (completed: boolean) => Promise<void>;
  onLeaveStep: () => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState(() => captureSetupInitialStep(state, initialStep));
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const busy = actionBusy || checking || configBusy;
  const backend = captureSetupBackend(state);
  const configShortcut = backend === "niri" || backend === "hyprland";
  const desktop = captureSetupDesktopName(state);
  const extension = state.gnomeExtension;
  const helper = backend === "hyprland" ? state.hyprlandHelper : state.kdeHelper;
  const helperBackend = backend === "kde" || backend === "hyprland";
  const installHelper = backend === "hyprland" ? "install-hyprland-helper" : "install-kde-helper";
  const removeHelper = backend === "hyprland" ? "remove-hyprland-helper" : "remove-kde-helper";
  const accessReady = captureSetupAccessReady(state);
  const permissionStatus = usePermissionStatus(
    async () => {
      const refreshed = await onRefresh();
      if (!refreshed?.macPermissions) throw new Error("Permission status unavailable");
      return refreshed.macPermissions;
    },
    state.macPermissions ?? { screenRecording: false, accessibility: false },
    Boolean(state.macPermissions) && step === "access" && !busy,
  );
  const macPermissions = state.macPermissions ? permissionStatus.status : undefined;
  const macPermissionsReady =
    !macPermissions ||
    permissionStatus.isReady(
      includeAccessibility ? ["screenRecording", "accessibility"] : ["screenRecording"],
    );
  const shortcutReady = captureSetupShortcutReady(state, shortcutChanged);
  const install = extension?.status === "not-installed" || extension?.status === "update-required";
  const enable = extension?.status === "disabled";
  const changeStep = (next: CaptureSetupStep) => {
    onLeaveStep();
    setChecked(false);
    setStep(next);
  };
  const checkAgain = async () => {
    if (busy) return;
    setChecking(true);
    setChecked(false);
    try {
      setChecked((await onRefresh()) !== undefined);
    } finally {
      setChecking(false);
    }
  };
  const accessCopy =
    state.message && !macPermissions
      ? {
          title: t("settings.snapshot.setup.access.retry.title"),
          description: t("settings.snapshot.setup.access.retry.description"),
        }
      : backend === "gnome" && extension
        ? extension.status === "enabled" && !accessReady
          ? {
              title: t("settings.snapshot.setup.access.extensionNotReady.title"),
              description: t("settings.snapshot.setup.access.extensionNotReady.description"),
            }
          : {
              title: t(`settings.snapshot.setup.gnome.${extension.status}.title`),
              description: t(`settings.snapshot.setup.gnome.${extension.status}.description`),
            }
        : helperBackend
          ? helper?.status === "ready"
            ? {
                title: t("settings.snapshot.setup.access.ready.title"),
                description: t("settings.snapshot.setup.access.ready.description"),
              }
            : helper?.status === "error"
              ? {
                  title: t("settings.snapshot.setup.access.helperError.title"),
                  description: t("settings.snapshot.setup.access.helperError.description"),
                }
              : {
                  title:
                    helper?.status === "update-required"
                      ? t("settings.snapshot.setup.access.helperUpdate.title")
                      : t("settings.snapshot.setup.access.allowHelper.title"),
                  description: t("settings.snapshot.setup.access.allowHelper.description"),
                }
          : backend === "niri"
            ? {
                title: t("settings.snapshot.setup.access.ready.title"),
                description: t("settings.snapshot.setup.access.ready.description"),
              }
            : backend === "picker"
              ? {
                  title: t("settings.snapshot.setup.access.picker.title"),
                  description: t("settings.snapshot.setup.access.picker.description"),
                }
              : {
                  title: t("settings.snapshot.setup.access.allow.title"),
                  description:
                    backend === "portal"
                      ? t("settings.snapshot.setup.access.allow.descriptionPortal")
                      : macPermissions
                        ? macPermissionsReady
                          ? t("settings.snapshot.setup.access.allow.descriptionMacReady")
                          : t("settings.snapshot.setup.access.allow.descriptionMacPending")
                        : t("settings.snapshot.setup.access.allow.description"),
                };
  const title = step === "access" ? accessCopy.title : t("settings.snapshot.setup.shortcut.title");
  const description =
    step === "access"
      ? accessCopy.description
      : configShortcut
        ? t("settings.snapshot.setup.shortcut.descriptionConfig")
        : state.mode === "portal"
          ? t("settings.snapshot.setup.shortcut.descriptionPortal")
          : t("settings.snapshot.setup.shortcut.descriptionDirect");
  const stepIndex = SETUP_STEPS.findIndex(({ id }) => id === step);
  const details = [
    ...new Set(
      [
        error,
        ...(step === "access"
          ? [
              state.message,
              backend === "gnome" &&
              (extension?.status === "error" || extension?.status === "unsupported")
                ? extension.message
                : null,
              helperBackend && helper?.status === "error" ? helper.message : null,
            ]
          : []),
      ].filter((detail) => detail !== null),
    ),
  ];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) void onClose(false);
      }}
    >
      <WizardPopup showCloseButton={!busy}>
        <WizardHeader
          title={
            desktop
              ? t("settings.snapshot.setup.headerForDesktop", { desktop })
              : t("settings.snapshot.setup.header")
          }
        >
          <WizardSteps
            steps={SETUP_STEPS.map((item) => t(`settings.snapshot.setup.steps.${item.id}`))}
            currentStep={stepIndex}
            isStepDisabled={(index) => busy || index > stepIndex}
            onStepChange={(index) => {
              const next = SETUP_STEPS[index];
              if (next && next.id !== step) changeStep(next.id);
            }}
          />
        </WizardHeader>
        <WizardPanel>
          <div className="space-y-4 text-sm">
            <div className="space-y-2" aria-live="polite">
              <h3 className="flex items-center gap-2 font-medium">{title}</h3>
              <DialogDescription>{description}</DialogDescription>
            </div>
            {step === "access" ? (
              <>
                <p
                  role="status"
                  aria-atomic="true"
                  className={
                    checked && !busy && !error ? "text-xs text-muted-foreground" : "sr-only"
                  }
                >
                  {checked && !busy && !error ? captureSetupCheckMessage(state) : null}
                </p>
                {macPermissions ? (
                  <PermissionChecklist
                    busy={busy}
                    permissions={[
                      {
                        id: "screenRecording",
                        icon: <MacScreenRecordingIcon className="size-8 shrink-0 drop-shadow-sm" />,
                        title: t("settings.snapshot.setup.permissions.screenRecording.title"),
                        description: t(
                          "settings.snapshot.setup.permissions.screenRecording.description",
                        ),
                        granted: macPermissions.screenRecording,
                        onAllow: () => void onAction("allow-screen-recording"),
                      },
                      {
                        id: "accessibility",
                        icon: <MacAccessibilityIcon className="size-8 shrink-0 drop-shadow-sm" />,
                        title: t("settings.snapshot.setup.permissions.accessibility.title"),
                        description: includeAccessibility
                          ? t("settings.snapshot.setup.permissions.accessibility.description")
                          : t(
                              "settings.snapshot.setup.permissions.accessibility.descriptionOptional",
                            ),
                        granted: macPermissions.accessibility,
                        onAllow: () => void onAction("allow-accessibility"),
                      },
                    ]}
                  />
                ) : null}
                {permissionStatus.error && macPermissions ? (
                  <p role="status" className="text-xs text-muted-foreground">
                    {permissionStatus.error}
                  </p>
                ) : null}
                {helperBackend && helper?.status === "error" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void onAction(installHelper)}
                  >
                    {t("settings.snapshot.setup.helperReinstall")}
                  </Button>
                ) : null}
              </>
            ) : configShortcut ? (
              <CaptureShortcutConfig
                state={state}
                disabled={actionBusy || checking || !accessReady}
                onBusyChange={setConfigBusy}
                onSaved={onRefresh}
                onComplete={() => onClose(true)}
              />
            ) : (
              <div className="space-y-3">
                {shortcutInput}
                {shortcutStatus ? (
                  <p className="text-xs text-muted-foreground" role="status">
                    {shortcutStatus}
                  </p>
                ) : null}
                {!shortcutChanged &&
                !state.shortcutRegistered &&
                !state.shortcutPending &&
                state.shortcutCanRetry !== false &&
                !isModifierPairShortcut(state.shortcut) ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void onAction("retry-shortcut")}
                  >
                    {state.mode === "portal"
                      ? t("settings.snapshot.shortcut.permissions")
                      : t("settings.snapshot.setup.tryAgain")}
                  </Button>
                ) : null}
              </div>
            )}
            {step === "shortcut" && !accessReady ? (
              <p role="alert" className="text-destructive">
                {t("settings.snapshot.setup.needsAttention")}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive">
                {t("settings.snapshot.setup.stepFailed")}
              </p>
            ) : null}
            {details.length > 0 || (step === "access" && (backend === "gnome" || helperBackend)) ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t("common.advanced")}</summary>
                <div className="mt-3 space-y-3">
                  {details.map((detail) => (
                    <p key={detail} className="break-words">
                      {detail}
                    </p>
                  ))}
                  {step === "access" && (backend === "gnome" || helperBackend) ? (
                    <p>{t("settings.snapshot.setup.includedNote")}</p>
                  ) : null}
                  {step === "access" && backend === "gnome" && extension?.status === "enabled" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void onAction("disable-extension")}
                    >
                      {t("settings.snapshot.setup.disableExtension")}
                    </Button>
                  ) : null}
                  {step === "access" && helperBackend && helper?.status !== "not-installed" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void onAction(removeHelper)}
                    >
                      {t("settings.snapshot.setup.removeHelper")}
                    </Button>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
        </WizardPanel>
        <WizardFooter>
          {step !== "access" ? (
            <Button variant="ghost" disabled={busy} onClick={() => changeStep("access")}>
              {t("common.back")}
            </Button>
          ) : null}
          <Button variant="ghost" disabled={busy} onClick={() => void onClose(false)}>
            {wasEnabled ? t("common.close") : t("settings.snapshot.setup.finishLater")}
          </Button>
          {step === "access" ? (
            helperBackend && !accessReady && helper?.status !== "ready" ? (
              <Button
                disabled={busy}
                aria-busy={busy}
                onClick={() =>
                  void (helper?.status === "error" ? checkAgain() : onAction(installHelper))
                }
              >
                {checking
                  ? t("settings.snapshot.setup.checking")
                  : busy
                    ? t("settings.snapshot.setup.installing")
                    : helper?.status === "error"
                      ? t("settings.snapshot.setup.checkAgain")
                      : helper?.status === "update-required"
                        ? t("settings.snapshot.setup.updateHelper")
                        : t("settings.snapshot.setup.installHelper")}
              </Button>
            ) : backend === "gnome" && !accessReady && extension?.status !== "enabled" ? (
              <Button
                disabled={busy}
                aria-busy={checking}
                onClick={() =>
                  void (install
                    ? onAction("install-extension")
                    : enable
                      ? onAction("enable-extension")
                      : checkAgain())
                }
              >
                {checking
                  ? t("settings.snapshot.setup.checking")
                  : busy
                    ? install
                      ? t("settings.snapshot.setup.installing")
                      : enable
                        ? t("settings.snapshot.setup.enabling")
                        : t("settings.snapshot.setup.working")
                    : install
                      ? extension?.status === "update-required"
                        ? t("settings.snapshot.setup.updateExtension")
                        : t("settings.snapshot.setup.installExtension")
                      : enable
                        ? t("settings.snapshot.setup.enableExtension")
                        : t("settings.snapshot.setup.checkAgain")}
              </Button>
            ) : (
              <PermissionContinueButton
                ready={macPermissionsReady}
                busy={busy}
                onClick={async () => {
                  if (await onEnable()) changeStep("shortcut");
                }}
              >
                {busy
                  ? t("settings.snapshot.setup.working")
                  : macPermissions
                    ? t("settings.snapshot.setup.testCaptureContinue")
                    : backend === "direct"
                      ? t("settings.snapshot.setup.allowCapture")
                      : !accessReady && !macPermissions
                        ? t("settings.snapshot.setup.tryAgain")
                        : t("common.continue")}
              </PermissionContinueButton>
            )
          ) : !configShortcut ? (
            <Button
              disabled={
                busy || !accessReady || (shortcutChanged ? !canSaveShortcut : !shortcutReady)
              }
              onClick={async () => {
                if (!shortcutChanged || (await onSaveShortcut())) await onClose(true);
              }}
            >
              {busy
                ? t("common.saving")
                : shortcutChanged
                  ? t("settings.snapshot.setup.saveAndFinish")
                  : t("common.done")}
            </Button>
          ) : null}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
