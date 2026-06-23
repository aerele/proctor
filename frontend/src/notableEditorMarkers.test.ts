// frontend/src/notableEditorMarkers.test.ts — pure classifier (EVID-1): which
// editor events count as NOTABLE paste/keystroke markers, their test-relative
// placement, blackout tagging, ordering, dedup-key stability, the N-cap, and the
// empty / no-anchor degenerate cases. No React, no IO.
import { describe, expect, it } from "vitest";
import type { EditorEventItem } from "./types";
import type { TimelineGapSpan } from "./recordingTimeline";
import { offsetSecFor } from "./recordingTimeline";
import {
  MAX_NOTABLE_MARKERS,
  NOTABLE,
  buildNotableEditorMarkers
} from "./notableEditorMarkers";

const T0 = Date.parse("2026-06-05T09:00:00.000Z");

// ISO timestamp `sec` seconds (and optional `ms`) past the test start.
function at(sec: number, ms = 0): string {
  return new Date(T0 + sec * 1000 + ms).toISOString();
}

function ev(overrides: Partial<EditorEventItem> & { type: string; timestamp: string }): EditorEventItem {
  return { problem_id: "sum-two", detail: {}, ...overrides };
}

function build(events: EditorEventItem[], gaps: TimelineGapSpan[] = []) {
  return buildNotableEditorMarkers({ events, testStartMs: T0, gaps });
}

describe("buildNotableEditorMarkers — paste classification", () => {
  it("flags a paste at the FOREIGN_PASTE_LEN boundary as large_paste", () => {
    const markers = build([
      ev({ type: "editor_paste", timestamp: at(10), detail: { len: NOTABLE.FOREIGN_PASTE_LEN } })
    ]);
    expect(markers).toHaveLength(1);
    expect(markers[0].kind).toBe("large_paste");
    expect(markers[0].chars).toBe(NOTABLE.FOREIGN_PASTE_LEN);
    expect(markers[0].label).toBe(`Large paste · ${NOTABLE.FOREIGN_PASTE_LEN} chars`);
  });

  it("flags a small paste (below the floor) as a plain paste tick", () => {
    const markers = build([
      ev({ type: "editor_paste", timestamp: at(5), detail: { len: NOTABLE.FOREIGN_PASTE_LEN - 1 } })
    ]);
    expect(markers).toHaveLength(1);
    expect(markers[0].kind).toBe("paste");
    expect(markers[0].label).toContain("Paste");
  });

  it("ignores an empty paste (len 0 or missing)", () => {
    expect(build([ev({ type: "editor_paste", timestamp: at(1), detail: { len: 0 } })])).toHaveLength(0);
    expect(build([ev({ type: "editor_paste", timestamp: at(1), detail: {} })])).toHaveLength(0);
  });

  it("flags a big editor_insert / editor_replace (insertedLen ≥ floor) as large_paste", () => {
    const markers = build([
      ev({ type: "editor_insert", timestamp: at(2), detail: { insertedLen: 120 } }),
      ev({ type: "editor_replace", timestamp: at(3), detail: { insertedLen: NOTABLE.FOREIGN_PASTE_LEN } })
    ]);
    expect(markers).toHaveLength(2);
    expect(markers.every((m) => m.kind === "large_paste")).toBe(true);
    expect(markers[0].chars).toBe(120);
  });

  it("does NOT flag a small insert/replace below the floor (those feed the burst path only)", () => {
    const markers = build([
      ev({ type: "editor_insert", timestamp: at(2), detail: { insertedLen: 1 } }),
      ev({ type: "editor_replace", timestamp: at(3), detail: { insertedLen: 10 } })
    ]);
    expect(markers).toHaveLength(0);
  });
});

describe("buildNotableEditorMarkers — keystroke bursts", () => {
  // 80 single-char inserts spread 20ms apart → all inside one 2000ms window.
  function singleCharInserts(count: number, stepMs: number): EditorEventItem[] {
    return Array.from({ length: count }, (_unused, i) =>
      ev({ type: "editor_insert", timestamp: at(10, i * stepMs), detail: { insertedLen: 1 } })
    );
  }

  it("emits ONE burst when BURST_MIN_CHARS single-char inserts land inside BURST_WINDOW_MS", () => {
    const markers = build(singleCharInserts(NOTABLE.BURST_MIN_CHARS, 20)); // 80 strokes over ~1580ms
    const bursts = markers.filter((m) => m.kind === "keystroke_burst");
    expect(bursts).toHaveLength(1);
    expect(bursts[0].chars).toBe(NOTABLE.BURST_MIN_CHARS);
    expect(bursts[0].label).toBe(`Typing burst · ${NOTABLE.BURST_MIN_CHARS} chars`);
    // Anchored at the window's FIRST keystroke.
    expect(bursts[0].timestamp).toBe(at(10, 0));
  });

  it("emits NO burst when the same chars are spread over 10s (cadence too slow)", () => {
    // 80 strokes, 130ms apart → ~10.3s, never 80 within any 2000ms window.
    const markers = build(singleCharInserts(NOTABLE.BURST_MIN_CHARS, 130));
    expect(markers.filter((m) => m.kind === "keystroke_burst")).toHaveLength(0);
  });

  it("emits one burst per BURST_MIN_CHARS-worth in a sustained fast run (window resets)", () => {
    // 160 strokes 10ms apart → two BURST_MIN_CHARS windows.
    const markers = build(singleCharInserts(NOTABLE.BURST_MIN_CHARS * 2, 10));
    expect(markers.filter((m) => m.kind === "keystroke_burst")).toHaveLength(2);
  });

  it("does not count multi-char inserts toward a burst (only single-char keystrokes)", () => {
    // 79 single-char + one big insert in window → the big insert is a large_paste,
    // and the single chars never reach 80 so there is no burst.
    const events = [
      ...Array.from({ length: 79 }, (_unused, i) =>
        ev({ type: "editor_insert", timestamp: at(10, i * 10), detail: { insertedLen: 1 } })
      ),
      ev({ type: "editor_insert", timestamp: at(10, 800), detail: { insertedLen: 200 } })
    ];
    const markers = build(events);
    expect(markers.filter((m) => m.kind === "keystroke_burst")).toHaveLength(0);
    expect(markers.filter((m) => m.kind === "large_paste")).toHaveLength(1);
  });
});

