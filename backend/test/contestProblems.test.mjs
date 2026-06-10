// backend/test/contestProblems.test.mjs — S-I §1.3: the contest problems[]
// shim, effective points, and the pure reference filter behind the
// live-reference guard. PURE unit tests — no handler import, no env, no GCP.
// Spec: docs/superpowers/specs/2026-06-10-s-i-multiproblem-detail-spec.md §1.3/§1.4
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contestProblemEntries,
  effectivePoints,
  findProblemReferences
} from "../src/contestProblems.mjs";

// ---- contestProblemEntries: THE shim, the only reader -------------------------

test("shim precedence: non-empty problems[] wins; legacy problem_id second; else []", () => {
  // problems[] present -> served sorted, legacy field ignored.
  const both = contestProblemEntries({
    problems: [{ problem_id: "b", points: 50, order: 1 }, { problem_id: "a", points: null, order: 0 }],
    problem_id: "legacy-one"
  });
  assert.deepEqual(both.map((e) => e.problem_id), ["a", "b"]);

  // legacy problem_id only (the SETTINGS doc and legacy contests).
  assert.deepEqual(contestProblemEntries({ problem_id: "sum-two" }), [
    { problem_id: "sum-two", points: null, order: 0 }
  ]);

  // empty problems[] does NOT mask a legacy problem_id.
  assert.deepEqual(contestProblemEntries({ problems: [], problem_id: "sum-two" }).map((e) => e.problem_id), ["sum-two"]);

  // nothing assigned.
  assert.deepEqual(contestProblemEntries({}), []);
  assert.deepEqual(contestProblemEntries(null), []);
  assert.deepEqual(contestProblemEntries({ problem_id: "" }), []);
});

test("shim: entries come back ordered by `order` with points defaulting to null", () => {
  const entries = contestProblemEntries({
    problems: [
      { problem_id: "c", order: 2 },
      { problem_id: "a", order: 0, points: 0 },
      { problem_id: "b", order: 1 }
    ]
  });
  assert.deepEqual(entries, [
    { problem_id: "a", points: 0, order: 0 },
    { problem_id: "b", points: null, order: 1 },
    { problem_id: "c", points: null, order: 2 }
  ]);
});

// ---- effectivePoints matrix ----------------------------------------------------

test("effectivePoints: entry override > bank points > 100 default; a 0 override sticks", () => {
  assert.equal(effectivePoints({ points: 40 }, { points: 80 }), 40);
  assert.equal(effectivePoints({ points: null }, { points: 80 }), 80);
  assert.equal(effectivePoints({ points: null }, {}), 100);
  assert.equal(effectivePoints({}, {}), 100);
  assert.equal(effectivePoints({ points: 0 }, { points: 80 }), 0);   // 0 is a real override
  assert.equal(effectivePoints({ points: null }, { points: 0 }), 0); // 0 bank points stick too
});

// ---- findProblemReferences -------------------------------------------------------

const CONTESTS = [
  { slug: "open-multi", status: "open", problems: [{ problem_id: "p1" }, { problem_id: "p2" }] },
  { slug: "draft-multi", status: "draft", problems: [{ problem_id: "p1" }] },
  { slug: "archived-multi", status: "archived", problems: [{ problem_id: "p1" }] },
  { slug: "legacy-style", status: "open", problem_id: "p3" }
];
const TEMPLATES = [
  { slug: "tpl-live", archived: false, problems: [{ problem_id: "p1" }] },
  { slug: "tpl-archived", archived: true, problems: [{ problem_id: "p1" }] }
];

test("findProblemReferences: matches contest problems[], the legacy field, and live templates; archived excluded", () => {
  const p1 = findProblemReferences("p1", { contests: CONTESTS, templates: TEMPLATES });
  assert.deepEqual(p1.contests.map((c) => c.slug), ["open-multi", "draft-multi"]);
  assert.deepEqual(p1.templates.map((t) => t.slug), ["tpl-live"]);

  const p3 = findProblemReferences("p3", { contests: CONTESTS, templates: TEMPLATES });
  assert.deepEqual(p3.contests.map((c) => c.slug), ["legacy-style"]);
  assert.deepEqual(p3.templates, []);

  const none = findProblemReferences("ghost", { contests: CONTESTS, templates: TEMPLATES });
  assert.deepEqual(none, { contests: [], templates: [] });
});
