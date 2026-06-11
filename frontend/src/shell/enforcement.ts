// frontend/src/shell/enforcement.ts
//
// F5.3/F5.6 — fullscreen HARD-BLOCK enforcement: PURE state machine only (no
// React, no DOM, no network). The escalation ladder:
//   L1 ("blocking")  — fullscreen exit while recording engages a full-screen
//                      takeover overlay; the candidate must TYPE the exact ack
//                      phrase AND re-enter fullscreen within the countdown.
//   L2 ("locking")   — countdown expiry OR more than K exits reports a
//                      violation; in "block" mode the server locks the session
//                      (release = room code or admin/invigilator unlock).
//   ("alert_hold")   — "alert_first" mode: the violation raises a critical
//                      alert but never locks; the candidate stays in the ack
//                      overlay until they comply or an invigilator acts.
// Exemptions (F5.5): an exempt session never engages the overlay — exits ride
// the event pipeline as plain anomalies (the S1 soft treatment).
//
// The driving hook (useEnforcement.ts) is thin glue: it samples DOM truth,
// runs the tick interval, performs the report_violation POST, and persists
// every transition per session so a reload mid-block re-engages the overlay.

export const FULLSCREEN_ACK_PHRASE = "I will not exit full screen after this";

// Wave-2 review fix: a violation report that never got a server verdict (failed
// POST, reload mid-flight) is RETRIED on the tick at this interval — one
// dropped request must never strand the candidate in a dead overlay while the
// server still shows a healthy session.
export const REPORT_RETRY_MS = 5_000;

export type EnforcementMode = "block" | "alert_first";

export type EnforcementConfig = {
  reentrySeconds: number;
  exitLimit: number;
  mode: EnforcementMode;
  exemptFullscreen: boolean;
};

export type EnforcementPhase = "idle" | "blocking" | "locking" | "alert_hold";

export type ViolationPhase = "countdown_expired" | "exit_limit";

export type EnforcementState = {
  phase: EnforcementPhase;
  // Total unexpected fullscreen exits this session (never reset by an episode
  // resolving — the K-exit ladder counts the session, not the episode).
  exitCount: number;
  // Absolute wall-clock deadline of the CURRENT blocking episode. Absolute so
  // a reload cannot restart the countdown.
  deadlineMs: number | null;
  // The exact phrase has been typed this episode (resets on engage + reload).
  ackOk: boolean;
  // The violation being (re)reported to the server — kept so a tick retry (or
  // a reload mid-locking) re-sends the SAME phase the ladder tripped on.
  violation: ViolationPhase | null;
  // True from the violate() transition until a violation_result verdict
  // arrives; while true, ticks re-emit report_violation every REPORT_RETRY_MS.
  reportPending: boolean;
  // Absolute earliest time of the next retry. null = retry on the next tick
  // (the reload case — retryAtMs is deliberately NOT persisted).
  retryAtMs: number | null;
};

export const initialEnforcementState: EnforcementState = {
  phase: "idle",
  exitCount: 0,
  deadlineMs: null,
  ackOk: false,
  violation: null,
  reportPending: false,
  retryAtMs: null
};

// Effects the caller must perform (mirrors examShell's emission pattern):
//   report_violation → POST /api/session/enforcement-violation (the server
//     raises the critical alert and decides lock vs alert-only).
//   event → emit a shell ProctorEvent through the normal pipeline.
export type EnforcementEffect =
  | { kind: "report_violation"; phase: ViolationPhase; exitCount: number }
  | { kind: "event"; type: string; detail: Record<string, unknown> };

export type EnforcementAction =
  | { kind: "fullscreen_exit"; nowMs: number; recording: boolean; expected: boolean }
  | { kind: "fullscreen_change"; fullscreen: boolean; nowMs: number }
  | { kind: "ack"; matched: boolean; fullscreen: boolean; nowMs: number }
  | { kind: "tick"; nowMs: number }
  | { kind: "config_change"; nowMs: number }
  | { kind: "violation_result"; locked: boolean; exempt?: boolean; nowMs: number }
  | { kind: "session_ended"; nowMs: number };

export type EnforcementResult = { state: EnforcementState; effects: EnforcementEffect[] };

function noop(state: EnforcementState): EnforcementResult {
  return { state, effects: [] };
}

// The single violation transition: block mode → "locking" (the effect's POST
// will lock the session server-side); alert_first → "alert_hold" (alert only).
// The report stays pending (and tick-retried) until a violation_result lands.
function violate(state: EnforcementState, phase: ViolationPhase, config: EnforcementConfig, nowMs: number): EnforcementResult {
  return {
    state: {
      ...state,
      phase: config.mode === "alert_first" ? "alert_hold" : "locking",
      ackOk: false,
      violation: phase,
      reportPending: true,
      retryAtMs: nowMs + REPORT_RETRY_MS
    },
    effects: [{ kind: "report_violation", phase, exitCount: state.exitCount }]
  };
}

