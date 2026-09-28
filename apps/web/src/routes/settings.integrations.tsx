import { createFileRoute } from "@tanstack/react-router";

import { IntegrationsSettingsPanel } from "../components/features/settings/IntegrationsSettings";

export const Route = createFileRoute("/settings/integrations")({
  component: IntegrationsSettingsPanel,
});
