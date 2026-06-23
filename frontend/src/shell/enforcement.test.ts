// frontend/src/shell/enforcement.test.ts
//
// F5.3/F5.6 — fullscreen HARD-BLOCK enforcement state machine (pure reducer).
// Covers the brief's required set: exit→ack flow, countdown expiry in BOTH
// enforcement modes, K-exit escalation, exemption bypass, and reload-mid-block
// re-engaging the overlay from persisted state.
import { describe, it, expect } from "vitest";
import {
  matchesAckPhrase,
  FULLSCREEN_ACK_PHRASE,
  REPORT_RETRY_MS,
  MIN_RECOVERY_SECONDS,
  alertHoldMessage,
  enforcementHeadline,
  enforcementSubline,
  initialEnforcementState,
  enforcementReducer,
  enforcementOverlayVisible,
  enforcementRemainingSeconds,
  serializeEnforcementState,
  deserializeEnforcementState,
  enforcementStorageKey,
  type EnforcementConfig,
  type EnforcementState
} from "./enforcement";

const config: EnforcementConfig = {
  reentrySeconds: 20,
  exitLimit: 2,
  mode: "block",
  exemptFullscreen: false
};

const T0 = 1_000_000;

function exit(state: EnforcementState, nowMs = T0, cfg = config, recording = true, expected = false) {
  return enforcementReducer(state, { kind: "fullscreen_exit", nowMs, recording, expected }, cfg);
}

describe("enforcementReducer — exit → ack flow (L1)", () => {
  it("fullscreen exit while recording engages the blocking overlay with a deadline", () => {
    const { state, effects } = exit(initialEnforcementState);
    expect(state.phase).toBe("blocking");
    expect(state.exitCount).toBe(1);
    expect(state.deadlineMs).toBe(T0 + 20_000);
    expect(state.ackOk).toBe(false);
    expect(effects).toEqual([]);
  });

  it("ignores exits while not recording, and the expected end-of-test exit", () => {
    expect(exit(initialEnforcementState, T0, config, false).state.phase).toBe("idle");
    expect(exit(initialEnforcementState, T0, config, true, true).state.phase).toBe("idle");
  });

  it("typed phrase alone does NOT resolve — fullscreen must also be back", () => {
    const blocking = exit(initialEnforcementState).state;
    const { state } = enforcementReducer(blocking, { kind: "ack", matched: true, fullscreen: false, nowMs: T0 + 5000 }, config);
    expect(state.phase).toBe("blocking");
    expect(state.ackOk).toBe(true);
  });

  it("fullscreen re-entry alone does NOT resolve — the phrase must be typed", () => {
    const blocking = exit(initialEnforcementState).state;
    const { state } = enforcementReducer(blocking, { kind: "fullscreen_change", fullscreen: true, nowMs: T0 + 5000 }, config);
    expect(state.phase).toBe("blocking");
  });

  it("phrase + fullscreen together resolve to idle and emit the ack event", () => {
    const blocking = exit(initialEnforcementState).state;
    const acked = enforcementReducer(blocking, { kind: "ack", matched: true, fullscreen: false, nowMs: T0 + 4000 }, config).state;
    const { state, effects } = enforcementReducer(acked, { kind: "fullscreen_change", fullscreen: true, nowMs: T0 + 6000 }, config);
    expect(state.phase).toBe("idle");
    expect(state.exitCount).toBe(1); // exit tally survives the episode
    expect(effects).toEqual([
      { kind: "event", type: "fullscreen_enforcement_ack", detail: { exit_count: 1, remaining_ms: 14_000 } }
    ]);
  });

  it("resolves in either order (fullscreen first, then phrase)", () => {
    const blocking = exit(initialEnforcementState).state;
    const { state } = enforcementReducer(blocking, { kind: "ack", matched: true, fullscreen: true, nowMs: T0 + 3000 }, config);
    expect(state.phase).toBe("idle");
  });

  it("a wrong phrase never sets ackOk", () => {
    const blocking = exit(initialEnforcementState).state;
    const { state } = enforcementReducer(blocking, { kind: "ack", matched: false, fullscreen: true, nowMs: T0 + 3000 }, config);
    expect(state.ackOk).toBe(false);
    expect(state.phase).toBe("blocking");
  });

  it("the exact phrase is the published constant", () => {
    expect(FULLSCREEN_ACK_PHRASE).toBe("I will not exit full screen after this");
  });
});

// #71 — admin per-contest toggle that drops ONLY the typed-ack step. The
// re-enter-fullscreen requirement and the exit-limit/countdown escalation are
// UNCHANGED; only the typed-phrase condition is removed.
describe("enforcementReducer — simplified fullscreen recovery (#71)", () => {
  const simplified: EnforcementConfig = { ...config, simplifiedFullscreenRecovery: true };

  it("simplified: re-entering fullscreen ALONE resolves the episode — no phrase required", () => {
    const blocking = exit(initialEnforcementState, T0, simplified).state;
    expect(blocking.phase).toBe("blocking");
    expect(blocking.ackOk).toBe(false);
    const { state, effects } = enforcementReducer(blocking, { kind: "fullscreen_change", fullscreen: true, nowMs: T0 + 5000 }, simplified);
    expect(state.phase).toBe("idle");
    expect(state.exitCount).toBe(1); // exit tally still survives the episode
    expect(effects).toEqual([
      { kind: "event", type: "fullscreen_enforcement_ack", detail: { exit_count: 1, remaining_ms: 15_000 } }
    ]);
  });

  it("default (flag off): fullscreen re-entry alone does NOT resolve — the phrase is still required", () => {
    const blocking = exit(initialEnforcementState).state;
    const { state } = enforcementReducer(blocking, { kind: "fullscreen_change", fullscreen: true, nowMs: T0 + 5000 }, config);
    expect(state.phase).toBe("blocking");
  });

  it("simplified: still does NOT resolve without fullscreen (the fullscreen requirement is never dropped)", () => {
    const blocking = exit(initialEnforcementState, T0, simplified).state;
    // An ack that's somehow matched but NOT yet in fullscreen must still hold.
    const { state } = enforcementReducer(blocking, { kind: "ack", matched: true, fullscreen: false, nowMs: T0 + 3000 }, simplified);
    expect(state.phase).toBe("blocking");
  });

  it("simplified: alert_hold also resolves on fullscreen alone", () => {
    const cfg: EnforcementConfig = { ...simplified, mode: "alert_first" };
    const blocking = exit(initialEnforcementState, T0, cfg).state;
    const hold = enforcementReducer(blocking, { kind: "tick", nowMs: T0 + 20_000 }, cfg).state;
    expect(hold.phase).toBe("alert_hold");
    const { state } = enforcementReducer(hold, { kind: "fullscreen_change", fullscreen: true, nowMs: T0 + 30_000 }, cfg);
    expect(state.phase).toBe("idle");
  });

  it("simplified: the exit-limit escalation is UNCHANGED (still locks past the limit)", () => {
    // limit 2: third exit escalates to locking regardless of the recovery flag.
    let state = exit(initialEnforcementState, T0, simplified).state;
    state = exit(state, T0 + 1000, simplified).state;
    const third = exit(state, T0 + 2000, simplified);
    expect(third.state.phase).toBe("locking");
    expect(third.effects).toEqual([
      { kind: "report_violation", phase: "exit_limit", exitCount: 3 }
    ]);
  });

  it("simplified: the countdown-expiry escalation is UNCHANGED (still locks on timeout)", () => {
    const blocking = exit(initialEnforcementState, T0, simplified).state;
    const { state, effects } = enforcementReducer(blocking, { kind: "tick", nowMs: T0 + 20_000 }, simplified);
    expect(state.phase).toBe("locking");
    expect(effects).toEqual([
      { kind: "report_violation", phase: "countdown_expired", exitCount: 1 }
    ]);
  });
});

