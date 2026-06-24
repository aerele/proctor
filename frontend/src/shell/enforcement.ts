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

// W10 (product owner, exam morning): the typed ack is judged CASE-INSENSITIVELY (and
// whitespace-tolerantly) — a nervous candidate typing "i will not exit..."
// must not fail the countdown over a shift key. Pure so the reducer tests pin it.
export function matchesAckPhrase(text: string): boolean {
  const norm = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(text) === norm(FULLSCREEN_ACK_PHRASE);
}

// Wave-2 review fix: a violation report that never got a server verdict (failed
// POST, reload mid-flight) is RETRIED on the tick at this interval — one
// dropped request must never strand the candidate in a dead overlay while the
// server still shows a healthy session.
export const REPORT_RETRY_MS = 5_000;

// REC-3 (v1.1): the humane recovery FLOOR. A native Esc cannot be vetoed by JS
// (browser fact), so the only kindness available on an accidental fullscreen
// exit is enough time to re-enter fullscreen AND complete the ack before the
// lock fires. A contest configured with a very short reentry (one had ≈5 s) gave
// the candidate no realistic chance. The fresh-episode deadline is therefore
// floored at MIN_RECOVERY_SECONDS. This is the ONLY change to the ladder:
//   • below the 20 s default → byte-identical (Math.max picks reentrySeconds);
//   • the exitCount increment, the exit-limit hard-lock path, the
//     deadline-not-extended-on-re-exit rule, and the lock-on-expiry are ALL
//     unchanged. The floor rescues a sub-15 s contest; it never weakens the gate.
export const MIN_RECOVERY_SECONDS = 15;

export type EnforcementMode = "block" | "alert_first";

export type EnforcementConfig = {
  reentrySeconds: number;
  exitLimit: number;
  mode: EnforcementMode;
  exemptFullscreen: boolean;
  // #71: admin per-contest toggle (heartbeat-delivered, like exemptFullscreen)
  // that removes ONLY the typed-ack step from the L1/alert_hold recovery — the
  // re-enter-fullscreen requirement and the exit-limit/countdown escalation are
  // UNCHANGED. Absent (older backend / never set) = the full two-step recovery.
  simplifiedFullscreenRecovery?: boolean;
  // #135 take-home: SOFT pre-T0 mode (driven by the take-home WaitingRoom hold,
  // NOT examGateActive). While true, a fullscreen exit is RECORDED as an event
  // and shows a gentle "back to fullscreen" nudge, but it never consumes the
  // exit limit and never reports a violation — the real escalation ladder only
  // starts once the exam opens (softMode flips false at T0). Absent = off.
  softMode?: boolean;
};

// #135: "soft" is the take-home pre-T0 nudge phase. It is EPHEMERAL — never
// persisted (serialized AS "idle"; never restored), re-derivable from the live
// fullscreen state on the next exit. This mirrors the "ackOk deliberately not
// persisted" precedent and kills the cross-T0 stale-overlay bug.
// LT-5 (v1.1): "fs_block" is the NO-COUNTDOWN re-entry block — shown after an
// exception we already handled (post-unlock, post re-share) where the candidate
// must return to fullscreen but is NOT in a violation episode: no deadline, no
// exitCount increment, no report. Like "soft", it is EPHEMERAL — serialized AS
// "idle", never restored — and is re-derived from live fullscreen on the next
// require_fullscreen dispatch.
export type EnforcementPhase = "idle" | "blocking" | "locking" | "alert_hold" | "soft" | "fs_block";

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
  // #71 live-release: a heartbeat-delivered config change. `fullscreen` carries
  // the candidate's CURRENT fullscreen truth so the simplified-recovery flip can
  // resolve an in-fullscreen candidate immediately (the exemptFullscreen release
  // does not need it — released() ignores fullscreen — so it stays optional).
  | { kind: "config_change"; nowMs: number; fullscreen?: boolean }
  | { kind: "violation_result"; locked: boolean; exempt?: boolean; nowMs: number }
  | { kind: "session_ended"; nowMs: number }
  // LT-5 (v1.1): the host demands fullscreen WITHOUT a countdown after an
  // exception it already handled (post-unlock, post re-share). `fullscreen`
  // carries the candidate's CURRENT fullscreen truth so the reducer can transition
  // idle↔fs_block. It NEVER touches the violation ladder (exitCount/deadline/
  // violation/reportPending) and is a no-op under softMode (a pre-T0 candidate must
  // never be forced into fs_block).
  | { kind: "require_fullscreen"; fullscreen: boolean; nowMs: number };

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

