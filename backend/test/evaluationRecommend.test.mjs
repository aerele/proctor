// backend/test/evaluationRecommend.test.mjs — pins the P3 recommendation layer.
//
// PII-FREE synthetic cohort (fabricated ids/names) shaped like a real scorecard
// list, designed so EVERY bucket, the phantom filter, the talent/raw ranking,
// and BOTH comparison surfaces (missed-by-raw-score, raw-score-traps) are
// exercised. The real-KPR oracle check lives outside the repo (junk/, PII) and
// is run manually before deploy; this file is the committed, data-free contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUCKET,
  isParticipant,
  recommendFor,
  annotateFlag,
  computeRecommendationReport,
} from "../src/evaluationRecommend.mjs";

// --- fixture helper ---
function card({ id, name, comp, score, talent, integrity, ed = 1000, subs = 5, shell = 100, conf = "high", flags = [] }) {
  return {
    identity_key: id,
    candidate_id: id.toUpperCase(),
    name,
    contest_slug: "fixture-contest",
    computed_at: "2026-06-12T12:00:00.000Z",
    coverage: { editor_events_n: ed, shell_events_n: shell, submissions_n: subs, confidence: conf },
    talent: { composite: comp, total_score: score, max_total: 88 },
    integrity: {},
    flags,
    tiers: { talent, integrity, one_line: `talent=${talent}; integrity=${integrity}` },
  };
}
const F = (code, severity) => ({ code, severity, problem_id: null, evidence: `${code} evidence` });

// A cohort with 5 hires, 3 raw-score traps (2 confirmed + 1 stub-gamer), 1 hold,
// 2 below-bar, and 1 zero-evidence phantom.
const COHORT = [
  card({ id: "a1", name: "Top Clean", comp: 68, score: 65, talent: "strong", integrity: "clean" }),
  card({ id: "a2", name: "Strong Watch", comp: 65, score: 60, talent: "strong", integrity: "watch", flags: [F("clone_cluster", "warning")] }),
  card({ id: "b1", name: "Missed One", comp: 62, score: 48, talent: "strong", integrity: "clean" }),
  card({ id: "b2", name: "Missed Two", comp: 58, score: 40, talent: "strong", integrity: "clean" }),
  card({ id: "b3", name: "Missed Three", comp: 55, score: 38, talent: "strong", integrity: "watch", flags: [F("foreign_paste", "warning")] }),
  card({ id: "c1", name: "Ring Lead", comp: 20, score: 62, talent: "weak", integrity: "confirmed", flags: [F("recurring_pair_conclusive", "critical"), F("hard_clone_cluster", "critical")] }),
  card({ id: "c2", name: "Ring Two", comp: 20, score: 55, talent: "weak", integrity: "confirmed", flags: [F("recurring_pair_conclusive", "critical")] }),
  card({ id: "e1", name: "Stub Gamer", comp: 27, score: 54, talent: "moderate", integrity: "watch", flags: [F("partial_gamer", "info")] }),
  card({ id: "d1", name: "Paste Flag", comp: 27, score: 33, talent: "moderate", integrity: "flag", flags: [F("high_paste_ratio", "critical")] }),
  card({ id: "f1", name: "Low One", comp: 10, score: 10, talent: "weak", integrity: "clean" }),
  card({ id: "f2", name: "Low Two", comp: 5, score: 5, talent: "weak", integrity: "clean" }),
  card({ id: "p1", name: "Phantom Enrollment", comp: 0, score: 0, talent: "weak", integrity: "clean", ed: 0, subs: 0 }),
];

test("isParticipant: real evidence vs zero-evidence phantom", () => {
  assert.equal(isParticipant(COHORT[0]), true);
  assert.equal(isParticipant(COHORT[COHORT.length - 1]), false); // p1: 0 editor + 0 subs
  assert.equal(isParticipant({ coverage: { editor_events_n: 0, submissions_n: 1 } }), true);
  assert.equal(isParticipant({ coverage: { editor_events_n: 5, submissions_n: 0 } }), true);
  assert.equal(isParticipant({}), false);
});

test("recommendFor: integrity gates talent (the calibration invariant)", () => {
  assert.equal(recommendFor(COHORT[0]).bucket, BUCKET.STRONG_HIRE); // strong+clean
  assert.equal(recommendFor(COHORT[1]).bucket, BUCKET.HIRE_DESKCHECK); // strong+watch -> NOT excluded
  assert.equal(recommendFor(COHORT[5]).bucket, BUCKET.EXCLUDE_INTEGRITY); // confirmed
  assert.equal(recommendFor(COHORT[8]).bucket, BUCKET.HOLD_REVIEW); // flag
  assert.equal(recommendFor(COHORT[7]).bucket, BUCKET.BELOW_BAR); // moderate talent
  assert.equal(recommendFor(COHORT[9]).bucket, BUCKET.BELOW_BAR); // weak+clean
});

