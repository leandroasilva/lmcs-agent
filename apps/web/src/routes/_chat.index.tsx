import { RefreshIcon } from "~/components/ui/refresh-icon";
import { scopeProjectRef } from "@lmcstools/client/environment";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { NoProjectsHero } from "../components/layout/NoProjectsHero";
import { sortScopedProjectsForSidebar } from "../components/layout/Sidebar.logic";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";

function ChatIndexRouteView() {
  return <IndexDraftLanding />;
}

/**
 * Landing on the index route drops straight into a draft thread for the most
 * recently active project, so the first screen is a prompt instead of a dead
 * end. Falls back to an add-project hero when no project exists yet.
 */
function IndexDraftLanding() {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({
    failed: false,
    retryRequest: 0,
  });

  const mostRecentProject = useMemo(
    () =>
      bootstrapped
        ? (sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null)
        : null,
    [bootstrapped, projects, threads],
  );

  useEffect(() => {
    if (mostRecentProject === null || startingRef.current) {
      return;
    }
    startingRef.current = true;
    void handleNewThread(scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id), {
      replace: true,
    }).catch(() => {
      startingRef.current = false;
      setStartState((state) => ({ ...state, failed: true }));
    });
  }, [handleNewThread, mostRecentProject, startState.retryRequest]);

  if (!bootstrapped) {
    return null;
  }
  if (mostRecentProject !== null) {
    return startState.failed ? (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    ) : null;
  }
  // First-run routing to the welcome wizard happens in FirstRunGate at the
  // root, before this route ever renders.
  return <NoProjectsHero />;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription>
            The project is still available. Try opening the draft again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RefreshIcon size="md" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