describe("enforcementReducer — countdown expiry", () => {
  it("block mode: deadline passing reports the violation and enters locking", () => {
    const blocking = exit(initialEnforcementState).state;
    const { state, effects } = enforcementReducer(blocking, { kind: "tick", nowMs: T0 + 20_000 }, config);
    expect(state.phase).toBe("locking");
    expect(effects).toEqual([
      { kind: "report_violation", phase: "countdown_expired", exitCount: 1 }
    ]);
  });

  it("alert_first mode: deadline passing reports the violation but holds in the ack overlay", () => {
    const cfg: EnforcementConfig = { ...config, mode: "alert_first" };
    const blocking = exit(initialEnforcementState, T0, cfg).state;
    const { state, effects } = enforcementReducer(blocking, { kind: "tick", nowMs: T0 + 20_000 }, cfg);
    expect(state.phase).toBe("alert_hold");
    expect(effects).toEqual([
      { kind: "report_violation", phase: "countdown_expired", exitCount: 1 }
    ]);
  });

  it("ticks before the deadline change nothing", () => {
    const blocking = exit(initialEnforcementState).state;
    const { state, effects } = enforcementReducer(blocking, { kind: "tick", nowMs: T0 + 19_999 }, config);
    expect(state).toBe(blocking);
    expect(effects).toEqual([]);
  });

  it("alert_hold still resolves when the candidate finally complies", () => {
    const cfg: EnforcementConfig = { ...config, mode: "alert_first" };
    const blocking = exit(initialEnforcementState, T0, cfg).state;
    const hold = enforcementReducer(blocking, { kind: "tick", nowMs: T0 + 20_000 }, cfg).state;
    const acked = enforcementReducer(hold, { kind: "ack", matched: true, fullscreen: true, nowMs: T0 + 30_000 }, cfg);
    expect(acked.state.phase).toBe("idle");
  });

  it("ticks inside the retry interval do not re-report", () => {
    const blocking = exit(initialEnforcementState).state;
    const locking = enforcementReducer(blocking, { kind: "tick", nowMs: T0 + 20_000 }, config).state;
    const again = enforcementReducer(locking, { kind: "tick", nowMs: T0 + 20_000 + REPORT_RETRY_MS - 1 }, config);
    expect(again.effects).toEqual([]);
    expect(again.state).toBe(locking);
  });
});

