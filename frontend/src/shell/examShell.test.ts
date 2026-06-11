// frontend/src/shell/examShell.test.ts
import { describe, it, expect } from "vitest";
import {
  deriveStage, stageHint, topBarVisible, fullscreenGateVisible, permissionsGateVisible,
  elapsedTimerActive, STAGE_META,
  formatWallClock, formatExamElapsed, formatRoomLabel,
  anomalyFromEvent, topBarReducer, initialTopBarState,
  serializeShellState, deserializeShellState, shellStateStorageKey,
  makeShellEvent, appendToBuffer,
  type StageInput, type RestorePreconditions, type TopBarState
} from "./examShell";
import type { ProctorEvent } from "../types";

const base: StageInput = { permissionsReady: true, fullscreen: true, gate: "form", status: "idle", examReleased: true };

describe("deriveStage", () => {
  it("1 PERMISSIONS: streams not acquired, in any pre-end state (F5.1 — prompts before fullscreen)", () => {
    expect(deriveStage({ ...base, permissionsReady: false })).toBe(1);
    expect(deriveStage({ ...base, permissionsReady: false, fullscreen: false })).toBe(1);
    // Resume after reload: streams never survive — stage A reruns before the form-less resume.
    expect(deriveStage({ ...base, permissionsReady: false, gate: "running", status: "idle" })).toBe(1);
    expect(deriveStage({ ...base, permissionsReady: false, gate: "pending_approval" })).toBe(1);
  });
  it("2 FULLSCREEN: permissions ready but not in fullscreen", () => {
    expect(deriveStage({ ...base, fullscreen: false })).toBe(2);
    expect(deriveStage({ ...base, fullscreen: false, gate: "running", status: "recording" })).toBe(2);
    expect(deriveStage({ ...base, fullscreen: false, gate: "pending_approval" })).toBe(2);
  });
  it("3 DETAILS: permissions + fullscreen OK, no session yet (gate form), incl. registration in flight", () => {
    expect(deriveStage(base)).toBe(3);
    expect(deriveStage({ ...base, status: "starting" })).toBe(3);
  });
  it("3 DETAILS: session exists but surface not live (resume ready / start in flight / pending approval)", () => {
    expect(deriveStage({ ...base, gate: "running", status: "idle" })).toBe(3);
    expect(deriveStage({ ...base, gate: "running", status: "starting" })).toBe(3);
    expect(deriveStage({ ...base, gate: "pending_approval", status: "idle" })).toBe(3);
  });
  it("3 DETAILS: recording but the room gate has not released the exam (S3 seam)", () => {
    expect(deriveStage({ ...base, gate: "running", status: "recording", examReleased: false })).toBe(3);
  });
  it("4 IN EXAM: recording (and ending) with the exam released", () => {
    expect(deriveStage({ ...base, gate: "running", status: "recording" })).toBe(4);
    expect(deriveStage({ ...base, gate: "running", status: "ending" })).toBe(4);
  });
  it("5 DONE: ended wins over everything, even with permissions/fullscreen lost", () => {
    expect(deriveStage({ ...base, gate: "ended", status: "ended", fullscreen: false, permissionsReady: false })).toBe(5);
    expect(deriveStage({ ...base, gate: "running", status: "ended" })).toBe(5);
  });
  it("locked reports 3 (the bar is hidden on the locked screen anyway)", () => {
    expect(deriveStage({ ...base, gate: "locked", status: "idle" })).toBe(3);
  });
});

describe("STAGE_META", () => {
  it("carries the F5.1 label + color block per stage (1 permissions, 2 fullscreen, 3 details, 4 exam, 5 done)", () => {
    expect(STAGE_META[1]).toEqual({ label: "PERMISSIONS", blockClass: "bg-red-600" });
    expect(STAGE_META[2]).toEqual({ label: "FULLSCREEN", blockClass: "bg-amber-500" });
    expect(STAGE_META[3]).toEqual({ label: "DETAILS", blockClass: "bg-sky-500" });
    expect(STAGE_META[4]).toEqual({ label: "IN EXAM", blockClass: "bg-emerald-600" });
    expect(STAGE_META[5]).toEqual({ label: "DONE", blockClass: "bg-indigo-600" });
  });
});

