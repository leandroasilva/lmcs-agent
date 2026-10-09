import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { cn } from "~/lib/utils";

export interface CodeEditorProps {
  value: string;
  language?: string;
  path?: string;
  onChange?: (value: string) => void;
  onSave?: (value: string) => void;
  readOnly?: boolean;
  className?: string;
  minimap?: boolean;
  lineNumbers?: "on" | "off" | "relative";
  wordWrap?: "on" | "off" | "wordWrapColumn" | "bounded";
  fontSize?: number;
  tabSize?: number;
  theme?: "vs-dark" | "vs-light" | "hc-black" | "hc-light";
}

export function CodeEditor({
  value,
  language = "plaintext",
  path,
  onChange,
  onSave,
  readOnly = false,
  className,
  minimap = true,
  lineNumbers = "on",
  wordWrap = "on",
  fontSize = 14,
  tabSize = 2,
  theme = "vs-dark",
}: CodeEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [isModified, setIsModified] = useState(false);

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;

      // Register save action
      editor.addAction({
        id: "save-file",
        label: "Save File",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: (ed) => {
          const currentValue = ed.getValue();
          onSave?.(currentValue);
          setIsModified(false);
        },
      });

      // Focus editor
      editor.focus();
    },
    [onSave],
  );

  const handleChange = useCallback(
    (newValue: string | undefined) => {
      if (newValue !== undefined) {
        onChange?.(newValue);
        setIsModified(true);
      }
    },
    [onChange],
  );

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (editorRef.current) {
          const currentValue = editorRef.current.getValue();
          onSave?.(currentValue);
          setIsModified(false);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onSave]);

  return (
    <div className={cn("relative h-full w-full overflow-hidden", className)}>
      <Editor
        height="100%"
        language={language}
        {...(path ? { path } : {})}
        value={value}
        onChange={handleChange}
        onMount={handleMount}
        theme={theme}
        options={{
          readOnly,
          minimap: { enabled: minimap },
          lineNumbers,
          wordWrap,
          fontSize,
          tabSize,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          renderWhitespace: "selection",
          bracketPairColorization: { enabled: true },
          guides: {
            bracketPairs: true,
            indentation: true,
          },
          padding: { top: 8, bottom: 8 },
          smoothScrolling: true,
          cursorBlinking: "smooth",
          cursorSmoothCaretAnimation: "on",
          formatOnPaste: true,
          formatOnType: true,
        }}
        loading={
          <div className="flex h-full items-center justify-center bg-background">
            <div className="text-sm text-muted-foreground">Loading editor...</div>
          </div>
        }
      />
      {isModified && !readOnly && (
        <div className="absolute right-2 top-2 rounded bg-accent px-2 py-0.5 text-xs text-accent-foreground">
          Modified
        </div>
      )}
    </div>
  );
}