// Wave-2 review fix: a FAILED violation POST used to strand the candidate in a
// dead "Test disabled" overlay forever (tick was a no-op outside blocking, so
// nothing ever retried while the server still showed a healthy session). The
// report now retries on the tick until a violation_result verdict arrives.
describe("enforcementReducer — violation report retry (failed POST recovery)", () => {
  it("locking with a pending report re-emits report_violation once the retry interval passes", () => {
    const blocking = exit(initialEnforcementState).state;
    const locking = enforcementReducer(blocking, { kind: "tick", nowMs: T0 + 20_000 }, config).state;
    expect(locking.reportPending).toBe(true);
    const retried = enforcementReducer(locking, { kind: "tick", nowMs: T0 + 20_000 + REPORT_RETRY_MS }, config);
    expect(retried.effects).toEqual([
      { kind: "report_violation", phase: "countdown_expired", exitCount: 1 }
    ]);
    // The next retry waits a full interval again.
    const tooSoon = enforcementReducer(retried.state, { kind: "tick", nowMs: T0 + 20_000 + REPORT_RETRY_MS + 1000 }, config);
    expect(tooSoon.effects).toEqual([]);
  });

  it("a violation_result settles the report — no further retries", () => {
    const blocking = exit(initialEnforcementState).state;
    const locking = enforcementReducer(blocking, { kind: "tick", nowMs: T0 + 20_000 }, config).state;
    const settled = enforcementReducer(locking, { kind: "violation_result", locked: true, nowMs: T0 + 21_000 }, config).state;
    expect(settled.reportPending).toBe(false);
    const later = enforcementReducer(settled, { kind: "tick", nowMs: T0 + 21_000 + REPORT_RETRY_MS * 3 }, config);
    expect(later.effects).toEqual([]);
  });

  it("alert_hold (alert_first mode) retries a pending report too, and keeps the exit_limit phase", () => {
    const cfg: EnforcementConfig = { ...config, mode: "alert_first", exitLimit: 0 };
    const hold = exit(initialEnforcementState, T0, cfg).state;
    expect(hold.phase).toBe("alert_hold");
    expect(hold.reportPending).toBe(true);
    const retried = enforcementReducer(hold, { kind: "tick", nowMs: T0 + REPORT_RETRY_MS }, cfg);
    expect(retried.effects).toEqual([
      { kind: "report_violation", phase: "exit_limit", exitCount: 1 }
    ]);
  });

  it("a reload mid-locking re-reports on the FIRST tick (persisted pending state)", () => {
    const blocking = exit(initialEnforcementState).state;
    const locking = enforcementReducer(blocking, { kind: "tick", nowMs: T0 + 20_000 }, config).state;
    const restored = deserializeEnforcementState(serializeEnforcementState(locking));
    expect(restored.phase).toBe("locking");
    expect(restored.reportPending).toBe(true);
    const { effects } = enforcementReducer(restored, { kind: "tick", nowMs: T0 + 60_000 }, config);
    expect(effects).toEqual([
      { kind: "report_violation", phase: "countdown_expired", exitCount: 1 }
    ]);
  });

  it("a LEGACY persisted locking payload (no pending flag) still retries after reload", () => {
    const legacy = JSON.stringify({ phase: "locking", exitCount: 2, deadlineMs: null });
    const restored = deserializeEnforcementState(legacy);
    expect(restored.phase).toBe("locking");
    expect(restored.reportPending).toBe(true);
    const { effects } = enforcementReducer(restored, { kind: "tick", nowMs: T0 }, config);
    expect(effects).toEqual([
      { kind: "report_violation", phase: "countdown_expired", exitCount: 2 }
    ]);
  });

  it("resolving an alert_hold episode (ack + fullscreen) stops any pending retry", () => {
    const cfg: EnforcementConfig = { ...config, mode: "alert_first", exitLimit: 0 };
    const hold = exit(initialEnforcementState, T0, cfg).state;
    const resolved = enforcementReducer(hold, { kind: "ack", matched: true, fullscreen: true, nowMs: T0 + 5000 }, cfg).state;
    expect(resolved.phase).toBe("idle");
    expect(resolved.reportPending).toBe(false);
    const later = enforcementReducer(resolved, { kind: "tick", nowMs: T0 + REPORT_RETRY_MS * 2 }, cfg);
    expect(later.effects).toEqual([]);
  });
});

describe("enforcementReducer — K-exit escalation (L2)", () => {
  it("exceeding the exit limit reports an exit_limit violation immediately (block mode)", () => {
    // limit 2: exits 1 and 2 are L1 episodes; exit 3 escalates.
    let state = exit(initialEnforcementState, T0).state;
    state = enforcementReducer(state, { kind: "ack", matched: true, fullscreen: true, nowMs: T0 + 1000 }, config).state;
    state = exit(state, T0 + 10_000).state;
    state = enforcementReducer(state, { kind: "ack", matched: true, fullscreen: true, nowMs: T0 + 11_000 }, config).state;
    const third = exit(state, T0 + 20_000);
    expect(third.state.phase).toBe("locking");
    expect(third.state.exitCount).toBe(3);
    expect(third.effects).toEqual([
      { kind: "report_violation", phase: "exit_limit", exitCount: 3 }
    ]);
  });

  it("exit while already blocking counts toward the limit but keeps the original deadline", () => {
    const first = exit(initialEnforcementState, T0).state;
    const reentered = enforcementReducer(first, { kind: "fullscreen_change", fullscreen: true, nowMs: T0 + 2000 }, config).state;
    const second = exit(reentered, T0 + 4000);
    expect(second.state.phase).toBe("blocking");
    expect(second.state.exitCount).toBe(2);
    expect(second.state.deadlineMs).toBe(T0 + 20_000); // NOT extended
  });

  it("alert_first mode: exceeding the limit holds in the overlay instead of locking", () => {
    const cfg: EnforcementConfig = { ...config, mode: "alert_first", exitLimit: 0 };
    const { state, effects } = exit(initialEnforcementState, T0, cfg);
    expect(state.phase).toBe("alert_hold");
    expect(effects).toEqual([
      { kind: "report_violation", phase: "exit_limit", exitCount: 1 }
    ]);
  });
});

