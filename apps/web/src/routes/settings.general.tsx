import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/features/settings/SettingsPanels";

function SettingsGeneralRoute() {
  return <GeneralSettingsPanel />;
}

export const Route = createFileRoute("/settings/general")({
  component: SettingsGeneralRoute,
});
