// frontend/src/recordingTimeline.test.ts — pure logic for the recordings
// timeline activity overlay + click-to-jump log (F6.7): test-relative offset
// computation, merge of the three streams (alerts / events / submissions),
// kind+severity filtering, blackout (recording-gap) tagging, and the simple
// offset-clustering used to keep dense event markers legible.
import { describe, expect, it } from "vitest";
import type { Alert, SessionEventItem, SubmissionEvent } from "./types";
import {
  DEFAULT_LOG_FILTERS,
  EVENT_TYPE_MAX,
  alertTypeFacets,
  alertsForCandidate,
  buildTimelineLog,
  clampEventType,
  clusterMarkers,
  eventLabel,
  eventTypeFacets,
  filterTimelineLog,
  isDuringGap,
  isInfoEntry,
  offsetSecFor,
  submissionScoreSummary,
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
    // F10.1: the separate camera stream's lifecycle events read plainly.
    expect(eventLabel("camera_recording_started")).toBe("Camera recording started");
    expect(eventLabel("camera_recording_error")).toBe("Camera recording error");
  });
  it("visibility_change uses the detail state", () => {
    expect(eventLabel("visibility_change", { state: "hidden" })).toBe("Tab hidden");
    expect(eventLabel("visibility_change", { state: "visible" })).toBe("Tab visible");
    expect(eventLabel("visibility_change")).toBe("Tab visibility changed");
  });
  it("falls back to humanizing unknown types", () => {
    expect(eventLabel("weird_new_thing")).toBe("weird new thing");
  });
  // F6 review: the backend caps detail strings but NOT the type itself; a
  // hostile/buggy emitter must not smear a 100KB type across the log rows.
  it("defensively truncates an oversized unknown type", () => {
    const label = eventLabel("x".repeat(500));
    expect(label.length).toBeLessThanOrEqual(EVENT_TYPE_MAX + 1); // +1 for the ellipsis
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("clampEventType", () => {
  it("passes ordinary types through unchanged", () => {
    expect(clampEventType("window_blur")).toBe("window_blur");
  });
  it("truncates past EVENT_TYPE_MAX with an ellipsis", () => {
    const clamped = clampEventType("a".repeat(EVENT_TYPE_MAX + 50));
    expect(clamped).toBe(`${"a".repeat(EVENT_TYPE_MAX)}…`);
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

describe("submissionScoreSummary", () => {
  it("renders both halves when counts + points are present", () => {
    expect(submissionScoreSummary(submission({ passed_count: 8, total: 10, score: 80, max_points: 100 })))
      .toBe("8/10 tests · 80/100");
  });
  it("renders counts only when points are absent", () => {
    expect(submissionScoreSummary(submission({ passed_count: 3, total: 5 }))).toBe("3/5 tests");
  });
  it("renders points only when counts are absent", () => {
    expect(submissionScoreSummary(submission({ score: 50, max_points: 100 }))).toBe("50/100");
  });
  it("renders a zero-weight problem as 0/0 rather than vanishing", () => {
    expect(submissionScoreSummary(submission({ passed_count: 0, total: 0, score: 0, max_points: 0 })))
      .toBe("0/0 tests · 0/0");
  });
  it("is empty when no score fields are present (poller-sourced)", () => {
    expect(submissionScoreSummary(submission({}))).toBe("");
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
    expect(entries[2].label).toBe("Submit · Accepted · Two Sum");
    expect(entries[2].valid).toBe(true);
  });

  it("labels failed submissions with Submit + their status", () => {
    const [entry] = buildTimelineLog({
      alerts: [],
      events: [],
      submissions: [submission({ valid: false, status: "Wrong Answer", challenge_name: "LRU Cache" })],
      testStartMs: T0,
      gaps: []
    });
    expect(entry.label).toBe("Submit · Wrong Answer · LRU Cache");
    expect(entry.valid).toBe(false);
  });

  it("threads explicit pass/fail counts + score into the submission label + detail", () => {
    const [entry] = buildTimelineLog({
      alerts: [],
      events: [],
      submissions: [
        submission({
          valid: false,
          status: "wrong_answer",
          challenge_name: "Two Sum",
          lang: "python3",
          passed_count: 8,
          total: 10,
          score: 80,
          max_points: 100
        })
      ],
      testStartMs: T0,
      gaps: []
    });
    // Label reads: "Submit · <result> · <challenge> · 8/10 tests · 80/100".
    expect(entry.label).toBe("Submit · wrong_answer · Two Sum · 8/10 tests · 80/100");
    // Score summary also lands in detail (alongside lang), so it is searchable.
    expect(entry.detail).toBe("python3 · 8/10 tests · 80/100");
  });

  it("omits the score chunk for poller-sourced submissions with no counts", () => {
    const [entry] = buildTimelineLog({
      alerts: [],
      events: [],
      submissions: [submission({ status: "Accepted", challenge_name: "Two Sum", lang: "python3" })],
      testStartMs: T0,
      gaps: []
    });
    // No passed_count/score → no trailing " · …/…" and detail is just the lang.
    expect(entry.label).toBe("Submit · Accepted · Two Sum");
    expect(entry.detail).toBe("python3");
  });

  it("renders RUN events DISTINCTLY from submits: 'Run · n/m samples · verdict · challenge', type 'run', result in label AND detail", () => {
    const [entry] = buildTimelineLog({
      alerts: [],
      events: [],
      submissions: [
        submission({
          submission_id: "run-1",
          kind: "run",
          valid: false,
          status: "wrong_answer",
          challenge_name: "Two Sum",
          lang: "python3",
          passed_count: 2,
          total: 3
        })
      ],
      testStartMs: T0,
      gaps: []
    });
    // Distinct "Run" prefix + "samples" wording (never "Submit"/"tests").
    expect(entry.label).toBe("Run · 2/3 samples · wrong_answer · Two Sum");
    // The result text is ALSO in detail (searchable), with the language.
    expect(entry.detail).toBe("python3 · 2/3 samples · wrong_answer");
    // The discriminator type is "run" (the event-type filter key) and the row is
    // a submission-stream entry (green/red lane), id prefixed "run:".
    expect(entry.kind).toBe("submission");
    expect(entry.type).toBe("run");
    expect(entry.id).toBe("run:run-1");
    expect(entry.valid).toBe(false);
  });

  it("an all-samples-pass run reads accepted + valid (GREEN)", () => {
    const [entry] = buildTimelineLog({
      alerts: [],
      events: [],
      submissions: [submission({ kind: "run", valid: true, passed_count: 3, total: 3, challenge_name: "Two Sum" })],
      testStartMs: T0,
      gaps: []
    });
    expect(entry.label).toBe("Run · 3/3 samples · accepted · Two Sum");
    expect(entry.valid).toBe(true);
  });

  it("a submission with kind absent is treated as a SUBMIT (legacy/poller events)", () => {
    const [entry] = buildTimelineLog({
      alerts: [],
      events: [],
      submissions: [submission({ status: "Accepted", challenge_name: "Two Sum" })],
      testStartMs: T0,
      gaps: []
    });
    expect(entry.type).toBe("submit");
    expect(entry.label.startsWith("Submit · ")).toBe(true);
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

  // F6 review: the per-entry `type` is rendered/tooled downstream — clamp an
  // oversized event type defensively (the backend does not cap this field).
  it("clamps an oversized event type on the merged entry", () => {
    const entries = buildTimelineLog({
      alerts: [],
      events: [event({ type: "z".repeat(EVENT_TYPE_MAX + 200) })],
      submissions: [],
      testStartMs: T0,
      gaps: []
    });
    expect(entries[0].type).toBe(`${"z".repeat(EVENT_TYPE_MAX)}…`);
    expect(entries[0].label.length).toBeLessThanOrEqual(EVENT_TYPE_MAX + 1);
  });

  // EVID-1: the notable editor markers fold in as event-kind rows (lighter path),
  // carrying their own type (notable_paste / notable_burst) + label + offset/gap.
  it("folds notable editor markers in as event-kind entries (EVID-1)", () => {
    const entries = buildTimelineLog({
      alerts: [],
      events: [],
      submissions: [],
      testStartMs: T0,
      gaps: [],
      editorMarkers: [
        { kind: "large_paste", id: "large_paste:two-sum:0@2026-06-05T09:05:00.000Z", timestamp: "2026-06-05T09:05:00.000Z", offsetSec: 300, chars: 412, problemId: "two-sum", duringGap: false, label: "Large paste · 412 chars" },
        { kind: "keystroke_burst", id: "keystroke_burst:two-sum:9@2026-06-05T09:06:00.000Z", timestamp: "2026-06-05T09:06:00.000Z", offsetSec: 360, chars: 90, problemId: "two-sum", duringGap: true, label: "Typing burst · 90 chars" }
      ]
    });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.kind === "event")).toBe(true);
    expect(entries.map((e) => e.type)).toEqual(["notable_paste", "notable_burst"]);
    expect(entries[0].label).toBe("Large paste · 412 chars");
    expect(entries[0].detail).toBe("problem: two-sum");
    expect(entries[1].duringGap).toBe(true);
    // They survive the event-type filter the same way other event types do.
    // LOG-1: editor markers are now INFO (hidden by default), so reveal them with
    // showInfoActivities to assert the event-type narrowing still isolates them.
    const onlyBurst = filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, showInfoActivities: true, eventTypes: ["notable_burst"] });
    expect(onlyBurst.map((e) => e.type)).toEqual(["notable_burst"]);
    // And the "events" kind toggle hides them with the rest of the event stream.
    const noEvents = filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, showInfoActivities: true, events: false });
    expect(noEvents).toHaveLength(0);
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

  // LOG-1: the default now HIDES neutral/info rows (here the lone window_blur
  // event), keeping every NOTABLE row (the two alerts + the submission). The
  // "Show info activities" flag (showInfoActivities) reveals the info row.
  it("defaults keep every notable entry and hide info (window_blur)", () => {
    const def = filterTimelineLog(entries, DEFAULT_LOG_FILTERS);
    expect(def.map((e) => e.kind)).toEqual(["alert", "alert", "submission"]);
    expect(def.some((e) => e.type === "window_blur")).toBe(false);
  });

  it("showInfoActivities reveals the hidden info rows (everything visible)", () => {
    expect(filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, showInfoActivities: true })).toHaveLength(4);
  });

  it("kind toggles drop that stream", () => {
    // events:false drops the event stream regardless of the info flag.
    expect(filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, showInfoActivities: true, events: false }).map((e) => e.kind)).toEqual([
      "alert",
      "alert",
      "submission"
    ]);
    // With info revealed, alerts+submissions off leaves only the lone event.
    expect(filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, showInfoActivities: true, alerts: false, submissions: false })).toHaveLength(1);
  });

  it("severity narrows alerts only (events/submissions unaffected)", () => {
    const critOnly = filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, showInfoActivities: true, severity: "critical" });
    expect(critOnly.map((e) => e.id)).toEqual(["alert:a-crit", entries[2].id, entries[3].id]);
  });

  it("free-text query matches across label + detail + type, all kinds", () => {
    // "two sum" is in the submission label only.
    const sub = filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, query: "two sum" });
    expect(sub.map((e) => e.kind)).toEqual(["submission"]);
    // "tab" is in the two alert labels ("Tab switched away").
    const tab = filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, query: "tab" });
    expect(tab.map((e) => e.kind)).toEqual(["alert", "alert"]);
    // matches the raw event type too (window_blur is info → reveal it to search it).
    const byType = filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, showInfoActivities: true, query: "window_blur" });
    expect(byType.map((e) => e.kind)).toEqual(["event"]);
    // case-insensitive; empty query is a no-op (info revealed keeps all 4).
    expect(filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, query: "TWO SUM" })).toHaveLength(1);
    expect(filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, showInfoActivities: true, query: "   " })).toHaveLength(4);
  });

  it("free-text query matches the submission score (counts + points in label/detail)", () => {
    const scored = buildTimelineLog({
      alerts: [],
      events: [],
      submissions: [
        submission({ submission_id: "s-scored", passed_count: 8, total: 10, score: 80, max_points: 100 })
      ],
      testStartMs: T0,
      gaps: []
    });
    expect(filterTimelineLog(scored, { ...DEFAULT_LOG_FILTERS, query: "8/10" }).map((e) => e.id)).toEqual(["sub:s-scored"]);
    expect(filterTimelineLog(scored, { ...DEFAULT_LOG_FILTERS, query: "80/100" }).map((e) => e.id)).toEqual(["sub:s-scored"]);
    expect(filterTimelineLog(scored, { ...DEFAULT_LOG_FILTERS, query: "tests" }).map((e) => e.id)).toEqual(["sub:s-scored"]);
  });

  it("eventTypes narrows EVENTS only (empty set = all event types)", () => {
    // window_blur is info → reveal it so the test exercises the event-type narrow.
    const onlyBlur = filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, showInfoActivities: true, eventTypes: ["window_blur"] });
    // the lone event survives; alerts + submission untouched.
    expect(onlyBlur.map((e) => e.kind)).toEqual(["alert", "alert", "event", "submission"]);
    const noneMatch = filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, showInfoActivities: true, eventTypes: ["clipboard_activity"] });
    expect(noneMatch.some((e) => e.kind === "event")).toBe(false);
    // alerts/submissions still present (event-type filter never touches them).
    expect(noneMatch.map((e) => e.kind)).toEqual(["alert", "alert", "submission"]);
  });

  it("alertTypes narrows ALERTS only (empty set = all alert types)", () => {
    const onlyTabAway = filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, showInfoActivities: true, alertTypes: ["tab_away"] });
    expect(onlyTabAway.map((e) => e.kind)).toEqual(["alert", "alert", "event", "submission"]);
    const noMatch = filterTimelineLog(entries, { ...DEFAULT_LOG_FILTERS, showInfoActivities: true, alertTypes: ["some_other_alert"] });
    expect(noMatch.some((e) => e.kind === "alert")).toBe(false);
    expect(noMatch.map((e) => e.kind)).toEqual(["event", "submission"]);
  });

  describe("run events flow through search + the event-type filter", () => {
    // A mixed stream: one proctor event, two runs, one submit.
    const mixed = buildTimelineLog({
      alerts: [],
      events: [event({ type: "window_blur", timestamp: "2026-06-05T09:00:30.000Z" })],
      submissions: [
        submission({ submission_id: "r1", kind: "run", valid: false, status: "wrong_answer", passed_count: 1, total: 3, submitted_at: "2026-06-05T09:01:00.000Z" }),
        submission({ submission_id: "r2", kind: "run", valid: true, passed_count: 3, total: 3, submitted_at: "2026-06-05T09:02:00.000Z" }),
        submission({ submission_id: "s1", kind: "submit", valid: true, status: "Accepted", submitted_at: "2026-06-05T09:03:00.000Z" })
      ],
      testStartMs: T0,
      gaps: []
    });

    it("a run event is FREE-TEXT searchable by its result text ('samples', 'Run', the verdict)", () => {
      expect(filterTimelineLog(mixed, { ...DEFAULT_LOG_FILTERS, query: "samples" }).map((e) => e.id)).toEqual(["run:r1", "run:r2"]);
      expect(filterTimelineLog(mixed, { ...DEFAULT_LOG_FILTERS, query: "run" }).map((e) => e.id)).toEqual(["run:r1", "run:r2"]);
      // The raw verdict in the label/detail is searchable too.
      expect(filterTimelineLog(mixed, { ...DEFAULT_LOG_FILTERS, query: "wrong_answer" }).map((e) => e.id)).toEqual(["run:r1"]);
    });

    it("event-type filter 'run' includes ONLY runs (events + submits dropped from the submission/event narrow)", () => {
      // window_blur is info → reveal it to assert a submission-type narrow leaves
      // the (revealed) event stream untouched.
      const onlyRuns = filterTimelineLog(mixed, { ...DEFAULT_LOG_FILTERS, showInfoActivities: true, eventTypes: ["run"] });
      // The "run" key narrows the submission stream to runs AND leaves the event
      // stream untouched (selecting a submission type doesn't hide proctor events)
      // — but the submit submission is excluded.
      expect(onlyRuns.map((e) => e.id)).toEqual(["event:0:window_blur@2026-06-05T09:00:30.000Z", "run:r1", "run:r2"]);
      expect(onlyRuns.some((e) => e.id === "sub:s1")).toBe(false);
    });

    it("event-type filter 'submit' includes ONLY submits among the submission stream (runs excluded)", () => {
      const onlySubmits = filterTimelineLog(mixed, { ...DEFAULT_LOG_FILTERS, eventTypes: ["submit"] });
      expect(onlySubmits.filter((e) => e.kind === "submission").map((e) => e.id)).toEqual(["sub:s1"]);
      expect(onlySubmits.some((e) => e.type === "run")).toBe(false);
    });

    it("toggling OFF the submissions kind drops both runs and submits", () => {
      // Reveal info so the lone (info) window_blur event is the expected remainder.
      const noSubs = filterTimelineLog(mixed, { ...DEFAULT_LOG_FILTERS, showInfoActivities: true, submissions: false });
      expect(noSubs.some((e) => e.kind === "submission")).toBe(false);
      expect(noSubs.map((e) => e.kind)).toEqual(["event"]);
    });
  });
});