// REC-3 (v1.1) — the humane recovery FLOOR. A fresh blocking episode's deadline
// is floored at MIN_RECOVERY_SECONDS so a contest configured below the floor
// still leaves a realistic window to re-enter fullscreen + ack before the lock.
// The floor must NOT weaken any part of the ladder: exitCount still increments,
// the exit-limit hard-lock still trips, the deadline is NOT extended on a
// re-exit, and the lock still fires at the (floored) deadline.
describe("enforcementReducer — REC-3 humane recovery floor", () => {
  it("the floor constant is 15 seconds", () => {
    expect(MIN_RECOVERY_SECONDS).toBe(15);
  });

  it("reentrySeconds BELOW the floor (≈5s contest) is raised to MIN_RECOVERY_SECONDS", () => {
    const short: EnforcementConfig = { ...config, reentrySeconds: 5 };
    const { state } = exit(initialEnforcementState, T0, short);
    expect(state.phase).toBe("blocking");
    // 5s would have been T0+5000; the floor lifts it to T0+15000.
    expect(state.deadlineMs).toBe(T0 + MIN_RECOVERY_SECONDS * 1000);
  });

  it("reentrySeconds AT the floor stays exactly the floor (no double-apply)", () => {
    const atFloor: EnforcementConfig = { ...config, reentrySeconds: 15 };
    const { state } = exit(initialEnforcementState, T0, atFloor);
    expect(state.deadlineMs).toBe(T0 + 15_000);
  });

  it("reentrySeconds ABOVE the floor (the 20s default) is byte-identical — floor never shortens", () => {
    // config.reentrySeconds is 20 → the default contest is unchanged.
    const { state } = exit(initialEnforcementState, T0, config);
    expect(state.deadlineMs).toBe(T0 + 20_000);
    // an explicitly larger value is also untouched.
    const longCfg: EnforcementConfig = { ...config, reentrySeconds: 45 };
    expect(exit(initialEnforcementState, T0, longCfg).state.deadlineMs).toBe(T0 + 45_000);
  });

  it("INVARIANT: exitCount still increments on every exit under a sub-floor config", () => {
    const short: EnforcementConfig = { ...config, reentrySeconds: 5 };
    const first = exit(initialEnforcementState, T0, short).state;
    expect(first.exitCount).toBe(1);
    const reentered = enforcementReducer(first, { kind: "fullscreen_change", fullscreen: true, nowMs: T0 + 1000 }, short).state;
    const second = exit(reentered, T0 + 2000, short).state;
    expect(second.exitCount).toBe(2);
  });

  it("INVARIANT: the exit-limit hard-lock ladder is UNCHANGED under a sub-floor config (no enforcement hole)", () => {
    // exitLimit 2: the 3rd exit must still hard-lock regardless of the floor.
    const short: EnforcementConfig = { ...config, reentrySeconds: 5 };
    let state = exit(initialEnforcementState, T0, short).state;
    state = exit(state, T0 + 1000, short).state;
    const third = exit(state, T0 + 2000, short);
    expect(third.state.phase).toBe("locking");
    expect(third.effects).toEqual([
      { kind: "report_violation", phase: "exit_limit", exitCount: 3 }
    ]);
  });

  it("INVARIANT: the deadline is NOT extended on a re-exit while blocking (floor applies only to a fresh episode)", () => {
    const short: EnforcementConfig = { ...config, reentrySeconds: 5 };
    const first = exit(initialEnforcementState, T0, short).state;
    expect(first.deadlineMs).toBe(T0 + 15_000); // floored fresh deadline
    // re-enter, then exit AGAIN before the deadline — the original (floored)
    // deadline must survive; the floor must not re-stamp a NEW later deadline.
    const reentered = enforcementReducer(first, { kind: "fullscreen_change", fullscreen: true, nowMs: T0 + 3000 }, short).state;
    const second = exit(reentered, T0 + 6000, short);
    expect(second.state.phase).toBe("blocking");
    expect(second.state.exitCount).toBe(2);
    expect(second.state.deadlineMs).toBe(T0 + 15_000); // NOT extended, NOT re-floored from T0+6000
  });

  it("INVARIANT: the lock STILL fires at the floored deadline if the candidate never re-enters", () => {
    const short: EnforcementConfig = { ...config, reentrySeconds: 5 };
    const blocking = exit(initialEnforcementState, T0, short).state;
    // just before the floored deadline: no escalation.
    const early = enforcementReducer(blocking, { kind: "tick", nowMs: T0 + 15_000 - 1 }, short);
    expect(early.state.phase).toBe("blocking");
    expect(early.effects).toEqual([]);
    // at the floored deadline: the lock fires.
    const { state, effects } = enforcementReducer(blocking, { kind: "tick", nowMs: T0 + 15_000 }, short);
    expect(state.phase).toBe("locking");
    expect(effects).toEqual([
      { kind: "report_violation", phase: "countdown_expired", exitCount: 1 }
    ]);
  });
});

// FLOW-1 (v1.1) — the recovery copy reassures the candidate the test is PAUSED,
// not locked, on an accidental EXIT (out-of-fullscreen blocking phase).
describe("enforcementSubline — FLOW-1 'paused, not locked' recovery reassurance", () => {
  it("blocking + out of fullscreen: leads with 'paused, not locked' and keeps the exit/steps wording", () => {
    const sub = enforcementSubline("blocking", false, 1);
    expect(sub).toContain("paused, not locked");
    expect(sub).toContain("exit #1");
    expect(sub).toContain("Complete BOTH steps"); // wave-5 wording preserved
  });

  it("blocking + out of fullscreen, simplified: still leads with 'paused, not locked', single action", () => {
    const sub = enforcementSubline("blocking", false, 1, true);
    expect(sub).toContain("paused, not locked");
    expect(sub).toContain("Return to fullscreen");
    expect(sub).not.toMatch(/both steps/i);
  });

  it("alert_hold + out of fullscreen: does NOT claim 'not locked' (the violation already fired)", () => {
    const sub = enforcementSubline("alert_hold", false, 2);
    expect(sub).not.toContain("paused, not locked");
    expect(sub).toContain("exit #2");
  });

  it("back in fullscreen: the reassurance lead is absent (the candidate already recovered fullscreen)", () => {
    expect(enforcementSubline("blocking", true, 1)).not.toContain("paused, not locked");
  });
});

