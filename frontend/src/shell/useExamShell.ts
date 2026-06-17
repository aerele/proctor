// frontend/src/shell/useExamShell.ts
//
// S1 exam shell — the ONE React hook (spec §9). Owns: the single
// fullscreenchange listener (fullscreen truth + fullscreen_enter/_exit
// emission), the visibilitychange mirror for restore preconditions, the
// pre-session event buffer, stage-transition emission, and the end-of-test
// exitFullscreen. ALL decisions live in the pure examShell.ts reducer/
// classifier (vitest-tested) — this file is thin glue.
//
// Event flow (single classification path, no double dispatch):
//   recorder/UI events -> StudentApp addEvent -> tap -> onShellEvent -> reducer
//   shell emissions    -> addEvent (same tap classifies them) + sendEvents/buffer
//
// StrictMode-safe: no side effects inside setState updaters; the reducer is
// driven through an explicit dispatch over a ref.

import { useEffect, useMemo, useRef, useState } from "react";
import { sendEvents } from "../api";
import type { ProctorEvent, SessionStatus } from "../types";
import {
  appendToBuffer, deriveStage, deserializeShellState, makeShellEvent, serializeShellState,
  shellStateStorageKey, topBarReducer, STAGE_META,
  type AnomalyReason, type RestorePreconditions, type ShellGate, type Stage,
  type TopBarAction, type TopBarState
} from "./examShell";

// localStorage access for the persisted top-bar state (FIX: the ⚑ flag chip
// used to be evadable by reload — React state reset while the session itself
// resumed). All decisions live in the pure serialize/deserialize functions in
// examShell.ts; these wrappers only guard against storage being unavailable
// (private mode, quota). NOTE: a candidate can still hand-delete the key —
// that is the client-side trust limit; the server-side event stream remains
// the durable record of hide/restore episodes.
function readStoredShellState(sessionId: string): string | null {
  if (!sessionId) return null;
  try {
    return window.localStorage.getItem(shellStateStorageKey(sessionId));
  } catch {
    return null;
  }
}

function writeStoredShellState(sessionId: string, state: TopBarState): void {
  if (!sessionId) return;
  try {
    window.localStorage.setItem(shellStateStorageKey(sessionId), serializeShellState(state));
  } catch {
    // Storage unavailable — the server events remain the durable record.
  }
}