describe("topBarVisible", () => {
  it("bar renders unless an anomaly episode is active or the session is locked", () => {
    expect(topBarVisible(false, "form")).toBe(true);
    expect(topBarVisible(false, "running")).toBe(true);
    expect(topBarVisible(false, "ended")).toBe(true);
    expect(topBarVisible(true, "running")).toBe(false);
    expect(topBarVisible(false, "locked")).toBe(false);
  });
});

describe("fullscreenGateVisible", () => {
  it("shows the gate ONLY at stage 2 (permissions done, fullscreen pending) with no anomaly episode", () => {
    expect(fullscreenGateVisible({ fullscreen: false, stage: 2, barHidden: false, gate: "form" })).toBe(true);
    expect(fullscreenGateVisible({ fullscreen: false, stage: 2, barHidden: false, gate: "running" })).toBe(true);
  });
  it("stage 1 belongs to the PermissionsGate — fullscreen gate stays hidden", () => {
    expect(fullscreenGateVisible({ fullscreen: false, stage: 1, barHidden: false, gate: "form" })).toBe(false);
  });
  it("hides the gate while in fullscreen", () => {
    expect(fullscreenGateVisible({ fullscreen: true, stage: 3, barHidden: false, gate: "form" })).toBe(false);
  });
  it("hides the gate at stage 5 DONE", () => {
    expect(fullscreenGateVisible({ fullscreen: false, stage: 5, barHidden: false, gate: "ended" })).toBe(false);
  });
  it("hides the gate while an anomaly episode owns fullscreen re-entry", () => {
    expect(fullscreenGateVisible({ fullscreen: false, stage: 2, barHidden: true, gate: "running" })).toBe(false);
  });
  it("locked + not fullscreen: gate hidden — the locked message takes precedence", () => {
    expect(fullscreenGateVisible({ fullscreen: false, stage: 2, barHidden: false, gate: "locked" })).toBe(false);
  });
});

describe("permissionsGateVisible", () => {
  it("shows at stage 1 (permissions pending) with no anomaly episode", () => {
    expect(permissionsGateVisible({ stage: 1, barHidden: false, gate: "form" })).toBe(true);
    // Resume after reload: gate running, streams gone — stage A reruns over the restored app.
    expect(permissionsGateVisible({ stage: 1, barHidden: false, gate: "running" })).toBe(true);
  });
  it("hidden once permissions are ready (stage 2+)", () => {
    expect(permissionsGateVisible({ stage: 2, barHidden: false, gate: "form" })).toBe(false);
    expect(permissionsGateVisible({ stage: 3, barHidden: false, gate: "form" })).toBe(false);
    expect(permissionsGateVisible({ stage: 5, barHidden: false, gate: "ended" })).toBe(false);
  });
  it("hidden during an anomaly episode and on the locked screen", () => {
    expect(permissionsGateVisible({ stage: 1, barHidden: true, gate: "running" })).toBe(false);
    expect(permissionsGateVisible({ stage: 1, barHidden: false, gate: "locked" })).toBe(false);
  });
});

describe("elapsedTimerActive", () => {
  it("ticks only while actively recording", () => {
    expect(elapsedTimerActive({ status: "recording", gate: "running" })).toBe(true);
  });
  it("F5.7: stops the moment the session/gate ends — never a count-up after test end", () => {
    expect(elapsedTimerActive({ status: "ended", gate: "ended" })).toBe(false);
    expect(elapsedTimerActive({ status: "recording", gate: "ended" })).toBe(false);
    expect(elapsedTimerActive({ status: "ended", gate: "running" })).toBe(false);
  });
  it("frozen while ending / idle / starting / error", () => {
    expect(elapsedTimerActive({ status: "ending", gate: "running" })).toBe(false);
    expect(elapsedTimerActive({ status: "idle", gate: "running" })).toBe(false);
    expect(elapsedTimerActive({ status: "starting", gate: "running" })).toBe(false);
    expect(elapsedTimerActive({ status: "error", gate: "running" })).toBe(false);
  });
});

