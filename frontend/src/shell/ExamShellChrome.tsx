// frontend/src/shell/ExamShellChrome.tsx
//
// S1 §9 render structure, shared by EVERY StudentApp branch (gate screens
// included): ExamTopBar (or nothing while vanished/locked) → AnomalyPanel
// (while vanished) → one-line stage hint → FullscreenGate overlay → the
// branch's own content (rendered by StudentApp after this component).
// Bar presence semantics: bar = all good; NO bar = walk over.

import type { SessionStatus } from "../types";
import { fullscreenGateVisible, stageHint, topBarVisible, type ShellGate } from "./examShell";
import { AnomalyPanel } from "./AnomalyPanel";
import { ExamTopBar } from "./ExamTopBar";
import { FullscreenGate } from "./FullscreenGate";
import type { ExamShellApi } from "./useExamShell";

export function ExamShellChrome({ shell, gate, status, identity, elapsedSeconds, examReleased, ownEditor }: {
  shell: ExamShellApi;
  gate: ShellGate;
  status: SessionStatus;
  identity: { name: string; username: string; room: string } | null;
  elapsedSeconds: number;
  examReleased: boolean;
  ownEditor: boolean;
}) {
  const barVisible = topBarVisible(shell.barHidden, gate);
  // While an anomaly episode is active the AnomalyPanel owns fullscreen
  // re-entry; the pre-recording gate overlay stays out of its way (§5.2). The
  // locked screen also takes precedence over the overlay — pure decision in
  // examShell.fullscreenGateVisible.
  const gateVisible = fullscreenGateVisible({ fullscreen: shell.fullscreen, stage: shell.stage, barHidden: shell.barHidden, gate });

  return (
    <>
      {barVisible ? (
        <ExamTopBar
          stage={shell.stage}
          identity={identity}
          elapsedSeconds={elapsedSeconds}
          recording={status === "recording" || status === "ending"}
          flagCount={shell.flagCount}
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
          {stageHint({ fullscreen: shell.fullscreen, gate, status, examReleased, ownEditor })}
        </p>
      ) : null}
      {gateVisible ? <FullscreenGate onEnter={shell.enterFullscreen} /> : null}
    </>
  );
}
