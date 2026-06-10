// frontend/src/shell/useEnforcement.ts
//
// F5.3-6 — the ONE React hook driving the fullscreen hard-block ladder and the
// switch-away debounce. ALL decisions live in the pure reducers
// (enforcement.ts / switchAway.ts, vitest-tested); this file is thin glue:
//   - taps StudentApp's addEvent funnel (same pattern as useExamShell),
//   - runs the 1 s tick while anything is active,
//   - performs the report_violation POST (the SERVER decides lock vs alert),
//   - persists every transition per session so a reload mid-block re-engages
//     the overlay with the original absolute deadline,
//   - emits switch_away_episode events through the normal event pipeline so
//     the backend's threshold-based tab_away alerting reaches the proctor.

import { useEffect, useMemo, useRef, useState } from "react";
import { reportEnforcementViolation, sendEvents } from "../api";
import type { ProctorEvent, SessionStatus } from "../types";
import {
  deserializeEnforcementState, enforcementOverlayVisible, enforcementReducer,
  enforcementRemainingSeconds, enforcementStorageKey, initialEnforcementState,
  serializeEnforcementState, FULLSCREEN_ACK_PHRASE,
  type EnforcementAction, type EnforcementConfig, type EnforcementPhase, type EnforcementState
} from "./enforcement";
import { makeShellEvent, type ShellGate } from "./examShell";
import { initialSwitchAwayState, isSwitchAwaySignal, switchAwayReducer, type SwitchAwayState } from "./switchAway";

function readStoredEnforcement(sessionId: string): EnforcementState {
  if (!sessionId) return initialEnforcementState;
  try {
    return deserializeEnforcementState(window.localStorage.getItem(enforcementStorageKey(sessionId)));
  } catch {
    return initialEnforcementState;
  }
}

function writeStoredEnforcement(sessionId: string, state: EnforcementState): void {
  if (!sessionId) return;
  try {
    window.localStorage.setItem(enforcementStorageKey(sessionId), serializeEnforcementState(state));
  } catch {
    // Storage unavailable — server alerts/locks remain the durable record.
  }
}

