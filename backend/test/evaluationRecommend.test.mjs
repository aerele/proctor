// backend/test/evaluationRecommend.test.mjs — pins the P3 recommendation layer.
//
// PII-FREE synthetic cohort (fabricated ids/names) shaped like a real scorecard
// list, designed so EVERY bucket, the phantom filter, the talent/raw ranking,
// and BOTH comparison surfaces (missed-by-raw-score, raw-score-traps) are
// exercised. The real-data oracle check lives outside the repo (junk/, PII) and
// is run manually before deploy; this file is the committed, data-free contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUCKET,
  isParticipant,
  recommendFor,
  genuineMedCount,
  annotateFlag,
  computeRecommendationReport,
} from "../src/evaluationRecommend.mjs";

// --- fixture helper ---
// Optional (c)/(d) fields, all defaulting to the original behavior so the
// pre-existing fixtures are byte-for-byte unchanged:
//   per_problem  -> talent.per_problem (the genuine_arc/_tier solve-arc map)
//   pasteRatio   -> integrity.paste_ratio (typed-vs-pasted; <0.12 = typed it)
//   foreignPastes-> integrity.foreign_pastes count (externally-sourced code)
function card({ id, name, comp, score, talent, integrity, ed = 1000, subs = 5, shell = 100, conf = "high", flags = [], per_problem = null, pasteRatio = 0, foreignPastes = 0 }) {
  const integrityObj = { paste_ratio: pasteRatio, foreign_pastes: Array.from({ length: foreignPastes }, (_, i) => ({ len: 40, preview: `fp${i}` })) };
  const talentObj = { composite: comp, total_score: score, max_total: 88 };
  if (per_problem) talentObj.per_problem = per_problem;
  return {
    identity_key: id,
    candidate_id: id.toUpperCase(),
    name,
    contest_slug: "fixture-contest",
    computed_at: "2026-06-12T12:00:00.000Z",
    coverage: { editor_events_n: ed, shell_events_n: shell, submissions_n: subs, confidence: conf },
    talent: talentObj,
    integrity: integrityObj,
    flags,
    tiers: { talent, integrity, one_line: `talent=${talent}; integrity=${integrity}` },
  };
}
// genuine-medium solve-arc map: `n` genuine med arcs + optional decoys (non-arc med
// + genuine-but-hard) so genuineMedCount counts ONLY genuine_arc && _tier==='med'.
function medArcs(n, { decoyMed = 0, genuineHard = 0 } = {}) {
  const pp = {};
  for (let i = 0; i < n; i++) pp[`gm${i}`] = { genuine_arc: true, _tier: "med", best_score: 10, max_points: 10 };
  for (let i = 0; i < decoyMed; i++) pp[`dm${i}`] = { genuine_arc: false, _tier: "med", best_score: 4, max_points: 10 };
  for (let i = 0; i < genuineHard; i++) pp[`gh${i}`] = { genuine_arc: true, _tier: "hard", best_score: 20, max_points: 20 };
  return pp;
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

test("annotateFlag: EVAL-2 unverified flags keep downgraded weak + pass the tag through (UI badge data path)", () => {
  // The owner's bar: a glitchy would-be-foreign paste must stay VISIBLE to the
  // reviewer. The eval UI renders a .fl-unverified badge from `flag.unverified`, and
  // the downgraded severity must drive `weak`. Guard that data contract so a future
  // regression (dropping the field, or weak not following the downgrade) can't
  // silently make a tagged foreign paste invisible / over-weighted.
  const downAfterAway = annotateFlag({ code: "foreign_paste_after_away", severity: "warning", unverified: true, problem_id: "p1", evidence: "x (reconstruction unreliable — unverified)" });
  assert.equal(downAfterAway.weak, true, "downgraded critical→warning reads weak");
  assert.equal(downAfterAway.unverified, true, "tag passes through so the UI badge renders");
  const downPlain = annotateFlag({ code: "foreign_paste", severity: "info", unverified: true });
  assert.equal(downPlain.weak, true, "downgraded warning→info reads weak");
  assert.equal(downPlain.unverified, true);
  // A normal (non-unverified) flag carries no tag and keeps its table-driven weak.
  assert.equal(annotateFlag(F("foreign_paste_after_away", "critical")).unverified, false);
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

// ============================================================================
// (c) SOLID_HIRE — moderate talent + >=2 genuine medium solves stays a HIRE.
// After the (c) talent floor demotes thin "strong" labels to moderate, the
// genuine mid-tier solvers must NOT drop below hire. Integrity still gates.
// ============================================================================

test("genuineMedCount: counts only genuine_arc && _tier==='med' (ignores non-arc med + genuine hard)", () => {
  assert.equal(genuineMedCount(card({ id: "g", name: "G", comp: 40, score: 40, talent: "moderate", integrity: "clean", per_problem: medArcs(2) })), 2);
  // decoys must not count: 2 genuine-med + 3 non-arc med + 1 genuine-hard => still 2
  assert.equal(genuineMedCount(card({ id: "g", name: "G", comp: 40, score: 40, talent: "moderate", integrity: "clean", per_problem: medArcs(2, { decoyMed: 3, genuineHard: 1 }) })), 2);
  assert.equal(genuineMedCount(card({ id: "g", name: "G", comp: 40, score: 40, talent: "moderate", integrity: "clean", per_problem: medArcs(1) })), 1);
  assert.equal(genuineMedCount({}), 0); // no per_problem -> 0, never throws
});

test("(c) recommendFor: moderate + gm>=2 + clean -> SOLID_HIRE (a hire)", () => {
  const r = recommendFor(card({ id: "sh", name: "Solid", comp: 45, score: 44, talent: "moderate", integrity: "clean", per_problem: medArcs(2) }));
  assert.equal(r.bucket, BUCKET.SOLID_HIRE);
  assert.match(r.reason, /2 genuine medium solves/);
});

test("(c) recommendFor: moderate + gm==1 -> below_bar (NOT promoted)", () => {
  const r = recommendFor(card({ id: "lo", name: "OneArc", comp: 30, score: 30, talent: "moderate", integrity: "clean", per_problem: medArcs(1) }));
  assert.equal(r.bucket, BUCKET.BELOW_BAR);
});

test("(c) recommendFor: moderate + gm>=2 + confirmed -> EXCLUDE (integrity gates talent)", () => {
  const r = recommendFor(card({ id: "cx", name: "ConfirmedSolid", comp: 45, score: 44, talent: "moderate", integrity: "confirmed", per_problem: medArcs(3) }));
  assert.equal(r.bucket, BUCKET.EXCLUDE_INTEGRITY);
});

test("(c) recommendFor: moderate + gm>=2 + watch -> SOLID_HIRE (watch = desk-check note, still a hire)", () => {
  const r = recommendFor(card({ id: "sw", name: "SolidWatch", comp: 42, score: 41, talent: "moderate", integrity: "watch", per_problem: medArcs(2), flags: [F("clone_cluster", "warning")] }));
  assert.equal(r.bucket, BUCKET.SOLID_HIRE);
});

test("(c) recommendFor: moderate + gm>=2 + flag -> HOLD (flag still holds, never SOLID_HIRE)", () => {
  const r = recommendFor(card({ id: "sf", name: "SolidFlag", comp: 42, score: 41, talent: "moderate", integrity: "flag", per_problem: medArcs(3), flags: [F("high_paste_ratio", "critical")] }));
  assert.equal(r.bucket, BUCKET.HOLD_REVIEW);
});

test("(c) report: SOLID_HIRE is a hire bucket, counted + ranked below strong/deskcheck, above hold/below_bar", () => {
  const cohort = [
    card({ id: "s1", name: "Strong Clean", comp: 70, score: 60, talent: "strong", integrity: "clean" }),
    card({ id: "m1", name: "Solid Mid", comp: 45, score: 44, talent: "moderate", integrity: "clean", per_problem: medArcs(2) }),
    card({ id: "m2", name: "Solid Watch", comp: 43, score: 42, talent: "moderate", integrity: "watch", per_problem: medArcs(2), flags: [F("clone_cluster", "warning")] }),
    card({ id: "m3", name: "Thin Mid", comp: 30, score: 30, talent: "moderate", integrity: "clean", per_problem: medArcs(1) }),
  ];
  const rep = computeRecommendationReport(cohort, {});
  assert.equal(rep.counts.solid_hire, 2); // m1, m2
  assert.equal(rep.counts.hires, 3); // s1 + m1 + m2 (solid counts as a hire)
  assert.ok(rep.hires.some((r) => r.identity_key === "m1") && rep.hires.some((r) => r.identity_key === "m2"));
  // m3 (gm==1) is NOT promoted
  assert.equal(rep.belowBar.find((r) => r.identity_key === "m3").bucket, BUCKET.BELOW_BAR);
  // ordering: BUCKET_META.order puts solid below strong/deskcheck and above hold/below_bar
  assert.ok(rep.counts.solid_hire >= 1);
});

// ============================================================================
// (d) ORIGIN-RESCUE — GENUINE_COPIED: the genuine solver who got copied FROM is
// reclassified out of exclude into a SEPARATE visible bucket (talent kept,
// integrity = a note). Earliest submit + typed it + >=2 arcs + no foreign paste.
// ============================================================================

// origin/copier fixtures: all confirmed-integrity (so they start EXCLUDED), with
// distinct profiles. `genuine` = typed it, 2 arcs, no foreign. `copier` = typed
// but 0 arcs (watch-retype). `external` = a foreign paste.
function genuineMember(id, name) {
  return card({ id, name, comp: 50, score: 50, talent: "strong", integrity: "confirmed", per_problem: medArcs(2), pasteRatio: 0.02, foreignPastes: 0, flags: [F("recurring_pair_conclusive", "critical")] });
}
function copierMember(id, name) {
  return card({ id, name, comp: 20, score: 50, talent: "weak", integrity: "confirmed", per_problem: medArcs(0), pasteRatio: 0.0, foreignPastes: 0, flags: [F("recurring_pair_conclusive", "critical")] });
}
function externalMember(id, name) {
  return card({ id, name, comp: 20, score: 50, talent: "weak", integrity: "confirmed", per_problem: medArcs(2), pasteRatio: 0.5, foreignPastes: 2, flags: [F("high_paste_ratio", "critical")] });
}

test("(d) 3-member cluster: earliest is typed+2arcs+no-foreign -> earliest GENUINE_COPIED, others stay excluded; chain surfaced", () => {
  const cohort = [
    genuineMember("o1", "Origin One"),
    copierMember("k1", "Copier One"),
    copierMember("k2", "Copier Two"),
  ];
  const meta = {
    clusters: {
      exact: [
        { ch: "p-med", hardness: "med", members: [
          { user: "o1", created: 1000 }, // earliest
          { user: "k1", created: 1300 },
          { user: "k2", created: 1600 },
        ] },
      ],
    },
    recurring_pairs: [],
  };
  const rep = computeRecommendationReport(cohort, meta);
  // o1 rescued
  assert.equal(rep.counts.genuine_copied, 1);
  const o1 = rep.genuineCopied.find((r) => r.identity_key === "o1");
  assert.ok(o1, "o1 should be in the GENUINE_COPIED bucket");
  assert.equal(o1.bucket, BUCKET.GENUINE_COPIED);
  assert.equal(o1.talent_tier, "strong"); // talent KEPT
  assert.deepEqual(o1.copied_by.sort(), ["k1", "k2"]);
  assert.match(o1.origin_chain, /Origin: Origin One \(copied by → /);
  assert.match(o1.origin_chain, /Copier One/);
  assert.match(o1.origin_chain, /Copier Two/);
  assert.match(o1.reason, /their work was copied/);
  // copiers stay excluded, NOT rescued, NOT hired
  assert.ok(rep.excluded.some((r) => r.identity_key === "k1"));
  assert.ok(rep.excluded.some((r) => r.identity_key === "k2"));
  assert.ok(!rep.genuineCopied.some((r) => r.identity_key === "k1" || r.identity_key === "k2"));
  // GENUINE_COPIED is a SEPARATE bucket — NOT silently merged into hires
  assert.ok(!rep.hires.some((r) => r.identity_key === "o1"));
});

test("(d) cluster where earliest has a foreign paste -> whole cluster external, NONE rescued", () => {
  const cohort = [
    externalMember("x1", "External First"), // earliest, has foreign paste
    genuineMember("g2", "Genuine Later"), // typed+arcs but submitted LATER
    copierMember("k3", "Copier"),
  ];
  const meta = {
    clusters: {
      exact: [
        { ch: "p-med", hardness: "med", members: [
          { user: "x1", created: 500 }, // earliest, foreign -> kills the whole cluster
          { user: "g2", created: 900 },
          { user: "k3", created: 1200 },
        ] },
      ],
    },
    recurring_pairs: [],
  };
  const rep = computeRecommendationReport(cohort, meta);
  assert.equal(rep.counts.genuine_copied, 0); // no rescue when earliest is external
  assert.ok(rep.excluded.some((r) => r.identity_key === "x1"));
  assert.ok(rep.excluded.some((r) => r.identity_key === "g2")); // later genuine NOT rescued
  assert.ok(rep.excluded.some((r) => r.identity_key === "k3"));
});

test("(d) recurring pair: earliest genuine origin rescued; ranked by each member's earliest submit", () => {
  const cohort = [genuineMember("o3", "Pair Origin"), copierMember("k4", "Pair Copier")];
  const meta = {
    // the pair's submit order is derived from the exact-cluster timestamps
    clusters: { exact: [{ ch: "p1", hardness: "med", members: [{ user: "o3", created: 100 }, { user: "k4", created: 800 }] }] },
    recurring_pairs: [{ pair: ["o3", "k4"], n_problems: 4, problems: ["p1", "p2", "p3", "p4"] }],
  };
  const rep = computeRecommendationReport(cohort, meta);
  const o3 = rep.genuineCopied.find((r) => r.identity_key === "o3");
  assert.ok(o3);
  assert.deepEqual(o3.copied_by, ["k4"]);
  assert.match(o3.origin_chain, /Origin: Pair Origin \(copied by → Pair Copier\)/);
  assert.ok(rep.excluded.some((r) => r.identity_key === "k4"));
});

test("(d) a moderate-with-gm2 origin that was only WATCH (not confirmed) is NOT touched by the rescue (rescue only lifts an EXCLUDE)", () => {
  // this candidate is already a SOLID_HIRE via (c); the rescue must not steal it.
  const cohort = [
    card({ id: "sh2", name: "Solid Not Excluded", comp: 45, score: 44, talent: "moderate", integrity: "watch", per_problem: medArcs(2), pasteRatio: 0.02, foreignPastes: 0, flags: [F("clone_cluster", "warning")] }),
    copierMember("k5", "Copier"),
  ];
  const meta = {
    clusters: { exact: [{ ch: "p1", hardness: "med", members: [{ user: "sh2", created: 100 }, { user: "k5", created: 700 }] }] },
    recurring_pairs: [],
  };
  const rep = computeRecommendationReport(cohort, meta);
  // sh2 stays a SOLID_HIRE (it was never excluded), not moved into GENUINE_COPIED
  assert.ok(rep.hires.some((r) => r.identity_key === "sh2"));
  assert.ok(!rep.genuineCopied.some((r) => r.identity_key === "sh2"));
});

// ============================================================================
// PENDING-4 (2026-06-22): tighten origin-rescue.
//   (a) do NOT fire on skeleton-only-differing recurring pairs (n_exact===0).
//   (b) a group resolves to AT MOST ONE origin — no mutual origin (a candidate
//       who is a copier in ANY group can never also be rescued as an origin).
// ============================================================================

test("(d) PENDING-4(a): skeleton-only recurring pair (n_exact=0) does NOT rescue anyone", () => {
  // Two confirmed candidates form a recurring pair with NO byte-identical match
  // (skeleton-only: same algorithm shape, different code) → no copy → nothing to
  // rescue. The earliest is genuine-profiled, but the pair is skeleton-only.
  const cohort = [genuineMember("s1", "Skel Origin"), copierMember("s2", "Skel Other")];
  const meta = {
    clusters: { exact: [] }, // NO exact cluster → skeleton-only
    recurring_pairs: [{ pair: ["s1", "s2"], n_problems: 2, problems: ["p1", "p2"], n_exact: 0 }],
  };
  const rep = computeRecommendationReport(cohort, meta);
  assert.equal(rep.counts.genuine_copied, 0, "skeleton-only pair (n_exact=0) yields NO rescue");
  assert.ok(rep.excluded.some((r) => r.identity_key === "s1"));
  assert.ok(rep.excluded.some((r) => r.identity_key === "s2"));
});

test("(d) PENDING-4(a): exact recurring pair (n_exact>=1) STILL rescues the genuine origin", () => {
  // Same as above but with a real coreExact match → rescue fires as before.
  const cohort = [genuineMember("e1", "Exact Origin"), copierMember("e2", "Exact Copier")];
  const meta = {
    clusters: { exact: [{ ch: "p1", hardness: "med", members: [{ user: "e1", created: 100 }, { user: "e2", created: 900 }] }] },
    recurring_pairs: [{ pair: ["e1", "e2"], n_problems: 2, problems: ["p1", "p2"], n_exact: 1 }],
  };
  const rep = computeRecommendationReport(cohort, meta);
  assert.equal(rep.counts.genuine_copied, 1);
  assert.ok(rep.genuineCopied.some((r) => r.identity_key === "e1"));
  assert.ok(rep.excluded.some((r) => r.identity_key === "e2"));
});

test("(d) PENDING-4(b): MUTUAL origin is impossible — two byte-identical typists, neither is rescued", () => {
  // two-byte-identical-typists shape: both typed byte-identical code, each ranks 'earliest'
  // on a DIFFERENT problem. Under the old merge BOTH were rescued (mutual origin);
  // now a candidate who is a copier in ANY group cannot be an origin → NEITHER is
  // rescued, both stay excluded (real copiers correctly held).
  const cohort = [genuineMember("m1", "Typist One"), genuineMember("m2", "Typist Two")];
  const meta = {
    clusters: {
      exact: [
        // on p-a, m1 is earliest; on p-b, m2 is earliest → each is a copier on the other
        { ch: "p-a", hardness: "med", members: [{ user: "m1", created: 100 }, { user: "m2", created: 200 }] },
        { ch: "p-b", hardness: "med", members: [{ user: "m2", created: 300 }, { user: "m1", created: 400 }] },
      ],
    },
    recurring_pairs: [{ pair: ["m1", "m2"], n_problems: 2, problems: ["p-a", "p-b"], n_exact: 2 }],
  };
  const rep = computeRecommendationReport(cohort, meta);
  assert.equal(rep.counts.genuine_copied, 0, "no mutual origin — neither rescued");
  assert.ok(rep.excluded.some((r) => r.identity_key === "m1"));
  assert.ok(rep.excluded.some((r) => r.identity_key === "m2"));
});

test("(d) PENDING-4(b): a clean unambiguous origin (earliest everywhere) is STILL rescued", () => {
  // o is earliest on BOTH problems (never a copier) → still a clean origin.
  const cohort = [genuineMember("o", "Clean Origin"), copierMember("c1", "Copier A"), copierMember("c2", "Copier B")];
  const meta = {
    clusters: {
      exact: [
        { ch: "p-a", hardness: "med", members: [{ user: "o", created: 100 }, { user: "c1", created: 500 }] },
        { ch: "p-b", hardness: "med", members: [{ user: "o", created: 150 }, { user: "c2", created: 600 }] },
      ],
    },
    recurring_pairs: [],
  };
  const rep = computeRecommendationReport(cohort, meta);
  assert.equal(rep.counts.genuine_copied, 1);
  const o = rep.genuineCopied.find((r) => r.identity_key === "o");
  assert.ok(o, "earliest-everywhere origin still rescued");
  assert.deepEqual(o.copied_by.sort(), ["c1", "c2"]);
  assert.ok(rep.excluded.some((r) => r.identity_key === "c1"));
  assert.ok(rep.excluded.some((r) => r.identity_key === "c2"));
});
