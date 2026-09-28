import { createFileRoute } from "@tanstack/react-router";
import { StorageSettingsPanel } from "../components/features/settings/StorageSettings";

export const Route = createFileRoute("/settings/storage")({ component: StorageSettingsPanel });
