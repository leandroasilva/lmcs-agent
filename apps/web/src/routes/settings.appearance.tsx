import { createFileRoute } from "@tanstack/react-router";

import { AppearanceSettingsPanel } from "../components/features/settings/SettingsPanels";

function SettingsAppearanceRoute() {
  return <AppearanceSettingsPanel />;
}

export const Route = createFileRoute("/settings/appearance")({
  component: SettingsAppearanceRoute,
});