describe("enforcementReducer — exemption bypass + live config", () => {
  it("exempt fullscreen: exits never engage the overlay", () => {
    const cfg: EnforcementConfig = { ...config, exemptFullscreen: true };
    const { state, effects } = exit(initialEnforcementState, T0, cfg);
    expect(state).toBe(initialEnforcementState);
    expect(effects).toEqual([]);
  });

  it("an exemption arriving mid-block releases the overlay", () => {
    const blocking = exit(initialEnforcementState).state;
    const cfg: EnforcementConfig = { ...config, exemptFullscreen: true };
    const { state } = enforcementReducer(blocking, { kind: "config_change", nowMs: T0 + 5000 }, cfg);
    expect(state.phase).toBe("idle");
  });

  // FIX 2 (exam-eve 2026-06-18): flipping simplified-fullscreen-recovery ON via
  // the heartbeat while a candidate is ALREADY blocking AND already back in
  // fullscreen must release them immediately — without this the overlay hides
  // both the ack input AND (fullscreen already true) the re-enter button, so
  // there is NO actionable element and the candidate is stranded until the
  // countdown expires into alert_hold.
  it("flip simplifiedFullscreenRecovery ON while blocking AND already in fullscreen → resolves to idle", () => {
    const blocking = exit(initialEnforcementState).state;
    expect(blocking.phase).toBe("blocking");
    const cfg: EnforcementConfig = { ...config, simplifiedFullscreenRecovery: true };
    const { state, effects } = enforcementReducer(blocking, { kind: "config_change", nowMs: T0 + 5000, fullscreen: true }, cfg);
    expect(state.phase).toBe("idle");
    // The resolution emits the ack event (same as a normal resolve).
    expect(effects.some((e) => e.kind === "event" && e.type === "fullscreen_enforcement_ack")).toBe(true);
  });

  // Guard: the fullscreen requirement is NEVER dropped. A candidate NOT in
  // fullscreen when the flip lands must STAY blocking and re-enter to resolve.
  it("flip simplifiedFullscreenRecovery ON while NOT in fullscreen → stays blocking (still requires fullscreen)", () => {
    const blocking = exit(initialEnforcementState).state;
    const cfg: EnforcementConfig = { ...config, simplifiedFullscreenRecovery: true };
    const { state, effects } = enforcementReducer(blocking, { kind: "config_change", nowMs: T0 + 5000, fullscreen: false }, cfg);
    expect(state.phase).toBe("blocking");
    expect(effects).toEqual([]);
    // …and re-entering fullscreen then resolves (no typed ack needed).
    const resolved = enforcementReducer(state, { kind: "fullscreen_change", fullscreen: true, nowMs: T0 + 6000 }, cfg).state;
    expect(resolved.phase).toBe("idle");
  });

  // The same live-release applies to alert_hold (candidate already past the
  // countdown but in fullscreen) — flipping the flag releases them.
  it("flip simplifiedFullscreenRecovery ON while in alert_hold AND in fullscreen → resolves to idle", () => {
    const cfg: EnforcementConfig = { ...config, mode: "alert_first" };
    const blocking = exit(initialEnforcementState, T0, cfg).state;
    const hold = enforcementReducer(blocking, { kind: "tick", nowMs: T0 + 20_000 }, cfg).state;
    expect(hold.phase).toBe("alert_hold");
    const flipped: EnforcementConfig = { ...cfg, simplifiedFullscreenRecovery: true };
    const { state } = enforcementReducer(hold, { kind: "config_change", nowMs: T0 + 21_000, fullscreen: true }, flipped);
    expect(state.phase).toBe("idle");
  });

  // The flip is a no-op when idle (nothing to resolve) — must not spuriously
  // emit an ack event or change state.
  it("flip simplifiedFullscreenRecovery ON while idle → no-op", () => {
    const cfg: EnforcementConfig = { ...config, simplifiedFullscreenRecovery: true };
    const { state, effects } = enforcementReducer(initialEnforcementState, { kind: "config_change", nowMs: T0, fullscreen: true }, cfg);
    expect(state).toBe(initialEnforcementState);
    expect(effects).toEqual([]);
  });

  it("session end releases any phase", () => {
    const blocking = exit(initialEnforcementState).state;
    const { state } = enforcementReducer(blocking, { kind: "session_ended", nowMs: T0 + 5000 }, config);
    expect(state.phase).toBe("idle");
  });

  it("violation_result locked:false (server says alert-only / exempt) falls back to alert_hold", () => {
    const blocking = exit(initialEnforcementState).state;
    const locking = enforcementReducer(blocking, { kind: "tick", nowMs: T0 + 20_000 }, config).state;
    const { state } = enforcementReducer(locking, { kind: "violation_result", locked: false, nowMs: T0 + 21_000 }, config);
    expect(state.phase).toBe("alert_hold");
  });

  it("violation_result exempt:true releases entirely", () => {
    const blocking = exit(initialEnforcementState).state;
    const locking = enforcementReducer(blocking, { kind: "tick", nowMs: T0 + 20_000 }, config).state;
    const { state } = enforcementReducer(locking, { kind: "violation_result", locked: false, exempt: true, nowMs: T0 + 21_000 }, config);
    expect(state.phase).toBe("idle");
  });
});

describe("enforcement persistence (reload mid-block re-engages)", () => {
  it("round-trips phase/exitCount/deadline, resetting the typed ack", () => {
    const blocking = exit(initialEnforcementState).state;
    const acked = enforcementReducer(blocking, { kind: "ack", matched: true, fullscreen: false, nowMs: T0 + 1000 }, config).state;
    const restored = deserializeEnforcementState(serializeEnforcementState(acked));
    expect(restored.phase).toBe("blocking");
    expect(restored.exitCount).toBe(1);
    expect(restored.deadlineMs).toBe(T0 + 20_000);
    expect(restored.ackOk).toBe(false); // must retype after reload
  });

  it("a reload past the deadline still escalates on the next tick", () => {
    const blocking = exit(initialEnforcementState).state;
    const restored = deserializeEnforcementState(serializeEnforcementState(blocking));
    const { state, effects } = enforcementReducer(restored, { kind: "tick", nowMs: T0 + 60_000 }, config);
    expect(state.phase).toBe("locking");
    expect(effects).toEqual([
      { kind: "report_violation", phase: "countdown_expired", exitCount: 1 }
    ]);
  });

  it("malformed / tampered payloads fall back to the initial state", () => {
    expect(deserializeEnforcementState(null)).toEqual(initialEnforcementState);
    expect(deserializeEnforcementState("not json")).toEqual(initialEnforcementState);
    expect(deserializeEnforcementState(JSON.stringify({ phase: "nonsense" }))).toEqual(initialEnforcementState);
    expect(deserializeEnforcementState(JSON.stringify({ phase: "blocking", exitCount: -2, deadlineMs: null }))).toEqual(initialEnforcementState);
  });

  it("storage key is per session", () => {
    expect(enforcementStorageKey("abc")).toBe("aerele-proctor-enforcement-abc");
  });
});

describe("overlay visibility + countdown helpers", () => {
  it("visible while a phase is active and the gate is not locked/ended", () => {
    const blocking = exit(initialEnforcementState).state;
    expect(enforcementOverlayVisible(blocking, "running")).toBe(true);
    expect(enforcementOverlayVisible(blocking, "locked")).toBe(false);
    expect(enforcementOverlayVisible(blocking, "ended")).toBe(false);
    expect(enforcementOverlayVisible(initialEnforcementState, "running")).toBe(false);
  });

  it("remaining seconds clamp at zero and round up", () => {
    const blocking = exit(initialEnforcementState).state;
    expect(enforcementRemainingSeconds(blocking, T0 + 500)).toBe(20);
    expect(enforcementRemainingSeconds(blocking, T0 + 19_100)).toBe(1);
    expect(enforcementRemainingSeconds(blocking, T0 + 25_000)).toBe(0);
    expect(enforcementRemainingSeconds(initialEnforcementState, T0)).toBe(null);
  });
});

