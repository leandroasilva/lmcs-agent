import { createFileRoute } from "@tanstack/react-router";

import { ConnectionsSettings } from "../components/features/settings/ConnectionsSettings";

export const Route = createFileRoute("/settings/connections")({
  component: ConnectionsSettings,
});
