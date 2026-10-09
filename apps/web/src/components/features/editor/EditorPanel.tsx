import { useCallback, useEffect, useMemo, useState } from "react";
import { Atom } from "effect/unstable/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { XIcon, SaveIcon, FileIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { CodeEditor } from "./CodeEditor";
import { ScrollArea } from "~/components/ui/scroll-area";

export interface EditorTab {
  id: string;
  path: string;
  fileName: string;
  language: string;
  content: string;
  originalContent: string;
  isModified: boolean;
  isLoading: boolean;
}

const editorTabsAtom = Atom.make<EditorTab[]>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("editor:tabs"),
);

const activeEditorTabIdAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("editor:active-tab-id"),
);

export function openFileInEditor(file: { path: string; content: string; language?: string }): void {
  const tabs = appAtomRegistry.get(editorTabsAtom);
  const existingTab = tabs.find((t) => t.path === file.path);

  if (existingTab) {
    appAtomRegistry.set(activeEditorTabIdAtom, existingTab.id);
    return;
  }

  const fileName = file.path.split("/").pop() ?? file.path;
  const language = file.language ?? detectLanguage(fileName);
  const newTab: EditorTab = {
    id: `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    path: file.path,
    fileName,
    language,
    content: file.content,
    originalContent: file.content,
    isModified: false,
    isLoading: false,
  };

  appAtomRegistry.set(editorTabsAtom, [...tabs, newTab]);
  appAtomRegistry.set(activeEditorTabIdAtom, newTab.id);
}

export function closeEditorTab(tabId: string): void {
  const tabs = appAtomRegistry.get(editorTabsAtom);
  const activeTabId = appAtomRegistry.get(activeEditorTabIdAtom);
  const newTabs = tabs.filter((t) => t.id !== tabId);
  appAtomRegistry.set(editorTabsAtom, newTabs);

  if (activeTabId === tabId) {
    const newActiveTab = newTabs[newTabs.length - 1] ?? null;
    appAtomRegistry.set(activeEditorTabIdAtom, newActiveTab?.id ?? null);
  }
}

function detectLanguage(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    html: "html",
    css: "css",
    scss: "scss",
    less: "less",
    md: "markdown",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    sh: "shell",
    bash: "shell",
    yml: "yaml",
    yaml: "yaml",
    xml: "xml",
    sql: "sql",
    graphql: "graphql",
    toml: "toml",
    ini: "ini",
    txt: "plaintext",
  };
  return languageMap[ext ?? ""] ?? "plaintext";
}

export function EditorPanel() {
  const tabs = useAtomValue(editorTabsAtom);
  const activeTabId = useAtomValue(activeEditorTabIdAtom);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );

  const handleTabClick = useCallback((tabId: string) => {
    appAtomRegistry.set(activeEditorTabIdAtom, tabId);
  }, []);

  const handleTabClose = useCallback((e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    closeEditorTab(tabId);
  }, []);

  const handleContentChange = useCallback(
    (newValue: string) => {
      if (!activeTab) return;
      const updatedTabs = tabs.map((t) =>
        t.id === activeTab.id
          ? {
              ...t,
              content: newValue,
              isModified: newValue !== t.originalContent,
            }
          : t,
      );
      appAtomRegistry.set(editorTabsAtom, updatedTabs);
    },
    [activeTab, tabs],
  );

  const handleSave = useCallback(
    (value: string) => {
      if (!activeTab) return;
      // TODO: Implement actual file save via RPC
      const updatedTabs = tabs.map((t) =>
        t.id === activeTab.id
          ? { ...t, content: value, originalContent: value, isModified: false }
          : t,
      );
      appAtomRegistry.set(editorTabsAtom, updatedTabs);
    },
    [activeTab, tabs],
  );

  if (tabs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="text-center">
          <FileIcon className="mx-auto mb-2 h-12 w-12 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No file open</p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            Open a file from the file explorer to start editing
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Tab bar */}
      <div className="flex h-9 border-b bg-muted/30">
        <ScrollArea className="flex-1">
          <div className="flex h-9 items-center">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={cn(
                  "group flex h-full items-center gap-1.5 border-r px-3 text-sm transition-colors hover:bg-muted/50",
                  activeTabId === tab.id
                    ? "bg-background text-foreground"
                    : "text-muted-foreground",
                )}
                onClick={() => handleTabClick(tab.id)}
              >
                <FileIcon className="h-3.5 w-3.5" />
                <span>{tab.fileName}</span>
                {tab.isModified && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-accent" />}
                <XIcon
                  className="ml-1 h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={(e) => handleTabClose(e, tab.id)}
                />
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Editor content */}
      <div className="flex-1 overflow-hidden">
        {activeTab ? (
          <CodeEditor
            key={activeTab.id}
            value={activeTab.content}
            language={activeTab.language}
            path={activeTab.path}
            onChange={handleContentChange}
            onSave={handleSave}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">Select a tab to edit</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default EditorPanel;
