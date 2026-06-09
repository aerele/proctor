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
  appendToBuffer, deriveStage, initialTopBarState, makeShellEvent, topBarReducer, STAGE_META,
  type AnomalyReason, type RestorePreconditions, type ShellGate, type Stage,
  type TopBarAction, type TopBarState
} from "./examShell";

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
  addEvent: (event: ProctorEvent) => void;
}): ExamShellApi {
  const { gate, status, sessionId, examReleased, addEvent } = opts;

  const [fullscreen, setFullscreen] = useState<boolean>(() => Boolean(document.fullscreenElement));
  const [pageVisible, setPageVisible] = useState<boolean>(() => document.visibilityState === "visible");
  const [barState, setBarState] = useState<TopBarState>(initialTopBarState);

  // Refs so the stable listeners/callbacks always see current values.
  const barRef = useRef<TopBarState>(initialTopBarState);
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
      if (sid) void sendEvents(sid, [event]); // fire-and-forget, like createUiEvent call sites
      else bufferRef.current = appendToBuffer(bufferRef.current, event);
    };
  }, []);

  // Single dispatch path into the pure reducer; emissions happen here (outside
  // any React state updater). Reentrancy is safe: barRef is updated BEFORE the
  // emission, and the emitted bookkeeping events classify as non-anomalies.
  const dispatch = useMemo(() => {
    return (action: TopBarAction) => {
      const { state, emit } = topBarReducer(barRef.current, action);
      if (state !== barRef.current) {
        barRef.current = state;
        setBarState(state);
      }
      if (emit) emitShellEvent(emit.type, emit.detail);
    };
  }, [emitShellEvent]);

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

  // Flush the pre-session buffer once a session exists (§8). Best-effort.
  useEffect(() => {
    if (!sessionId || bufferRef.current.length === 0) return;
    const buffered = bufferRef.current;
    bufferRef.current = [];
    void sendEvents(sessionId, buffered);
  }, [sessionId]);

  const stage = deriveStage({ fullscreen, gate, status, examReleased });

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