describe("stageHint", () => {
  it("stage 1: permissions + screen-share instruction (prompts happen BEFORE fullscreen)", () => {
    const hint = stageHint({ ...base, permissionsReady: false, ownEditor: true });
    expect(hint).toMatch(/permission/i);
    expect(hint).toMatch(/screen/i);
  });
  it("stage 2: fullscreen instruction", () => {
    expect(stageHint({ ...base, fullscreen: false, ownEditor: true })).toMatch(/fullscreen/i);
  });
  it("stage 3: details + start proctoring", () => {
    expect(stageHint({ ...base, ownEditor: true })).toMatch(/details/i);
  });
  it("stage 3 variants: pending approval / locked / resume / start in flight / end-retry / waiting for release", () => {
    expect(stageHint({ ...base, gate: "pending_approval", ownEditor: true })).toMatch(/approve/i);
    expect(stageHint({ ...base, gate: "locked", ownEditor: true })).toMatch(/locked/i);
    expect(stageHint({ ...base, gate: "running", status: "idle", ownEditor: true })).toMatch(/resume recording/i);
    expect(stageHint({ ...base, gate: "running", status: "starting", ownEditor: true })).toMatch(/entire screen/i);
    expect(stageHint({ ...base, gate: "running", status: "error", ownEditor: true })).toMatch(/retry/i);
    expect(stageHint({ ...base, gate: "running", status: "recording", examReleased: false, ownEditor: true })).toMatch(/room/i);
  });
  it("stage 4: own-editor copy never mentions HackerRank; legacy copy does", () => {
    const own = stageHint({ ...base, gate: "running", status: "recording", ownEditor: true });
    expect(own).toMatch(/coding workspace/i);
    expect(own).not.toMatch(/hackerrank/i);
    expect(stageHint({ ...base, gate: "running", status: "recording", ownEditor: false })).toMatch(/HackerRank/);
  });
  it("stage 5: complete", () => {
    expect(stageHint({ ...base, gate: "ended", status: "ended", ownEditor: true })).toMatch(/complete/i);
  });
});

describe("formatWallClock", () => {
  it("renders HH:MM:SS local time, zero-padded", () => {
    expect(formatWallClock(new Date(2026, 5, 10, 9, 5, 3))).toBe("09:05:03");
    expect(formatWallClock(new Date(2026, 5, 10, 23, 59, 59))).toBe("23:59:59");
  });
});

describe("formatExamElapsed", () => {
  it("renders H:MM:SS with unpadded hours", () => {
    expect(formatExamElapsed(0)).toBe("0:00:00");
    expect(formatExamElapsed(61)).toBe("0:01:01");
    expect(formatExamElapsed(3723)).toBe("1:02:03");
  });
  it("clamps negatives to zero", () => {
    expect(formatExamElapsed(-5)).toBe("0:00:00");
  });
});

describe("formatRoomLabel", () => {
  it("prefixes 'Room ' onto a bare value", () => {
    expect(formatRoomLabel("A")).toBe("Room A");
    expect(formatRoomLabel("12")).toBe("Room 12");
  });
  it("does NOT double-prefix a value that already starts with 'Room'", () => {
    expect(formatRoomLabel("Room A")).toBe("Room A");
    expect(formatRoomLabel("room a")).toBe("room a");
    expect(formatRoomLabel("ROOM 3")).toBe("ROOM 3");
  });
  it("treats 'Roomy' (no word boundary) as a bare value", () => {
    // \b after "room" means only "Room"/"Room " etc. are recognized, not
    // an unrelated word that merely starts with those letters.
    expect(formatRoomLabel("Roomy Hall")).toBe("Room Roomy Hall");
  });
  it("trims and falls back to an em-dash placeholder when empty", () => {
    expect(formatRoomLabel("")).toBe("Room —");
    expect(formatRoomLabel("   ")).toBe("Room —");
    expect(formatRoomLabel(null)).toBe("Room —");
    expect(formatRoomLabel(undefined)).toBe("Room —");
    expect(formatRoomLabel("  B  ")).toBe("Room B");
  });
});