// Wave-3 fix: the alert_hold banner used to claim "Time expired" even when the
// hold was reached through the EXIT LIMIT — the copy must name the violation
// that actually tripped.
describe("enforcementHeadline / enforcementSubline (W5 — overlay tells the live truth)", () => {
  it("out of fullscreen: the classic exit wording", () => {
    expect(enforcementHeadline("blocking", false)).toBe("You left fullscreen");
    expect(enforcementHeadline("alert_hold", false)).toBe("You left fullscreen");
    expect(enforcementSubline("blocking", false, 1)).toContain("Complete BOTH steps");
    expect(enforcementSubline("blocking", false, 1)).toContain("exit #1");
  });

  it("back in fullscreen (phrase still missing): points at the remaining step instead of re-shouting the exit", () => {
    expect(enforcementHeadline("blocking", true)).toBe("Finish the steps to continue");
    expect(enforcementHeadline("alert_hold", true)).toBe("Finish the steps to continue");
    expect(enforcementSubline("alert_hold", true, 2)).toContain("back in fullscreen");
    expect(enforcementSubline("alert_hold", true, 2)).toContain("exit #2");
  });

  it("locking reads as the lock regardless of fullscreen state", () => {
    expect(enforcementHeadline("locking", false)).toBe("Test disabled");
    expect(enforcementHeadline("locking", true)).toBe("Test disabled");
    expect(enforcementSubline("locking", true, 3)).toContain("locked");
  });

  // #71: with simplified recovery on there is a SINGLE action (re-enter
  // fullscreen) — the copy must not promise "both steps" / plural "steps".
  it("simplified recovery: copy reads in terms of the single re-enter-fullscreen action", () => {
    // out of fullscreen: subline points at the one button, never "BOTH steps".
    const subline = enforcementSubline("blocking", false, 1, true);
    expect(subline).toContain("exit #1");
    expect(subline).toContain("Return to fullscreen");
    expect(subline).not.toMatch(/both steps/i);
    expect(subline).not.toMatch(/steps/i);
    // back-in-fullscreen headline is singular, not the plural "steps" wording.
    expect(enforcementHeadline("blocking", true, true)).toBe("Return to fullscreen to continue");
    expect(enforcementHeadline("alert_hold", true, true)).toBe("Return to fullscreen to continue");
    expect(enforcementHeadline("blocking", true, true)).not.toMatch(/steps/i);
  });

  it("default path is unchanged when the simplified flag is explicitly false", () => {
    expect(enforcementHeadline("blocking", true, false)).toBe("Finish the steps to continue");
    expect(enforcementSubline("blocking", false, 1, false)).toContain("Complete BOTH steps");
    // out-of-fullscreen headline ignores the flag (the exit wording is shared).
    expect(enforcementHeadline("blocking", false, true)).toBe("You left fullscreen");
  });
});

describe("alertHoldMessage", () => {
  it("countdown expiry reads as time expired", () => {
    expect(alertHoldMessage("countdown_expired")).toMatch(/^Time expired/);
  });
  it("exit-limit holds name the exit limit, not time", () => {
    expect(alertHoldMessage("exit_limit")).toMatch(/exit/i);
    expect(alertHoldMessage("exit_limit")).not.toMatch(/time expired/i);
  });
  it("an unknown/null violation (legacy persisted state) keeps the time wording", () => {
    expect(alertHoldMessage(null)).toMatch(/^Time expired/);
  });
  it("every variant tells the candidate the proctor was alerted and how to continue", () => {
    for (const violation of ["countdown_expired", "exit_limit", null] as const) {
      expect(alertHoldMessage(violation)).toMatch(/proctor has been alerted/);
      expect(alertHoldMessage(violation)).toMatch(/both steps/i);
    }
  });

  // #71: simplified recovery banner names the single re-enter-fullscreen action.
  it("simplified recovery: the banner says return to fullscreen, not both steps", () => {
    for (const violation of ["countdown_expired", "exit_limit", null] as const) {
      const msg = alertHoldMessage(violation, true);
      expect(msg).toMatch(/proctor has been alerted/);
      expect(msg).toMatch(/return to fullscreen/i);
      expect(msg).not.toMatch(/both steps/i);
    }
    // the cause wording is still violation-specific (wave-3 rule preserved).
    expect(alertHoldMessage("exit_limit", true)).toMatch(/exit/i);
    expect(alertHoldMessage("countdown_expired", true)).toMatch(/^Time expired/);
  });
});

