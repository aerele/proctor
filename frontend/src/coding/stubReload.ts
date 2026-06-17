// frontend/src/coding/stubReload.ts
//
// W9: "Reload stub" with a 20-second undo — pure logic.
//
// When an admin updates a problem's starter stub mid-exam, candidates who
// already edited keep their code (correct), but had NO way to pull the fresh
// stub. W9 adds an explicit, confirmed "Reload stub" action:
//
//   click → window.confirm warning ("all your edits will be gone") →
//   snapshot the current editor content → replace with the stub →
//   show "Undo (20s)" which restores the snapshot.
//
// STUB SOURCE: the freshest stub the client has is problem.stubs[language]
// from the latest start/resume payload (stubs ride PublicProblem — F12.2).
// There is NO candidate-facing problems refetch (the heartbeat carries no
// problems; /api/session/resume is the full recorder bootstrap, not a stub
// fetch), so we deliberately read the in-memory payload and invent no routes.
// A candidate who reloads the page resumes with the newest stubs anyway.
//
// SNAPSHOT STATE MACHINE (one snapshot at a time — keep it simple):
//   trigger : confirmed reload → takeUndoSnapshot(problem, language, code, now)
//   restore : Undo click while alive → put snapshot.code back, discard
//   discard : (a) window lapses (UNDO_WINDOW after takenAtMs),
//             (b) the candidate switches PROBLEM,
//             (c) the candidate switches LANGUAGE on the snapshot's problem.
//   Run/Submit during the window are NOT special-cased — they use whatever
//   is in the editor, and the window keeps running.
import type { EditorEvent } from "../types";

export const STUB_UNDO_WINDOW_SECONDS = 20;
export const STUB_UNDO_WINDOW_MS = STUB_UNDO_WINDOW_SECONDS * 1000;

export type StubUndoSnapshot = {
  problemId: string;
  language: string;
  /** The candidate's pre-reload editor content (what Undo restores). */
  code: string;
  takenAtMs: number;
};

// Visibility rule: the button shows ONLY when the problem ships an
// author-supplied stub for the current language. The generic STARTERS
// scaffold is NOT "a stub" — no-stub problems show no button. Mirrors the
// starterFor non-string guard (an explicit empty-string stub counts).
export function canReloadStub(
  problem: { stubs?: Partial<Record<string, string>> } | null | undefined,
  language: string
): boolean {
  return typeof problem?.stubs?.[language] === "string";
}

// The window.confirm copy (repo-standard confirm medium). Owner's words for
// the spirit: "all your edits will be gone. Are you sure?" — scoped to THIS
// problem + language.
export function reloadStubConfirmMessage(language: string): string {
  return `Reload the starter stub for this problem (${language})? Your editor content will be replaced with the fresh stub — all your edits will be gone. Are you sure?`;
}

export function takeUndoSnapshot(problemId: string, language: string, code: string, nowMs: number): StubUndoSnapshot {
  return { problemId, language, code, takenAtMs: nowMs };
}

// Seconds left on the Undo affordance for a given problem+language view.
// 0 means "no undo": no snapshot, a snapshot for a DIFFERENT problem or
// language (discard rules b/c render as instant-invisible), or a lapsed
// window. Ceil so the label counts 20 → 1 and disappears exactly at expiry.
export function undoSecondsRemaining(
  snapshot: StubUndoSnapshot | null | undefined,
  problemId: string,
  language: string,
  nowMs: number
): number {
  if (!snapshot) return 0;
  if (snapshot.problemId !== problemId || snapshot.language !== language) return 0;
  return Math.max(0, Math.ceil((snapshot.takenAtMs + STUB_UNDO_WINDOW_MS - nowMs) / 1000));
}

// ---- Telemetry (additive editor events; same shape family as
// problem_switched — snake_case detail keys, ISO timestamp) ------------------

export function stubReloadedEvent(language: string, stubLen: number, replacedLen: number, timestamp: string): EditorEvent {
  return { type: "stub_reloaded", timestamp, detail: { language, stub_len: stubLen, replaced_len: replacedLen } };
}

export function stubReloadUndoneEvent(language: string, restoredLen: number, timestamp: string): EditorEvent {
  return { type: "stub_reload_undone", timestamp, detail: { language, restored_len: restoredLen } };
}
