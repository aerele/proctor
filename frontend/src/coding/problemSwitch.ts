// frontend/src/coding/problemSwitch.ts
//
// S-I §4: pure logic for the multi-problem candidate workspace — status-chip
// derivation (submit outcomes ONLY, never Run), the workspace score totals,
// per-problem localStorage draft persistence with restore guards, the
// single-problem/legacy layout pin, live submit-summary merging (mirrors the
// backend scoreboard.mjs computeSessionSummary semantics) and the helpers for
// rendering SERVER-driven cooldowns (retry_after_seconds — the client never
// double-accounts cooldown windows).
// Spec: docs/superpowers/specs/2026-06-10-s-i-multiproblem-detail-spec.md.
import type { ProblemSubmissionSummary, SubmitResult } from "../types";

// Backend MAX_SOURCE_CODE_LENGTH parity (handler.mjs): a draft the server
// would reject as oversize is not worth restoring.
export const MAX_DRAFT_CODE_CHARS = 65536;

export const DRAFT_KEY_PREFIX = "proctor-draft::";

export type ChipState = "none" | "zero" | "partial" | "solved";
export type ProblemChip = { state: ChipState; label: string };

// Spec §4.1: `—` (no submission) / `↻ 40/100` (partial best, amber) /
// `✓ 100/100` (full best, green) / `✗ 0/100` (attempted, zero, red-muted).
// Chip state derives ONLY from submit outcomes (summary + live responses).
export function chipFor(summary: ProblemSubmissionSummary | null | undefined): ProblemChip {
  if (!summary || summary.attempts <= 0) return { state: "none", label: "—" };
  const best = summary.best_score;
  const max = summary.max_points;
  // Full best — including the zero-point edge where only the verdict can say.
  if ((max > 0 && best >= max) || (max <= 0 && summary.best_verdict === "accepted")) {
    return { state: "solved", label: `✓ ${best}/${max}` };
  }
  if (best > 0) return { state: "partial", label: `↻ ${best}/${max}` };
  return { state: "zero", label: `✗ 0/${max}` };
}

export type WorkspaceTotals = { earned: number; possible: number; solved: number; count: number };

// Spec §4.1 workspace header: `Total: 140 / 300` (Σ best per problem over Σ
// effective points) + solved x/y for the progress line. Summary entries for
// problems outside the contest list never count.
export function workspaceTotals(
  problems: ReadonlyArray<{ id: string; points: number }>,
  summaries: Record<string, ProblemSubmissionSummary>
): WorkspaceTotals {
  let earned = 0;
  let possible = 0;
  let solved = 0;
  for (const problem of problems) {
    possible += problem.points;
    const summary = summaries[problem.id];
    if (!summary || summary.attempts <= 0) continue;
    earned += summary.best_score;
    if (chipFor(summary).state === "solved") solved += 1;
  }
  return { earned, possible, solved, count: problems.length };
}

// Live submit response → updated per-problem summary. Mirrors the backend
// computeSessionSummary cell semantics: best_verdict tracks the submission
// that set best_score; last_* always track the newest submission.
export function mergeSubmitOutcome(
  summary: ProblemSubmissionSummary | null | undefined,
  result: SubmitResult,
  submittedAtIso: string
): ProblemSubmissionSummary {
  if (!summary || summary.attempts <= 0) {
    return {
      best_score: result.score,
      max_points: result.max_points,
      attempts: (summary?.attempts ?? 0) + 1,
      best_verdict: result.verdict,
      last_verdict: result.verdict,
      last_submitted_at: submittedAtIso
    };
  }
  const improved = result.score > summary.best_score;
  return {
    best_score: improved ? result.score : summary.best_score,
    max_points: result.max_points,
    attempts: summary.attempts + 1,
    best_verdict: improved ? result.verdict : summary.best_verdict,
    last_verdict: result.verdict,
    last_submitted_at: submittedAtIso
  };
}

// One stored submission row (demo store / future replay views).
export type StoredSubmission = {
  problem_id: string;
  verdict: SubmitResult["verdict"];
  score: number;
  max_points: number;
  created_at: string;
};

// Fold a submission list into the per-problem summary map — mirrors the
// backend scoreboard.mjs computeSessionSummary (the demo branch reuses this so
// demo chips/attempts/totals behave exactly like the server's payload).
export function summarizeSubmissions(submissions: readonly StoredSubmission[]): Record<string, ProblemSubmissionSummary> {
  const sorted = [...submissions].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const summary: Record<string, ProblemSubmissionSummary> = {};
  for (const submission of sorted) {
    if (!submission.problem_id) continue;
    summary[submission.problem_id] = mergeSubmitOutcome(
      summary[submission.problem_id],
      {
        verdict: submission.verdict,
        score: submission.score,
        max_points: submission.max_points,
        passed_count: 0,
        total: 0,
        submission_id: ""
      },
      submission.created_at
    );
  }
  return summary;
}

// ---- Per-problem editor drafts (spec §4.2) ----------------------------------
// Key scheme: proctor-draft::{session_id}::{problem_id}.

export type EditorDraft = { language: string; code: string };

export function draftKey(sessionId: string, problemId: string): string {
  return `${DRAFT_KEY_PREFIX}${sessionId}::${problemId}`;
}

export function serializeDraft(draft: EditorDraft, updatedAtIso: string): string {
  return JSON.stringify({ language: draft.language, code: draft.code, updated_at: updatedAtIso });
}

// Restore guards: corrupt JSON, non-string fields, a language the problem
// does not allow (fall back to languages[0] + starter at the call site) and
// oversize code all reject the draft entirely.
export function restoreDraft(raw: string | null, allowedLanguages: readonly string[]): EditorDraft | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { language, code } = parsed as Record<string, unknown>;
  if (typeof language !== "string" || typeof code !== "string") return null;
  if (code.length > MAX_DRAFT_CODE_CHARS) return null;
  if (!allowedLanguages.includes(language)) return null;
  return { language, code };
}

// Minimal Storage surface so tests run without a DOM localStorage.
export type DraftStorage = {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
};

// Prefix-scan removal of every draft belonging to ONE session — called at all
// existing sessionStorageKey removal sites (end/expire/replay-invalid paths).
export function clearSessionDrafts(sessionId: string, storage: DraftStorage): void {
  const prefix = `${DRAFT_KEY_PREFIX}${sessionId}::`;
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && key.startsWith(prefix)) doomed.push(key);
  }
  for (const key of doomed) storage.removeItem(key);
}

// ---- Layout pin (task §3) ----------------------------------------------------
// problems.length === 1 (and the legacy single-problem deployment) → NO
// sidebar; the workspace renders exactly as before S-I.
export function showProblemSidebar(problemCount: number): boolean {
  return problemCount > 1;
}

// ---- Server-driven cooldown rendering (spec §4.3) -----------------------------
// The 429 rate_limited body carries retry_after_seconds; the client renders a
// countdown from it and NEVER computes its own cooldown windows.
export function execRetryAfterSeconds(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const body = (error as { body?: unknown }).body;
  if (!body || typeof body !== "object") return null;
  const retry = (body as Record<string, unknown>).retry_after_seconds;
  return typeof retry === "number" && Number.isFinite(retry) && retry > 0 ? retry : null;
}

export function cooldownSecondsRemaining(untilMs: number | null | undefined, nowMs: number): number {
  if (!untilMs) return 0;
  return Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
}