function clearStoredShellState(sessionId: string): void {
  if (!sessionId) return;
  try {
    window.localStorage.removeItem(shellStateStorageKey(sessionId));
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

export type ExamShellApi = {
  fullscreen: boolean;
  stage: Stage;
  barHidden: boolean;
  flagCount: number;
  activeReasons: AnomalyReason[];
  // Live precondition view for the AnomalyPanel (button enable + guidance).
  preconditions: RestorePreconditions;
  enterFullscreen: () => Promise<void>;
  restoreBar: () => void;
  // Tap point: StudentApp's addEvent funnel calls this for EVERY event.
  onShellEvent: (event: ProctorEvent) => void;
};

export function useExamShell(opts: {
  gate: ShellGate;
  status: SessionStatus;
  sessionId: string;
  examReleased: boolean;
  // F5.1: the stage-1 permissions gate is satisfied (screen share live or
  // recording already running) — computed by App from the checklist state.
  permissionsReady: boolean;
  addEvent: (event: ProctorEvent) => void;
}): ExamShellApi {
  const { gate, status, sessionId, examReleased, permissionsReady, addEvent } = opts;

  const [fullscreen, setFullscreen] = useState<boolean>(() => Boolean(document.fullscreenElement));
  const [pageVisible, setPageVisible] = useState<boolean>(() => document.visibilityState === "visible");
  // Reducer initial state: rehydrated from the persisted per-session copy when
  // the hook mounts with an already-resumed sessionId (defensive parse — a
  // missing/tampered key yields the fresh initial state).
  const [barState, setBarState] = useState<TopBarState>(() => deserializeShellState(readStoredShellState(sessionId)));

  // Refs so the stable listeners/callbacks always see current values.
  const barRef = useRef<TopBarState>(barState);
  // Which sessionId the reducer state was last rehydrated for. App.tsx resumes
  // the session AFTER mount (async), so sessionId usually arrives late — the
  // first dispatch or the sessionId effect (whichever runs first) rehydrates.
  const hydratedSidRef = useRef<string>(sessionId);
  const statusRef = useRef(status);
  const sessionIdRef = useRef(sessionId);
  const addEventRef = useRef(addEvent);
  const bufferRef = useRef<ProctorEvent[]>([]);
  const expectedExitRef = useRef(false);
  statusRef.current = status;
  sessionIdRef.current = sessionId;
  addEventRef.current = addEvent;

  // Emit a shell event into the funnel + network (buffered pre-session, §8).
  // The funnel tap classifies it — emission itself never touches the reducer.
  const emitShellEvent = useMemo(() => {
    return (type: string, detail?: Record<string, unknown>) => {
      const event = makeShellEvent(type, detail, new Date().toISOString(), document.visibilityState);
      addEventRef.current(event);
      const sid = sessionIdRef.current;
      // F9: fire-and-forget, like createUiEvent call sites. A locked/ended
      // session 403/409s these by design (fullscreen enter/exit keeps firing
      // on the blocked screens) — swallow so expected rejections never hit
      // the console as unhandled.
      if (sid) void sendEvents(sid, [event]).catch(() => undefined);
      else bufferRef.current = appendToBuffer(bufferRef.current, event);
    };
  }, []);

  // Rehydrate the reducer state from storage exactly once per sessionId. Runs
  // lazily at the top of dispatch (so a DOM event firing between the resume
  // and the sessionId effect can never persist over the stored episode) and
  // eagerly from the sessionId effect below.
  const ensureHydrated = useMemo(() => {
    return () => {
      const sid = sessionIdRef.current;
      if (!sid || hydratedSidRef.current === sid) return;
      hydratedSidRef.current = sid;
      const raw = readStoredShellState(sid);
      if (raw == null) return; // fresh session — nothing stored, keep current state
      const restored = deserializeShellState(raw);
      barRef.current = restored;
      setBarState(restored);
    };
  }, []);

  // Single dispatch path into the pure reducer; emissions happen here (outside
  // any React state updater). Reentrancy is safe: barRef is updated BEFORE the
  // emission, and the emitted bookkeeping events classify as non-anomalies.
  // Every transition is persisted per session so a reload cannot launder the
  // flag chip or an active hide episode.
  const dispatch = useMemo(() => {
    return (action: TopBarAction) => {
      ensureHydrated();
      const { state, emit } = topBarReducer(barRef.current, action);
      if (state !== barRef.current) {
        barRef.current = state;
        setBarState(state);
        writeStoredShellState(sessionIdRef.current, state);
      }
      if (emit) emitShellEvent(emit.type, emit.detail);
    };
  }, [emitShellEvent, ensureHydrated]);

  const onShellEvent = useMemo(() => {
    return (event: ProctorEvent) => {
      dispatch({ kind: "event", event, recording: statusRef.current === "recording", nowMs: Date.now() });
    };
  }, [dispatch]);

  // THE single fullscreenchange listener (spec §5.2) — owns fullscreen truth.
  useEffect(() => {
    const onFullscreenChange = () => {
      const fs = Boolean(document.fullscreenElement);
      setFullscreen(fs);
      if (fs) {
        emitShellEvent("fullscreen_enter");
      } else {
        const expected = expectedExitRef.current;
        expectedExitRef.current = false;
        emitShellEvent("fullscreen_exit", expected ? { expected: true } : undefined);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [emitShellEvent]);

  // Mirror tab visibility for the AnomalyPanel's live precondition display.
  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Rehydrate as soon as the (resumed or fresh) sessionId arrives.
  useEffect(() => {
    if (sessionId) ensureHydrated();
  }, [sessionId, ensureHydrated]);

  // Flush the pre-session buffer once a session exists (§8). Best-effort.
  useEffect(() => {
    if (!sessionId || bufferRef.current.length === 0) return;
    const buffered = bufferRef.current;
    bufferRef.current = [];
    // F9: best-effort flush — expected 403/409 when the session is blocked.
    void sendEvents(sessionId, buffered).catch(() => undefined);
  }, [sessionId]);

  const stage = deriveStage({ permissionsReady, fullscreen, gate, status, examReleased });

  // Spec §4: emit onboarding_stage on every transition (buffered pre-session).
  const prevStageRef = useRef<Stage | null>(null);
  useEffect(() => {
    const from = prevStageRef.current;
    prevStageRef.current = stage;
    if (from === null || from === stage) return;
    emitShellEvent("onboarding_stage", { from, to: stage, label: STAGE_META[stage].label });
  }, [stage, emitShellEvent]);

  // Spec §5.2 test end: clear any hide episode so the DONE bar renders, then
  // leave fullscreen ourselves — marked expected so it is logged with
  // detail {expected:true} and never classified as an anomaly.
  useEffect(() => {
    if (stage !== 5) return;
    dispatch({ kind: "session_ended", nowMs: Date.now() });
    // Session over: drop the persisted shell state (the dispatch above already
    // persisted the unhidden state; the remove wins because it runs after).
    clearStoredShellState(sessionIdRef.current);
    if (document.fullscreenElement) {
      expectedExitRef.current = true;
      void document.exitFullscreen().catch(() => {
        expectedExitRef.current = false; // already exited / rejected — swallow
      });
    }
  }, [stage, dispatch]);

  // Click = fresh user gesture, always valid (gate + panel buttons call this).
  // Rejection (browser policy) is surfaced inline by the caller; never auto-loops.
  const enterFullscreen = useMemo(() => {
    return async () => {
      await document.documentElement.requestFullscreen();
    };
  }, []);

  // Panel acknowledge — preconditions are sampled live from the DOM and
  // re-checked inside the pure reducer (no restore unless all hold).
  const restoreBar = useMemo(() => {
    return () => {
      dispatch({
        kind: "restore",
        nowMs: Date.now(),
        preconditions: {
          fullscreen: Boolean(document.fullscreenElement),
          visible: document.visibilityState === "visible",
          recording: statusRef.current === "recording"
        }
      });
    };
  }, [dispatch]);

  return {
    fullscreen,
    stage,
    barHidden: barState.barHidden,
    flagCount: barState.flagCount,
    activeReasons: barState.activeReasons,
    preconditions: { fullscreen, visible: pageVisible, recording: status === "recording" },
    enterFullscreen,
    restoreBar,
    onShellEvent
  };
}
