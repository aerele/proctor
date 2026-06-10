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

export type EnforcementMode = "block" | "alert_first";

export type EnforcementConfig = {
  reentrySeconds: number;
  exitLimit: number;
  mode: EnforcementMode;
  exemptFullscreen: boolean;
};

export type EnforcementPhase = "idle" | "blocking" | "locking" | "alert_hold";

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
};

export const initialEnforcementState: EnforcementState = {
  phase: "idle",
  exitCount: 0,
  deadlineMs: null,
  ackOk: false
};

export type ViolationPhase = "countdown_expired" | "exit_limit";

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
function violate(state: EnforcementState, phase: ViolationPhase, config: EnforcementConfig): EnforcementResult {
  return {
    state: { ...state, phase: config.mode === "alert_first" ? "alert_hold" : "locking", ackOk: false },
    effects: [{ kind: "report_violation", phase, exitCount: state.exitCount }]
  };
}

// Resolve the L1 episode once BOTH conditions hold (typed phrase + fullscreen).
function tryResolve(state: EnforcementState, nowMs: number, fullscreen: boolean): EnforcementResult {
  if (!state.ackOk || !fullscreen) return noop(state);
  const remaining = state.deadlineMs == null ? 0 : Math.max(0, state.deadlineMs - nowMs);
  return {
    state: { ...state, phase: "idle", deadlineMs: null, ackOk: false },
    effects: [{ kind: "event", type: "fullscreen_enforcement_ack", detail: { exit_count: state.exitCount, remaining_ms: remaining } }]
  };
}

export function enforcementReducer(
  state: EnforcementState,
  action: EnforcementAction,
  config: EnforcementConfig
): EnforcementResult {
  if (action.kind === "session_ended") {
    return state.phase === "idle" ? noop(state) : noop({ ...state, phase: "idle", deadlineMs: null, ackOk: false });
  }

  if (action.kind === "config_change") {
    // Live exemption (heartbeat-delivered): release any active overlay.
    if (config.exemptFullscreen && state.phase !== "idle") {
      return noop({ ...state, phase: "idle", deadlineMs: null, ackOk: false });
    }
    return noop(state);
  }

  if (action.kind === "fullscreen_exit") {
    if (!action.recording || action.expected || config.exemptFullscreen) return noop(state);
    if (state.phase === "locking" || state.phase === "alert_hold") return noop(state);
    const exitCount = state.exitCount + 1;
    if (exitCount > config.exitLimit) {
      return violate({ ...state, exitCount }, "exit_limit", config);
    }
    // New episode keeps an EXISTING deadline (an exit while already blocking
    // must not extend the countdown); a fresh episode starts one.
    const deadlineMs = state.phase === "blocking" && state.deadlineMs != null
      ? state.deadlineMs
      : action.nowMs + config.reentrySeconds * 1000;
    return noop({ phase: "blocking", exitCount, deadlineMs, ackOk: state.phase === "blocking" ? state.ackOk : false });
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
    if (state.phase !== "blocking" || state.deadlineMs == null || action.nowMs < state.deadlineMs) return noop(state);
    return violate(state, "countdown_expired", config);
  }

  // violation_result — the server's verdict on a reported violation.
  if (state.phase !== "locking") return noop(state);
  if (action.exempt) return noop({ ...state, phase: "idle", deadlineMs: null, ackOk: false });
  if (action.locked) return noop(state); // gate flips to "locked"; overlay yields to the locked screen
  return noop({ ...state, phase: "alert_hold", ackOk: false });
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
    deadlineMs: state.deadlineMs
    // ackOk deliberately NOT persisted — the phrase must be retyped after reload.
  });
}

const PHASES: EnforcementPhase[] = ["idle", "blocking", "locking", "alert_hold"];

export function deserializeEnforcementState(raw: string | null): EnforcementState {
  if (raw == null) return initialEnforcementState;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return initialEnforcementState;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return initialEnforcementState;
  const { phase, exitCount, deadlineMs } = parsed as Record<string, unknown>;
  if (typeof phase !== "string" || !PHASES.includes(phase as EnforcementPhase)) return initialEnforcementState;
  if (typeof exitCount !== "number" || !Number.isInteger(exitCount) || exitCount < 0) return initialEnforcementState;
  if (deadlineMs !== null && typeof deadlineMs !== "number") return initialEnforcementState;
  // A persisted blocking phase without a deadline is a tampered shape.
  if (phase === "blocking" && deadlineMs == null) return initialEnforcementState;
  return { phase: phase as EnforcementPhase, exitCount, deadlineMs: deadlineMs as number | null, ackOk: false };
}