describe("anomalyFromEvent", () => {
  const anomalyCases: Array<[string, Record<string, unknown> | undefined, string]> = [
    ["fullscreen_exit", undefined, "You left fullscreen."],
    ["window_blur", undefined, "You switched to another window or application."],
    ["page_hide", undefined, "This exam tab was hidden or closed."],
    ["screen_share_stopped", { reason: "track_ended" }, "Screen sharing stopped."],
    ["recording_error", { kind: "screen" }, "Screen recording hit an error."],
    ["ip_address_changed", { previous: "1.2.3.4", current: "5.6.7.8" }, "Your network connection changed."]
  ];
  it.each(anomalyCases)("%s is an anomaly", (type, detail, message) => {
    expect(anomalyFromEvent(type, detail)).toEqual({ anomaly: true, reason: type, message });
  });
  it("visibility_change is an anomaly ONLY when state is hidden", () => {
    expect(anomalyFromEvent("visibility_change", { state: "hidden" })).toEqual({
      anomaly: true, reason: "visibility_change", message: "This exam tab was hidden."
    });
    expect(anomalyFromEvent("visibility_change", { state: "visible" })).toEqual({ anomaly: false });
  });
  it("the expected end-of-test fullscreen_exit is NOT an anomaly", () => {
    expect(anomalyFromEvent("fullscreen_exit", { expected: true })).toEqual({ anomaly: false });
  });
  it.each([
    "fullscreen_enter", "window_focus", "before_unload", "clipboard_activity",
    "reload_shortcut_blocked", "upload_error", "event_upload_error", "heartbeat_error",
    "chunk_uploaded", "small_video_chunk_detected", "invalid_share_surface",
    "integrity_notice",
    "camera_microphone_optional_capture_failed", "camera_stopped", "microphone_stopped",
    "editor_blur", "editor_focus", "editor_paste",
    "onboarding_stage", "topbar_hidden", "topbar_restored"
  ])("%s is NOT an anomaly", (type) => {
    expect(anomalyFromEvent(type)).toEqual({ anomaly: false });
  });
});

const evt = (type: string, detail?: Record<string, unknown>, at = "2026-06-10T01:00:00.000Z"): ProctorEvent =>
  ({ type, timestamp: at, detail });

const allClear: RestorePreconditions = { fullscreen: true, visible: true, recording: true };

