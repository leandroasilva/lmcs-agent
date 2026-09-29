import { codexFeedbackNotice, type CodexFeedbackSubmission } from "@lmcstools/client/state/threads";
import { MessageSquareIcon } from "lucide-react";

import { writeTextToClipboard } from "../../../hooks/useCopyToClipboard";
import { translateDynamic } from "../../../i18n";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function feedbackBannerItem(
  submission: CodexFeedbackSubmission,
  onDismiss: () => void,
): ComposerBannerStackItem | null {
  const notice = codexFeedbackNotice(submission);
  if (!notice) return null;
  return {
    id: `feedback:${submission.id}`,
    variant:
      submission.status === "failed" ? "error" : submission.status === "sent" ? "success" : "info",
    priority: submission.status === "uploading" ? "activity" : "notice",
    icon: <MessageSquareIcon />,
    ...notice,
    actions:
      submission.status === "sent" ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            void writeTextToClipboard(submission.feedbackId, "Codex feedback thread ID").catch(
              (error: unknown) => {
                toastManager.add({
                  type: "error",
                  title: "Could not copy thread ID",
                  description: error instanceof Error ? error.message : "An error occurred.",
                });
              },
            );
          }}
        >
          {translateDynamic("chat.feedback.copyId", "Copy ID")}
        </Button>
      ) : undefined,
    ...(submission.status !== "uploading"
      ? {
          dismissLabel: translateDynamic("chat.feedback.dismissLabel", "Dismiss feedback notice"),
          onDismiss,
        }
      : {}),
  };
}
