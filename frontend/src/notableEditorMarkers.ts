// frontend/src/notableEditorMarkers.ts — pure classifier (EVID-1). Takes the raw
// per-session EDITOR event stream (GET /api/admin/session-editor-events) and
// returns the NOTABLE subset — large pastes, smaller pastes, and keystroke
// bursts — as time-placed markers for the recording Evidence-tab timeline lane.
// No React, no IO; everything here is vitest-covered (notableEditorMarkers.test.ts).
//
// "Notable" is decided CLIENT-SIDE from fields already on each editor event,
// using thresholds COPIED from the eval engine so the markers track the
// detectors. We do NOT import across the frontend/backend boundary (they share no
// module graph) — the constants are duplicated WITH a citation, the same pattern
// CHUNK_SECONDS etc. already use. See docs/proposed/evidence-keystroke-markers.md.
import type { EditorEventItem } from "./types";
import { offsetSecFor, isDuringGap, type TimelineGapSpan } from "./recordingTimeline";

// Threshold constants — kept aligned with the eval REPLAY detectors. A retune
// there must be mirrored here (and vice-versa) to keep the marker definition
// tracking what the scorecard flags:
//   FOREIGN_PASTE_LEN  ← REPLAY.MIN_FOREIGN_PASTE_LEN = 30  (backend/src/evaluationReplay.mjs:21)
//   BURST_WINDOW_MS    ← REPLAY.BURST_WINDOW_MS       = 2000 (backend/src/evaluationReplay.mjs:24)
//   BURST_MIN_CHARS    ← REPLAY.BURST_MIN_CHARS        = 80  (backend/src/evaluationReplay.mjs:25)
export const NOTABLE = {
  FOREIGN_PASTE_LEN: 30,
  BURST_WINDOW_MS: 2000,
  BURST_MIN_CHARS: 80
} as const;

// Defensive cap on the number of rendered markers — a pathological session can
// emit thousands of pastes/bursts and we never want to smear that many DOM ticks
// onto the scrubber. After classification we keep the most notable N (by char
// count). Mirrors the SESSION_EVENTS_LIMIT discipline (adminSessions.mjs).
export const MAX_NOTABLE_MARKERS = 300;

export type NotableMarkerKind = "large_paste" | "paste" | "keystroke_burst";

// One classified, time-placed editor marker for the recording timeline.
export type NotableEditorMarker = {
  kind: NotableMarkerKind;
  /** Stable React key: `${kind}:${problemId}:${index}@${timestamp}`. */
  id: string;
  /** ISO of the underlying editor event (the window START for bursts). */
  timestamp: string;
  /** Test-relative seconds (offsetSecFor result; can be negative pre-start). */
  offsetSec: number;
  /** Pasted/inserted char count (for the label + relative sizing). */
  chars: number;
  problemId: string | null;
  duringGap: boolean;
  /** e.g. "Large paste · 412 chars" / "Typing burst · 140 chars". */
  label: string;
};