// #135 take-home — SOFT pre-T0 enforcement. While softMode is true (the
// take-home WaitingRoom hold, pre-T0), a fullscreen exit is RECORDED as an event
// and shows a gentle nudge, but never consumes the exit limit and never reports
// a violation. At T0 softMode flips false and the real ladder starts clean.
describe("enforcementReducer — soft pre-T0 mode (#135)", () => {
  const soft: EnforcementConfig = { ...config, softMode: true };

  // T-F3 — soft→full transition
  it("T-F3: a soft exit records an event, leaves exitCount untouched, no report_violation, phase 'soft'", () => {
    const { state, effects } = exit(initialEnforcementState, T0, soft);
    expect(state.phase).toBe("soft");
    expect(state.exitCount).toBe(0); // NOT consumed
    expect(effects).toEqual([
      { kind: "event", type: "fullscreen_exit_soft", detail: { expected: false } }
    ]);
    // no report_violation in the effects at all
    expect(effects.some((e) => e.kind === "report_violation")).toBe(false);
  });

  it("T-F3: re-entering fullscreen clears the soft nudge to idle (no ack event)", () => {
    const softState = exit(initialEnforcementState, T0, soft).state;
    expect(softState.phase).toBe("soft");
    const { state, effects } = enforcementReducer(softState, { kind: "fullscreen_change", fullscreen: true, nowMs: T0 + 2000 }, soft);
    expect(state.phase).toBe("idle");
    expect(state.exitCount).toBe(0);
    expect(effects).toEqual([]); // silent — nothing was held against the candidate
  });

  it("T-F3: flipping softMode OFF (T0) clears a lingering soft nudge to idle; the NEXT exit starts the ladder at exitCount=1", () => {
    const softState = exit(initialEnforcementState, T0, soft).state;
    expect(softState.phase).toBe("soft");
    // T0 flip: softMode now false.
    const flipped = enforcementReducer(softState, { kind: "config_change", nowMs: T0 + 1000, fullscreen: false }, config);
    expect(flipped.state.phase).toBe("idle");
    expect(flipped.state.exitCount).toBe(0); // soft exits never seeded the count
    expect(flipped.effects).toEqual([]);
    // The first real exit after T0 engages the full ladder at exitCount=1.
    const firstReal = exit(flipped.state, T0 + 2000, config);
    expect(firstReal.state.phase).toBe("blocking");
    expect(firstReal.state.exitCount).toBe(1);
    expect(firstReal.state.deadlineMs).toBe(T0 + 2000 + 20_000);
  });

  // T-F4 — soft never locks
  it("T-F4: repeated soft exits beyond the exit limit never lock and never POST a violation", () => {
    let state = initialEnforcementState;
    let allEffects: ReturnType<typeof exit>["effects"] = [];
    // exitLimit is 2; fire 5 soft exits — far past it.
    for (let i = 0; i < 5; i++) {
      const res = exit(state, T0 + i * 1000, soft);
      state = res.state;
      allEffects = allEffects.concat(res.effects);
    }
    expect(state.phase).toBe("soft");
    expect(state.exitCount).toBe(0);
    expect(allEffects.every((e) => e.kind === "event" && e.type === "fullscreen_exit_soft")).toBe(true);
    expect(allEffects.some((e) => e.kind === "report_violation")).toBe(false);
  });

  // T-F5 — soft inert in tick
  it("T-F5: tick on a 'soft' state is a noop (no deadline, no escalation)", () => {
    const softState = exit(initialEnforcementState, T0, soft).state;
    const { state, effects } = enforcementReducer(softState, { kind: "tick", nowMs: T0 + 60_000 }, soft);
    expect(state).toBe(softState); // referentially unchanged
    expect(effects).toEqual([]);
  });

  // T-F4 cont. — the expected end-of-test exit and not-recording are still ignored in soft mode.
  it("soft mode still ignores exits while not recording and the expected exit", () => {
    expect(exit(initialEnforcementState, T0, soft, false).state.phase).toBe("idle");
    expect(exit(initialEnforcementState, T0, soft, true, true).state.phase).toBe("idle");
  });

  // exemptFullscreen still wins over softMode (an exempt session never overlays).
  it("exemptFullscreen takes precedence over softMode (no overlay at all)", () => {
    const cfg: EnforcementConfig = { ...soft, exemptFullscreen: true };
    const { state, effects } = exit(initialEnforcementState, T0, cfg);
    expect(state).toBe(initialEnforcementState);
    expect(effects).toEqual([]);
  });
});

// T-F7 — soft-mode trigger (C-1 regression). softMode is the reducer's only
// lever for soft enforcement; it is driven by waitingRoomActive at the call site
// (StudentApp), NOT examGateActive. A take-home contest with room_gate_enabled
// off therefore still enters soft mode — proven here at the reducer boundary:
// soft behavior depends ONLY on config.softMode, with no room-gate coupling.
describe("enforcementReducer — soft trigger is config.softMode alone (T-F7 / C-1)", () => {
  it("soft behavior engages purely from config.softMode (room-gate-independent)", () => {
    // No room-gate concept exists in the reducer — softMode is the whole trigger.
    const soft: EnforcementConfig = { ...config, softMode: true };
    expect(exit(initialEnforcementState, T0, soft).state.phase).toBe("soft");
    // The same exit with softMode off is the classic blocking ladder.
    expect(exit(initialEnforcementState, T0, config).state.phase).toBe("blocking");
  });
});

// AMENDMENT A2 + A16 — the soft phase must NOT persist (cross-T0 stale-overlay
// kill) and the T0 boundary must be deterministic.
describe("soft phase persistence + T0 boundary determinism (A2 / A16)", () => {
  const soft: EnforcementConfig = { ...config, softMode: true };

  // A2: serialize a soft phase AS idle; never restore soft on deserialize.
  it("A2: a soft phase serializes AS 'idle' and round-trips to idle (never restored)", () => {
    const softState = exit(initialEnforcementState, T0, soft).state;
    expect(softState.phase).toBe("soft");
    const serialized = serializeEnforcementState(softState);
    expect(JSON.parse(serialized).phase).toBe("idle"); // serialized AS idle
    const restored = deserializeEnforcementState(serialized);
    expect(restored.phase).toBe("idle");
  });

  it("A2: a tampered/forced { phase: 'soft' } payload falls back to the initial state (soft not in allowlist)", () => {
    expect(deserializeEnforcementState(JSON.stringify({ phase: "soft", exitCount: 3, deadlineMs: null })))
      .toEqual(initialEnforcementState);
  });

  // A16: persist soft → deserialize (softMode=false) → phase idle + exitCount
  // preserved + next exit increments to 1; first exit strictly after
  // softMode=false yields exitCount=1; no double-count.
  it("A16: persist soft → deserialize (softMode off) → phase idle, exitCount preserved, next exit increments to 1", () => {
    // Build a state that already has a real pre-existing exitCount, then a soft
    // nudge layered on (exitCount must survive the soft serialize→restore).
    let state = exit(initialEnforcementState, T0, config).state; // real exit, exitCount=1
    state = enforcementReducer(state, { kind: "ack", matched: true, fullscreen: true, nowMs: T0 + 500 }, config).state; // resolve → idle, exitCount=1
    expect(state.exitCount).toBe(1);
    // Now a soft nudge (would only happen if softMode were on — construct it directly via the reducer).
    const softState = exit(state, T0 + 1000, soft).state;
    expect(softState.phase).toBe("soft");
    expect(softState.exitCount).toBe(1); // soft did not touch it
    // Persist (cross-T0 reload) and restore under softMode=false.
    const restored = deserializeEnforcementState(serializeEnforcementState(softState));
    expect(restored.phase).toBe("idle"); // soft never restored
    expect(restored.exitCount).toBe(1); // preserved
    // The next REAL exit (post-T0) increments to 2 — one physical exit, one increment.
    const next = exit(restored, T0 + 2000, config);
    expect(next.state.phase).toBe("blocking");
    expect(next.state.exitCount).toBe(2);
  });

  it("A16: the first exit strictly after softMode=false yields exitCount=1 from a clean start (no pre-T0 seeding, no double-count)", () => {
    // Pre-T0: several soft exits — none seed the count.
    let state = initialEnforcementState;
    for (let i = 0; i < 3; i++) state = exit(state, T0 + i * 1000, soft).state;
    expect(state.phase).toBe("soft");
    expect(state.exitCount).toBe(0);
    // T0 flip clears the lingering soft nudge.
    const cleared = enforcementReducer(state, { kind: "config_change", nowMs: T0 + 5000, fullscreen: false }, config).state;
    expect(cleared.phase).toBe("idle");
    expect(cleared.exitCount).toBe(0);
    // The FIRST real exit yields exactly 1 — not 0 (no-op), not 2 (double-count).
    const first = exit(cleared, T0 + 6000, config);
    expect(first.state.exitCount).toBe(1);
    expect(first.state.phase).toBe("blocking");
  });
});