// LOG-1: neutral/info entries (the normal paste marker, focus/blur, fullscreen,
// clipboard, keystroke bursts) are hidden by default behind the "Show info
// activities" chip; NOTABLE entries (alerts incl. confirmed-foreign pastes,
// submissions, error/other events) are never info and always show.
describe("info / notable classification (LOG-1)", () => {
  it("DEFAULT_LOG_FILTERS hides info by default (showInfoActivities === false)", () => {
    expect(DEFAULT_LOG_FILTERS.showInfoActivities).toBe(false);
  });

  it("isInfoEntry: neutral event types are info; alerts/submissions/other events are NOT", () => {
    const built = buildTimelineLog({
      alerts: [
        // A confirmed-FOREIGN paste surfaces as an ALERT — must be notable.
        alert({ id: "fp", type: "paste_detected", title: "Foreign paste detected", severity: "warning", timestamp: "2026-06-05T09:02:00.000Z" })
      ],
      events: [
        event({ type: "window_blur", timestamp: "2026-06-05T09:01:00.000Z" }),
        event({ type: "clipboard_activity", timestamp: "2026-06-05T09:01:10.000Z" }),
        // A non-neutral (error) event must stay notable.
        event({ type: "recording_error", timestamp: "2026-06-05T09:01:20.000Z" })
      ],
      submissions: [submission({ submitted_at: "2026-06-05T09:03:00.000Z" })],
      testStartMs: T0,
      gaps: [],
      editorMarkers: [
        // The NORMAL (non-foreign) paste marker → info.
        { kind: "paste", id: "paste:p:0@2026-06-05T09:01:30.000Z", timestamp: "2026-06-05T09:01:30.000Z", offsetSec: 90, chars: 40, problemId: "p", duringGap: false, label: "Paste · 40 chars" }
      ]
    });
    const byType = (t: string) => built.find((e) => e.type === t)!;
    expect(isInfoEntry(byType("window_blur"))).toBe(true);
    expect(isInfoEntry(byType("clipboard_activity"))).toBe(true);
    expect(isInfoEntry(byType("notable_paste"))).toBe(true); // the normal paste marker
    expect(isInfoEntry(byType("recording_error"))).toBe(false); // error → notable
    expect(isInfoEntry(byType("paste_detected"))).toBe(false); // alert (foreign) → notable
    expect(isInfoEntry(byType("submit"))).toBe(false); // submission → notable
  });

  it("hides info when showInfoActivities=false, shows it when true; notable always shown", () => {
    const built = buildTimelineLog({
      alerts: [
        alert({ id: "a-warn", type: "tab_away", title: "Tab switched away", severity: "warning", timestamp: "2026-06-05T09:02:00.000Z" }),
        // A confirmed-FOREIGN paste, modeled as the alert it surfaces as.
        alert({ id: "a-foreign", type: "paste_detected", title: "Foreign paste detected", severity: "warning", timestamp: "2026-06-05T09:02:30.000Z" })
      ],
      events: [event({ type: "window_blur", timestamp: "2026-06-05T09:01:00.000Z" })],
      submissions: [],
      testStartMs: T0,
      gaps: [],
      editorMarkers: [
        { kind: "paste", id: "paste:p:0@2026-06-05T09:01:30.000Z", timestamp: "2026-06-05T09:01:30.000Z", offsetSec: 90, chars: 40, problemId: "p", duringGap: false, label: "Paste · 40 chars" }
      ]
    });

    // Default (info OFF): the window_blur event + the normal paste marker are hidden;
    // BOTH alerts (incl. the confirmed-foreign paste) remain.
    const hidden = filterTimelineLog(built, DEFAULT_LOG_FILTERS);
    expect(hidden.map((e) => e.id).sort()).toEqual(["alert:a-foreign", "alert:a-warn"]);
    expect(hidden.some((e) => e.type === "window_blur")).toBe(false);
    expect(hidden.some((e) => e.type === "notable_paste")).toBe(false);

    // Info ON: the neutral rows appear alongside the (still-present) alerts.
    const shown = filterTimelineLog(built, { ...DEFAULT_LOG_FILTERS, showInfoActivities: true });
    expect(shown.some((e) => e.type === "window_blur")).toBe(true);
    expect(shown.some((e) => e.type === "notable_paste")).toBe(true);

    // The confirmed-foreign paste ALERT + the alert show in BOTH states.
    for (const f of [DEFAULT_LOG_FILTERS, { ...DEFAULT_LOG_FILTERS, showInfoActivities: true }]) {
      const ids = filterTimelineLog(built, f).map((e) => e.id);
      expect(ids).toContain("alert:a-foreign");
      expect(ids).toContain("alert:a-warn");
    }
  });

  it("a confirmed-foreign paste alert is never hidden even when its neutral paste marker is", () => {
    // The SAME paste yields a neutral notable_paste marker (info) AND a foreign
    // alert (notable). The marker hides by default; the alert never does.
    const built = buildTimelineLog({
      alerts: [alert({ id: "foreign", type: "paste_detected", title: "Foreign paste detected", severity: "critical", timestamp: "2026-06-05T09:01:30.000Z" })],
      events: [],
      submissions: [],
      testStartMs: T0,
      gaps: [],
      editorMarkers: [
        { kind: "large_paste", id: "large_paste:p:0@2026-06-05T09:01:30.000Z", timestamp: "2026-06-05T09:01:30.000Z", offsetSec: 90, chars: 412, problemId: "p", duringGap: false, label: "Large paste · 412 chars" }
      ]
    });
    const def = filterTimelineLog(built, DEFAULT_LOG_FILTERS);
    expect(def.map((e) => e.id)).toEqual(["alert:foreign"]); // marker hidden, alert kept
  });
});

