import { createFileRoute } from "@tanstack/react-router";
import { ProjectsSettings } from "../components/features/settings/ProjectsSettings";

export const Route = createFileRoute("/settings/projects")({
  component: ProjectsSettings,
});