// REGRESSION (D3): with softMode absent/false throughout, every soft-touching
// path is byte-identical to today — the soft feature is fully gated.
describe("regression — softMode=false is behavior-preserving (D3)", () => {
  it("a fullscreen exit with softMode off behaves exactly as today (blocking ladder, exitCount=1)", () => {
    const { state, effects } = exit(initialEnforcementState, T0, config);
    expect(state.phase).toBe("blocking");
    expect(state.exitCount).toBe(1);
    expect(state.deadlineMs).toBe(T0 + 20_000);
    expect(effects).toEqual([]);
  });

  it("config_change with softMode off and no soft phase is the pre-existing no-op (idle stays idle)", () => {
    const { state, effects } = enforcementReducer(initialEnforcementState, { kind: "config_change", nowMs: T0, fullscreen: false }, config);
    expect(state).toBe(initialEnforcementState);
    expect(effects).toEqual([]);
  });

  it("config_change with softMode off does not disturb an active blocking episode", () => {
    const blocking = exit(initialEnforcementState, T0, config).state;
    const { state, effects } = enforcementReducer(blocking, { kind: "config_change", nowMs: T0 + 1000, fullscreen: false }, config);
    expect(state).toBe(blocking);
    expect(effects).toEqual([]);
  });

  it("serialize/deserialize of a normal blocking state is unchanged by the soft coercion", () => {
    const blocking = exit(initialEnforcementState, T0, config).state;
    const restored = deserializeEnforcementState(serializeEnforcementState(blocking));
    expect(restored.phase).toBe("blocking");
    expect(restored.exitCount).toBe(1);
    expect(restored.deadlineMs).toBe(T0 + 20_000);
  });
});

// T-F6 — message variants. With { takeHome, phone } the locking/alert copy
// routes to the proctor phone; without the opts arg the in-venue copy is
// byte-identical (D3). Plus the soft copy arms.
describe("copy variants — take-home {phone} threading + soft arms (T-F6)", () => {
  it("enforcementSubline locking: takeHome+phone routes to the proctor number", () => {
    const remote = enforcementSubline("locking", false, 3, false, { takeHome: true, phone: "+91 98765 43210" });
    expect(remote).toContain("Call your proctor at +91 98765 43210");
    expect(remote).not.toMatch(/raise your hand/i);
  });

  it("enforcementSubline locking: no opts arg is byte-identical in-venue copy (D3)", () => {
    expect(enforcementSubline("locking", true, 3)).toBe("Your test is being locked. Raise your hand and call your room proctor.");
    // explicit falsy opts is also in-venue
    expect(enforcementSubline("locking", true, 3, false, { takeHome: false })).toBe("Your test is being locked. Raise your hand and call your room proctor.");
  });

  it("alertHoldMessage: takeHome+phone routes to the proctor number, not the invigilator", () => {
    const remote = alertHoldMessage("countdown_expired", false, { takeHome: true, phone: "+91 98765 43210" });
    expect(remote).toContain("call your proctor at +91 98765 43210");
    expect(remote).not.toMatch(/invigilator/i);
  });

  it("alertHoldMessage: no opts arg is byte-identical in-venue copy (D3)", () => {
    expect(alertHoldMessage("countdown_expired")).toBe("Time expired — your proctor has been alerted. Complete both steps below to continue, or wait for the invigilator.");
    expect(alertHoldMessage("countdown_expired", false, { takeHome: false })).toBe("Time expired — your proctor has been alerted. Complete both steps below to continue, or wait for the invigilator.");
  });

  it("the soft headline/subline arms are gentle and never imply the limit or name 'exit #N'", () => {
    expect(enforcementHeadline("soft", false)).toBe("You're not in fullscreen");
    expect(enforcementHeadline("soft", true)).toBe("You're not in fullscreen");
    const sub = enforcementSubline("soft", false, 5);
    expect(sub).toContain("hasn't started yet");
    expect(sub).toContain("not counted against you");
    expect(sub).not.toMatch(/exit #/i);
    expect(sub).not.toMatch(/both steps/i);
  });
});

// W10 (exam morning): the ack phrase is judged case- and whitespace-insensitively.
describe("matchesAckPhrase (W10)", () => {
  it("accepts the exact phrase", () => {
    expect(matchesAckPhrase("I will not exit full screen after this")).toBe(true);
  });
  it("accepts case variants", () => {
    expect(matchesAckPhrase("i will not exit full screen after this")).toBe(true);
    expect(matchesAckPhrase("I WILL NOT EXIT FULL SCREEN AFTER THIS")).toBe(true);
  });
  it("tolerates leading/trailing/runs of whitespace", () => {
    expect(matchesAckPhrase("  i will  not exit full screen after this ")).toBe(true);
  });
  it("still rejects wrong words", () => {
    expect(matchesAckPhrase("i will not exit fullscreen after this")).toBe(false);
    expect(matchesAckPhrase("")).toBe(false);
  });
});
