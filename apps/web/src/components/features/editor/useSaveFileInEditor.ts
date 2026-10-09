import { useCallback } from "react";
import { EnvironmentId } from "@lmcstools/core";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

export function useSaveFileInEditor(environmentId: EnvironmentId | null, cwd: string | null) {
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });

  return useCallback(
    async (filePath: string, content: string): Promise<boolean> => {
      if (!environmentId || !cwd) {
        console.error("No environment or cwd selected");
        return false;
      }

      // Calculate relative path from cwd
      const relativePath = filePath.startsWith(cwd)
        ? filePath.slice(cwd.length).replace(/^\//, "")
        : filePath;

      try {
        const result = await writeFile({
          environmentId,
          input: { cwd, relativePath, contents: content },
        });

        if (result._tag === "Success") {
          return true;
        } else {
          console.error("Failed to save file:", result);
          return false;
        }
      } catch (error) {
        console.error("Error saving file:", error);
        return false;
      }
    },
    [environmentId, cwd, writeFile],
  );
}