describe("buildNotableEditorMarkers — placement, ordering, gaps, ids", () => {
  it("offsetSec equals offsetSecFor(timestamp, testStartMs)", () => {
    const ts = at(42);
    const markers = build([ev({ type: "editor_paste", timestamp: ts, detail: { len: 100 } })]);
    expect(markers[0].offsetSec).toBe(offsetSecFor(ts, T0));
    expect(markers[0].offsetSec).toBe(42);
  });

  it("allows a NEGATIVE offset for a pre-start paste (matches buildTimelineLog)", () => {
    const markers = build([ev({ type: "editor_paste", timestamp: at(-7), detail: { len: 100 } })]);
    expect(markers).toHaveLength(1);
    expect(markers[0].offsetSec).toBe(-7);
  });

  it("returns markers sorted by offsetSec regardless of input order", () => {
    const markers = build([
      ev({ type: "editor_paste", timestamp: at(30), detail: { len: 100 } }),
      ev({ type: "editor_paste", timestamp: at(5), detail: { len: 100 } }),
      ev({ type: "editor_paste", timestamp: at(20), detail: { len: 100 } })
    ]);
    expect(markers.map((m) => m.offsetSec)).toEqual([5, 20, 30]);
  });

  it("tags a marker whose offset lands inside a supplied gap span as duringGap", () => {
    const markers = build(
      [
        ev({ type: "editor_paste", timestamp: at(50), detail: { len: 100 } }),
        ev({ type: "editor_paste", timestamp: at(80), detail: { len: 100 } })
      ],
      [{ fromSec: 40, toSec: 60 }]
    );
    const inGap = markers.find((m) => m.offsetSec === 50);
    const outGap = markers.find((m) => m.offsetSec === 80);
    expect(inGap?.duringGap).toBe(true);
    expect(outGap?.duringGap).toBe(false);
  });

  it("surfaces the problem_id and carries a stable, unique id per marker", () => {
    const markers = build([
      ev({ type: "editor_paste", timestamp: at(10), problem_id: "n-queens", detail: { len: 100 } }),
      ev({ type: "editor_paste", timestamp: at(11), problem_id: "n-queens", detail: { len: 100 } })
    ]);
    expect(markers[0].problemId).toBe("n-queens");
    const ids = new Set(markers.map((m) => m.id));
    expect(ids.size).toBe(markers.length); // ids are unique
  });

  it("drops events with an unparseable timestamp", () => {
    const markers = build([
      ev({ type: "editor_paste", timestamp: "not-a-date", detail: { len: 100 } }),
      ev({ type: "editor_paste", timestamp: at(10), detail: { len: 100 } })
    ]);
    expect(markers).toHaveLength(1);
    expect(markers[0].offsetSec).toBe(10);
  });
});

describe("buildNotableEditorMarkers — degenerate inputs + cap", () => {
  it("returns [] for empty input", () => {
    expect(build([])).toEqual([]);
  });

  it("returns [] when testStartMs is non-finite", () => {
    const markers = buildNotableEditorMarkers({
      events: [ev({ type: "editor_paste", timestamp: at(10), detail: { len: 100 } })],
      testStartMs: NaN,
      gaps: []
    });
    expect(markers).toEqual([]);
  });

  it("caps to MAX_NOTABLE_MARKERS, keeping the largest pastes", () => {
    // (MAX + 50) pastes: the FIRST 50 are tiny-but-notable, the rest are huge.
    // The cap must keep the huge ones (highest char count) and drop the small.
    const events: EditorEventItem[] = [];
    for (let i = 0; i < MAX_NOTABLE_MARKERS + 50; i += 1) {
      const big = i >= 50;
      events.push(ev({ type: "editor_paste", timestamp: at(i), detail: { len: big ? 1000 : 31 } }));
    }
    const markers = build(events);
    expect(markers).toHaveLength(MAX_NOTABLE_MARKERS);
    expect(markers.every((m) => m.chars === 1000)).toBe(true);
  });

  it("never exceeds the cap", () => {
    const events = Array.from({ length: MAX_NOTABLE_MARKERS * 2 }, (_unused, i) =>
      ev({ type: "editor_paste", timestamp: at(i), detail: { len: 100 + i } })
    );
    expect(build(events).length).toBeLessThanOrEqual(MAX_NOTABLE_MARKERS);
  });
});
