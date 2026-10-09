import { useCallback } from "react";
import { EnvironmentId } from "@lmcstools/core";
import { executeAtomQuery } from "@lmcstools/client/state/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { openFileInEditor } from "./EditorPanel";

export function useOpenInInternalEditor(environmentId: EnvironmentId | null, cwd: string | null) {
  return useCallback(
    async (filePath: string) => {
      if (!environmentId || !cwd) {
        console.error("No environment or cwd selected");
        return;
      }

      // Calculate relative path from cwd
      const relativePath = filePath.startsWith(cwd)
        ? filePath.slice(cwd.length).replace(/^\//, "")
        : filePath;

      try {
        const queryAtom = projectEnvironment.readFile({
          environmentId,
          input: { cwd, relativePath },
        });

        const result = await executeAtomQuery(appAtomRegistry, queryAtom, {
          reportDefect: false,
          reportFailure: false,
        });

        if (result._tag === "Success") {
          openFileInEditor({
            path: filePath,
            content: result.value.contents,
          });
        } else {
          console.error("Failed to read file:", result);
        }
      } catch (error) {
        console.error("Error opening file in internal editor:", error);
      }
    },
    [environmentId, cwd],
  );
}
