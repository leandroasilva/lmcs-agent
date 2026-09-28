import {
  isModifierPairShortcut,
  type DesktopCaptureConfigApplied,
  type DesktopCaptureConfigPreview,
  type DesktopSnapShotState,
} from "@lmcstools/core";
import { parseKeybindingShortcut } from "@lmcstools/core/keybindings";
import { FileDiff } from "@pierre/diffs/react";
import { parseDiffFromFile } from "@pierre/diffs";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import "../../../i18n";
import { getDesktopSnapShotBridge } from "../../../lib/desktopSnapShot";
import { resolveDiffThemeName } from "../../../lib/diffRendering";
import { useTheme } from "../../../hooks/useTheme";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { shortcutToKeybindingInput } from "./KeybindingsSettings.logic";
import { useSnapShotShortcutRecorder } from "./useSnapShotShortcutRecorder";

const DEFAULT_SHORTCUT = parseKeybindingShortcut("Ctrl+Shift+2")!;

/** Wizard-owned config review; config contents never leave the desktop bridge. */
export function CaptureShortcutConfig({
  state,
  disabled = false,
  onBusyChange,
  onSaved,
  onComplete,
}: {
  state: DesktopSnapShotState;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onSaved?: () => Promise<unknown>;
  onComplete?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const bridge = getDesktopSnapShotBridge();
  const { resolvedTheme } = useTheme();
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const [preview, setPreview] = useState<DesktopCaptureConfigPreview | null>(null);
  const [result, setResult] = useState<DesktopCaptureConfigApplied | null>(null);
  const [error, setError] = useState<{
    message: string;
    detail?: string;
  } | null>(null);
  const [working, setWorking] = useState<"reading" | "writing" | null>(null);
  const [keys, setKeys] = useState<string | null>(null);
  const [customFile, setCustomFile] = useState(false);
  const busy = disabled || working !== null;
  const supported = Boolean(bridge?.previewSnapShotConfig && bridge.applySnapShotConfig);
  const changed = preview !== null && preview.before !== preview.after;
  const niri = state.linuxBackend === "niri";
  const desktop = niri ? "Niri" : "Hyprland";
  const shortcutKeys = (keys ?? preview?.shortcut)?.trim();
  const recorder = useSnapShotShortcutRecorder({
    shortcut: shortcutKeys
      ? (parseKeybindingShortcut(shortcutKeys.replace(/super/gi, "meta")) ?? DEFAULT_SHORTCUT)
      : DEFAULT_SHORTCUT,
    disabled: busy,
    allowModifierPairs: false,
    onStart: () => setError(null),
    onError: (message) => setError({ message }),
    onRecord: (shortcut) => {
      if (isModifierPairShortcut(shortcut)) return;
      setKeys(
        shortcutToKeybindingInput({
          ...shortcut,
          ctrlKey: shortcut.ctrlKey || shortcut.modKey,
          modKey: false,
        }),
      );
      setPreview(null);
      setError(null);
    },
  });
  const actionBusy = busy || recorder.recording;
  const diff = useMemo(
    () =>
      preview && changed
        ? parseDiffFromFile(
            { name: preview.path, contents: preview.before },
            { name: preview.path, contents: preview.after },
          )
        : null,
    [preview, changed],
  );
  const begin = (phase: "reading" | "writing") => {
    setWorking(phase);
    onBusyChange?.(true);
    setError(null);
  };
  const end = () => {
    setWorking(null);
    onBusyChange?.(false);
  };
  const read = async (chooseFile = customFile, operation: "install" | "remove" = "install") => {
    if (actionBusy || !bridge?.previewSnapShotConfig) return;
    begin("reading");
    setPreview(null);
    setResult(null);
    setCustomFile(chooseFile);
    try {
      setPreview(
        await bridge.previewSnapShotConfig({
          operation,
          chooseFile,
          ...(keys?.trim() ? { shortcut: keys.trim() } : {}),
        }),
      );
    } catch (cause) {
      setError({
        message: t("settings.snapshot.config.errorPrepare"),
        ...(cause instanceof Error ? { detail: cause.message } : {}),
      });
    } finally {
      end();
    }
  };
  const apply = async () => {
    if (actionBusy || !preview || !bridge?.applySnapShotConfig) return;
    begin("writing");
    try {
      const applied = await bridge.applySnapShotConfig(preview.id);
      setResult(applied);
      await onSaved?.();
      if (!applied.warning && preview.operation === "install" && onComplete) {
        toastManager.add({
          type: "success",
          title: "Shortcut saved",
          description: `Use ${preview.shortcut} from another app.`,
        });
        await onComplete();
      }
    } catch (cause) {
      setError({
        message: t("settings.snapshot.config.errorSave"),
        ...(cause instanceof Error ? { detail: cause.message } : {}),
      });
      setPreview(null);
    } finally {
      end();
    }
  };

  return (
    <div className="space-y-4 text-sm">
      {!result ? (
        <div className="flex items-center justify-between gap-3">
          <span>{t("settings.snapshot.config.shortcutLabel")}</span>
          {recorder.input}
        </div>
      ) : null}
      {recorder.recording ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("settings.snapshot.config.pressHint")}
        </p>
      ) : null}
      {result ? (
        <p role="status">
          {result.warning
            ? t("settings.snapshot.config.savedWithWarning")
            : preview?.operation === "remove"
              ? t("settings.snapshot.config.removed")
              : t("settings.snapshot.config.savedUse", {
                  shortcut: preview?.shortcut,
                })}
        </p>
      ) : preview ? (
        <>
          <p className="text-muted-foreground">
            {changed
              ? preview.operation === "remove"
                ? t("settings.snapshot.config.reviewRemove")
                : t("settings.snapshot.config.reviewSave")
              : preview.operation === "remove"
                ? t("settings.snapshot.config.nothingToRemove")
                : t("settings.snapshot.config.alreadySetUp")}
          </p>
          {diff ? (
            <div
              className="max-h-80 overflow-auto rounded-lg border text-xs"
              aria-label={t("settings.snapshot.config.changesAria")}
            >
              <FileDiff
                fileDiff={diff}
                options={{
                  diffStyle: "unified",
                  theme: resolveDiffThemeName(resolvedTheme),
                  overflow: "wrap",
                }}
              />
            </div>
          ) : null}
          {changed ? (
            <p className="text-xs text-muted-foreground">
              {t("settings.snapshot.config.onlyChanges")}
            </p>
          ) : null}
          <div className="flex gap-2">
            {changed || preview.operation === "install" ? (
              <Button
                disabled={
                  actionBusy ||
                  (preview.operation === "install" && state.shortcutActionRegistered === false)
                }
                aria-busy={working === "writing"}
                onClick={() => void apply()}
              >
                {working === "writing"
                  ? t("common.saving")
                  : changed
                    ? preview.operation === "install"
                      ? t("settings.snapshot.config.saveShortcut")
                      : t("settings.snapshot.config.removeShortcut")
                    : t("common.done")}
              </Button>
            ) : null}
            <Button variant="ghost" disabled={actionBusy} onClick={() => setPreview(null)}>
              {t("common.cancel")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground">{t("settings.snapshot.config.intro")}</p>
          <Button
            disabled={actionBusy || !supported}
            aria-busy={working === "reading"}
            onClick={() => void read()}
          >
            {working === "reading"
              ? t("settings.snapshot.config.preparing")
              : t("settings.snapshot.config.reviewChanges")}
          </Button>
          {!supported ? (
            <p className="text-xs text-muted-foreground">
              {t("settings.snapshot.config.updateRequired")}
            </p>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="text-destructive">
          {error.message}
        </p>
      ) : null}
      {state.shortcutActionRegistered === false && state.shortcutMessage ? (
        <p role="status" className="text-muted-foreground">
          {state.shortcutPending
            ? t("settings.snapshot.config.connecting")
            : t("settings.snapshot.config.restartRequired")}
        </p>
      ) : null}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{t("common.advanced")}</summary>
        <div className="mt-3 space-y-3">
          {error?.detail || result?.warning ? (
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                {t("settings.snapshot.config.troubleshooting")}
              </p>
              <p className="break-words">{error?.detail ?? result?.warning}</p>
            </div>
          ) : null}
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              {t("settings.snapshot.config.settingsFile")}
            </p>
            <p className="break-all font-mono">
              {preview?.path ??
                state.shortcutConfigPath ??
                (niri ? "~/.config/niri/config.kdl" : "~/.config/hypr/hyprland.conf")}
            </p>
            {niri ? <p>{t("settings.snapshot.config.includedFilesNote")}</p> : null}
            {preview && preview.resolvedPath !== preview.path ? (
              <p className="break-all">
                {t("settings.snapshot.config.linkedTo", {
                  path: preview.resolvedPath,
                })}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={actionBusy || !supported}
              onClick={() => void read(true)}
            >
              {t("settings.snapshot.config.chooseDifferentFile")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={actionBusy || !supported}
              onClick={() => void read(customFile, "remove")}
            >
              {t("settings.snapshot.config.removeShortcutEllipsis")}
            </Button>
            {result ? (
              <Button
                size="sm"
                variant="outline"
                disabled={actionBusy || !supported}
                onClick={() => void read()}
              >
                {t("settings.snapshot.config.reviewChanges")}
              </Button>
            ) : null}
          </div>
          <p>
            {t("settings.snapshot.config.useDesktopFile")}{" "}
            {niri
              ? t("settings.snapshot.config.customConfigNote")
              : t("settings.snapshot.config.omarchyNote")}
          </p>
          {result?.backupPath ? (
            <p className="break-all">
              {t("settings.snapshot.config.backupLine", {
                path: result.backupPath,
              })}
            </p>
          ) : null}
          <p className="font-medium text-foreground">{t("settings.snapshot.config.manualSetup")}</p>
          <p>
            {niri
              ? t("settings.snapshot.config.manualNiri")
              : t("settings.snapshot.config.manualHyprland")}{" "}
            {t("settings.snapshot.config.manualChangeKeys")}
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted/50 p-3">
            {state.shortcutBinding}
          </pre>
          <Button
            size="sm"
            variant="outline"
            disabled={actionBusy || !state.shortcutBinding}
            onClick={() => {
              if (state.shortcutBinding) copyToClipboard(state.shortcutBinding);
            }}
          >
            {isCopied
              ? t("settings.snapshot.config.copied")
              : t("settings.snapshot.config.copyShortcut")}
          </Button>
          <p>{t("settings.snapshot.config.turnOffNote", { desktop })}</p>
          {state.shortcutActionRegistered === false ? (
            <p role="status">{state.shortcutMessage}</p>
          ) : null}
          {onComplete ? (
            <Button
              size="sm"
              variant="outline"
              disabled={actionBusy || state.shortcutActionRegistered === false}
              onClick={() => void onComplete()}
            >
              {t("settings.snapshot.config.addedShortcut")}
            </Button>
          ) : null}
        </div>
      </details>
    </div>
  );
}