test("recommendFor: a confirmed copier is excluded even with a top raw score", () => {
  const r = recommendFor(COHORT[5]); // c1: confirmed, raw score 62 (cohort-high)
  assert.equal(r.bucket, BUCKET.EXCLUDE_INTEGRITY);
});

test("recommendFor: inconclusive integrity never excludes a strong solver", () => {
  const c = card({ id: "x", name: "X", comp: 50, score: 40, talent: "strong", integrity: "inconclusive" });
  const r = recommendFor(c);
  assert.equal(r.bucket, BUCKET.HIRE_DESKCHECK);
  assert.match(r.reason, /could not be fully assessed/);
});

test("annotateFlag: weak vs conclusive marking", () => {
  assert.equal(annotateFlag(F("clone_cluster", "warning")).weak, true);
  assert.equal(annotateFlag(F("recurring_pair_conclusive", "critical")).weak, false);
  assert.equal(annotateFlag(F("partial_gamer", "info")).weak, true);
  assert.equal(annotateFlag(F("high_paste_ratio", "critical")).weak, false);
});

test("report: counts, phantom filter", () => {
  const rep = computeRecommendationReport(COHORT, { contest_slug: "fixture-contest" });
  assert.equal(rep.counts.total_docs, 12);
  assert.equal(rep.counts.participants, 11);
  assert.equal(rep.counts.phantoms, 1);
  assert.equal(rep.counts.strong_hire, 3); // a1, b1, b2
  assert.equal(rep.counts.hire_deskcheck, 2); // a2, b3
  assert.equal(rep.counts.hires, 5);
  assert.equal(rep.counts.exclude_integrity, 2); // c1, c2
  assert.equal(rep.counts.hold_review, 1); // d1
  assert.equal(rep.counts.below_bar, 3); // e1, f1, f2
});

test("report: talent ranking and the hire list order", () => {
  const rep = computeRecommendationReport(COHORT, {});
  assert.deepEqual(rep.hires.map((r) => r.identity_key), ["a1", "a2", "b1", "b2", "b3"]);
  assert.deepEqual(rep.hires.map((r) => r.talent_rank), [1, 2, 3, 4, 5]);
  // phantom never appears in any ranked list
  assert.ok(!rep.ranked.some((r) => r.identity_key === "p1"));
});

test("report: missed-by-raw-score = genuine hires a same-depth raw cut would skip", () => {
  const rep = computeRecommendationReport(COHORT, {});
  // depth = 5 hires; raw-top-5 by score = a1(65),c1(62),a2(60),c2(55),e1(54)
  // hires b1,b2,b3 (raw scores 48/40/38) fall outside -> all three are "missed"
  assert.deepEqual(rep.missedByRawScore.map((r) => r.identity_key), ["b1", "b2", "b3"]);
});

test("report: raw-score traps = high-raw names that are NOT hires, with why_not", () => {
  const rep = computeRecommendationReport(COHORT, {});
  const traps = rep.rawScoreTraps;
  // raw-top-5 not hires = c1, c2 (confirmed) + e1 (stub-gamer)
  assert.deepEqual(traps.map((r) => r.identity_key).sort(), ["c1", "c2", "e1"]);
  const byId = Object.fromEntries(traps.map((r) => [r.identity_key, r]));
  assert.equal(byId.c1.why_not, "confirmed copying");
  assert.equal(byId.c2.why_not, "confirmed copying");
  assert.match(byId.e1.why_not, /stub-gaming/);
});

test("report: dossier flags annotated; top_finding is the conclusive one", () => {
  const rep = computeRecommendationReport(COHORT, {});
  const ringLead = rep.excluded.find((r) => r.identity_key === "c1");
  assert.ok(ringLead.flags.length >= 1);
  assert.equal(ringLead.top_finding.code, "recurring_pair_conclusive");
  assert.equal(ringLead.top_finding.weak, false);
  const watchHire = rep.hires.find((r) => r.identity_key === "a2");
  assert.equal(watchHire.top_finding, null); // only a weak clone_cluster, no conclusive finding
});

test("report: FOR/AGAINST case — clean hire states absence affirmatively, ring states the conclusive finding", () => {
  const rep = computeRecommendationReport(COHORT, {});
  const a1 = rep.hires.find((r) => r.identity_key === "a1"); // strong+clean
  assert.ok(a1.case.for.length >= 1);
  assert.equal(a1.case.against.length, 1);
  assert.match(a1.case.against[0], /No adverse signal/);
  const c1 = rep.excluded.find((r) => r.identity_key === "c1"); // confirmed
  assert.ok(c1.case.against.some((s) => /Recurring identical code/.test(s)));
  const a2 = rep.hires.find((r) => r.identity_key === "a2"); // strong+watch
  assert.ok(a2.case.against.some((s) => /weak signal/.test(s)));
  assert.ok(a2.case.against.some((s) => /desk-check and not a block/.test(s)));
  // the reassurance must NOT claim false pattern-identity ("exactly this weak pattern")
  assert.ok(!a2.case.against.some((s) => /exactly this weak pattern/.test(s)));
});

