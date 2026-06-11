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
import type { ContestSummary } from "../types";

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
