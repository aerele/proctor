// frontend/src/shell/examShell.ts
//
// S1 exam shell — PURE logic only (no React, no DOM calls): onboarding-stage
// derivation, the per-stage hint line, bar-presence rule, and small display
// formatters. (Task 2 adds anomaly classification + the top-bar reducer.)
// Everything here is vitest-tested; the React hook (useExamShell.ts) and the
// shell components stay thin.
//
// Design: docs/superpowers/specs/2026-06-09-s1-exam-shell-design.md

import type { ProctorEvent, SessionStatus } from "../types";

// Mirrors StudentApp's `StudentGate` union (App.tsx) — declared here, not
// imported, so the pure module has no dependency on App.tsx. The two unions
// are structurally identical, so App's gate value is directly assignable.
export type ShellGate = "form" | "pending_approval" | "locked" | "ended" | "running";

export type Stage = 1 | 2 | 3 | 4 | 5;

// Spec §4: the five onboarding stages — at-a-distance label + stage-block color.
export const STAGE_META: Record<Stage, { label: string; blockClass: string }> = {
  1: { label: "FULLSCREEN", blockClass: "bg-red-600" },
  2: { label: "DETAILS", blockClass: "bg-amber-500" },
  3: { label: "GET READY", blockClass: "bg-sky-500" },
  4: { label: "IN EXAM", blockClass: "bg-emerald-600" },
  5: { label: "DONE", blockClass: "bg-indigo-600" }
};

export type StageInput = {
  fullscreen: boolean;
  gate: ShellGate;
  status: SessionStatus;
  // S3 room-gate seam: true when the room gate is not enabled/built (tonight:
  // S3 has not landed, so App.tsx always passes true) or the invigilator has
  // released the room code. false => recording candidates wait at stage 3.
  examReleased: boolean;
};

// Spec §4 derivation contract. Priority: ended wins; then the fullscreen gate;
// then session progress. `locked` reports 3 — the spec's "keeps the last
// pre-lock stage" is unimplementable in a pure function, and the bar never
// renders while locked (see topBarVisible), so the value is unobservable.
export function deriveStage({ fullscreen, gate, status, examReleased }: StageInput): Stage {
  if (gate === "ended" || status === "ended") return 5;
  if (!fullscreen) return 1;
  if (gate === "form") return 2;
  // A session exists (running / pending_approval / locked).
  if (status === "recording" || status === "ending") return examReleased ? 4 : 3;
  return 3;
}

// Spec §7: bar presence semantics — the bar renders on EVERY branch except
// during an anomaly episode and on the locked screen (absence = walk over;
// the locked hide is a render rule, not a reducer episode — no flag increment).
export function topBarVisible(barHidden: boolean, gate: ShellGate): boolean {
  return !barHidden && gate !== "locked";
}

// FullscreenGate overlay visibility. The overlay renders only when out of
// fullscreen, before DONE, and while no anomaly episode owns fullscreen
// re-entry (the AnomalyPanel has its own button, §5.2). The locked screen also
// suppresses it: a locked candidate can do nothing about fullscreen, so the
// locked message takes precedence over the gate.
export function fullscreenGateVisible(input: {
  fullscreen: boolean;
  stage: Stage;
  barHidden: boolean;
  gate: ShellGate;
}): boolean {
  return !input.fullscreen && input.stage < 5 && !input.barHidden && input.gate !== "locked";
}

// Spec §7.4: the one-line close-up hint under the bar — survives from the
// deleted StudentStepBanner. ownEditor mirrors the server-driven problem flag
// (S4: Boolean(sessionConfig?.problem) in App.tsx); only the in-exam hint is
// surface-specific (own-editor copy must not say HackerRank).
export function stageHint(input: StageInput & { ownEditor: boolean }): string {
  const stage = deriveStage(input);
  const { gate, status, ownEditor } = input;
  if (stage === 5) return "Your test is complete. You may close this tab.";
  if (stage === 1) return "The exam runs in fullscreen from start to finish. Enter fullscreen to continue.";
  if (stage === 2) return "Read the rules, fill in your details and consent, then start proctoring.";
  if (stage === 4) {
    return ownEditor
      ? "Recording is active. Solve the problem in the coding workspace below and keep this tab running. End the test here when you submit."
      : "Recording is active. Open HackerRank with the Start test button and keep this tab running. End the test here when you submit.";
  }
  // Stage 3 — GET READY variants.
  if (gate === "pending_approval") return "Waiting for a proctor to approve this device. Stay on this page.";
  if (gate === "locked") return "Your session is locked. Call a proctor to unlock you.";
  if (status === "starting") return "Follow the browser prompt and share your Entire Screen.";
  if (status === "error") return "Recording has stopped. Use the Retry button on this page to finish ending your test.";
  if (status === "recording" || status === "ending") return "Recording is active. Waiting for your room's exam code to be released.";
  return "Your session was restored. Press Resume recording to share your screen again and continue.";
}