function clearStoredEnforcement(sessionId: string): void {
  if (!sessionId) return;
  try {
    window.localStorage.removeItem(enforcementStorageKey(sessionId));
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

export type EnforcementApi = {
  phase: EnforcementPhase;
  exitCount: number;
  /** Countdown seconds while blocking; null otherwise. */
  remainingSeconds: number | null;
  /** The exact phrase has been typed this episode. */
  ackOk: boolean;
  overlayVisible: boolean;
  /** Candidate typed into the ack box — matched live against the exact phrase. */
  submitAck: (text: string) => void;
  /** Tap point: StudentApp's addEvent funnel calls this for EVERY event. */
  onShellEvent: (event: ProctorEvent) => void;
};

export function useEnforcement(opts: {
  gate: ShellGate;
  status: SessionStatus;
  sessionId: string;
  config: EnforcementConfig;
  addEvent: (event: ProctorEvent) => void;
  /** Server confirmed a block-mode lock — App flips its gate to "locked". */
  onLocked: (lockedReason: string) => void;
  /** L1 episode resolved (phrase + fullscreen) — App restores the top bar. */
  onResolved: () => void;
}): EnforcementApi {
  const { gate, status, sessionId, config, addEvent, onLocked, onResolved } = opts;

  const [state, setState] = useState<EnforcementState>(() => readStoredEnforcement(sessionId));
  // Re-rendered each second while a countdown runs (state changes only on
  // reducer transitions, so the ticking display needs its own clock value).
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const stateRef = useRef<EnforcementState>(state);
  const switchAwayRef = useRef<SwitchAwayState>(initialSwitchAwayState);
  const hydratedSidRef = useRef<string>(sessionId);
  const configRef = useRef(config);
  const statusRef = useRef(status);
  const sessionIdRef = useRef(sessionId);
  const addEventRef = useRef(addEvent);
  const onLockedRef = useRef(onLocked);
  const onResolvedRef = useRef(onResolved);
  configRef.current = config;
  statusRef.current = status;
  sessionIdRef.current = sessionId;
  addEventRef.current = addEvent;
  onLockedRef.current = onLocked;
  onResolvedRef.current = onResolved;

  // Emit an enforcement event through the funnel + network (same shape as the
  // shell's emitShellEvent; enforcement only runs with a live session, so no
  // pre-session buffer is needed — a missing sessionId just skips the network).
  const emitEvent = useMemo(() => {
    return (type: string, detail?: Record<string, unknown>) => {
      const event = makeShellEvent(type, detail, new Date().toISOString(), document.visibilityState);
      addEventRef.current(event);
      const sid = sessionIdRef.current;
      if (sid) void sendEvents(sid, [event]);
    };
  }, []);

  // Rehydrate exactly once per sessionId (App resumes the session AFTER mount,
  // so the id usually arrives late) — a reload mid-block re-engages the
  // overlay with the persisted ABSOLUTE deadline.
  const ensureHydrated = useMemo(() => {
    return () => {
      const sid = sessionIdRef.current;
      if (!sid || hydratedSidRef.current === sid) return;
      hydratedSidRef.current = sid;
      const restored = readStoredEnforcement(sid);
      stateRef.current = restored;
      setState(restored);
    };
  }, []);

  // Single dispatch path; effects run here, outside any React state updater.
  const dispatch = useMemo(() => {
    return (action: EnforcementAction) => {
      ensureHydrated();
      const before = stateRef.current;
      const { state: next, effects } = enforcementReducer(before, action, configRef.current);
      if (next !== before) {
        stateRef.current = next;
        setState(next);
        // Keep the countdown display honest from the very first render of a
        // fresh episode (the 1 s tick catches up afterwards).
        setNowMs(Date.now());
        writeStoredEnforcement(sessionIdRef.current, next);
        // L1 resolution (phrase + fullscreen) → let App restore the top bar.
        if (before.phase !== "idle" && next.phase === "idle"
          && (action.kind === "ack" || action.kind === "fullscreen_change")) {
          onResolvedRef.current();
        }
      }
      for (const effect of effects) {
        if (effect.kind === "event") {
          emitEvent(effect.type, effect.detail);
          continue;
        }
        // report_violation — the server raises the alert and decides lock vs
        // alert-only; its verdict feeds back into the reducer.
        const sid = sessionIdRef.current;
        if (!sid) continue;
        void reportEnforcementViolation(sid, effect.phase, effect.exitCount)
          .then((result) => {
            dispatch({ kind: "violation_result", locked: result.locked, exempt: result.exempt, nowMs: Date.now() });
            if (result.locked) onLockedRef.current(result.locked_reason || "fullscreen_enforcement");
          })
          .catch(() => {
            // Network failure: stay in the current phase; the next tick is a
            // no-op (violation already reported once) but the heartbeat's
            // status channel still flips the gate if the server locked us.
          });
      }
    };
  }, [emitEvent, ensureHydrated]);

  // The funnel tap: fullscreen exits drive the hard-block ladder; blur/hide
  // runs drive the switch-away debounce. Both reducers are pure.
  const onShellEvent = useMemo(() => {
    return (event: ProctorEvent) => {
      const now = Date.now();
      if (event.type === "fullscreen_exit") {
        dispatch({ kind: "fullscreen_exit", nowMs: now, recording: statusRef.current === "recording", expected: event.detail?.expected === true });
        return;
      }
      if (event.type === "fullscreen_enter") {
        dispatch({ kind: "fullscreen_change", fullscreen: true, nowMs: now });
        return;
      }
      // Switch-away debounce: only while recording (idle/setup blurs are the
      // candidate arranging windows, not leaving the exam).
      if (statusRef.current !== "recording") return;
      const signal = isSwitchAwaySignal(event);
      if (!signal) return;
      const { state: nextSw, episode } = switchAwayReducer(switchAwayRef.current, { kind: signal, nowMs: now });
      switchAwayRef.current = nextSw;
      if (episode) emitEvent("switch_away_episode", { count: episode.count, duration_ms: episode.duration_ms });
    };
  }, [dispatch, emitEvent]);

  // Rehydrate as soon as the (resumed or fresh) sessionId arrives.
  useEffect(() => {
    if (sessionId) ensureHydrated();
  }, [sessionId, ensureHydrated]);

  // The 1 s tick: countdown expiry + switch-away episode close. Runs while a
  // countdown could fire (any active phase — including right after a reload,
  // before the resume completes) or an episode window is open.
  const phaseActive = state.phase !== "idle";
  const recording = status === "recording";
  useEffect(() => {
    if (!phaseActive && !recording) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      dispatch({ kind: "tick", nowMs: now });
      const { state: nextSw, episode } = switchAwayReducer(switchAwayRef.current, { kind: "tick", nowMs: now });
      switchAwayRef.current = nextSw;
      if (episode) emitEvent("switch_away_episode", { count: episode.count, duration_ms: episode.duration_ms });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [phaseActive, recording, dispatch, emitEvent]);

  // Live exemption release (heartbeat-delivered config change).
  const exemptFullscreen = config.exemptFullscreen;
  useEffect(() => {
    if (exemptFullscreen) dispatch({ kind: "config_change", nowMs: Date.now() });
  }, [exemptFullscreen, dispatch]);

  // The server lock became visible through ANY channel (violation verdict or
  // the heartbeat's status flip): settle a pending report so the tick retry
  // loop stops POSTing against a session that is already locked.
  useEffect(() => {
    if (gate === "locked" && stateRef.current.reportPending) {
      dispatch({ kind: "violation_result", locked: true, nowMs: Date.now() });
    }
  }, [gate, dispatch]);

  // The lock was SERVED (gate left "locked" via room code / admin unlock):
  // reset to a fresh ladder — exitCount restarts so a single later accident is
  // an L1 episode again, not an instant relock. The proctor was in the loop;
  // the server-side alerts remain the durable history.
  const prevGateRef = useRef<ShellGate>(gate);
  useEffect(() => {
    const cameFromLocked = prevGateRef.current === "locked" && gate !== "locked" && gate !== "ended";
    prevGateRef.current = gate;
    if (!cameFromLocked || stateRef.current.phase === "idle") return;
    const released: EnforcementState = { ...initialEnforcementState };
    stateRef.current = released;
    setState(released);
    writeStoredEnforcement(sessionIdRef.current, released);
  }, [gate]);

  // Session over: release any phase, flush an open switch-away episode, and
  // drop the persisted state.
  useEffect(() => {
    if (gate !== "ended" && status !== "ended") return;
    dispatch({ kind: "session_ended", nowMs: Date.now() });
    const { state: nextSw, episode } = switchAwayReducer(switchAwayRef.current, { kind: "flush", nowMs: Date.now() });
    switchAwayRef.current = nextSw;
    if (episode) emitEvent("switch_away_episode", { count: episode.count, duration_ms: episode.duration_ms });
    clearStoredEnforcement(sessionIdRef.current);
  }, [gate, status, dispatch, emitEvent]);

  const submitAck = useMemo(() => {
    return (text: string) => {
      dispatch({
        kind: "ack",
        matched: text === FULLSCREEN_ACK_PHRASE,
        fullscreen: Boolean(document.fullscreenElement),
        nowMs: Date.now()
      });
    };
  }, [dispatch]);

  return {
    phase: state.phase,
    exitCount: state.exitCount,
    remainingSeconds: enforcementRemainingSeconds(state, nowMs),
    ackOk: state.ackOk,
    overlayVisible: enforcementOverlayVisible(state, gate),
    submitAck,
    onShellEvent
  };
}
