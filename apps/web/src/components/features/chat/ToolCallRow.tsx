import { useMemo } from "react";
import { Hammer, Loader2, CheckCircle2, XCircle, Wrench, Bot } from "lucide-react";
import type { ProviderRuntimeEvent } from "@lmcstools/core";
import { cn } from "~/lib/utils";

interface ToolCallRowProps {
  event: ProviderRuntimeEvent;
}

/**
 * Render a single tool call event with real-time status indicator.
 *
 * Shows:
 * - Tool name and icon
 * - Status (in progress, completed, failed)
 * - Duration (if completed)
 * - Output preview (for bash commands)
 */
export function ToolCallRow({ event }: ToolCallRowProps) {
  const { toolName, status, toolInput, duration } = useMemo(() => {
    const payload = event.payload as any;
    const toolName = payload?.toolName ?? payload?.title ?? "tool_call";
    const toolInput = payload?.data?.toolInput ?? payload?.data ?? {};
    const status = payload?.status ?? "inProgress";
    const duration = payload?.duration;

    return { toolName, status, toolInput, duration };
  }, [event]);

  const icon = useMemo(() => {
    // Icon based on tool type
    if (toolName.toLowerCase().includes("bash") || toolName.toLowerCase().includes("shell")) {
      return <Hammer className="h-4 w-4" />;
    }
    if (toolName.toLowerCase().includes("mcp")) {
      return <Wrench className="h-4 w-4" />;
    }
    if (toolName.toLowerCase().includes("agent") || toolName.toLowerCase().includes("collab")) {
      return <Bot className="h-4 w-4" />;
    }
    return <Hammer className="h-4 w-4" />;
  }, [toolName]);

  const statusIcon = useMemo(() => {
    if (status === "inProgress") {
      return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
    }
    if (status === "completed" || status === "success") {
      return <CheckCircle2 className="h-4 w-4 text-success" />;
    }
    if (status === "failed" || status === "error") {
      return <XCircle className="h-4 w-4 text-destructive" />;
    }
    return null;
  }, [status]);

  const outputPreview = useMemo(() => {
    // Show bash command if available
    if (toolInput?.command) {
      return String(toolInput.command).slice(0, 100);
    }
    // Show file path if available
    if (toolInput?.path || toolInput?.file_path) {
      return String(toolInput.path ?? toolInput.file_path).slice(0, 100);
    }
    return null;
  }, [toolInput]);

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        status === "inProgress" && "border-accent bg-accent/5",
        status === "completed" && "border-success/30 bg-success/5",
        status === "failed" && "border-destructive/30 bg-destructive/5",
      )}
    >
      <div className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{toolName}</span>
          {statusIcon}
          {duration !== undefined && (
            <span className="text-xs text-muted-foreground">
              {typeof duration === "number" ? `${duration}ms` : duration}
            </span>
          )}
        </div>
        {outputPreview && (
          <div className="mt-1 text-xs text-muted-foreground font-mono truncate">
            {outputPreview}
          </div>
        )}
      </div>
    </div>
  );
}

interface ToolCallListProps {
  events: ReadonlyArray<ProviderRuntimeEvent>;
}

/**
 * Render a list of tool call events with real-time status.
 *
 * Shows the most recent tool calls first.
 */
export function ToolCallList({ events }: ToolCallListProps) {
  if (events.length === 0) {
    return null;
  }

  // Show most recent first, limit to last 10
  const recentEvents = events.slice(-10).reverse();

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">
        {events.length === 1 ? "1 tool call" : `${events.length} tool calls`}
      </div>
      <div className="space-y-1">
        {recentEvents.map((event, index) => (
          <ToolCallRow key={`${event.itemId}-${index}`} event={event} />
        ))}
      </div>
    </div>
  );
}
