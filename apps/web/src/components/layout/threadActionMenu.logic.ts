import type { ContextMenuItem } from "@lmcstools/core";
import type { SnoozePreset } from "@lmcstools/client/state/thread-settled";

import { translateDynamic } from "../../i18n";

/**
 * Ids for the per-thread action menu. Snooze presets are dispatched as
 * `snooze:<presetId>` so the union stays closed while the preset list
 * remains data-driven.
 */
export type ThreadActionMenuId =
  | "new-thread-on-branch"
  | "filter-by-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread-id"
  | "archive"
  | "delete";

export interface ThreadActionMenuState {
  readonly branch: string | null;
  /**
   * Project scoping for the thread list. Null on surfaces with no scoped
   * list behind the menu (the chat header), where the item must not show.
   */
  readonly projectFilter: {
    readonly label: string;
    /** True when the list is already scoped to this thread's project. */
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  /** False while the user has turned automatic settlement off for this thread. */
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects a thread with an active turn, so disable it here rather than let the action fail. */
  readonly isRunning: boolean;
  readonly supports: {
    readonly settlement: boolean;
    /** Server understands thread.auto-settle.set. */
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
}

/**
 * Single source for the per-thread action menu: the sidebar row's right-click
 * menu and the chat header menu share labels, ordering, and capability gating.
 * Each surface supplies state for the actions it supports.
 */
export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  return [
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: translateDynamic(
              "sidebar.threadAction.newThreadOnBranch",
              `New thread on ${state.branch}`,
              { branch: state.branch },
            ),
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? {
                id: "unpin" as const,
                label: translateDynamic("sidebar.threadAction.unpin", "Unpin thread"),
                icon: "pin-off",
              }
            : {
                id: "pin" as const,
                label: translateDynamic("sidebar.threadAction.pin", "Pin thread"),
                icon: "pin",
              },
        ]
      : []),
    // Both lifecycle actions stay available on pinned threads: settling
    // clears the pin ("done" beats "keep on top"), and snoozing hides the
    // card until wake with the pin intact.
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? {
                id: "unsettle" as const,
                label: translateDynamic("sidebar.threadAction.unsettle", "Un-settle thread"),
                icon: "circle-check",
              }
            : {
                id: "settle" as const,
                label: translateDynamic("sidebar.threadAction.settle", "Settle thread"),
                icon: "circle-check",
              },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? {
                id: "unsnooze" as const,
                label: translateDynamic("sidebar.threadAction.wake", "Wake thread"),
                icon: "clock",
              }
            : {
                id: "snooze" as const,
                label: translateDynamic("sidebar.threadAction.snooze", "Snooze"),
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: `${preset.label} (${preset.whenLabel})`,
                  })),
                  {
                    id: "snooze:custom" as const,
                    label: translateDynamic("sidebar.snoozePreset.custom", "Custom…"),
                    separatorBefore: true,
                  },
                ],
              },
        ]
      : []),
    {
      id: "rename",
      label: translateDynamic("sidebar.threadAction.rename", "Rename thread"),
      icon: "pencil",
      separatorBefore: true,
    },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle
              ? translateDynamic("sidebar.threadAction.regenerating", "Regenerating…")
              : translateDynamic("sidebar.threadAction.regenerateTitle", "Regenerate title"),
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    {
      id: "mark-unread",
      label: translateDynamic("sidebar.threadAction.markUnread", "Mark unread"),
      icon: "mail-open",
    },
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? translateDynamic("sidebar.threadAction.showAllProjects", "Show all projects")
              : translateDynamic(
                  "sidebar.threadAction.filterBy",
                  `Filter by ${state.projectFilter.label}`,
                  { project: state.projectFilter.label },
                ),
            icon: "folder-tree",
          },
        ]
      : []),
    // A submenu with the current option checked, not a one-shot action:
    // this is a setting, and it sits with the other per-thread settings
    // rather than the lifecycle verbs above. Disabled keeps long-running
    // threads out of the settled shelf no matter how quiet they get.
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: translateDynamic("sidebar.threadAction.autoSettle", "Auto-settle behavior"),
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: translateDynamic("sidebar.threadAction.autoSettleEnabled", "Enabled"),
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: translateDynamic("sidebar.threadAction.autoSettleDisabled", "Disabled"),
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: translateDynamic("sidebar.threadAction.copy", "Copy"),
      icon: "copy",
      separatorBefore: true,
      children: [
        {
          id: "copy-path",
          label: translateDynamic("sidebar.threadAction.copyPath", "Path"),
          icon: "folder",
        },
        ...(state.branch
          ? [
              {
                id: "copy-branch" as const,
                label: translateDynamic("sidebar.threadAction.copyBranch", "Branch"),
                icon: "git-branch",
              },
            ]
          : []),
        {
          id: "copy-thread-id",
          label: translateDynamic("sidebar.threadAction.copyThreadId", "Thread ID"),
          icon: "hash",
        },
      ],
    },
    {
      id: "project-settings",
      label: translateDynamic("sidebar.threadAction.projectSettings", "Project settings"),
      icon: "settings",
    },
    // Archive removes the thread from the sidebar while keeping its
    // conversation under Settings > Archived threads — distinct from Settle
    // (stays visible in the Settled shelf) and Delete (clears history for
    // good), so it sits beside Delete without borrowing its destructive
    // styling.
    {
      id: "archive",
      label: translateDynamic("sidebar.threadAction.archive", "Archive thread"),
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: translateDynamic("sidebar.threadAction.delete", "Delete"),
      destructive: true,
      icon: "trash",
    },
  ];
}