// Right side of the bar: a ticking local wall clock — every stage gets a
// ticking element (a screenshot or printout cannot tick).
export function formatWallClock(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Elapsed exam time, H:MM:SS (hours unpadded — reads as "0:14:09"). Spec §7.1.
// (App.tsx's formatElapsed dies with TimerBar; this is the shell's own.)
export function formatExamElapsed(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}

// ---- Spec §6: anomaly classification ---------------------------------------

export type AnomalyVerdict =
  | { anomaly: true; reason: string; message: string }
  | { anomaly: false };

// Friendly panel copy per anomaly event type (spec §6 table). Every event type
// NOT in this map (editor_*, clipboard_activity, window_focus, infra errors,
// the shell's own bookkeeping events, …) is a non-anomaly by construction.
const ANOMALY_MESSAGES: Record<string, string> = {
  fullscreen_exit: "You left fullscreen.",
  window_blur: "You switched to another window or application.",
  page_hide: "This exam tab was hidden or closed.",
  screen_share_stopped: "Screen sharing stopped.",
  recording_error: "Screen recording hit an error.",
  ip_address_changed: "Your network connection changed.",
  integrity_checkpoint_missed: "You missed an attendance check."
};

export function anomalyFromEvent(type: string, detail?: Record<string, unknown>): AnomalyVerdict {
  if (type === "visibility_change") {
    return detail?.state === "hidden"
      ? { anomaly: true, reason: "visibility_change", message: "This exam tab was hidden." }
      : { anomaly: false };
  }
  // The end-of-test exitFullscreen() is logged with detail.expected === true
  // (spec §5.2) — never an anomaly.
  if (type === "fullscreen_exit" && detail?.expected === true) return { anomaly: false };
  const message = ANOMALY_MESSAGES[type];
  return message ? { anomaly: true, reason: type, message } : { anomaly: false };
}

// ---- Spec §6/§7: top-bar vanish/restore reducer -----------------------------

export type AnomalyReason = { type: string; message: string; at: string };

export type TopBarState = {
  barHidden: boolean;
  // Permanent ⚑ chip: hide EPISODES this session (transitions count, not events).
  flagCount: number;
  // Current episode's reasons, deduped by type, in arrival order.
  activeReasons: AnomalyReason[];
  hiddenAtMs: number | null;
};

export const initialTopBarState: TopBarState = {
  barHidden: false,
  flagCount: 0,
  activeReasons: [],
  hiddenAtMs: null
};

export type RestorePreconditions = {
  fullscreen: boolean;
  visible: boolean;
  recording: boolean;
};

export type TopBarAction =
  // Every event flowing through StudentApp's addEvent funnel. `recording` is
  // sampled at dispatch time — anomalies vanish the bar ONLY while recording
  // (spec decision 4; the share-picker "starting" moment is therefore safe).
  | { kind: "event"; event: ProctorEvent; recording: boolean; nowMs: number }
  // Candidate clicked "I have fixed this". Preconditions are re-checked here —
  // restore is a no-op unless ALL hold (spec §7.3).
  | { kind: "restore"; preconditions: RestorePreconditions; nowMs: number }
  // Test ended mid-episode: unhide so the DONE bar (with its permanent flag
  // chip) renders. Not in the spec — see plan "resolutions" item 5.
  | { kind: "session_ended"; nowMs: number };

// Emissions the caller must send through the events pipeline (spec §6 episode
// semantics: ONE topbar_hidden per excursion, ONE topbar_restored on restore).
export type ShellEmission =
  | { type: "topbar_hidden"; detail: { reason: string; trigger_type: string } }
  | { type: "topbar_restored"; detail: { hidden_ms: number; reasons: string[] } };

export type TopBarResult = { state: TopBarState; emit: ShellEmission | null };

export function topBarReducer(state: TopBarState, action: TopBarAction): TopBarResult {
  if (action.kind === "event") {
    const verdict = anomalyFromEvent(action.event.type, action.event.detail);
    if (!verdict.anomaly || !action.recording) return { state, emit: null };
    const reason: AnomalyReason = { type: verdict.reason, message: verdict.message, at: action.event.timestamp };
    if (!state.barHidden) {
      // First anomaly of an episode: ONE topbar_hidden + ONE flag increment.
      return {
        state: { barHidden: true, flagCount: state.flagCount + 1, activeReasons: [reason], hiddenAtMs: action.nowMs },
        emit: { type: "topbar_hidden", detail: { reason: verdict.message, trigger_type: verdict.reason } }
      };
    }
    // Already hidden: append the reason (deduped by type) — no double-counting
    // a single excursion that fires blur+hidden+fullscreen_exit together.
    if (state.activeReasons.some((r) => r.type === reason.type)) return { state, emit: null };
    return { state: { ...state, activeReasons: [...state.activeReasons, reason] }, emit: null };
  }

  if (action.kind === "restore") {
    const { fullscreen, visible, recording } = action.preconditions;
    if (!state.barHidden || !fullscreen || !visible || !recording) return { state, emit: null };
    return restoreState(state, action.nowMs);
  }

  // session_ended
  if (!state.barHidden) return { state, emit: null };
  return restoreState(state, action.nowMs);
}

function restoreState(state: TopBarState, nowMs: number): TopBarResult {
  return {
    state: { ...state, barHidden: false, activeReasons: [], hiddenAtMs: null },
    emit: {
      type: "topbar_restored",
      detail: {
        hidden_ms: state.hiddenAtMs == null ? 0 : Math.max(0, nowMs - state.hiddenAtMs),
        reasons: state.activeReasons.map((r) => r.type)
      }
    }
  };
}

// ---- Top-bar state persistence (per session) --------------------------------
//
// A page reload used to reset barHidden/flagCount/activeReasons while the
// session itself resumed via localStorage — a candidate could launder the ⚑
// flag chip with F5. The reducer state is therefore serialized per session id
// on every transition and rehydrated as the reducer's initial state on resume.
//
// TRUST LIMIT: this is client-side only. A candidate can still hand-delete the
// localStorage key (or edit it — tampering is detected only as a malformed
// shape and resets to the initial state). The server-side event stream
// (topbar_hidden / topbar_restored) remains the durable record of episodes;
// this persistence merely keeps the on-screen chip honest across reloads.

export function shellStateStorageKey(sessionId: string): string {
  return `aerele-proctor-shell-state-${sessionId}`;
}

// Explicit field pick so accidental extra in-memory fields never leak to disk.
export function serializeShellState(state: TopBarState): string {
  return JSON.stringify({
    barHidden: state.barHidden,
    flagCount: state.flagCount,
    activeReasons: state.activeReasons,
    hiddenAtMs: state.hiddenAtMs
  });
}

// Defensive parse: anything that is not exactly the persisted shape (malformed
// JSON, wrong types, missing fields, negative/fractional counts) falls back to
// the fresh initial state — never a half-applied object.
export function deserializeShellState(raw: string | null): TopBarState {
  if (raw == null) return initialTopBarState;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return initialTopBarState;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return initialTopBarState;
  const { barHidden, flagCount, activeReasons, hiddenAtMs } = parsed as Record<string, unknown>;
  if (typeof barHidden !== "boolean") return initialTopBarState;
  if (typeof flagCount !== "number" || !Number.isInteger(flagCount) || flagCount < 0) return initialTopBarState;
  if (hiddenAtMs !== null && typeof hiddenAtMs !== "number") return initialTopBarState;
  if (!Array.isArray(activeReasons)) return initialTopBarState;
  const reasons: AnomalyReason[] = [];
  for (const entry of activeReasons) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return initialTopBarState;
    const { type, message, at } = entry as Record<string, unknown>;
    if (typeof type !== "string" || typeof message !== "string" || typeof at !== "string") return initialTopBarState;
    reasons.push({ type, message, at });
  }
  return { barHidden, flagCount, activeReasons: reasons, hiddenAtMs };
}

// ---- Spec §8: shell event helpers -------------------------------------------

// Shell-emitted ProctorEvent — mirrors App.tsx createUiEvent, but pure:
// timestamp and visibility_state are passed in by the DOM-aware caller.
export function makeShellEvent(
  type: string,
  detail: Record<string, unknown> | undefined,
  nowIso: string,
  visibilityState: DocumentVisibilityState
): ProctorEvent {
  return { type, timestamp: nowIso, detail, visibility_state: visibilityState };
}

// Pre-session event buffer (spec §8): cap 50, oldest dropped. Best-effort
// audit, not evidence of record — dropped silently if no session ever exists.
export const SHELL_EVENT_BUFFER_CAP = 50;

export function appendToBuffer(
  buffer: ProctorEvent[],
  event: ProctorEvent,
  cap: number = SHELL_EVENT_BUFFER_CAP
): ProctorEvent[] {
  const next = [...buffer, event];
  return next.length > cap ? next.slice(next.length - cap) : next;
}
