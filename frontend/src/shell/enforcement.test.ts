// frontend/src/shell/enforcement.test.ts
//
// F5.3/F5.6 — fullscreen HARD-BLOCK enforcement state machine (pure reducer).
// Covers the brief's required set: exit→ack flow, countdown expiry in BOTH
// enforcement modes, K-exit escalation, exemption bypass, and reload-mid-block
// re-engaging the overlay from persisted state.
import { describe, it, expect } from "vitest";
import {
  FULLSCREEN_ACK_PHRASE,
  REPORT_RETRY_MS,
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
});
