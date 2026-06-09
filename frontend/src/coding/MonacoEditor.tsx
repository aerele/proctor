// frontend/src/coding/MonacoEditor.tsx
import Editor, { type OnMount } from "@monaco-editor/react";
import { mapContentChange, mapPaste, mapCursor, mapSelection, coalesceCursor } from "./editorEvents";
import type { EditorEvent } from "../types";

const MONACO_LANG: Record<string, string> = { python: "python", cpp: "cpp", java: "java", javascript: "javascript" };

export function MonacoEditor({ language, value, onChange, onEvent }: {
  language: "python" | "cpp" | "java" | "javascript";
  value: string;
  onChange: (v: string) => void;
  onEvent: (e: EditorEvent) => void;
}) {
  let lastCursor: { line: number; col: number } | null = null;

  const handleMount: OnMount = (editor) => {
    editor.onDidChangeModelContent((ev) => {
      for (const c of ev.changes) {
        onEvent(mapContentChange(
          { rangeLength: c.rangeLength, text: c.text, rangeStartLine: c.range.startLineNumber, rangeStartCol: c.range.startColumn },
          new Date().toISOString()
        ));
      }
    });
    editor.onDidPaste((ev) => {
      const len = editor.getModel()?.getValueLengthInRange(ev.range) ?? 0;
      onEvent(mapPaste({ len, line: ev.range.startLineNumber, col: ev.range.startColumn }, new Date().toISOString()));
    });
    editor.onDidChangeCursorPosition((ev) => {
      const pos = { line: ev.position.lineNumber, col: ev.position.column };
      if (coalesceCursor(lastCursor, pos)) return;
      lastCursor = pos;
      onEvent(mapCursor(pos, new Date().toISOString()));
    });
    editor.onDidChangeCursorSelection((ev) => {
      const s = ev.selection;
      if (s.isEmpty()) return; // empty selection == cursor; already captured
      onEvent(mapSelection({ startLine: s.startLineNumber, startCol: s.startColumn, endLine: s.endLineNumber, endCol: s.endColumn }, new Date().toISOString()));
    });
    editor.onDidFocusEditorText(() => onEvent({ type: "editor_focus", timestamp: new Date().toISOString() }));
    editor.onDidBlurEditorText(() => onEvent({ type: "editor_blur", timestamp: new Date().toISOString() }));
  };

  return (
    <Editor
      height="60vh"
      language={MONACO_LANG[language]}
      value={value}
      onChange={(v: string | undefined) => onChange(v ?? "")}
      onMount={handleMount}
      options={{ minimap: { enabled: false }, fontSize: 14, automaticLayout: true, contextmenu: false }}
    />
  );
}
