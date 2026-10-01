import { createFileRoute } from "@tanstack/react-router";

import { DiagnosticsSettingsPanel } from "../components/features/settings/DiagnosticsSettings";

export const Route = createFileRoute("/settings/diagnostics")({
  component: DiagnosticsSettingsPanel,
});
