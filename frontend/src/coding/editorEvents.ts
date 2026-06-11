// frontend/src/coding/editorEvents.ts
import type { EditorEvent } from "../types";

export type ContentChange = {
  rangeLength: number;
  text: string;
  rangeStartLine: number;
  rangeStartCol: number;
  rangeEndLine: number;
  rangeEndCol: number;
};

// Stored text cap per change event (design §4.2: events carry text + full range;
// paste content arrives through these change events, so cap pathological inserts).
export const MAX_STORED_TEXT_CHARS = 2000;

export function mapContentChange(c: ContentChange, timestamp: string): EditorEvent {
  const insertedLen = c.text.length;
  const deletedLen = c.rangeLength;
  let type: EditorEvent["type"];
  if (insertedLen > 0 && deletedLen > 0) type = "editor_replace";
  else if (deletedLen > 0) type = "editor_delete";
  else type = "editor_insert";
  const detail: Record<string, unknown> = {
    insertedLen,
    deletedLen,
    text: insertedLen > MAX_STORED_TEXT_CHARS ? c.text.slice(0, MAX_STORED_TEXT_CHARS) : c.text,
    startLine: c.rangeStartLine,
    startCol: c.rangeStartCol,
    endLine: c.rangeEndLine,
    endCol: c.rangeEndCol,
  };
  if (insertedLen > MAX_STORED_TEXT_CHARS) detail.truncated = true;
  return { type, timestamp, detail };
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

// S-I §3.5: the switch marker — sent in the INCOMING problem's batch so the
// post-spine code-replay scrubber can stitch per-problem timelines.
export function problemSwitchedEvent(fromProblemId: string, toProblemId: string, timestamp: string): EditorEvent {
  return {
    type: "problem_switched",
    timestamp,
    detail: { from_problem_id: fromProblemId, to_problem_id: toProblemId }
  };
}

// S-I §3.5: one EventBatcher per problem, created lazily — batches stay
// problem-homogeneous by construction (the backend stores one problem_id per
// NDJSON batch). switchTo() flushes the OUTGOING problem's batcher on every
// switch and queues the problem_switched marker on the incoming one; dispose()
// flushes everything (workspace unmount loses nothing).
export class ProblemBatchers {
  private batchers = new Map<string, EventBatcher>();
  constructor(private opts: { maxSize: number; maxMs: number; onFlush: (problemId: string, events: EditorEvent[]) => void }) {}
  private batcherFor(problemId: string): EventBatcher {
    let batcher = this.batchers.get(problemId);
    if (!batcher) {
      batcher = new EventBatcher({
        maxSize: this.opts.maxSize,
        maxMs: this.opts.maxMs,
        onFlush: (events) => this.opts.onFlush(problemId, events)
      });
      this.batchers.set(problemId, batcher);
    }
    return batcher;
  }
  add(problemId: string, event: EditorEvent) { this.batcherFor(problemId).add(event); }
  flush(problemId: string) { this.batchers.get(problemId)?.flush(); }
  switchTo(fromProblemId: string, toProblemId: string, timestamp: string) {
    this.batchers.get(fromProblemId)?.flush();
    this.add(toProblemId, problemSwitchedEvent(fromProblemId, toProblemId, timestamp));
  }
  dispose() { for (const batcher of this.batchers.values()) batcher.dispose(); }
}
