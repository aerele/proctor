// frontend/src/candidate/candidateRenderGate.ts
//
// B2 / LT-1 / MI-1 (v1.1 candidate-flow state machine) — the PURE render-gate
// decision for the in-exam branches of StudentApp's render cascade. Extracted so
// the load-bearing "exam content never renders outside fullscreen" rule and the
// MA-5 post-unlock trace are vitest-tested without jsdom / the giant component.
//
// This mirrors EXACTLY the two ordered branches in StudentApp.tsx:
//   1. FS_BLOCK_NO_COUNTDOWN  — recording + running + exam-released but NOT in
//      fullscreen → the calm "return to fullscreen" block (no countdown).
//   2. IN_EXAM (W1)           — the same, PLUS hasProblem AND fullscreen → the
//      coding workspace renders.
// Anything else falls through to the classic fallback / other branches.
//
// The branches that precede these in the cascade (locked, ended, hold,
// waiting-room, room-gate) are handled before this gate is consulted; this gate
// only decides among "show the workspace", "show the fullscreen block", or
// "neither — fall through".

export type CandidateRenderInput = {
  hasProblem: boolean;
  status: string; // SessionStatus
  gate: string; // StudentGate
  examGateActive: boolean; // room gate still holding the exam closed
  examViewAllowed: boolean; // recordingPreExamState — past hold + waiting room
  fullscreen: boolean; // shell.fullscreen (live truth)
};

export type CandidateRenderDecision = "exam_workspace" | "fullscreen_block" | "fall_through";

// The shared precondition for BOTH in-exam branches: an actively-recording,
// running, exam-released session (room gate open, past the pre-exam holds).
// LT-1: neither the FS_BLOCK block nor W1 is reached unless recording is live.
function inExamRecording(input: CandidateRenderInput): boolean {
  return input.status === "recording"
    && input.gate === "running"
    && !input.examGateActive
    && input.examViewAllowed;
}

export function candidateRenderDecision(input: CandidateRenderInput): CandidateRenderDecision {
  if (!inExamRecording(input)) return "fall_through";
  // FS_BLOCK first (MI-1): out of fullscreen → the calm block, NEVER the
  // workspace and NEVER the classic fallback. This precedes W1 in the cascade.
  if (!input.fullscreen) return "fullscreen_block";
  // IN_EXAM (W1): fullscreen AND has a problem to show. (A fullscreen session
  // with no own-editor problem falls through to the classic fallback, as before.)
  if (input.hasProblem) return "exam_workspace";
  return "fall_through";
}
