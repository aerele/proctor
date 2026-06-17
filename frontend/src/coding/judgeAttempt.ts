// frontend/src/coding/judgeAttempt.ts
//
// M9 — Run/Submit used to wrap the judge call in try/finally with no catch, so
// a failed request (judge unreachable, 5xx, network drop) left the candidate
// staring at a stale or empty panel with zero feedback. This wrapper turns any
// rejection into a single, friendly, candidate-facing outcome the workspace can
// render inline — without leaking raw error text — while passing successes
// straight through.

export const JUDGE_UNREACHABLE_MESSAGE = "Couldn't reach the judge — try again.";

export type JudgeAttempt<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export async function runJudgeAttempt<T>(action: () => Promise<T>): Promise<JudgeAttempt<T>> {
  try {
    return { ok: true, value: await action() };
  } catch {
    return { ok: false, error: JUDGE_UNREACHABLE_MESSAGE };
  }
}
