// frontend/src/shell/examShell.ts
//
// S1 exam shell — PURE logic only (no React, no DOM calls): onboarding-stage
// derivation, the per-stage hint line, bar-presence rule, and small display
// formatters. (Task 2 adds anomaly classification + the top-bar reducer.)
// Everything here is vitest-tested; the React hook (useExamShell.ts) and the
// shell components stay thin.
//
// Design: docs/superpowers/specs/2026-06-09-s1-exam-shell-design.md

import type { SessionStatus } from "../types";

// Mirrors StudentApp's `StudentGate` union (App.tsx) — declared here, not
// imported, so the pure module has no dependency on App.tsx. The two unions
// are structurally identical, so App's gate value is directly assignable.
export type ShellGate = "form" | "pending_approval" | "locked" | "ended" | "running";

export type Stage = 1 | 2 | 3 | 4 | 5;

// Spec §4: the five onboarding stages — at-a-distance label + stage-block color.
export const STAGE_META: Record<Stage, { label: string; blockClass: string }> = {
  1: { label: "FULLSCREEN", blockClass: "bg-red-600" },
  2: { label: "DETAILS", blockClass: "bg-amber-500" },
  3: { label: "GET READY", blockClass: "bg-sky-500" },
  4: { label: "IN EXAM", blockClass: "bg-emerald-600" },
  5: { label: "DONE", blockClass: "bg-indigo-600" }
};

export type StageInput = {
  fullscreen: boolean;
  gate: ShellGate;
  status: SessionStatus;
  // S3 room-gate seam: true when the room gate is not enabled/built (tonight:
  // S3 has not landed, so App.tsx always passes true) or the invigilator has
  // released the room code. false => recording candidates wait at stage 3.
  examReleased: boolean;
};

// Spec §4 derivation contract. Priority: ended wins; then the fullscreen gate;
// then session progress. `locked` reports 3 — the spec's "keeps the last
// pre-lock stage" is unimplementable in a pure function, and the bar never
// renders while locked (see topBarVisible), so the value is unobservable.
export function deriveStage({ fullscreen, gate, status, examReleased }: StageInput): Stage {
  if (gate === "ended" || status === "ended") return 5;
  if (!fullscreen) return 1;
  if (gate === "form") return 2;
  // A session exists (running / pending_approval / locked).
  if (status === "recording" || status === "ending") return examReleased ? 4 : 3;
  return 3;
}

// Spec §7: bar presence semantics — the bar renders on EVERY branch except
// during an anomaly episode and on the locked screen (absence = walk over;
// the locked hide is a render rule, not a reducer episode — no flag increment).
export function topBarVisible(barHidden: boolean, gate: ShellGate): boolean {
  return !barHidden && gate !== "locked";
}

// Spec §7.4: the one-line close-up hint under the bar — survives from the
// deleted StudentStepBanner. ownEditor mirrors App.tsx's OWN_EDITOR; only the
// in-exam hint is surface-specific (own-editor copy must not say HackerRank).
export function stageHint(input: StageInput & { ownEditor: boolean }): string {
  const stage = deriveStage(input);
  const { gate, status, ownEditor } = input;
  if (stage === 5) return "Your test is complete. You may close this tab.";
  if (stage === 1) return "The exam runs in fullscreen from start to finish. Enter fullscreen to continue.";
  if (stage === 2) return "Read the rules, fill in your details and consent, then start proctoring.";
  if (stage === 4) {
    return ownEditor
      ? "Recording is active. Solve the problem in the coding workspace below and keep this tab running. End the test here when you submit."
      : "Recording is active. Open HackerRank with the Start test button and keep this tab running. End the test here when you submit.";
  }
  // Stage 3 — GET READY variants.
  if (gate === "pending_approval") return "Waiting for a proctor to approve this device. Stay on this page.";
  if (gate === "locked") return "Your session is locked. Call a proctor to unlock you.";
  if (status === "starting") return "Follow the browser prompt and share your Entire Screen.";
  if (status === "error") return "Recording has stopped. Use the Retry button on this page to finish ending your test.";
  if (status === "recording" || status === "ending") return "Recording is active. Waiting for your room's exam code to be released.";
  return "Your session was restored. Press Resume recording to share your screen again and continue.";
}

// Right side of the bar: a ticking local wall clock — every stage gets a
// ticking element (a screenshot or printout cannot tick).
export function formatWallClock(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Elapsed exam time, H:MM:SS (hours unpadded — reads as "0:14:09"). Spec §7.1.
// (App.tsx's formatElapsed dies with TimerBar; this is the shell's own.)
export function formatExamElapsed(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}
