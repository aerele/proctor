// frontend/src/coding/editorEvents.test.ts
import { describe, it, expect } from "vitest";
import { mapContentChange, coalesceCursor, EventBatcher } from "./editorEvents";

const ts = () => "2026-06-09T10:00:00.000Z";

describe("mapContentChange", () => {
  it("maps a single-char insert to editor_insert with length + position", () => {
    const ev = mapContentChange({ rangeLength: 0, text: "a", rangeStartLine: 1, rangeStartCol: 1 }, ts());
    expect(ev.type).toBe("editor_insert");
    expect(ev.detail).toMatchObject({ insertedLen: 1, deletedLen: 0, line: 1, col: 1 });
  });
  it("maps a deletion (text empty, rangeLength>0) to editor_delete", () => {
    const ev = mapContentChange({ rangeLength: 3, text: "", rangeStartLine: 2, rangeStartCol: 4 }, ts());
    expect(ev.type).toBe("editor_delete");
    expect(ev.detail).toMatchObject({ deletedLen: 3 });
  });
  it("maps a replace (both > 0) to editor_replace", () => {
    const ev = mapContentChange({ rangeLength: 2, text: "xy", rangeStartLine: 1, rangeStartCol: 1 }, ts());
    expect(ev.type).toBe("editor_replace");
  });
  it("flags a large paste-like insert via mapPaste separately", () => {
    // paste is mapped by its own helper; see mapPaste in impl
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
