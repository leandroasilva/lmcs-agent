import type { EnvironmentThreadStatus } from "@lmcstools/client/state/threads";

import { translateDynamic } from "./i18n";

export type ThreadSyncPhase = "loading" | "syncing";

export function resolveThreadSyncPhase(input: {
  readonly detailExists: boolean;
  readonly shellExists: boolean;
  readonly status: EnvironmentThreadStatus;
}): ThreadSyncPhase | null {
  if (!input.shellExists) {
    return null;
  }

  switch (input.status) {
    case "empty":
    case "cached":
    case "synchronizing":
      return input.detailExists ? "syncing" : "loading";
    case "deleted":
    case "live":
      return null;
  }
}

export function threadSyncLabel(phase: ThreadSyncPhase): string {
  return phase === "loading"
    ? translateDynamic("chat.timeline.loadingMessages", "Loading messages...")
    : translateDynamic("chat.timeline.syncingMessages", "Syncing messages...");
}
