// frontend/src/recordingTimeline.test.ts — pure logic for the recordings
// timeline activity overlay + click-to-jump log (F6.7): test-relative offset
// computation, merge of the three streams (alerts / events / submissions),
// kind+severity filtering, blackout (recording-gap) tagging, and the simple
// offset-clustering used to keep dense event markers legible.
import { describe, expect, it } from "vitest";
import type { Alert, SessionEventItem, SubmissionEvent } from "./types";
import {
  DEFAULT_LOG_FILTERS,
  alertsForCandidate,
  buildTimelineLog,
  clusterMarkers,
  eventLabel,
  filterTimelineLog,
  isDuringGap,
  offsetSecFor,
  summarizeEventDetail
} from "./recordingTimeline";

const T0 = Date.parse("2026-06-05T09:00:00.000Z");

function alert(overrides: Partial<Alert>): Alert {
  return {
    id: "proctor:tab_away:asha_r:c1:1",
    source: "proctor",
    type: "tab_away",
    severity: "warning",
    timestamp: "2026-06-05T09:10:00.000Z",
    hackerrank_username: "Asha_R",
    title: "Tab switched away",
    ...overrides
  };
}

function event(overrides: Partial<SessionEventItem>): SessionEventItem {
  return { type: "window_blur", timestamp: "2026-06-05T09:05:00.000Z", ...overrides };
}

function submission(overrides: Partial<SubmissionEvent>): SubmissionEvent {
  return {
    submission_id: "s-1",
    hackerrank_username: "Asha_R",
    valid: true,
    submitted_at: "2026-06-05T09:15:00.000Z",
    status: "Accepted",
    challenge_name: "Two Sum",
    ...overrides
  };
}

describe("offsetSecFor", () => {
  it("is (timestamp − testStart) in seconds", () => {
    expect(offsetSecFor("2026-06-05T09:01:30.000Z", T0)).toBe(90);
    expect(offsetSecFor("2026-06-05T08:59:00.000Z", T0)).toBe(-60);
  });
  it("returns null for invalid timestamps or an invalid test start", () => {
    expect(offsetSecFor("garbage", T0)).toBeNull();
    expect(offsetSecFor("", T0)).toBeNull();
    expect(offsetSecFor("2026-06-05T09:01:30.000Z", Number.NaN)).toBeNull();
  });
});

describe("isDuringGap", () => {
  const gaps = [
    { fromSec: 100, toSec: 200 },
    { fromSec: 500, toSec: 530 }
  ];
  it("is true inside (and at the edges of) a gap", () => {
    expect(isDuringGap(150, gaps)).toBe(true);
    expect(isDuringGap(100, gaps)).toBe(true);
    expect(isDuringGap(200, gaps)).toBe(true);
    expect(isDuringGap(510, gaps)).toBe(true);
  });
  it("is false outside every gap", () => {
    expect(isDuringGap(99, gaps)).toBe(false);
    expect(isDuringGap(300, gaps)).toBe(false);
    expect(isDuringGap(0, [])).toBe(false);
  });
});

describe("eventLabel", () => {
  it("maps known event types to friendly labels", () => {
    expect(eventLabel("window_blur")).toBe("Window lost focus");
    expect(eventLabel("clipboard_activity")).toBe("Clipboard activity");
    expect(eventLabel("ip_address_changed")).toBe("IP address changed");
    expect(eventLabel("session_started")).toBe("Session started");
  });
  it("visibility_change uses the detail state", () => {
    expect(eventLabel("visibility_change", { state: "hidden" })).toBe("Tab hidden");
    expect(eventLabel("visibility_change", { state: "visible" })).toBe("Tab visible");
    expect(eventLabel("visibility_change")).toBe("Tab visibility changed");
  });
  it("falls back to humanizing unknown types", () => {
    expect(eventLabel("weird_new_thing")).toBe("weird new thing");
  });
});

describe("summarizeEventDetail", () => {
  it("joins scalar entries into a short one-liner", () => {
    expect(summarizeEventDetail({ state: "hidden", count: 2 })).toBe("state: hidden · count: 2");
  });
  it("caps entries and truncates long values", () => {
    const summary = summarizeEventDetail({ a: 1, b: 2, c: 3, d: 4 });
    expect(summary).toBe("a: 1 · b: 2 · c: 3");
    expect(summarizeEventDetail({ msg: "x".repeat(200) })).toHaveLength("msg: ".length + 80 + 1); // truncated + ellipsis
  });
  it("is empty for missing/empty detail", () => {
    expect(summarizeEventDetail(undefined)).toBe("");
    expect(summarizeEventDetail({})).toBe("");
  });
});

