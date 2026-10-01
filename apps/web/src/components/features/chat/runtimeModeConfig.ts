import type { RuntimeMode } from "@lmcstools/core";
import { type LucideIcon, LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon } from "lucide-react";

import { translateDynamic } from "../../../i18n";

// Labels resolve through i18n at access time so renderers pick up locale
// changes without threading a translator through every call site.
export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    get label() {
      return translateDynamic("chat.runtimeMode.supervised", "Supervised");
    },
    get description() {
      return translateDynamic(
        "chat.runtimeMode.supervisedDescription",
        "Ask before commands and file changes.",
      );
    },
    icon: LockIcon,
  },
  "auto-accept-edits": {
    get label() {
      return translateDynamic("chat.runtimeMode.autoAcceptEdits", "Auto-accept edits");
    },
    get description() {
      return translateDynamic(
        "chat.runtimeMode.autoAcceptEditsDescription",
        "Auto-approve edits, ask before other actions.",
      );
    },
    icon: PenLineIcon,
  },
  auto: {
    get label() {
      return translateDynamic("chat.runtimeMode.auto", "Auto");
    },
    get description() {
      return translateDynamic(
        "chat.runtimeMode.autoDescription",
        "Supported providers approve routine actions; others still ask.",
      );
    },
    icon: SparklesIcon,
  },
  "full-access": {
    get label() {
      return translateDynamic("chat.runtimeMode.fullAccess", "Full access");
    },
    get description() {
      return translateDynamic(
        "chat.runtimeMode.fullAccessDescription",
        "Allow commands and edits without prompts.",
      );
    },
    icon: LockOpenIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