describe("topBarReducer", () => {
  it("first anomaly while recording: hides the bar, increments the flag, emits ONE topbar_hidden", () => {
    const { state, emit } = topBarReducer(initialTopBarState, { kind: "event", event: evt("window_blur"), recording: true, nowMs: 1000 });
    expect(state.barHidden).toBe(true);
    expect(state.flagCount).toBe(1);
    expect(state.activeReasons).toEqual([
      { type: "window_blur", message: "You switched to another window or application.", at: "2026-06-10T01:00:00.000Z" }
    ]);
    expect(emit).toEqual({
      type: "topbar_hidden",
      detail: { reason: "You switched to another window or application.", trigger_type: "window_blur" }
    });
  });
  it("anomaly while NOT recording: no-op (pre-recording exits only re-show the gate)", () => {
    const { state, emit } = topBarReducer(initialTopBarState, { kind: "event", event: evt("fullscreen_exit"), recording: false, nowMs: 1000 });
    expect(state).toBe(initialTopBarState);
    expect(emit).toBeNull();
  });
  it("non-anomaly events never touch the bar", () => {
    const { state, emit } = topBarReducer(initialTopBarState, { kind: "event", event: evt("window_focus"), recording: true, nowMs: 1000 });
    expect(state).toBe(initialTopBarState);
    expect(emit).toBeNull();
  });
  it("episode dedupe: blur+hidden+fullscreen_exit in one excursion = ONE flag, reasons deduped by type, no second emission", () => {
    let r = topBarReducer(initialTopBarState, { kind: "event", event: evt("window_blur"), recording: true, nowMs: 1000 });
    r = topBarReducer(r.state, { kind: "event", event: evt("visibility_change", { state: "hidden" }), recording: true, nowMs: 1100 });
    expect(r.emit).toBeNull();
    r = topBarReducer(r.state, { kind: "event", event: evt("fullscreen_exit"), recording: true, nowMs: 1200 });
    expect(r.emit).toBeNull();
    const again = topBarReducer(r.state, { kind: "event", event: evt("window_blur"), recording: true, nowMs: 1300 });
    expect(again.emit).toBeNull();
    expect(again.state.flagCount).toBe(1);
    expect(again.state.activeReasons.map((x) => x.type)).toEqual(["window_blur", "visibility_change", "fullscreen_exit"]);
  });
  it("fullscreen_enter never auto-restores the bar", () => {
    const hidden = topBarReducer(initialTopBarState, { kind: "event", event: evt("fullscreen_exit"), recording: true, nowMs: 1000 }).state;
    const { state, emit } = topBarReducer(hidden, { kind: "event", event: evt("fullscreen_enter"), recording: true, nowMs: 2000 });
    expect(state.barHidden).toBe(true);
    expect(emit).toBeNull();
  });
  it("restore: rejected until ALL preconditions hold", () => {
    const hidden = topBarReducer(initialTopBarState, { kind: "event", event: evt("window_blur"), recording: true, nowMs: 1000 }).state;
    for (const broken of [
      { ...allClear, fullscreen: false },
      { ...allClear, visible: false },
      { ...allClear, recording: false }
    ]) {
      const r = topBarReducer(hidden, { kind: "restore", preconditions: broken, nowMs: 9000 });
      expect(r.state.barHidden).toBe(true);
      expect(r.emit).toBeNull();
    }
  });
  it("restore with preconditions met: bar back, reasons cleared, flag persists, emits topbar_restored with hidden_ms + reasons", () => {
    let r = topBarReducer(initialTopBarState, { kind: "event", event: evt("window_blur"), recording: true, nowMs: 1000 });
    r = topBarReducer(r.state, { kind: "event", event: evt("visibility_change", { state: "hidden" }), recording: true, nowMs: 1500 });
    const restored = topBarReducer(r.state, { kind: "restore", preconditions: allClear, nowMs: 61_000 });
    expect(restored.state).toEqual({ barHidden: false, flagCount: 1, activeReasons: [], hiddenAtMs: null });
    expect(restored.emit).toEqual({
      type: "topbar_restored",
      detail: { hidden_ms: 60_000, reasons: ["window_blur", "visibility_change"] }
    });
  });
  it("a SECOND episode after restore increments the flag to 2", () => {
    let r = topBarReducer(initialTopBarState, { kind: "event", event: evt("window_blur"), recording: true, nowMs: 1000 });
    r = topBarReducer(r.state, { kind: "restore", preconditions: allClear, nowMs: 2000 });
    r = topBarReducer(r.state, { kind: "event", event: evt("page_hide"), recording: true, nowMs: 3000 });
    expect(r.state.barHidden).toBe(true);
    expect(r.state.flagCount).toBe(2);
    expect(r.emit?.type).toBe("topbar_hidden");
  });
  it("restore while not hidden: no-op, no emission", () => {
    const r = topBarReducer(initialTopBarState, { kind: "restore", preconditions: allClear, nowMs: 1000 });
    expect(r.state).toBe(initialTopBarState);
    expect(r.emit).toBeNull();
  });
  it("session_ended while hidden: unhides (the DONE bar must render), flag persists, logs the restore", () => {
    const hidden = topBarReducer(initialTopBarState, { kind: "event", event: evt("window_blur"), recording: true, nowMs: 1000 }).state;
    const r = topBarReducer(hidden, { kind: "session_ended", nowMs: 5000 });
    expect(r.state.barHidden).toBe(false);
    expect(r.state.flagCount).toBe(1);
    expect(r.emit).toEqual({ type: "topbar_restored", detail: { hidden_ms: 4000, reasons: ["window_blur"] } });
  });
});

describe("shellStateStorageKey", () => {
  it("namespaces the persisted shell state per session id", () => {
    expect(shellStateStorageKey("abc-123")).toBe("aerele-proctor-shell-state-abc-123");
  });
});

