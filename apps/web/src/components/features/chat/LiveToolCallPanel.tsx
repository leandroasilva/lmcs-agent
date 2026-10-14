import { useMemo } from "react";
import { useProviderRuntimeEvents } from "~/hooks/useProviderRuntimeEvents";
import { ToolCallList } from "./ToolCallRow";

interface LiveToolCallPanelProps {
  environmentId: string;
  threadId: string;
  isVisible: boolean;
}

/**
 * Show real-time tool executions in the chat view.
 *
 * Displays a compact panel with the most recent tool calls, updating
 * live as events arrive from the provider.
 */
export function LiveToolCallPanel({ environmentId, threadId, isVisible }: LiveToolCallPanelProps) {
  const { toolCallEvents } = useProviderRuntimeEvents({
    enabled: isVisible,
    threadId,
  });

  if (!isVisible || toolCallEvents.length === 0) {
    return null;
  }

  return (
    <div className="border-b bg-muted/30 px-4 py-2">
      <ToolCallList events={toolCallEvents} />
    </div>
  );
}