test("recommendFor: the exclude gate is robust to upstream tier-string drift (casing/whitespace)", () => {
  const drifted = { tiers: { talent: "Weak", integrity: " Confirmed " }, talent: { composite: 62 } };
  assert.equal(recommendFor(drifted).bucket, BUCKET.EXCLUDE_INTEGRITY);
  const driftedHire = { tiers: { talent: " Strong ", integrity: "CLEAN" }, talent: { composite: 60 } };
  assert.equal(recommendFor(driftedHire).bucket, BUCKET.STRONG_HIRE);
});

test("report: coverage-aware clean line — thin coverage is NOT stamped a full clearance", () => {
  const thinClean = card({ id: "tc", name: "Thin Clean", comp: 50, score: 40, talent: "strong", integrity: "clean", ed: 1200, subs: 0, conf: "medium" });
  const rep = computeRecommendationReport([thinClean], {});
  const tc = rep.hires.find((r) => r.identity_key === "tc");
  assert.ok(tc.case.against.some((s) => /not a full clearance/.test(s)), tc.case.against.join(" | "));
  // a full-coverage high-confidence clean keeps the conclusive wording
  const fullClean = card({ id: "fc", name: "Full Clean", comp: 60, score: 55, talent: "strong", integrity: "clean", ed: 4000, subs: 8, conf: "high" });
  const rep2 = computeRecommendationReport([fullClean], {});
  assert.ok(rep2.hires[0].case.against.some((s) => /clean editor history/.test(s)));
});

test("report: twin-pairs peer_evidence built from meta for confirmed copiers, empty for hires", () => {
  const meta = {
    recurring_pairs: [{ pair: ["c1", "c2"], n_problems: 5, n_hard: 1, problems: ["p1", "p2", "p3", "p4", "p5"] }],
    clusters: { exact: [{ ch: "p5", hardness: "hard", members: [{ user: "c1", created: 1000 }, { user: "c2", created: 1211 }] }] },
  };
  // give c1/c2 a room via cross_inputs
  const cohort = COHORT.map((c) => (c.identity_key === "c1" || c.identity_key === "c2") ? { ...c, cross_inputs: { room: "Lab A" } } : c);
  const rep = computeRecommendationReport(cohort, meta);
  const c1 = rep.excluded.find((r) => r.identity_key === "c1");
  assert.equal(c1.peer_evidence.length, 1);
  assert.equal(c1.peer_evidence[0].peer, "c2");
  assert.equal(c1.peer_evidence[0].n_problems, 5);
  assert.equal(c1.peer_evidence[0].same_room, true);
  assert.equal(c1.peer_evidence[0].hard_delta.dt_sec, 211);
  assert.equal(c1.peer_evidence[0].hard_delta.i_was_first, true); // c1 created earlier
  // a clean hire has no peer evidence
  assert.equal(rep.hires.find((r) => r.identity_key === "a1").peer_evidence.length, 0);
});

test("report: raw-score traps carry bucket so the headline can split by reason", () => {
  const rep = computeRecommendationReport(COHORT, {});
  // every trap must expose its bucket (used to split confirmed-copying vs hold vs below-bar)
  assert.ok(rep.rawScoreTraps.every((t) => typeof t.bucket === "string"));
  const hold = rep.rawScoreTraps.find((t) => t.bucket === BUCKET.HOLD_REVIEW);
  if (hold) assert.match(hold.why_not, /not a confirmed violation/);
});

test("report: shadow-leaderboard rank_delta — confirmed copier with a top raw score shows a big demotion", () => {
  const rep = computeRecommendationReport(COHORT, {});
  const c1 = rep.excluded.find((r) => r.identity_key === "c1"); // raw #2-ish, talent bottom
  assert.ok(c1.rank_delta < 0, "ring lead should be demoted vs raw score");
  const b1 = rep.hires.find((r) => r.identity_key === "b1"); // talent #3, raw #6
  assert.ok(b1.rank_delta > 0, "buried genuine talent should be promoted vs raw score");
});

test("report: calibration anchor present (honest never excluded; ring fully caught)", () => {
  const rep = computeRecommendationReport(COHORT, {});
  assert.equal(rep.calibration.honest_excluded, 0);
  assert.equal(rep.calibration.ring_caught, rep.calibration.ring_total);
});

test("report: missing_signals surfaces thin coverage without punishing it", () => {
  const thin = card({ id: "z", name: "Z", comp: 50, score: 40, talent: "strong", integrity: "inconclusive", ed: 1000, subs: 0 });
  const rep = computeRecommendationReport([thin], {});
  const z = rep.ranked[0];
  assert.ok(z.missing_signals.includes("submissions"));
  assert.equal(z.bucket, BUCKET.HIRE_DESKCHECK); // still not excluded
});

test("report: empty / malformed input never throws", () => {
  assert.equal(computeRecommendationReport([], {}).counts.participants, 0);
  assert.equal(computeRecommendationReport(null, null).counts.participants, 0);
  assert.equal(computeRecommendationReport(undefined).counts.participants, 0);
});