// Release any active phase back to idle (resolution, exemption, session end) —
// clears the episode AND any pending report retry.
function released(state: EnforcementState): EnforcementState {
  return { ...state, phase: "idle", deadlineMs: null, ackOk: false, violation: null, reportPending: false, retryAtMs: null };
}

// Resolve the L1 episode once BOTH conditions hold (typed phrase + fullscreen).
function tryResolve(state: EnforcementState, nowMs: number, fullscreen: boolean): EnforcementResult {
  if (!state.ackOk || !fullscreen) return noop(state);
  const remaining = state.deadlineMs == null ? 0 : Math.max(0, state.deadlineMs - nowMs);
  return {
    state: released(state),
    effects: [{ kind: "event", type: "fullscreen_enforcement_ack", detail: { exit_count: state.exitCount, remaining_ms: remaining } }]
  };
}

export function enforcementReducer(
  state: EnforcementState,
  action: EnforcementAction,
  config: EnforcementConfig
): EnforcementResult {
  if (action.kind === "session_ended") {
    return state.phase === "idle" ? noop(state) : noop(released(state));
  }

  if (action.kind === "config_change") {
    // Live exemption (heartbeat-delivered): release any active overlay.
    if (config.exemptFullscreen && state.phase !== "idle") {
      return noop(released(state));
    }
    return noop(state);
  }

  if (action.kind === "fullscreen_exit") {
    if (!action.recording || action.expected || config.exemptFullscreen) return noop(state);
    if (state.phase === "locking" || state.phase === "alert_hold") return noop(state);
    const exitCount = state.exitCount + 1;
    if (exitCount > config.exitLimit) {
      return violate({ ...state, exitCount }, "exit_limit", config, action.nowMs);
    }
    // New episode keeps an EXISTING deadline (an exit while already blocking
    // must not extend the countdown); a fresh episode starts one.
    const deadlineMs = state.phase === "blocking" && state.deadlineMs != null
      ? state.deadlineMs
      : action.nowMs + config.reentrySeconds * 1000;
    return noop({
      ...state,
      phase: "blocking",
      exitCount,
      deadlineMs,
      ackOk: state.phase === "blocking" ? state.ackOk : false
    });
  }

  if (action.kind === "ack") {
    if (state.phase !== "blocking" && state.phase !== "alert_hold") return noop(state);
    const next = { ...state, ackOk: action.matched };
    return action.matched ? tryResolve(next, action.nowMs, action.fullscreen) : noop(next);
  }

  if (action.kind === "fullscreen_change") {
    if (!action.fullscreen) return noop(state); // exits arrive via fullscreen_exit
    if (state.phase !== "blocking" && state.phase !== "alert_hold") return noop(state);
    return tryResolve(state, action.nowMs, true);
  }

  if (action.kind === "tick") {
    if (state.phase === "blocking") {
      if (state.deadlineMs == null || action.nowMs < state.deadlineMs) return noop(state);
      return violate(state, "countdown_expired", config, action.nowMs);
    }
    // Wave-2 review fix: retry an unanswered violation report. retryAtMs null
    // means "retry on the next tick" (a reload mid-locking restores that way).
    if ((state.phase === "locking" || state.phase === "alert_hold") && state.reportPending
      && (state.retryAtMs == null || action.nowMs >= state.retryAtMs)) {
      return {
        state: { ...state, retryAtMs: action.nowMs + REPORT_RETRY_MS },
        effects: [{ kind: "report_violation", phase: state.violation ?? "countdown_expired", exitCount: state.exitCount }]
      };
    }
    return noop(state);
  }

  // violation_result — the server's verdict on a reported violation. Settles
  // the pending report (stops the tick retries) whatever the verdict.
  if (state.phase !== "locking" && state.phase !== "alert_hold") return noop(state);
  const settled = { ...state, reportPending: false, retryAtMs: null };
  if (action.exempt) return noop(released(settled));
  if (action.locked) return noop(settled); // gate flips to "locked"; overlay yields to the locked screen
  if (state.phase === "locking") return noop({ ...settled, phase: "alert_hold", ackOk: false });
  return noop(settled);
}

// ---- Overlay / countdown helpers --------------------------------------------

// The takeover overlay renders for ANY active phase except when the locked /
// ended screens own the viewport (gate is App's StudentGate-compatible union).
export function enforcementOverlayVisible(state: EnforcementState, gate: string): boolean {
  return state.phase !== "idle" && gate !== "locked" && gate !== "ended";
}

