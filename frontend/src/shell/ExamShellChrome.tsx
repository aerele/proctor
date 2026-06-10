// frontend/src/shell/ExamShellChrome.tsx
//
// S1 §9 render structure, shared by EVERY StudentApp branch (gate screens
// included): ExamTopBar (or nothing while vanished/locked) → AnomalyPanel
// (while vanished) → one-line stage hint → FullscreenGate overlay → the
// branch's own content (rendered by StudentApp after this component).
// Bar presence semantics: bar = all good; NO bar = walk over.

import type { SessionStatus } from "../types";
import { fullscreenGateVisible, permissionsGateVisible, stageHint, topBarVisible, type ShellGate } from "./examShell";
import { AnomalyPanel } from "./AnomalyPanel";
import { ExamTopBar } from "./ExamTopBar";
import { FullscreenGate } from "./FullscreenGate";
import { PermissionsGate, type PermissionsGateProps } from "./PermissionsGate";
import type { ExamShellApi } from "./useExamShell";

export function ExamShellChrome({ shell, gate, status, identity, elapsedSeconds, examReleased, permissionsReady, permissionsGate, ownEditor, remainingLabel, timeUp }: {
  shell: ExamShellApi;
  gate: ShellGate;
  status: SessionStatus;
  identity: { name: string; username: string; room: string } | null;
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
}) {
  const barVisible = topBarVisible(shell.barHidden, gate);
  // While an anomaly episode is active the AnomalyPanel owns fullscreen
  // re-entry; the pre-recording gate overlays stay out of its way (§5.2). The
  // locked screen also takes precedence over the overlays — pure decisions in
  // examShell.permissionsGateVisible / fullscreenGateVisible (mutually
  // exclusive: stage 1 vs stage 2).
  const permGateVisible = permissionsGateVisible({ stage: shell.stage, barHidden: shell.barHidden, gate });
  const gateVisible = fullscreenGateVisible({ fullscreen: shell.fullscreen, stage: shell.stage, barHidden: shell.barHidden, gate });

  return (
    <>
      {barVisible ? (
        <ExamTopBar
          stage={shell.stage}
          identity={identity}
          elapsedSeconds={elapsedSeconds}
          recording={(status === "recording" || status === "ending") && gate !== "ended"}
          flagCount={shell.flagCount}
          remainingLabel={remainingLabel}
          timeUp={timeUp}
        />
      ) : null}
      {shell.barHidden ? (
        <AnomalyPanel
          reasons={shell.activeReasons}
          preconditions={shell.preconditions}
          onRestore={shell.restoreBar}
          onEnterFullscreen={shell.enterFullscreen}
        />
      ) : null}
      {barVisible ? (
        <p className="mb-5 text-sm leading-6 text-muted">
          {stageHint({ permissionsReady, fullscreen: shell.fullscreen, gate, status, examReleased, ownEditor })}
        </p>
      ) : null}
      {permGateVisible ? <PermissionsGate {...permissionsGate} /> : null}
      {gateVisible ? <FullscreenGate onEnter={shell.enterFullscreen} /> : null}
    </>
  );
}
