// frontend/src/coding/editorEvents.test.ts
import { describe, it, expect } from "vitest";
import { mapContentChange, mapPaste, mapCursor, mapSelection, coalesceCursor, EventBatcher } from "./editorEvents";

const ts = () => "2026-06-09T10:00:00.000Z";

describe("mapContentChange", () => {
  it("maps a single-char insert to editor_insert carrying text + full range", () => {
    const ev = mapContentChange(
      { rangeLength: 0, text: "a", rangeStartLine: 1, rangeStartCol: 1, rangeEndLine: 1, rangeEndCol: 1 },
      ts()
    );
    expect(ev).toEqual({
      type: "editor_insert",
      timestamp: ts(),
      detail: { insertedLen: 1, deletedLen: 0, text: "a", startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
    });
  });
  it("maps a deletion (text empty, rangeLength>0) to editor_delete with the deleted range", () => {
    const ev = mapContentChange(
      { rangeLength: 3, text: "", rangeStartLine: 2, rangeStartCol: 4, rangeEndLine: 2, rangeEndCol: 7 },
      ts()
    );
    expect(ev).toEqual({
      type: "editor_delete",
      timestamp: ts(),
      detail: { insertedLen: 0, deletedLen: 3, text: "", startLine: 2, startCol: 4, endLine: 2, endCol: 7 },
    });
  });
  it("maps a replace (both > 0) to editor_replace carrying replacement text + replaced range", () => {
    const ev = mapContentChange(
      { rangeLength: 2, text: "xy", rangeStartLine: 1, rangeStartCol: 1, rangeEndLine: 1, rangeEndCol: 3 },
      ts()
    );
    expect(ev).toEqual({
      type: "editor_replace",
      timestamp: ts(),
      detail: { insertedLen: 2, deletedLen: 2, text: "xy", startLine: 1, startCol: 1, endLine: 1, endCol: 3 },
    });
  });
  it("carries multi-line inserted text (paste content arrives through change events)", () => {
    const pasted = "def f():\n    return 1\n";
    const ev = mapContentChange(
      { rangeLength: 0, text: pasted, rangeStartLine: 3, rangeStartCol: 1, rangeEndLine: 3, rangeEndCol: 1 },
      ts()
    );
    expect(ev.type).toBe("editor_insert");
    expect(ev.detail).toEqual({
      insertedLen: pasted.length, deletedLen: 0, text: pasted,
      startLine: 3, startCol: 1, endLine: 3, endCol: 1,
    });
  });
  it("truncates stored text at 2000 chars and sets truncated: true, keeping the real insertedLen", () => {
    const big = "x".repeat(2500);
    const ev = mapContentChange(
      { rangeLength: 0, text: big, rangeStartLine: 1, rangeStartCol: 1, rangeEndLine: 1, rangeEndCol: 1 },
      ts()
    );
    expect(ev.type).toBe("editor_insert");
    expect((ev.detail as any).text).toBe("x".repeat(2000));
    expect((ev.detail as any).text.length).toBe(2000);
    expect((ev.detail as any).truncated).toBe(true);
    expect((ev.detail as any).insertedLen).toBe(2500);
  });
  it("omits the truncated flag for text at exactly 2000 chars", () => {
    const exact = "y".repeat(2000);
    const ev = mapContentChange(
      { rangeLength: 0, text: exact, rangeStartLine: 1, rangeStartCol: 1, rangeEndLine: 1, rangeEndCol: 1 },
      ts()
    );
    expect((ev.detail as any).text).toBe(exact);
    expect(ev.detail).not.toHaveProperty("truncated");
  });
});

describe("mapPaste", () => {
  it("maps a paste to editor_paste with len + position", () => {
    const ev = mapPaste({ len: 120, line: 4, col: 7 }, ts());
    expect(ev).toEqual({
      type: "editor_paste",
      timestamp: ts(),
      detail: { len: 120, line: 4, col: 7 },
    });
  });
});

describe("mapCursor", () => {
  it("maps a cursor move to editor_cursor with line/col", () => {
    const ev = mapCursor({ line: 12, col: 3 }, ts());
    expect(ev).toEqual({
      type: "editor_cursor",
      timestamp: ts(),
      detail: { line: 12, col: 3 },
    });
  });
});

describe("mapSelection", () => {
  it("maps a selection to editor_selection with the full range", () => {
    const ev = mapSelection({ startLine: 2, startCol: 1, endLine: 5, endCol: 10 }, ts());
    expect(ev).toEqual({
      type: "editor_selection",
      timestamp: ts(),
      detail: { startLine: 2, startCol: 1, endLine: 5, endCol: 10 },
    });
  });
});

describe("coalesceCursor", () => {
  it("drops a cursor event that lands on the same line/col as the previous within the window", () => {
    const a = { line: 5, col: 2 }; const b = { line: 5, col: 2 };
    expect(coalesceCursor(a, b)).toBe(true); // true => should be dropped/coalesced
  });
  it("keeps a cursor move to a different line", () => {
    expect(coalesceCursor({ line: 5, col: 2 }, { line: 8, col: 1 })).toBe(false);
  });
});

describe("EventBatcher", () => {
  it("flushes when batch reaches maxSize", async () => {
    const flushed: any[][] = [];
    const b = new EventBatcher({ maxSize: 2, maxMs: 100000, onFlush: (evs) => flushed.push(evs) });
    b.add({ type: "editor_insert", timestamp: ts() });
    b.add({ type: "editor_insert", timestamp: ts() });
    expect(flushed.length).toBe(1);
    expect(flushed[0].length).toBe(2);
    b.dispose();
  });
});
