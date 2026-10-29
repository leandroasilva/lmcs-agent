/**
 * Pure helpers for creating files and folders from the workspace file tree.
 * The panel owns the RPC calls; everything decidable without them lives here.
 */

/**
 * Folder a new entry is created in, derived from the row the user last
 * selected: inside a selected directory, beside a selected file, and at the
 * workspace root when nothing is selected.
 */
export function resolveCreationParentPath(
  selectedPath: string | null,
  selectedKind: "file" | "directory" | undefined,
): string {
  if (!selectedPath) return "";
  if (selectedKind === "directory") return selectedPath;
  const slash = selectedPath.lastIndexOf("/");
  return slash === -1 ? "" : selectedPath.slice(0, slash);
}

/** Rejects names the filesystem and the wire contracts cannot take; null means valid. */
export function validateNewEntryName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Enter a name.";
  if (trimmed.startsWith("/")) return "Name must be relative to the target folder.";
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return "Name contains an invalid path segment.";
    }
    if (segment.length > 255) return "Name segments must be 255 characters or fewer.";
  }
  return null;
}

/** Workspace-relative path of a new entry named `name` inside `parentDir`. */
export function joinRelativePath(parentDir: string, name: string): string {
  const trimmed = name.trim();
  return parentDir.length === 0 ? trimmed : `${parentDir}/${trimmed}`;
}
