import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Atom } from "effect/unstable/reactivity";
import { type EnvironmentId, type GitConflict, type VcsRef } from "@lmcstools/core";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

const mergeDialogOpenAtom = Atom.make<boolean>(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("git:merge-dialog-open"),
);

const mergeDialogConflictsAtom = Atom.make<GitConflict[]>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("git:merge-dialog-conflicts"),
);

const mergeDialogSourceBranchAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("git:merge-dialog-source-branch"),
);

const mergeDialogTargetBranchAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("git:merge-dialog-target-branch"),
);

export function openMergeDialog(options: {
  sourceBranch: string;
  targetBranch: string;
  conflicts?: GitConflict[];
}): void {
  appAtomRegistry.set(mergeDialogSourceBranchAtom, options.sourceBranch);
  appAtomRegistry.set(mergeDialogTargetBranchAtom, options.targetBranch);
  appAtomRegistry.set(mergeDialogConflictsAtom, options.conflicts ?? []);
  appAtomRegistry.set(mergeDialogOpenAtom, true);
}

export function closeMergeDialog(): void {
  appAtomRegistry.set(mergeDialogOpenAtom, false);
  appAtomRegistry.set(mergeDialogConflictsAtom, []);
  appAtomRegistry.set(mergeDialogSourceBranchAtom, null);
  appAtomRegistry.set(mergeDialogTargetBranchAtom, null);
}

interface MergeBranchDialogProps {
  open: boolean;
  branches: ReadonlyArray<VcsRef>;
  currentBranch: string | null;
  environmentId: EnvironmentId | null;
  cwd: string | null;
  onMerge: (sourceBranch: string, targetBranch: string) => void;
  onAbort?: () => void;
  onResolveConflict?: (
    path: string,
    resolution: "ours" | "theirs" | "manual",
    manualContent?: string,
  ) => void;
  onOpenChange: (open: boolean) => void;
}