describe("buildTimelineLog", () => {
  const gaps = [{ fromSec: 240, toSec: 360 }]; // blackout 4–6 min

  it("merges the three streams time-ordered with kind, offset and labels", () => {
    const entries = buildTimelineLog({
      alerts: [alert({ timestamp: "2026-06-05T09:10:00.000Z" })],
      events: [event({ timestamp: "2026-06-05T09:05:00.000Z" })],
      submissions: [submission({ submitted_at: "2026-06-05T09:15:00.000Z" })],
      testStartMs: T0,
      gaps: []
    });
    expect(entries.map((e) => e.kind)).toEqual(["event", "alert", "submission"]);
    expect(entries.map((e) => e.offsetSec)).toEqual([300, 600, 900]);
    expect(entries[0].label).toBe("Window lost focus");
    expect(entries[1].label).toBe("Tab switched away");
    expect(entries[1].severity).toBe("warning");
    expect(entries[2].label).toBe("Accepted · Two Sum");
    expect(entries[2].valid).toBe(true);
  });

  it("labels failed submissions with their status", () => {
    const [entry] = buildTimelineLog({
      alerts: [],
      events: [],
      submissions: [submission({ valid: false, status: "Wrong Answer", challenge_name: "LRU Cache" })],
      testStartMs: T0,
      gaps: []
    });
    expect(entry.label).toBe("Wrong Answer · LRU Cache");
    expect(entry.valid).toBe(false);
  });

  it("tags entries that land inside a recording gap as duringGap", () => {
    const entries = buildTimelineLog({
      alerts: [],
      events: [
        event({ timestamp: "2026-06-05T09:05:00.000Z" }), // 300s → inside 240–360
        event({ timestamp: "2026-06-05T09:08:00.000Z" }) // 480s → outside
      ],
      submissions: [],
      testStartMs: T0,
      gaps
    });
    expect(entries.map((e) => e.duringGap)).toEqual([true, false]);
  });

  it("skips noise event types and records with invalid timestamps", () => {
    const entries = buildTimelineLog({
      alerts: [alert({ timestamp: "garbage" })],
      events: [
        event({ type: "chunk_uploaded", timestamp: "2026-06-05T09:01:00.000Z" }),
        event({ type: "event_upload_error", timestamp: "2026-06-05T09:01:10.000Z" }),
        event({ timestamp: "2026-06-05T09:02:00.000Z" })
      ],
      submissions: [],
      testStartMs: T0,
      gaps: []
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("event");
    expect(entries[0].type).toBe("window_blur");
  });

  it("returns nothing when the test start is invalid (no anchor, no offsets)", () => {
    const entries = buildTimelineLog({
      alerts: [alert({})],
      events: [event({})],
      submissions: [submission({})],
      testStartMs: Number.NaN,
      gaps: []
    });
    expect(entries).toEqual([]);
  });

  it("gives every entry a stable unique id", () => {
    const entries = buildTimelineLog({
      alerts: [alert({})],
      events: [event({}), event({})], // identical events must still get distinct ids
      submissions: [submission({})],
      testStartMs: T0,
      gaps: []
    });
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("filterTimelineLog", () => {
  const entries = buildTimelineLog({
    alerts: [
      alert({ id: "a-crit", severity: "critical", timestamp: "2026-06-05T09:01:00.000Z" }),
      alert({ id: "a-warn", severity: "warning", timestamp: "2026-06-05T09:02:00.000Z" })
    ],
    events: [event({ timestamp: "2026-06-05T09:03:00.000Z" })],
    submissions: [submission({ submitted_at: "2026-06-05T09:04:00.000Z" })],
    testStartMs: T0,
    gaps: []
  });

  it("defaults keep everything", () => {
    expect(filterTimelineLog(entries, DEFAULT_LOG_FILTERS)).toHaveLength(4);
  });

  it("kind toggles drop that stream", () => {
    expect(filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, events: false }).map((e) => e.kind)).toEqual([
      "alert",
      "alert",
      "submission"
    ]);
    expect(filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, alerts: false, submissions: false })).toHaveLength(1);
  });

  it("severity narrows alerts only (events/submissions unaffected)", () => {
    const critOnly = filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, severity: "critical" });
    expect(critOnly.map((e) => e.id)).toEqual(["alert:a-crit", entries[2].id, entries[3].id]);
  });
});

describe("alertsForCandidate", () => {
  const alerts = [
    alert({ id: "a1", username_norm: "asha_r", hackerrank_username: "Asha_R" }),
    alert({ id: "a2", username_norm: "karan_v", hackerrank_username: "Karan_V" }),
    alert({ id: "a3", username_norm: undefined, hackerrank_username: "Asha_R" })
  ];

  it("matches on username_norm, falling back to a lowercase username compare", () => {
    const mine = alertsForCandidate(alerts, { username_norm: "asha_r", hackerrank_username: "Asha_R" });
    expect(mine.map((a) => a.id)).toEqual(["a1", "a3"]);
  });

  it("uses the lowercased username when the session has no username_norm", () => {
    const mine = alertsForCandidate(alerts, { hackerrank_username: "Karan_V" });
    expect(mine.map((a) => a.id)).toEqual(["a2"]);
  });

  it("matches nothing when the session has no identity", () => {
    expect(alertsForCandidate(alerts, {})).toEqual([]);
  });
});

describe("clusterMarkers", () => {
  const entries = buildTimelineLog({
    alerts: [],
    events: [
      event({ timestamp: "2026-06-05T09:00:10.000Z" }), // 10s
      event({ timestamp: "2026-06-05T09:00:12.000Z" }), // 12s — clusters with 10s
      event({ timestamp: "2026-06-05T09:05:00.000Z" }) // 300s — far away
    ],
    submissions: [],
    testStartMs: T0,
    gaps: []
  });

  it("groups markers closer than minSepSec into one cluster", () => {
    const clusters = clusterMarkers(entries, 5);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].entries).toHaveLength(2);
    expect(clusters[0].offsetSec).toBe(10);
    expect(clusters[1].entries).toHaveLength(1);
    expect(clusters[1].offsetSec).toBe(300);
  });

  it("keeps every marker separate when they are spread out", () => {
    expect(clusterMarkers(entries, 1)).toHaveLength(3);
    expect(clusterMarkers([], 5)).toEqual([]);
  });
});