// Resolve the L1 episode once the recovery conditions hold. Normally that is
// BOTH the typed phrase AND fullscreen; with #71's simplified-recovery toggle
// on, the typed-ack condition is treated as satisfied so re-entering fullscreen
// alone resolves the episode (the fullscreen requirement is NEVER dropped).
function tryResolve(state: EnforcementState, nowMs: number, fullscreen: boolean, config: EnforcementConfig): EnforcementResult {
  const ackSatisfied = config.simplifiedFullscreenRecovery === true || state.ackOk;
  if (!ackSatisfied || !fullscreen) return noop(state);
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
    // #71 live-release: simplified-fullscreen-recovery flipped ON mid-episode.
    // A candidate already stuck in the red overlay AND already back in
    // fullscreen has no actionable element (the ack input is hidden by the flip
    // and the re-enter button is hidden because fullscreen is already true), so
    // mirror exemptFullscreen's mid-block release: try to resolve NOW. The
    // fullscreen requirement is NEVER dropped — tryResolve only resolves when
    // action.fullscreen is true, so a candidate NOT in fullscreen stays blocking
    // and must still re-enter.
    if (config.simplifiedFullscreenRecovery === true
      && (state.phase === "blocking" || state.phase === "alert_hold")) {
      return tryResolve(state, action.nowMs, action.fullscreen === true, config);
    }
    // #135 T0 flip: soft mode turned OFF (the exam opened). Drop a lingering
    // soft nudge to idle so the live ladder starts clean at exitCount=0 — the
    // pre-T0 soft exits never seed the count.
    if (!config.softMode && state.phase === "soft") {
      return noop({ ...state, phase: "idle" });
    }
    return noop(state);
  }

  // LT-5 (v1.1): the NO-COUNTDOWN re-entry block. The host dispatches this after
  // an exception it already handled (post-unlock, post re-share) to require
  // fullscreen WITHOUT arming a countdown. It is a REDUCER INVARIANT (not a host
  // convention) that this only ever moves idle↔fs_block and NEVER touches the
  // violation ladder — so bouncing through fs_block can never farm a free exit or
  // reset the cumulative exitCount.
  if (action.kind === "require_fullscreen") {
    // MI-2: a no-op under softMode — a soft/pre-T0 candidate must NEVER be forced
    // into fs_block. Placed FIRST in this arm's ordered precedence, mirroring the
    // fullscreen_exit softMode early-return below.
    if (config.softMode) return noop(state);
    if (action.fullscreen) {
      // Back in fullscreen: clear the block. Only ever clears the fs_block we own
      // — an active blocking/alert_hold/locking/soft episode is left untouched
      // (require_fullscreen only transitions idle↔fs_block).
      return state.phase === "fs_block" ? noop({ ...state, phase: "idle" }) : noop(state);
    }
    // Out of fullscreen: arm the no-countdown block, but ONLY from idle/fs_block —
    // never clobber a live violation episode (blocking/alert_hold/locking) or a
    // soft nudge. Never increments exitCount, never sets a deadline.
    return state.phase === "idle" || state.phase === "fs_block"
      ? noop({ ...state, phase: "fs_block" })
      : noop(state);
  }

  if (action.kind === "fullscreen_exit") {
    if (!action.recording || action.expected || config.exemptFullscreen) return noop(state);
    // #135 take-home pre-T0: RECORD the exit + show a gentle nudge, but NEVER
    // touch exitCount and NEVER report a violation — the exam hasn't started, so
    // nothing counts against the candidate yet. The real ladder begins at T0.
    if (config.softMode) {
      return {
        state: { ...state, phase: "soft" },
        effects: [{ kind: "event", type: "fullscreen_exit_soft", detail: { expected: action.expected } }]
      };
    }
    if (state.phase === "locking" || state.phase === "alert_hold") return noop(state);
    const exitCount = state.exitCount + 1;
    if (exitCount > config.exitLimit) {
      return violate({ ...state, exitCount }, "exit_limit", config, action.nowMs);
    }
    // A re-exit WITHIN the SAME live blocking window keeps the EXISTING deadline
    // (an exit while already blocking must not extend the countdown — the
    // anti-farming invariant); a fresh episode starts a new one. REC-3: a fresh
    // deadline is floored at MIN_RECOVERY_SECONDS so a contest configured below the
    // floor still leaves a humane window to recover.
    //
    // LT-3 FIX (v1.1, CONFIRMED LIVE BUG): the existing deadline is only reused
    // while it is STILL IN THE FUTURE. The previous code reused it for ANY
    // phase==="blocking", so a STALE (already-expired) deadline — left behind when
    // a candidate re-entered fullscreen in the default flow without yet typing the
    // ack, so tryResolve never settled the episode to idle and never cleared the
    // deadline — was reused by a much-later exit, which then locked IMMEDIATELY on
    // the next tick (the "second exit locks immediately" symptom). Gating on
    // `state.deadlineMs > action.nowMs` keeps the anti-farming invariant for a
    // genuine re-exit inside the live window (deadline still future ⇒ reused, not
    // extended) while giving a later genuine exit a FRESH, floored countdown. The
    // cumulative exitCount ladder above is untouched — the floor/reuse change only
    // affects the per-episode deadline, never the session exit budget.
    const reuseExistingDeadline = state.phase === "blocking"
      && state.deadlineMs != null
      && state.deadlineMs > action.nowMs;
    const deadlineMs = reuseExistingDeadline
      ? state.deadlineMs as number
      : action.nowMs + Math.max(config.reentrySeconds, MIN_RECOVERY_SECONDS) * 1000;
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
    return action.matched ? tryResolve(next, action.nowMs, action.fullscreen, config) : noop(next);
  }

  if (action.kind === "fullscreen_change") {
    if (!action.fullscreen) return noop(state); // exits arrive via fullscreen_exit
    // #135 take-home: re-entering fullscreen clears the soft nudge silently (no
    // ack event — nothing was held against the candidate pre-T0).
    if (state.phase === "soft") return noop({ ...state, phase: "idle" });
    if (state.phase !== "blocking" && state.phase !== "alert_hold") return noop(state);
    return tryResolve(state, action.nowMs, true, config);
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
//
// #71: with simplified recovery on there is no typed-ack step, so re-entering
// fullscreen is the ONLY action — the back-in-fullscreen headline drops the
// plural "steps" wording (there is nothing left to finish).
// #135: the optional `opts` carries take-home context ({ takeHome, phone }) so
// the locked/alert copy can route the candidate to their remote proctor instead
// of "raise your hand". Absent ⇒ byte-identical in-venue copy (D3).
export type EnforcementCopyOptions = { takeHome?: boolean; phone?: string };

export function enforcementHeadline(phase: EnforcementPhase, fullscreen: boolean, simplifiedRecovery = false): string {
  // #135 take-home pre-T0 soft nudge — gentle, never says "exit #N" or implies
  // the limit (the exam hasn't started).
  if (phase === "soft") return "You're not in fullscreen";
  // LT-5 (v1.1): the no-countdown re-entry block — CALM, no-fault copy. MUST sit
  // ABOVE the `!fullscreen` line below (BL-2b): fs_block is always out-of-
  // fullscreen, so without this it would be shadowed by the accusatory
  // "You left fullscreen". This is a return-to-fullscreen prompt, not a violation.
  if (phase === "fs_block") return "Enter full screen to continue";
  if (phase === "locking") return "Test disabled";
  if (!fullscreen) return "You left fullscreen";
  return simplifiedRecovery ? "Return to fullscreen to continue" : "Finish the steps to continue";
}

// W5 fix (same truthfulness rule for the sub-line): once back in fullscreen,
// point at the remaining step instead of repeating the exit instruction.
//
// #71: simplified recovery has a single action (re-enter fullscreen), so the
// out-of-fullscreen line points at that one button instead of "BOTH steps".
export function enforcementSubline(phase: EnforcementPhase, fullscreen: boolean, exitCount: number, simplifiedRecovery = false, opts?: EnforcementCopyOptions): string {
  // #135 take-home pre-T0 soft nudge — reassure, do NOT name the exit number or
  // imply the limit (nothing is counted yet).
  if (phase === "soft") {
    return "Your exam hasn't started yet. Please return to fullscreen — this was noted but not counted against you.";
  }
  // LT-5 (v1.1): the no-countdown re-entry block — CALM, no-fault copy. MUST sit
  // ABOVE the `if (fullscreen)` and `!fullscreen` paths below (BL-2b) so it is
  // never shadowed. No "exit #N", no "test will be locked" — this is a plain
  // return-to-fullscreen prompt after an exception we already handled.
  if (phase === "fs_block") {
    return "You're not in fullscreen — return to fullscreen to continue your exam.";
  }
  if (phase === "locking") {
    // Remote (take-home): point at the proctor phone instead of "raise your hand".
    return opts?.takeHome
      ? `Your test is being locked. Call your proctor at ${opts.phone || "the number provided"}.`
      : "Your test is being locked. Raise your hand and call your room proctor.";
  }
  if (fullscreen) {
    return `Fullscreen exit #${exitCount} was recorded. You are back in fullscreen — finish the remaining step below to continue your exam.`;
  }
  // FLOW-1 (v1.1): on an accidental fullscreen EXIT the candidate is still in the
  // recoverable "blocking" window — a native Esc can't be vetoed, so reassure them
  // up front that the test is PAUSED, not locked, before the recovery steps. Only
  // on "blocking" (alert_hold means the violation already fired / proctor alerted,
  // so "not locked" would mislead). The "exit #N" + steps wording is preserved.
  const recoverable = phase === "blocking"
    ? "You left full screen. Your test is paused, not locked — "
    : "";
  return simplifiedRecovery
    ? `${recoverable}Fullscreen exit #${exitCount} was recorded. Return to fullscreen below to continue your exam.`
    : `${recoverable}Fullscreen exit #${exitCount} was recorded. Complete BOTH steps below to continue your exam.`;
}

// Wave-3 fix: the alert_hold banner used to claim "Time expired" even when the
// hold was reached through the EXIT LIMIT — word it by the violation that
// tripped. null (legacy persisted state with no violation) keeps the time
// wording, the pre-fix default.
//
// #71: simplified recovery has a single action, so the banner says "Return to
// fullscreen" instead of "Complete both steps".
export function alertHoldMessage(violation: ViolationPhase | null, simplifiedRecovery = false, opts?: EnforcementCopyOptions): string {
  const cause = violation === "exit_limit"
    ? "You exited fullscreen too many times"
    : "Time expired";
  // Remote (take-home): route to the proctor phone instead of the in-room
  // invigilator. Absent opts ⇒ byte-identical in-venue copy (D3).
  const fallback = opts?.takeHome
    ? `call your proctor at ${opts.phone || "the number provided"}`
    : "wait for the invigilator";
  const action = simplifiedRecovery
    ? `Return to fullscreen below to continue, or ${fallback}.`
    : `Complete both steps below to continue, or ${fallback}.`;
  return `${cause} — your proctor has been alerted. ${action}`;
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
    // #135 (A2) + LT-5 (v1.1): "soft" and "fs_block" are EPHEMERAL — serialized
    // AS "idle" and never restored, so a reload never resurrects a stale pre-T0
    // nudge or a stale re-entry block. Both are re-derived from live fullscreen on
    // the next exit / require_fullscreen dispatch. Mirrors the "ackOk deliberately
    // not persisted" precedent.
    phase: state.phase === "soft" || state.phase === "fs_block" ? "idle" : state.phase,
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

// #135 (A2) + LT-5 (v1.1): "soft" and "fs_block" are deliberately NOT in the
// allowlist — a persisted/tampered "soft"/"fs_block" phase is never restored (it
// falls back to initial), reinforcing that both are ephemeral and re-derivable on
// the next live exit / require_fullscreen dispatch.
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