export function MergeBranchDialog({
  open,
  branches,
  currentBranch,
  environmentId,
  cwd,
  onMerge,
  onAbort,
  onResolveConflict,
  onOpenChange,
}: MergeBranchDialogProps) {
  const conflicts = useAtomValue(mergeDialogConflictsAtom);
  const sourceBranch = useAtomValue(mergeDialogSourceBranchAtom);
  const targetBranch = useAtomValue(mergeDialogTargetBranchAtom);

  const [selectedSourceBranch, setSelectedSourceBranch] = useState<string>(sourceBranch ?? "");
  const [selectedTargetBranch, setSelectedTargetBranch] = useState<string>(
    targetBranch ?? currentBranch ?? "",
  );
  const [selectedConflictPath, setSelectedConflictPath] = useState<string | null>(null);
  const [manualContent, setManualContent] = useState<string>("");
  const [isResolving, setIsResolving] = useState(false);

  useEffect(() => {
    if (sourceBranch) setSelectedSourceBranch(sourceBranch);
    if (targetBranch) setSelectedTargetBranch(targetBranch);
  }, [sourceBranch, targetBranch]);

  const localBranches = useMemo(
    () => branches.filter((b) => !b.isRemote && b.name !== currentBranch),
    [branches, currentBranch],
  );

  const selectedConflict = useMemo(
    () => conflicts.find((c) => c.path === selectedConflictPath) ?? null,
    [conflicts, selectedConflictPath],
  );

  const handleResolve = useCallback(
    (resolution: "ours" | "theirs" | "manual") => {
      if (!selectedConflictPath || !onResolveConflict) return;
      setIsResolving(true);
      onResolveConflict(
        selectedConflictPath,
        resolution,
        resolution === "manual" ? manualContent : undefined,
      );
      setIsResolving(false);
      setSelectedConflictPath(null);
      setManualContent("");
    },
    [selectedConflictPath, onResolveConflict, manualContent],
  );

  const handleMerge = useCallback(() => {
    if (!selectedSourceBranch || !selectedTargetBranch) return;
    onMerge(selectedSourceBranch, selectedTargetBranch);
    onOpenChange(false);
  }, [selectedSourceBranch, selectedTargetBranch, onMerge, onOpenChange]);

  const handleAbort = useCallback(() => {
    onAbort?.();
    onOpenChange(false);
  }, [onAbort, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Merge Branches</DialogTitle>
          <DialogDescription>
            {conflicts.length > 0
              ? "Resolve merge conflicts before completing the merge."
              : "Select branches to merge."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {conflicts.length > 0 ? (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground">
                Merging <span className="font-mono font-semibold">{sourceBranch}</span> into{" "}
                <span className="font-mono font-semibold">{targetBranch}</span>
              </div>
              <div className="space-y-2">
                <div className="text-sm font-medium">Conflicted Files</div>
                <ScrollArea className="h-[200px]">
                  <div className="space-y-1">
                    {conflicts.map((conflict) => (
                      <button
                        key={conflict.path}
                        className={cn(
                          "w-full text-left px-3 py-2 rounded-md text-sm hover:bg-accent transition-colors",
                          selectedConflictPath === conflict.path && "bg-accent",
                        )}
                        onClick={() => {
                          setSelectedConflictPath(conflict.path);
                          setManualContent("");
                        }}
                      >
                        <span className="font-mono">{conflict.path}</span>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              </div>
              {selectedConflict && (
                <div className="space-y-3">
                  <div className="text-sm font-medium">
                    Resolve: <span className="font-mono">{selectedConflict.path}</span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        // Open conflict file in internal editor
                        if (!environmentId || !cwd) return;

                        import("../features/editor/EditorPanel").then(({ openFileInEditor }) => {
                          import("~/state/projects").then(({ projectEnvironment }) => {
                            import("@lmcstools/client/state/runtime").then(
                              ({ executeAtomQuery }) => {
                                import("~/rpc/atomRegistry").then(
                                  ({ appAtomRegistry: registry }) => {
                                    const queryAtom = projectEnvironment.readFile({
                                      environmentId,
                                      input: {
                                        cwd,
                                        relativePath: selectedConflict.path,
                                      },
                                    });

                                    executeAtomQuery(registry, queryAtom, {
                                      reportDefect: false,
                                      reportFailure: false,
                                    }).then((result) => {
                                      if (result._tag === "Success") {
                                        openFileInEditor({
                                          path: `${cwd}/${selectedConflict.path}`,
                                          content: result.value.contents,
                                        });
                                      }
                                    });
                                  },
                                );
                              },
                            );
                          });
                        });
                      }}
                      disabled={isResolving || !environmentId || !cwd}
                    >
                      Open in Editor
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleResolve("ours")}
                      disabled={isResolving}
                    >
                      Accept Ours
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleResolve("theirs")}
                      disabled={isResolving}
                    >
                      Accept Theirs
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <div className="text-xs text-muted-foreground">
                      Or provide manual resolution:
                    </div>
                    <Textarea
                      value={manualContent}
                      onChange={(e) => setManualContent(e.target.value)}
                      placeholder="Enter resolved content..."
                      className="min-h-[150px]"
                    />
                    <Button
                      size="sm"
                      onClick={() => handleResolve("manual")}
                      disabled={!manualContent.trim() || isResolving}
                    >
                      Apply Manual Resolution
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Source Branch (from)</label>
                <select
                  value={selectedSourceBranch}
                  onChange={(e) => setSelectedSourceBranch(e.target.value)}
                  className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                >
                  <option value="">Select source branch...</option>
                  {localBranches.map((branch) => (
                    <option key={branch.name} value={branch.name}>
                      {branch.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Target Branch (into)</label>
                <select
                  value={selectedTargetBranch}
                  onChange={(e) => setSelectedTargetBranch(e.target.value)}
                  className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                >
                  <option value="">Select target branch...</option>
                  {localBranches.map((branch) => (
                    <option key={branch.name} value={branch.name}>
                      {branch.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {conflicts.length > 0 && onAbort && (
            <Button variant="outline" onClick={handleAbort}>
              Abort Merge
            </Button>
          )}
          {conflicts.length === 0 && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleMerge}
                disabled={!selectedSourceBranch || !selectedTargetBranch}
              >
                Merge
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
