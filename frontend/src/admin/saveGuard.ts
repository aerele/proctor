// D1 (Karthi decision, Wave6): "warn-on-save" confirm gate — reusable PURE
// decision logic for "this admin save touches something LIVE; confirm first".
//
// IMPORTANT (flagged for Karthi): the EXACT trigger Karthi agreed to was not
// recoverable from disk. The implemented interpretation is the clearest impactful
// one: saving an edit to a published problem that is referenced by an OPEN
// (running/active) contest. An open contest can have candidates sitting it right
// now, so editing the problem changes the statement/tests/limits they see
// mid-exam — exactly the foot-gun a confirm dialog should guard. The gate is a
// pure function so it is trivially reusable for the contest window/settings save
// too if Karthi wants it extended there.
//
// "Live" == contest.status === "open". Draft contests are not yet running and
// archived contests are over, so a save against problems only those reference is
// safe and prompts nothing.
import type { ApiError } from "../api";
import type { ContestSummary, ProblemDoc } from "../types";

/** Does a contest reference this problem — via the S-I problems[] array or the
 * legacy single-problem assignment (problem_id on the synth legacy row)? */
function contestReferencesProblem(contest: ContestSummary, problemId: string): boolean {
  if (Array.isArray(contest.problems) && contest.problems.some((p) => p.problem_id === problemId)) return true;
  return contest.problem_id === problemId;
}

/** Every contest (any status) that references the problem. A blank id never
 * matches — a brand-new draft has no id yet, so its first save is always safe. */
export function contestsReferencingProblem(problemId: string, contests: ContestSummary[]): ContestSummary[] {
  if (!problemId) return [];
  return contests.filter((contest) => contestReferencesProblem(contest, problemId));
}

/** Only the OPEN (running/active) contests that reference the problem — the set
 * whose candidates a problem edit can affect right now. */
export function liveContestsReferencingProblem(problemId: string, contests: ContestSummary[]): ContestSummary[] {
  return contestsReferencingProblem(problemId, contests).filter((contest) => contest.status === "open");
}

/** The save needs a confirm dialog when at least one OPEN contest references the
 * problem being saved. */
export function shouldConfirmLiveSave(problemId: string, contests: ContestSummary[]): boolean {
  return liveContestsReferencingProblem(problemId, contests).length > 0;
}

/** The confirm-dialog copy: how many running/active contests are affected, named
 * by slug, with the explicit "Continue?" the dialog asks. */
export function liveSaveConfirmMessage(problemId: string, liveContests: ContestSummary[]): string {
  const count = liveContests.length;
  const noun = count === 1 ? "running/active contest" : "running/active contests";
  const slugs = liveContests.map((contest) => contest.slug).join(", ");
  return `This change affects ${count} ${noun} (${slugs}). Candidates sitting ${count === 1 ? "it" : "them"} right now will see the edited problem. Continue?`;
}

// ---- W7: backend hidden-test live-edit guard (409) ---------------------------
// The D1 gate above is the frontend's best-effort warning (it sees whatever the
// contests fetch returned). The backend enforces its own AUTHORITATIVE guard for
// HIDDEN-test edits (adminSaveProblem): changing hiddenTests while ≥1 OPEN
// contest references the problem 409s with `live_edit_confirmation_required`
// plus the open-contest slugs (flat `contests` key on the error body) until the
// save body carries confirm_live_edit === problem.id. These pure helpers
// classify that 409 and build the confirmed retry payload; ProblemBank binds
// window.confirm to them — same attempt/confirm/resend shape as the
// ContestsPanel problem_add_requires_confirm / points_edit_confirmation_required
// flows.

/** The parsed live_edit_confirmation_required guard: which OPEN contests the
 * SERVER says reference the problem (slugs from the 409 body's `contests`). */
export type LiveEditGuard = { contests: string[] };

/** Classify a thrown save error: the backend's hidden-test live-edit 409 →
 * LiveEditGuard, anything else → null (those errors must surface normally). */
export function liveEditGuardFromError(cause: unknown): LiveEditGuard | null {
  const apiError = cause as ApiError | null;
  if (!apiError || typeof apiError !== "object") return null;
  if (apiError.status !== 409 || apiError.code !== "live_edit_confirmation_required") return null;
  const raw = apiError.body?.contests;
  // Defensive: the backend always names the slugs; a malformed body still
  // fires the guard (the dialog just can't name the contests).
  return { contests: Array.isArray(raw) ? raw.map(String) : [] };
}

/** The hidden-test confirm-dialog copy: what is changing, which open contests
 * the server reported, and what that means for candidates mid-exam. */
export function liveEditConfirmMessage(problemId: string, guard: LiveEditGuard): string {
  const count = guard.contests.length;
  const referenced = count
    ? `${count} OPEN ${count === 1 ? "contest" : "contests"} (${guard.contests.join(", ")})`
    : "an OPEN contest";
  return `Hidden tests are changing on "${problemId}", which is referenced by ${referenced}. Candidates sitting ${count > 1 ? "them" : "it"} right now will be graded against the new hidden tests from their next submission — scores already recorded are not re-graded. Continue?`;
}

/** The confirmed retry: the SAME save payload plus the confirmation the backend
 * requires (confirm_live_edit === the problem id). Wire-only — the backend
 * whitelists problem fields, so the flag is never stored. */
export function liveEditRetryBody(doc: ProblemDoc): ProblemDoc & { confirm_live_edit: string } {
  return { ...doc, confirm_live_edit: doc.id };
}
