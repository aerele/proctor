// frontend/src/shell/ExamShellChrome.tsx
//
// S1 §9 render structure, shared by EVERY StudentApp branch (gate screens
// included), with the W2 flip: shellHeaderMode picks the fixed header —
//   strip  (healthy)  → slim ExamTopBar,
//   alert  (anomaly)  → BIG fixed AnomalyPanel banner (stays until resolved),
//   hidden (locked)   → nothing (the locked screen owns the viewport)
// — then the one-line stage hint (suppressed in the W1 exam view), then the
// Permissions/Fullscreen gate overlays. Bar presence semantics flipped with
// W2: slim strip = all good; big red banner = problem.

import type { SessionStatus } from "../types";
import { fullscreenGateVisible, permissionsGateVisible, shellHeaderMode, stageHint, type ShellGate } from "./examShell";
import { AnomalyPanel } from "./AnomalyPanel";
import { ExamTopBar } from "./ExamTopBar";
import { FullscreenGate } from "./FullscreenGate";
import { PermissionsGate, type PermissionsGateProps } from "./PermissionsGate";
import type { ExamShellApi } from "./useExamShell";
import type { ReactNode } from "react";

export function ExamShellChrome({ shell, gate, status, identity, contestName, elapsedSeconds, examReleased, permissionsReady, permissionsGate, ownEditor, remainingLabel, timeUp, actions, hideStageHint }: {
  shell: ExamShellApi;
  gate: ShellGate;
  status: SessionStatus;
  identity: { name: string; candidate_id: string; room: string } | null;
  contestName?: string | null;
  elapsedSeconds: number;
  examReleased: boolean;
  // F5.1: stage-1 state + the PermissionsGate's checklist/handlers (App owns
  // the acquisition glue; the chrome only decides visibility).
  permissionsReady: boolean;
  permissionsGate: PermissionsGateProps;
  ownEditor: boolean;
  // S5: skew-corrected exam countdown ("H:MM:SS") + time-up flag for the top
  // bar. null → no end time known (no countdown shown).
  remainingLabel: string | null;
  timeUp: boolean;
  /** W1: strip action slot (proctoring-panel toggle + End test in the exam). */
  actions?: ReactNode;
  /** W1: the exam view suppresses the stage hint — zero distraction. */
  hideStageHint?: boolean;
}) {
  const headerMode = shellHeaderMode(shell.barHidden, gate);
  // While an anomaly episode is active the AnomalyPanel owns fullscreen
  // re-entry; the pre-recording gate overlays stay out of its way (§5.2). The
  // locked screen also takes precedence over the overlays — pure decisions in
  // examShell.permissionsGateVisible / fullscreenGateVisible (mutually
  // exclusive: stage 1 vs stage 2).
  const permGateVisible = permissionsGateVisible({ stage: shell.stage, barHidden: shell.barHidden, gate });
  const gateVisible = fullscreenGateVisible({ fullscreen: shell.fullscreen, stage: shell.stage, barHidden: shell.barHidden, gate });

  return (
    <>
      {headerMode === "strip" ? (
        <ExamTopBar
          stage={shell.stage}
          identity={identity}
          contestName={contestName}
          elapsedSeconds={elapsedSeconds}
          recording={(status === "recording" || status === "ending") && gate !== "ended"}
          flagCount={shell.flagCount}
          remainingLabel={remainingLabel}
          timeUp={timeUp}
          actions={actions}
        />
      ) : null}
      {headerMode === "alert" ? (
        <AnomalyPanel
          reasons={shell.activeReasons}
          preconditions={shell.preconditions}
          onRestore={shell.restoreBar}
          onEnterFullscreen={shell.enterFullscreen}
        />
      ) : null}
      {headerMode === "strip" && !hideStageHint ? (
        <p className="mb-5 text-sm leading-6 text-muted">
          {stageHint({ permissionsReady, fullscreen: shell.fullscreen, gate, status, examReleased, ownEditor })}
        </p>
      ) : null}
      {permGateVisible ? <PermissionsGate {...permissionsGate} /> : null}
      {gateVisible ? <FullscreenGate onEnter={shell.enterFullscreen} /> : null}
    </>
  );
}
