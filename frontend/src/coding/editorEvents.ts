// frontend/src/coding/editorEvents.ts
import type { EditorEvent } from "../types";

export type ContentChange = { rangeLength: number; text: string; rangeStartLine: number; rangeStartCol: number };

export function mapContentChange(c: ContentChange, timestamp: string): EditorEvent {
  const insertedLen = c.text.length;
  const deletedLen = c.rangeLength;
  let type: EditorEvent["type"];
  if (insertedLen > 0 && deletedLen > 0) type = "editor_replace";
  else if (deletedLen > 0) type = "editor_delete";
  else type = "editor_insert";
  return { type, timestamp, detail: { insertedLen, deletedLen, line: c.rangeStartLine, col: c.rangeStartCol } };
}

export function mapPaste(p: { len: number; line: number; col: number }, timestamp: string): EditorEvent {
  return { type: "editor_paste", timestamp, detail: { len: p.len, line: p.line, col: p.col } };
}

export function mapCursor(pos: { line: number; col: number }, timestamp: string): EditorEvent {
  return { type: "editor_cursor", timestamp, detail: { line: pos.line, col: pos.col } };
}

export function mapSelection(sel: { startLine: number; startCol: number; endLine: number; endCol: number }, timestamp: string): EditorEvent {
  return { type: "editor_selection", timestamp, detail: sel };
}

// Returns true if `next` cursor should be coalesced (dropped) because it equals `prev`.
export function coalesceCursor(prev: { line: number; col: number } | null, next: { line: number; col: number }): boolean {
  return !!prev && prev.line === next.line && prev.col === next.col;
}

export class EventBatcher {
  private buf: EditorEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private opts: { maxSize: number; maxMs: number; onFlush: (events: EditorEvent[]) => void }) {}
  add(e: EditorEvent) {
    this.buf.push(e);
    if (this.buf.length >= this.opts.maxSize) return this.flush();
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.opts.maxMs);
  }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.buf.length) return;
    const batch = this.buf; this.buf = [];
    this.opts.onFlush(batch);
  }
  dispose() { this.flush(); }
}