// Seconds left on the blocking countdown (rounded UP so "0" means expired),
// null when no countdown is running.
export function enforcementRemainingSeconds(state: EnforcementState, nowMs: number): number | null {
  if (state.phase !== "blocking" || state.deadlineMs == null) return null;
  return Math.max(0, Math.ceil((state.deadlineMs - nowMs) / 1000));
}

// W5 fix: the overlay headline must tell the truth about the CURRENT state.
// It used to read "You left fullscreen" for the whole episode — including
// after the candidate had already returned to fullscreen and only the typed
// phrase was missing, which read as a stuck/looping alert ("I came back, why
// is it still shouting?"). Pure so the wording is vitest-tested.
export function enforcementHeadline(phase: EnforcementPhase, fullscreen: boolean): string {
  if (phase === "locking") return "Test disabled";
  return fullscreen ? "Finish the steps to continue" : "You left fullscreen";
}

// W5 fix (same truthfulness rule for the sub-line): once back in fullscreen,
// point at the remaining step instead of repeating the exit instruction.
export function enforcementSubline(phase: EnforcementPhase, fullscreen: boolean, exitCount: number): string {
  if (phase === "locking") return "Your test is being locked. Raise your hand and call your room proctor.";
  return fullscreen
    ? `Fullscreen exit #${exitCount} was recorded. You are back in fullscreen — finish the remaining step below to continue your exam.`
    : `Fullscreen exit #${exitCount} was recorded. Complete BOTH steps below to continue your exam.`;
}

// Wave-3 fix: the alert_hold banner used to claim "Time expired" even when the
// hold was reached through the EXIT LIMIT — word it by the violation that
// tripped. null (legacy persisted state with no violation) keeps the time
// wording, the pre-fix default.
export function alertHoldMessage(violation: ViolationPhase | null): string {
  const cause = violation === "exit_limit"
    ? "You exited fullscreen too many times"
    : "Time expired";
  return `${cause} — your proctor has been alerted. Complete both steps below to continue, or wait for the invigilator.`;
}

// ---- Persistence (per session) ----------------------------------------------
//
// Mirrors examShell's top-bar persistence: a reload mid-block must re-engage
// the overlay (and keep the ABSOLUTE deadline, so F5 is not an escape hatch).
// Client-side trust limit identical to the shell state: hand-deleting the key
// only un-renders the overlay — the server-side events/alerts remain durable,
// and a candidate who stays out of fullscreen re-engages on the next exit.

export function enforcementStorageKey(sessionId: string): string {
  return `aerele-proctor-enforcement-${sessionId}`;
}

export function serializeEnforcementState(state: EnforcementState): string {
  return JSON.stringify({
    phase: state.phase,
    exitCount: state.exitCount,
    deadlineMs: state.deadlineMs,
    // Wave-2 fix: the unanswered-report bookkeeping survives a reload so the
    // first tick after restore re-sends the violation (retryAtMs deliberately
    // NOT persisted — null = retry immediately).
    violation: state.violation,
    reportPending: state.reportPending
    // ackOk deliberately NOT persisted — the phrase must be retyped after reload.
  });
}

const PHASES: EnforcementPhase[] = ["idle", "blocking", "locking", "alert_hold"];
const VIOLATION_PHASES: ViolationPhase[] = ["countdown_expired", "exit_limit"];

export function deserializeEnforcementState(raw: string | null): EnforcementState {
  if (raw == null) return initialEnforcementState;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return initialEnforcementState;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return initialEnforcementState;
  const { phase, exitCount, deadlineMs, violation, reportPending } = parsed as Record<string, unknown>;
  if (typeof phase !== "string" || !PHASES.includes(phase as EnforcementPhase)) return initialEnforcementState;
  if (typeof exitCount !== "number" || !Number.isInteger(exitCount) || exitCount < 0) return initialEnforcementState;
  if (deadlineMs !== null && typeof deadlineMs !== "number") return initialEnforcementState;
  // A persisted blocking phase without a deadline is a tampered shape.
  if (phase === "blocking" && deadlineMs == null) return initialEnforcementState;
  // A legacy payload (pre-retry fields) restoring into "locking" is exactly the
  // stranded-overlay case the retry exists for — treat its report as pending.
  const restoredPending = typeof reportPending === "boolean"
    ? reportPending
    : phase === "locking";
  return {
    phase: phase as EnforcementPhase,
    exitCount,
    deadlineMs: deadlineMs as number | null,
    ackOk: false,
    violation: typeof violation === "string" && VIOLATION_PHASES.includes(violation as ViolationPhase)
      ? violation as ViolationPhase
      : null,
    reportPending: restoredPending,
    retryAtMs: null
  };
}