describe("type facets", () => {
  const entries = buildTimelineLog({
    alerts: [
      alert({ id: "a1", type: "tab_away", title: "Tab switched away", timestamp: "2026-06-05T09:01:00.000Z" }),
      alert({ id: "a2", type: "tab_away", title: "Tab switched away", timestamp: "2026-06-05T09:02:00.000Z" }),
      alert({ id: "a3", type: "paste_detected", title: "Paste detected", timestamp: "2026-06-05T09:03:00.000Z" })
    ],
    events: [
      event({ type: "window_blur", timestamp: "2026-06-05T09:04:00.000Z" }),
      event({ type: "window_blur", timestamp: "2026-06-05T09:05:00.000Z" }),
      event({ type: "clipboard_activity", timestamp: "2026-06-05T09:06:00.000Z" })
    ],
    submissions: [submission({ submitted_at: "2026-06-05T09:07:00.000Z" })],
    testStartMs: T0,
    gaps: []
  });

  it("eventTypeFacets lists DISTINCT event types with friendly labels + counts, sorted by count desc", () => {
    const facets = eventTypeFacets(entries);
    // Submission-stream facets (run/submit) come FIRST so the run/submit narrow
    // is the headline option, then the event-type facets sorted by count desc.
    expect(facets).toEqual([
      { type: "submit", label: "Submit", count: 1 },
      { type: "window_blur", label: "Window lost focus", count: 2 },
      { type: "clipboard_activity", label: "Clipboard activity", count: 1 }
    ]);
  });

  it("eventTypeFacets spans BOTH run and submit submission entries (the P3 runs-vs-submits filter)", () => {
    const mixed = buildTimelineLog({
      alerts: [],
      events: [event({ type: "window_blur", timestamp: "2026-06-05T09:04:00.000Z" })],
      submissions: [
        submission({ submission_id: "r1", kind: "run", submitted_at: "2026-06-05T09:01:00.000Z" }),
        submission({ submission_id: "r2", kind: "run", submitted_at: "2026-06-05T09:02:00.000Z" }),
        submission({ submission_id: "s1", kind: "submit", submitted_at: "2026-06-05T09:03:00.000Z" })
      ],
      testStartMs: T0,
      gaps: []
    });
    expect(eventTypeFacets(mixed)).toEqual([
      { type: "run", label: "Run", count: 2 },
      { type: "submit", label: "Submit", count: 1 },
      { type: "window_blur", label: "Window lost focus", count: 1 }
    ]);
  });

  it("alertTypeFacets lists DISTINCT alert types with their titles + counts", () => {
    const facets = alertTypeFacets(entries);
    expect(facets).toEqual([
      { type: "tab_away", label: "Tab switched away", count: 2 },
      { type: "paste_detected", label: "Paste detected", count: 1 }
    ]);
  });

  it("facets are empty when no entries of that kind exist", () => {
    // A lone submit still yields its submission facet (the event-type menu now
    // spans run/submit); only the EVENT-proper + alert facets are empty here.
    const onlySub = buildTimelineLog({ alerts: [], events: [], submissions: [submission({})], testStartMs: T0, gaps: [] });
    expect(eventTypeFacets(onlySub)).toEqual([{ type: "submit", label: "Submit", count: 1 }]);
    expect(alertTypeFacets(onlySub)).toEqual([]);
    // Truly empty when there are no entries at all.
    const empty = buildTimelineLog({ alerts: [], events: [], submissions: [], testStartMs: T0, gaps: [] });
    expect(eventTypeFacets(empty)).toEqual([]);
    expect(alertTypeFacets(empty)).toEqual([]);
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