// Read a non-negative integer field off a (scalar-only) editor detail. The
// backend projection keeps len/insertedLen as numbers, but be defensive against
// strings/missing/negative — return 0 for anything that isn't a finite count.
function countField(detail: EditorEventItem["detail"], key: string): number {
  const raw = detail?.[key];
  const num = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

// The inserted-char count for an insert/replace event (insertedLen), or the
// pasted-char count for a paste (len). Used by both the paste classifier and the
// burst accumulator. editor_paste carries `len`; insert/replace carry `insertedLen`.
function pasteChars(event: EditorEventItem): number {
  return countField(event.detail, "len");
}
function insertedChars(event: EditorEventItem): number {
  return countField(event.detail, "insertedLen");
}

function problemIdOf(event: EditorEventItem): string | null {
  const id = event.problem_id;
  return id == null || id === "" ? null : String(id);
}

// M2: cap-ranking tier — higher wins a seat first. Pastes (foreign source
// appearing in the editor) are the stronger integrity signal than a fast typing
// burst, so they outrank bursts regardless of the bursts' larger summed char
// count. large_paste and paste share a tier (char count tiebreaks within it);
// keystroke_burst sits below both.
function notabilityTier(kind: NotableMarkerKind): number {
  return kind === "keystroke_burst" ? 0 : 1;
}

// Classify an editor-event stream into notable paste/keystroke markers placed on
// the test-relative scale.
//
// Behaviour:
//  - Returns [] when the test-start anchor is non-finite (offsetSecFor returns
//    null for every event in that case anyway — guarded explicitly for clarity).
//  - Sorts events by timestamp first, so the burst sliding-window sees them in order.
//  - Emits a `large_paste`/`paste` marker per qualifying paste OR large insert/replace.
//  - Runs a sliding-window accumulator over SINGLE-CHAR inserts (insertedLen===1),
//    emitting one `keystroke_burst` per window whose summed chars cross BURST_MIN_CHARS.
//  - Drops events with unparseable timestamps (offsetSecFor === null).
//  - Caps to MAX_NOTABLE_MARKERS, keeping the highest char counts.
//  - Returns the kept markers sorted by offsetSec.
export function buildNotableEditorMarkers(params: {
  events: EditorEventItem[];
  testStartMs: number;
  gaps: TimelineGapSpan[];
}): NotableEditorMarker[] {
  const { events, testStartMs, gaps } = params;
  if (!Number.isFinite(testStartMs) || !events.length) return [];

  // Sort a COPY by timestamp so the input order doesn't matter and the burst
  // window walks chronologically. localeCompare matches the backend's ordering.
  const sorted = [...events].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  const markers: NotableEditorMarker[] = [];

  const pushMarker = (
    kind: NotableMarkerKind,
    event: EditorEventItem,
    index: number,
    chars: number,
    labelHead: string
  ): void => {
    const offsetSec = offsetSecFor(event.timestamp, testStartMs);
    if (offsetSec === null) return; // unparseable timestamp / no anchor → drop
    const problemId = problemIdOf(event);
    markers.push({
      kind,
      id: `${kind}:${problemId ?? "?"}:${index}@${event.timestamp}`,
      timestamp: event.timestamp,
      offsetSec,
      chars,
      problemId,
      duringGap: isDuringGap(offsetSec, gaps),
      label: `${labelHead} · ${chars} char${chars === 1 ? "" : "s"}`
    });
  };

  // ---- Pastes / large inserts (one marker per qualifying event) -------------
  sorted.forEach((event, index) => {
    if (event.type === "editor_paste") {
      const chars = pasteChars(event);
      if (chars <= 0) return; // a paste of nothing isn't notable
      if (chars >= NOTABLE.FOREIGN_PASTE_LEN) pushMarker("large_paste", event, index, chars, "Large paste");
      else pushMarker("paste", event, index, chars, "Paste");
    } else if (event.type === "editor_insert" || event.type === "editor_replace") {
      // A big PROGRAMMATIC insert/replace (e.g. an IDE auto-fill or a paste that
      // surfaced as a replace) crossing the foreign-paste floor is a large_paste
      // too — same reviewer-actionable "a big blob appeared here" fact.
      const chars = insertedChars(event);
      if (chars >= NOTABLE.FOREIGN_PASTE_LEN) pushMarker("large_paste", event, index, chars, "Large paste");
    }
  });

  // ---- Keystroke bursts (sliding window over single-char inserts) -----------
  // A sudden flood of TYPED chars: within a BURST_WINDOW_MS window, the summed
  // chars of single-char editor_inserts >= BURST_MIN_CHARS. Each crossing emits
  // ONE burst marker anchored at the window's FIRST keystroke, then the window
  // resets so one long typing run yields one marker per BURST_MIN_CHARS-worth.
  //
  // M1: the window is PER-PROBLEM, matching the backend detector
  // (evaluationReplay.mjs addToBurst — a separate burstWin array keyed by pid).
  // A single global window would sum the tail of problem A and the head of
  // problem B that fall within BURST_WINDOW_MS into a FAKE burst mis-attributed
  // to A. We partition keystrokes by problem_id and walk an independent sliding
  // window per bucket; a null/empty problem_id is its own bucket. The kept-order
  // is preserved by anchoring each emitted burst at its real event index, then
  // re-sorting at the end (return is by offsetSec regardless).
  const keystrokesByProblem = new Map<string, Array<{ event: EditorEventItem; index: number; ms: number }>>();
  sorted.forEach((event, index) => {
    if (event.type !== "editor_insert" || insertedChars(event) !== 1) return;
    const ms = Date.parse(event.timestamp || "");
    if (!Number.isFinite(ms)) return;
    // Bucket key: the problem id, or a sentinel for null/empty so unattributed
    // keystrokes form their own window and never merge with a real problem's.
    const key = problemIdOf(event) ?? " __no_problem__";
    let bucket = keystrokesByProblem.get(key);
    if (!bucket) {
      bucket = [];
      keystrokesByProblem.set(key, bucket);
    }
    bucket.push({ event, index, ms });
  });

  for (const keystrokes of keystrokesByProblem.values()) {
    let windowStart = 0; // index into `keystrokes` of the current window's first stroke
    let windowChars = 0;
    for (let i = 0; i < keystrokes.length; i += 1) {
      // Advance the window start until [windowStart, i] fits inside BURST_WINDOW_MS.
      while (keystrokes[i].ms - keystrokes[windowStart].ms > NOTABLE.BURST_WINDOW_MS) {
        windowChars -= 1; // each kept stroke contributed exactly 1 char
        windowStart += 1;
      }
      windowChars += 1;
      if (windowChars >= NOTABLE.BURST_MIN_CHARS) {
        const anchor = keystrokes[windowStart];
        pushMarker("keystroke_burst", anchor.event, anchor.index, windowChars, "Typing burst");
        // Reset the window AFTER the crossing stroke so a long run produces one
        // marker per BURST_MIN_CHARS, not one per stroke past the threshold.
        windowStart = i + 1;
        windowChars = 0;
      }
    }
  }

  // ---- Cap (keep the most notable) + final ordering -------------------------
  // M2: rank by a NOTABILITY TIER before char count. A keystroke burst's summed
  // chars dwarf a single paste's (80+ vs one ~30-char paste), so a pure
  // `b.chars - a.chars` cap would evict pastes — the STRONGER cheating signal
  // (foreign source appearing) — in favour of bursts. We tier pastes above
  // bursts and use chars only as the in-tier tiebreak, so at the cap pastes are
  // retained first and bursts fill the remainder. (Tier-then-chars is cleaner
  // than per-kind quotas: no share-size to tune, and it degrades gracefully when
  // one kind is absent.)
  let kept = markers;
  if (kept.length > MAX_NOTABLE_MARKERS) {
    kept = [...markers]
      .sort((a, b) => notabilityTier(b.kind) - notabilityTier(a.kind) || b.chars - a.chars)
      .slice(0, MAX_NOTABLE_MARKERS);
  }
  return kept.sort(
    (a, b) => a.offsetSec - b.offsetSec || a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)
  );
}
