// scripts/reconcile-tracking.test.mjs — fixtures for the anti-slip reconcile gate.
//
// Drives the pure `reconcile()` core with in-memory "prior" vs "current" tracking
// docs (no git, no filesystem), proving the three contract cases:
//   (a) FAILS when an ID is dropped with no disposition (the T1 regression);
//   (b) PASSES when the ID is still present in any state (☐ / ◑ / ✅ / DEFERRED);
//   (c) PASSES on a normal no-op (docs unchanged).
//
// Run:  node --test scripts/*.test.mjs
//   (or, from the repo, `node --test scripts/reconcile-tracking.test.mjs`)

import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "./reconcile-tracking.mjs";

// A realistic prior BACKLOG with a spread of ID shapes the regex must catch:
// plain (**T1**, **S5**, **F13**, **M2**) and dashed (**REC-4**, **FLOW-1**,
// **ALERT-1**, **LT-14**).
const PRIOR_BACKLOG = `
# Backlog
- ✅ **REC-4** — admin chunk count fixed.
- ◑ **FLOW-1** — re-share flow.
- ☐ **T1** — page-merge onboarding screen.
- ✅ **ALERT-1** — alert feedback.
- ☐ **LT-14** — eval tab iframe.
- → **F13** moved to ROADMAP v2.
- **M2** — leaderboard decision.
- ☐ **S5** — the anti-slip auditor.
`;
const PRIOR_ROADMAP = `
# Roadmap
- **F14** — eval rule registry.
`;

test("(a) FAILS: a prior ID dropped with no disposition is reported as an orphan", () => {
  // T1 is rewritten away entirely — the exact slip this gate exists to catch.
  const currentBacklog = PRIOR_BACKLOG.replace(
    "- ☐ **T1** — page-merge onboarding screen.\n",
    ""
  );
  const { priorIds, orphans } = reconcile({
    baseTexts: [PRIOR_BACKLOG, PRIOR_ROADMAP],
    currentTexts: [currentBacklog, PRIOR_ROADMAP],
  });
  assert.ok(priorIds.includes("T1"), "T1 should be among the prior IDs");
  assert.deepEqual(orphans, ["T1"], "T1 must be the sole orphan");
});

test("(b1) PASSES: ID still present as an active ☐ todo", () => {
  const { orphans } = reconcile({
    baseTexts: ["- ☐ **T1** — onboarding."],
    currentTexts: ["- ☐ **T1** — onboarding (still active)."],
  });
  assert.deepEqual(orphans, []);
});

test("(b2) PASSES: ID still present as ◑ in-progress", () => {
  const { orphans } = reconcile({
    baseTexts: ["- ☐ **T1** — onboarding."],
    currentTexts: ["- ◑ **T1** — onboarding (in progress)."],
  });
  assert.deepEqual(orphans, []);
});

test("(b3) PASSES: ID still present as ✅ done", () => {
  const { orphans } = reconcile({
    baseTexts: ["- ☐ **T1** — onboarding."],
    currentTexts: ["- ✅ **T1** — onboarding shipped."],
  });
  assert.deepEqual(orphans, []);
});

test("(b4) PASSES: ID still present with an explicit DEFERRED disposition", () => {
  const { orphans } = reconcile({
    baseTexts: ["- ☐ **T1** — onboarding."],
    currentTexts: ["- ⏸ **T1** — DEFERRED to v2 (see ROADMAP)."],
  });
  assert.deepEqual(orphans, []);
});

test("(b5) PASSES: ID legitimately moved BACKLOG -> ROADMAP still counts as present", () => {
  // Removed from BACKLOG but re-stated in ROADMAP — combined corpus still has it.
  const { orphans } = reconcile({
    baseTexts: ["- ☐ **F13** — auto-AI verify.", ""],
    currentTexts: ["- (moved to roadmap)", "- **F13** — auto-AI verify (v2)."],
  });
  assert.deepEqual(orphans, []);
});

test("(c) PASSES: normal no-op (docs unchanged) yields no orphans", () => {
  const { priorIds, currentIds, orphans } = reconcile({
    baseTexts: [PRIOR_BACKLOG, PRIOR_ROADMAP],
    currentTexts: [PRIOR_BACKLOG, PRIOR_ROADMAP],
  });
  assert.deepEqual(orphans, []);
  assert.deepEqual(priorIds, currentIds, "prior and current ID sets identical");
  // Sanity: the dashed + plain shapes are all recognised.
  for (const id of ["REC-4", "FLOW-1", "T1", "ALERT-1", "LT-14", "F13", "M2", "S5", "F14"]) {
    assert.ok(priorIds.includes(id), `expected ${id} to be recognised by the ID regex`);
  }
});

test("regex: ignores bare numeric bold and tolerates trailing punctuation", () => {
  const { priorIds, orphans } = reconcile({
    baseTexts: ["**42** is not an ID. **T1**, **REC-4**: and **S5**."],
    currentTexts: ["**T1** **REC-4** **S5**"],
  });
  assert.ok(!priorIds.includes("42"), "bare numeric bold must not be treated as an ID");
  assert.deepEqual(priorIds, ["REC-4", "S5", "T1"]);
  assert.deepEqual(orphans, []);
});

test("regex: captures handles carrying INLINE annotation inside the bold span", () => {
  // The real docs write handles like **T1 (page-merge half)** and **STUB-1 — APPROVED**.
  // The handle is the leading token; trailing annotation inside the bold must not hide it.
  const { priorIds } = reconcile({
    baseTexts: [
      "- ☐ **T1 (page-merge half)** — dropped + unbuilt.\n" +
        "- ✅ **STUB-1 — APPROVED 2026-06-23 (night-run).**\n" +
        "- **M2 — candidate-visible leaderboard:** → v2.\n" +
        "- **F13 vs F14:** disjoint.\n" +
        "- ⚠ **FLOW-1 / T7** — fullscreen render-gate.",
    ],
    currentTexts: [""],
  });
  // Only the LEADING token of each bold span is the handle: from "**F13 vs F14:**"
  // we get F13 (the handle), not F14 (a mid-span prose reference). From "**FLOW-1 / T7**"
  // we get only FLOW-1. That conservative rule is correct — a second ID mentioned
  // mid-bold is a cross-reference, and its own tracked occurrence lives elsewhere.
  for (const id of ["T1", "STUB-1", "M2", "F13", "FLOW-1"]) {
    assert.ok(priorIds.includes(id), `expected inline-annotated handle ${id} to be captured`);
  }
  assert.ok(!priorIds.includes("F14"), "F14 is mid-span here, not a leading handle");
  assert.ok(!priorIds.includes("T7"), "T7 is mid-span here, not a leading handle");
});

test("regex: bold DISPOSITION words / shouty prose are NOT mistaken for IDs", () => {
  // A handle always ends in a number group; digit-less all-caps bold must be ignored.
  const { priorIds } = reconcile({
    baseTexts: ["**DEFERRED** **DROPPED** **FOLDED** **BUILT** **Hard rule** **T1abc** **FLOW-1A**"],
    currentTexts: [""],
  });
  assert.deepEqual(priorIds, [], "no digit-less or malformed bold token should count as an ID");
});

test("adding a brand-new ID is fine — gate only fails on DISappearance", () => {
  const { orphans } = reconcile({
    baseTexts: ["- ☐ **T1** — old."],
    currentTexts: ["- ☐ **T1** — old.", "- ☐ **NEW-9** — brand new item."],
  });
  assert.deepEqual(orphans, []);
});
