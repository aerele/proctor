// backend/src/contestProblems.mjs
// S-I §1.3: the contest problems[] SHIM + effective points + the pure
// reference filter behind the live-reference guard. Pure module — no store,
// no env; handler.mjs supplies pre-fetched docs.
//
// THE shim is the only reader of a contest's problem assignment. Precedence:
//   1. non-empty problems[]      -> sorted by `order`, normalized entries
//   2. legacy `problem_id` field -> a single synthesized entry (the legacy
//      SETTINGS doc and legacy contests keep working with zero migration)
//   3. nothing                   -> []
//
// Spec: docs/superpowers/specs/2026-06-10-s-i-multiproblem-detail-spec.md §1.3/§1.4

export function contestProblemEntries(contestOrSettings) {
  const source = contestOrSettings && typeof contestOrSettings === "object" ? contestOrSettings : {};
  if (Array.isArray(source.problems) && source.problems.length) {
    return source.problems
      .map((entry, index) => ({
        problem_id: String(entry?.problem_id || ""),
        points: entry?.points ?? null,
        order: Number.isFinite(Number(entry?.order)) ? Number(entry.order) : index
      }))
      .sort((a, b) => a.order - b.order);
  }
  const legacyId = String(source.problem_id || "");
  if (legacyId) return [{ problem_id: legacyId, points: null, order: 0 }];
  return [];
}

// Entry override > bank problem points > the 100 default. `??` (not `||`) so a
// genuine 0-point override or 0-point bank problem sticks. Scoring call sites
// pass a MERGED view {...problem, points: effectivePoints(entry, problem)}
// into the existing scoreSubmission — problems.mjs scoring stays untouched.
export function effectivePoints(entry, problem) {
  return entry?.points ?? problem?.points ?? 100;
}

// Pure filter over pre-fetched docs (bounded limit(500) queries handler-side;
// both collections are low-cardinality — deliberately NO denormalized
// problem_ids index field). Non-archived contests matching problems[] OR the
// legacy problem_id field; non-archived templates matching problems[].
// Returns the matched DOCS — callers project slugs / filter by status.
export function findProblemReferences(problemId, { contests = [], templates = [] } = {}) {
  const id = String(problemId || "");
  if (!id) return { contests: [], templates: [] };
  const matches = (problems) => Array.isArray(problems) && problems.some((entry) => entry?.problem_id === id);
  return {
    contests: contests.filter((contest) =>
      contest && contest.status !== "archived"
      && (matches(contest.problems) || String(contest.problem_id || "") === id)),
    templates: templates.filter((template) =>
      template && !template.archived && matches(template.problems))
  };
}
