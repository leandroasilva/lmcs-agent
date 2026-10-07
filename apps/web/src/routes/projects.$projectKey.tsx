import { createFileRoute, redirect } from "@tanstack/react-router";

import { isElectron } from "../env";

export const Route = createFileRoute("/projects/$projectKey")({
  beforeLoad: async ({ context, params }) => {
    // Pairing is optional in desktop mode - allow access without authentication.
    const isUnauthenticated =
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static";
    if (isUnauthenticated && !isElectron()) {
      throw redirect({ to: "/pair", replace: true });
    }
    throw redirect({
      to: "/settings/projects",
      search: { project: params.projectKey, machine: undefined },
      replace: true,
    });
  },
});