describe("serializeShellState / deserializeShellState", () => {
  const midEpisode: TopBarState = {
    barHidden: true,
    flagCount: 3,
    activeReasons: [
      { type: "window_blur", message: "You switched to another window or application.", at: "2026-06-10T01:00:00.000Z" },
      { type: "visibility_change", message: "This exam tab was hidden.", at: "2026-06-10T01:00:01.000Z" }
    ],
    hiddenAtMs: 12_345
  };

  it("round-trips a mid-episode state (reasons keep type/message/at; hiddenAtMs survives)", () => {
    expect(deserializeShellState(serializeShellState(midEpisode))).toEqual(midEpisode);
  });
  it("round-trips a calm state with prior flags", () => {
    const calm: TopBarState = { barHidden: false, flagCount: 2, activeReasons: [], hiddenAtMs: null };
    expect(deserializeShellState(serializeShellState(calm))).toEqual(calm);
  });
  it("round-trips the initial state", () => {
    expect(deserializeShellState(serializeShellState(initialTopBarState))).toEqual(initialTopBarState);
  });
  it("missing key (null) => fresh initial state", () => {
    expect(deserializeShellState(null)).toEqual(initialTopBarState);
  });
  it("malformed JSON => fresh initial state", () => {
    expect(deserializeShellState("{nope")).toEqual(initialTopBarState);
    expect(deserializeShellState("")).toEqual(initialTopBarState);
  });
  it("non-object payloads => fresh initial state", () => {
    expect(deserializeShellState("42")).toEqual(initialTopBarState);
    expect(deserializeShellState("\"hi\"")).toEqual(initialTopBarState);
    expect(deserializeShellState("null")).toEqual(initialTopBarState);
    expect(deserializeShellState("[]")).toEqual(initialTopBarState);
  });
  it("tampered field types => fresh initial state", () => {
    const tampered: Array<Record<string, unknown>> = [
      { ...midEpisode, barHidden: "false" },
      { ...midEpisode, flagCount: "0" },
      { ...midEpisode, flagCount: -1 },
      { ...midEpisode, flagCount: 1.5 },
      { ...midEpisode, activeReasons: "none" },
      { ...midEpisode, activeReasons: [{ type: 7, message: "x", at: "t" }] },
      { ...midEpisode, activeReasons: [null] },
      { ...midEpisode, hiddenAtMs: "12345" }
    ];
    for (const bad of tampered) {
      expect(deserializeShellState(JSON.stringify(bad))).toEqual(initialTopBarState);
    }
  });
  it("missing fields => fresh initial state (a hand-edited partial object never half-applies)", () => {
    expect(deserializeShellState(JSON.stringify({ flagCount: 1 }))).toEqual(initialTopBarState);
    expect(deserializeShellState(JSON.stringify({ barHidden: true, flagCount: 1, activeReasons: [] }))).toEqual(initialTopBarState);
  });
  it("extra unknown fields are dropped, known fields kept", () => {
    const withExtra = { ...midEpisode, sneaky: true };
    expect(deserializeShellState(JSON.stringify(withExtra))).toEqual(midEpisode);
  });
  it("serialize emits only the persisted fields", () => {
    expect(JSON.parse(serializeShellState(midEpisode))).toEqual({
      barHidden: true,
      flagCount: 3,
      activeReasons: midEpisode.activeReasons,
      hiddenAtMs: 12_345
    });
  });
});

describe("makeShellEvent / appendToBuffer", () => {
  it("makeShellEvent builds a ProctorEvent in the createUiEvent shape", () => {
    expect(makeShellEvent("fullscreen_enter", { via: "gate" }, "2026-06-10T01:00:00.000Z", "visible")).toEqual({
      type: "fullscreen_enter",
      timestamp: "2026-06-10T01:00:00.000Z",
      detail: { via: "gate" },
      visibility_state: "visible"
    });
  });
  it("appendToBuffer caps at 50, dropping the oldest", () => {
    let buf: ProctorEvent[] = [];
    for (let i = 0; i < 55; i++) buf = appendToBuffer(buf, makeShellEvent(`e${i}`, undefined, "t", "visible"));
    expect(buf.length).toBe(50);
    expect(buf[0].type).toBe("e5");
    expect(buf[49].type).toBe("e54");
  });
});
