// backend/src/evaluationRecommend.mjs — the P3 RECOMMENDATION LAYER.
//
// PURE + BROWSER-SAFE. No node imports, no IO, no env. This single source is
//   (a) unit-tested in node (test/evaluationRecommend.test.mjs), and
//   (b) served verbatim to the /eval-ui page by eval-server.mjs (GET
//       /eval-ui/recommend.js) and imported there as an ES module — so the
//       recommendation the browser shows is the EXACT logic the tests pin. No
//       second copy, no drift.
//
// WHY A READ-TIME TRANSFORM (not an engine rewrite)
// -------------------------------------------------
// The detection engine (evaluationMetrics.mjs) already derives, per candidate,
// `tiers.talent` (weak|moderate|strong), `tiers.integrity`
// (clean|watch|flag|confirmed|inconclusive) and a confirmed-capped
// `talent.composite`. Calibration against a real ground-truth cohort (the
// candidates an organization actually selected, plus a known confirmed copying
// ring) proved those tiers ALREADY separate the real hires from the ring
// correctly. So the recommendation is a PURE TRANSFORM over the stored
// scorecards — additive, zero risk to the calibrated detector.
//
// THE CALIBRATION INVARIANT (why honest candidates ~never get excluded)
// ---------------------------------------------------------------------
// Integrity GATES talent; the two are orthogonal and NEVER averaged. Only
// `confirmed` excludes; `flag` holds for manual review; `watch`/`inconclusive`
// are desk-check notes, NEVER a hire-blocker. This is forced by the data: a
// majority of the genuinely-selected candidates in the calibration cohort carry
// a `watch` note (a single shared medium problem — weak by design). A naive
// "any flag => exclude" rule would have rejected most of the real hires.

export const RECOMMEND_VERSION = "2";

export const BUCKET = {
  STRONG_HIRE: "strong_hire",
  HIRE_DESKCHECK: "hire_deskcheck",
  SOLID_HIRE: "solid_hire",
  GENUINE_COPIED: "genuine_copied",
  HOLD_REVIEW: "hold_review",
  EXCLUDE_INTEGRITY: "exclude_integrity",
  BELOW_BAR: "below_bar",
};

// Display order + labels for the buckets (UI consumes this). SOLID_HIRE ranks
// BELOW strong_hire/hire_deskcheck and ABOVE hold/exclude/below_bar (it is still
// a HIRE — the spec hard rule is that nobody drops below hire). GENUINE_COPIED is
// a SEPARATE surfaced rescue bucket (a genuine solver who was copied FROM); it
// sits after the hires, before hold, so a human sees exactly who was rescued.
export const BUCKET_META = {
  [BUCKET.STRONG_HIRE]: { label: "Strong hire", tone: "good", order: 1 },
  [BUCKET.HIRE_DESKCHECK]: { label: "Hire — desk-check", tone: "warn", order: 2 },
  [BUCKET.SOLID_HIRE]: { label: "Solid hire — genuine mid-tier solver", tone: "good", order: 3 },
  [BUCKET.GENUINE_COPIED]: { label: "Genuine — their work was copied", tone: "good", order: 4 },
  [BUCKET.HOLD_REVIEW]: { label: "Hold — integrity review", tone: "warn", order: 5 },
  [BUCKET.EXCLUDE_INTEGRITY]: { label: "Exclude — integrity", tone: "bad", order: 6 },
  [BUCKET.BELOW_BAR]: { label: "Below the bar", tone: "muted", order: 7 },
};

const HIRE_BUCKETS = new Set([BUCKET.STRONG_HIRE, BUCKET.HIRE_DESKCHECK, BUCKET.SOLID_HIRE]);
export function isHireBucket(bucket) {
  return HIRE_BUCKETS.has(bucket);
}

// A PARTICIPANT is a scorecard with real evidence — at least one editor event OR
// one submission. Zero-evidence rows (roster/enrollment identities whose
// sessions never linked — e.g. a mid-contest roster clear can leave many
// composite-0 clean placeholder docs that are not real participants) are NOT
// participants and are excluded from every ranked view. This is the availability
// principle at the cohort level: no data ⇒ not a candidate to rank, never a
// fabricated "clean 0".
export function isParticipant(card) {
  const c = (card && card.coverage) || {};
  return (c.editor_events_n || 0) > 0 || (c.submissions_n || 0) > 0;
}

// Count this card's GENUINE MEDIUM solves: per_problem entries that carry a real
// solve arc (genuine_arc===true) on a medium-tier problem (_tier==='med'). This is
// the evidence behind SOLID_HIRE — a moderate-talent candidate with >=2 genuine
// medium solves is a real mid-tier solver, not a stub-gamer. (The old strong-talent
// gate was genuineHard>=1 || genuineMed>=2; after the (c) talent floor demotes thin
// "strong" labels to moderate, this keeps those genuine mid-tier solvers as hires
// rather than dropping them below the bar — the spec hard rule: nobody drops below
// hire.) Robust to a missing/!object per_problem map.
export function genuineMedCount(card) {
  const pp = (card && card.talent && card.talent.per_problem) || {};
  let n = 0;
  for (const k of Object.keys(pp)) {
    const e = pp[k] || {};
    if (e.genuine_arc === true && e._tier === "med") n++;
  }
  return n;
}

// Per-candidate bucket + one-line reason. Integrity gates talent.
//   confirmed                 -> EXCLUDE (regardless of score)
//   flag                      -> HOLD for review
//   strong talent + clean     -> STRONG HIRE
//   strong talent + watch/inconclusive -> HIRE (desk-check note)
//   moderate + >=2 genuine medium solves + clean/watch -> SOLID HIRE
//   anything else             -> below the bar
// `inconclusive` (missing-signal availability gate) is treated like `watch`:
// never excludes, but can't fully clear — so a strong solver with inconclusive
// integrity is a desk-check, not a clean hire.
export function recommendFor(card) {
  const tiers = (card && card.tiers) || {};
  // Normalize the tier strings before gating. The exclude gate (integrity ===
  // "confirmed") is the single most safety-critical line in the layer — a copier
  // reaching the hire set is the worst failure mode — so make it robust to any
  // upstream formatting drift (casing / stray whitespace) rather than depending
  // on an implicit byte-exact cross-module contract with the detector.
  const talent = String(tiers.talent || "").trim().toLowerCase();
  const integrity = String(tiers.integrity || "").trim().toLowerCase();
  const composite = Number(card && card.talent && card.talent.composite) || 0;

  if (integrity === "confirmed") {
    return {
      bucket: BUCKET.EXCLUDE_INTEGRITY,
      reason: "Confirmed copying — excluded regardless of score.",
      talent_tier: talent,
      integrity_tier: integrity,
      composite,
    };
  }
  if (integrity === "flag") {
    return {
      bucket: BUCKET.HOLD_REVIEW,
      reason: "Integrity concern (externally-sourced code) — hold for a manual review before any offer.",
      talent_tier: talent,
      integrity_tier: integrity,
      composite,
    };
  }
  if (talent === "strong") {
    if (integrity === "clean") {
      return {
        bucket: BUCKET.STRONG_HIRE,
        reason: "Strong genuine problem-solver with a clean record — recommend hire.",
        talent_tier: talent,
        integrity_tier: integrity,
        composite,
      };
    }
    const note =
      integrity === "inconclusive"
        ? "integrity could not be fully assessed (limited captured data)"
        : "only a weak desk-check note (a single shared medium problem / a minor paste)";
    return {
      bucket: BUCKET.HIRE_DESKCHECK,
      reason: `Strong problem-solver; ${note} — recommend hire after a short desk-check.`,
      talent_tier: talent,
      integrity_tier: integrity,
      composite,
    };
  }
  // SOLID HIRE: a moderate-talent candidate who still has >=2 genuine medium
  // solves and a clean (or watch — a single desk-check note, still hire) record
  // is a real mid-tier solver, kept as a HIRE (spec hard rule: nobody drops below
  // hire). `confirmed`/`flag` already returned above, so a confirmed-integrity
  // solid candidate never reaches here — integrity still gates talent.
  if (talent === "moderate" && (integrity === "clean" || integrity === "watch")) {
    const genuineMed = genuineMedCount(card);
    if (genuineMed >= 2) {
      const note =
        integrity === "watch"
          ? " (a single weak desk-check note — confirm in a short desk-check)"
          : "";
      return {
        bucket: BUCKET.SOLID_HIRE,
        reason: `Solid hire — genuine mid-tier solver: ${genuineMed} genuine medium solves${note}.`,
        talent_tier: talent,
        integrity_tier: integrity,
        composite,
      };
    }
  }
  return {
    bucket: BUCKET.BELOW_BAR,
    reason: `Talent ${talent || "weak"} — below the hiring bar on this contest.`,
    talent_tier: talent,
    integrity_tier: integrity,
    composite,
  };
}

// Plain-English annotation of a raw flag, with a `weak` marker so the UI can show
// WHY a desk-check note is weak (e.g. a single shared medium problem is
// convergence-plausible) vs a conclusive integrity finding.
const FLAG_INFO = {
  recurring_pair_conclusive: { label: "Recurring identical code with a peer across multiple problems — conclusive copying.", weak: false },
  hard_clone_cluster: { label: "Identical code on a HARD problem shared with peers.", weak: false },
  clone_cluster: { label: "Shared identical code on a single medium problem — convergence-plausible.", weak: true },
  failed_clone_cluster: { label: "Identical failed code shared with peers.", weak: false },
  directed_paste_match: { label: "Pasted code matches a specific peer's submission.", weak: false },
  high_paste_ratio: { label: "Most of the submitted code was pasted, not typed.", weak: false },
  foreign_paste_after_away: { label: "Pasted a full solution right after leaving the tab.", weak: false },
  foreign_paste: { label: "Pasted code that was not typed earlier in the session.", weak: true },
  zero_effort_solve: { label: "Full solution with almost no typing or active time.", weak: false },
  telemetry_tampered: { label: "Submitted code does not match the captured editor stream.", weak: false },
  premeditated_clipboard: { label: "Clipboard pre-loaded with a solution before the problem opened.", weak: false },
  superhuman_cadence: { label: "Typing speed beyond a plausible human rate.", weak: true },
  metronomic_cadence: { label: "Unnaturally even keystroke timing.", weak: true },
  partial_gamer: { label: "Earned partial credit by trivially editing the stub (talent-only note, not an integrity flag).", weak: true },
};

export function annotateFlag(flag) {
  const code = (flag && flag.code) || "";
  const info = FLAG_INFO[code] || { label: code.replace(/_/g, " "), weak: (flag && flag.severity) !== "critical" };
  return {
    code,
    severity: (flag && flag.severity) || "info",
    problem_id: (flag && flag.problem_id) || null,
    evidence: (flag && flag.evidence) || "",
    label: info.label,
    weak: info.weak,
  };
}

function displayName(card) {
  return (
    (card && card.name) ||
    (card && card.candidate_id) ||
    (card && card.username_norm) ||
    (card && card.identity_key) ||
    "—"
  );
}

// METHOD-CALIBRATION reference (the trust anchor). The recommendation ruleset was
// calibrated against a real ground-truth cohort: a heavily-proctored honest
// control group (the genuine distribution) + a known confirmed copying ring + the
// candidates the organization actually selected. This is a STATIC statement about
// the METHOD's validation (it holds for any contest the method is applied to),
// shown so a reviewer can see WHY the thresholds are trustworthy: honest
// candidates are ~never excluded. No candidate PII is stored here.
export const CALIBRATION = {
  control_cohort: "heavily-proctored honest control group",
  honest_excluded: 0, // every genuinely-selected candidate retained; watch ≠ block
  ring_caught: 9, // every confirmed copying-ring member excluded
  ring_total: 9,
  note:
    "Calibrated so an honest candidate is ~never excluded: only conclusive copying excludes; a single shared medium problem is a desk-check note, never a block.",
};

// Build the FOR / AGAINST case for a candidate — the recommendation as an
// ARGUMENT a reviewer can break, not a bare verdict. FOR = the talent evidence;
// AGAINST = the integrity findings (or an affirmative "no adverse signal").
function buildCase(card, bucket, annotatedFlags) {
  const t = (card && card.talent) || {};
  const forPts = [];
  const score = Number(t.total_score) || 0;
  const maxTotal = Number(t.max_total) || 0;
  if (Number(t.n_solved_full) > 0) forPts.push(`Solved ${t.n_solved_full} problem${t.n_solved_full === 1 ? "" : "s"} fully`);
  if (t.hardest_tier && t.hardest_tier !== "none") forPts.push(`reached ${t.hardest_tier}-difficulty problems`);
  if (Number(t.first_attempt_solves) > 0) forPts.push(`${t.first_attempt_solves} first-attempt solve${t.first_attempt_solves === 1 ? "" : "s"}`);
  if (Array.isArray(t.honest_reach) && t.honest_reach.length) forPts.push(`${t.honest_reach.length} genuine solve arc${t.honest_reach.length === 1 ? "" : "s"} (wrong-tries before accept)`);
  forPts.push(`${score}${maxTotal ? "/" + maxTotal : ""} raw score`);

  const against = [];
  const adverse = (annotatedFlags || []).filter((f) => f && f.code && f.code !== "partial_gamer");
  for (const f of adverse) {
    against.push(f.weak ? `${f.label} (weak signal)` : f.label);
  }
  const gamer = (annotatedFlags || []).find((f) => f && f.code === "partial_gamer");
  if (gamer) against.push(gamer.label);
  if (!against.length) {
    // Honest absence: only claim a conclusive "clean history" when coverage was
    // actually full + high-confidence. With thin/absent capture, say so — a no-
    // signal candidate is "clean on what was recorded", NOT fully cleared. (This
    // is the false-clear guard: the 2026 retyper produces a clean-looking capture,
    // so an unqualified "clean" is exactly the wrong over-trust.)
    const conf = (card && card.coverage && card.coverage.confidence) || "";
    const miss = missingSignals(card);
    if ((conf && conf !== "high") || miss.length) {
      against.push(
        "No adverse signal in the captured streams, but coverage was limited" +
          (miss.length ? ` (thin/absent: ${miss.join(", ")})` : "") +
          " — clean on what was recorded, not a full clearance."
      );
    } else {
      against.push("No adverse signal on any captured stream — clean editor history.");
    }
  }
  if (bucket === BUCKET.HIRE_DESKCHECK && adverse.length) {
    against.push(
      "Why this is a desk-check and not a block: a single weak signal like this is not, on its own, evidence of copying — confirm it in a short desk-check before an offer."
    );
  }
  return { for: forPts, against };
}

// Which captured streams were thin/absent for this candidate (availability made
// VISIBLE, never punitive). Read-time, coverage-level only.
function missingSignals(card) {
  const c = (card && card.coverage) || {};
  const out = [];
  if ((c.editor_events_n || 0) === 0) out.push("editor keystrokes");
  if ((c.shell_events_n || 0) === 0) out.push("proctoring/shell events");
  if ((c.submissions_n || 0) === 0) out.push("submissions");
  return out;
}

// TWIN-PAIRS evidence — the "30-second verifiable" receipt behind an integrity
// exclusion: WHO this candidate shares identical code with, on HOW MANY problems
// (and how many hard), the submit-time gap on the hardest shared problem, and
// same-room corroboration. Built purely from the cross-pass meta
// (recurring_pairs + clusters.exact) + each side's cross_inputs.room. Empty for
// candidates not in any conclusive pair (i.e. every genuine hire).
function peerEvidenceFor(identityKey, meta, byId) {
  const pairs = ((meta && meta.recurring_pairs) || []).filter(
    (p) => p && Array.isArray(p.pair) && p.pair.indexOf(identityKey) !== -1
  );
  if (!pairs.length) return [];
  const exact = (meta && meta.clusters && meta.clusters.exact) || [];
  const roomOf = (id) => (((byId.get(id) || {}).cross_inputs || {}).room) || "";
  const nameOf = (id) => (byId.get(id) || {}).name || id;
  const myRoom = roomOf(identityKey);
  return pairs
    .map((p) => {
      const peer = p.pair[0] === identityKey ? p.pair[1] : p.pair[0];
      // submit-time delta on the hardest shared exact-clone problem
      let hard = null;
      for (const cl of exact) {
        if (cl.hardness !== "hard") continue;
        const me = (cl.members || []).find((m) => m.user === identityKey);
        const them = (cl.members || []).find((m) => m.user === peer);
        if (me && them) {
          hard = {
            problem: cl.ch,
            dt_sec: Math.abs((me.created || 0) - (them.created || 0)),
            i_was_first: (me.created || 0) <= (them.created || 0),
          };
          break;
        }
      }
      const peerRoom = roomOf(peer);
      return {
        peer,
        peer_name: nameOf(peer),
        n_problems: p.n_problems || (p.problems ? p.problems.length : 0),
        n_hard: p.n_hard || 0,
        problems: p.problems || [],
        same_room: !!(myRoom && peerRoom && myRoom === peerRoom),
        room: myRoom || peerRoom || "",
        hard_delta: hard,
      };
    })
    .sort((a, b) => b.n_hard - a.n_hard || b.n_problems - a.n_problems);
}

// Count this card's GENUINE solve arcs across ALL tiers (per_problem entries with
// genuine_arc===true) — the (b) gate for an origin rescue (>=2 real solve arcs).
function genuineArcCount(card) {
  const pp = (card && card.talent && card.talent.per_problem) || {};
  let n = 0;
  for (const k of Object.keys(pp)) {
    if ((pp[k] || {}).genuine_arc === true) n++;
  }
  return n;
}

// How many FOREIGN pastes (code that appeared without being typed = externally
// sourced) this card carries. A genuine origin has ZERO. Robust to a missing list.
function foreignPasteCount(card) {
  const fp = (card && card.integrity && card.integrity.foreign_pastes) || [];
  return Array.isArray(fp) ? fp.length : 0;
}

// Does this card pass the GENUINE-ORIGIN profile gate (independent of submit
// order)? (a) typed it themselves (paste_ratio < 0.12), (b) >=2 genuine solve
// arcs, (c) NO foreign paste. The submit-FIRST requirement is applied per-group
// by the caller. Mirrors the approved origin-rescue plan.
function isGenuineOriginProfile(card) {
  const pasteRatio = Number(card && card.integrity && card.integrity.paste_ratio) || 0;
  return pasteRatio < 0.12 && genuineArcCount(card) >= 2 && foreignPasteCount(card) === 0;
}

// ORIGIN-RESCUE (d): "genuine — their work was copied". For each conclusive clone
// group (meta.clusters.exact, whose members carry `created` submit timestamps) and
// recurring pair (meta.recurring_pairs), rank members by submit time. The EARLIEST
// member who (a) typed it (paste_ratio<0.12), (b) has >=2 genuine arcs, (c) has NO
// foreign paste is a genuine ORIGIN — the identical copies came AFTER them — and is
// rescued from exclude to a SEPARATE visible bucket: talent KEPT, integrity becomes
// a NOTE not a block. If the EARLIEST member has a foreign paste, the whole group is
// externally sourced → NO rescue (everyone stays excluded). Watch-retype copiers
// (later submit / no arc) and external sources stay excluded/held.
//
// Returns Map<identity_key, { copied_by:[id...], chain:"Origin: X (copied by → Y, Z)",
//   group_kind:"cluster"|"recurring_pair", group_label, arcs }>. Pure — no IO.
//
// `byId` resolves member ids → cards (for the profile gate + names). A member id
// with no card (a phantom/peer outside the participant set) can never be a rescued
// origin but DOES count for submit-ordering when it carries a cluster `created`.
function computeOriginRescues(meta, byId) {
  const rescues = new Map();
  const nameOf = (id) => (byId.get(id) || {}).name || id;

  // earliest-submit time per member, derived from every exact cluster they appear
  // in (recurring pairs don't carry timestamps; clusters do). Lower = earlier.
  const exact = (meta && meta.clusters && meta.clusters.exact) || [];
  const firstSeen = new Map();
  for (const cl of exact) {
    for (const m of cl.members || []) {
      if (!m || m.user == null) continue;
      const t = Number(m.created);
      if (!Number.isFinite(t)) continue;
      const prev = firstSeen.get(m.user);
      if (prev == null || t < prev) firstSeen.set(m.user, t);
    }
  }

  // Each "group" is a member-id list with a comparator for submit order. Exact
  // clusters order by the cluster's own per-problem `created`; recurring pairs
  // order by each member's earliest-seen submit time (from firstSeen).
  //
  // PENDING-4(a): origin-rescue must NOT fire on SKELETON-ONLY-differing pairs.
  // Exact CLUSTERS are coreExact-identical by construction (safe). But recurring
  // PAIRS are built from skeleton agreement — a skeleton-only pair (different
  // accepted code, same algorithm shape) is not a copy at all, so it can never
  // have a victim/origin to rescue. We require the pair carry ≥1 byte-identical
  // coreExact shared problem (`n_exact >= 1`) before it forms a rescue group.
  const groups = [];
  for (const cl of exact) {
    const members = (cl.members || [])
      .filter((m) => m && m.user != null)
      .map((m) => ({ user: m.user, t: Number(m.created) }))
      .sort((a, b) => (a.t || 0) - (b.t || 0));
    if (members.length < 2) continue;
    groups.push({ kind: "cluster", label: cl.ch || "", order: members.map((m) => m.user) });
  }
  for (const p of (meta && meta.recurring_pairs) || []) {
    if (!p || !Array.isArray(p.pair) || p.pair.length < 2) continue;
    // PENDING-4(a): skip skeleton-only-differing pairs (no exact match → no copy
    // → nothing to rescue). `n_exact` is the cross-pass enrichment; absent (older
    // meta) → fall back to allowing the pair (no regression on pre-fix data).
    if (p.n_exact != null && Number(p.n_exact) < 1) continue;
    const order = p.pair
      .slice()
      .sort((a, b) => (firstSeen.has(a) ? firstSeen.get(a) : Infinity) - (firstSeen.has(b) ? firstSeen.get(b) : Infinity));
    groups.push({ kind: "recurring_pair", label: (p.problems || []).join(", "), order });
  }

  // PENDING-4(b): a clone group resolves to AT MOST ONE origin — NO mutual origin.
  // A candidate who is a downstream COPIER (a non-earliest member) in ANY group
  // can never also be rescued as an origin. This kills the fragile case where two
  // candidates with byte-identical code each rank "earliest" on a different
  // problem and BOTH get rescued (the substantive-copy pair): if neither is unambiguously
  // first across every shared group, neither is a clean victim and both stay
  // excluded. Build the global copier set first, then only earliest-everywhere
  // members are eligible.
  const everCopier = new Set();
  for (const g of groups) {
    const order = g.order || [];
    for (let i = 1; i < order.length; i++) everCopier.add(order[i]);
  }

  for (const g of groups) {
    const order = g.order;
    if (!order || order.length < 2) continue;
    const earliest = order[0];
    // PENDING-4(b): an origin that is ALSO a copier somewhere is not a clean
    // victim — skip the whole group (no mutual origin).
    if (everCopier.has(earliest)) continue;
    const earliestCard = byId.get(earliest);
    // earliest has a foreign paste (or no card / no profile) → whole group is
    // externally sourced via them → NO rescue; everyone stays excluded.
    if (!earliestCard || !isGenuineOriginProfile(earliestCard)) continue;
    const copiedBy = order.slice(1);
    const chain = `Origin: ${nameOf(earliest)} (copied by → ${copiedBy.map(nameOf).join(", ")})`;
    const existing = rescues.get(earliest);
    if (existing) {
      // same candidate is the genuine origin of more than one group — merge the
      // copier set + keep the richest chain (most copiers). (Still ONE origin per
      // group; this only aggregates that single origin's multiple victims.)
      for (const c of copiedBy) if (existing.copied_by.indexOf(c) === -1) existing.copied_by.push(c);
      if (copiedBy.length > (existing._n || 0)) {
        existing.chain = chain;
        existing._n = copiedBy.length;
      }
    } else {
      rescues.set(earliest, {
        copied_by: copiedBy.slice(),
        chain,
        group_kind: g.kind,
        group_label: g.label,
        arcs: genuineArcCount(earliestCard),
        _n: copiedBy.length,
      });
    }
  }
  return rescues;
}

// Build the full cohort recommendation report from the raw scorecard list (the
// `evaluations` array from GET /api/admin/contest-evaluations). Pure.
//
// Returns:
//   { version, contest_slug, generated_from,
//     counts: { participants, phantoms, ...per-bucket },
//     ranked:        [ enriched, ... ]   // all participants, by talent rank
//     hires:         [ enriched, ... ]   // STRONG_HIRE + HIRE_DESKCHECK, ranked
//     hold, excluded, belowBar:          // the other buckets, ranked
//     missedByRawScore: [ enriched ]     // genuine hires a same-depth RAW-score cut would skip
//     rawScoreTraps:    [ enriched ]     // top raw-score names that are NOT hires (would be wrongly picked)
//   }
// Each enriched entry: { identity_key, name, candidate_id, composite, total_score,
//   max_total, talent_tier, integrity_tier, confidence, bucket, bucket_label,
//   reason, talent_rank, raw_rank, flags:[annotated], one_line }.
export function computeRecommendationReport(evaluations, meta) {
  const cards = Array.isArray(evaluations) ? evaluations : [];
  const participants = cards.filter(isParticipant);
  const phantoms = cards.length - participants.length;
  // peer lookup (names + rooms) for the twin-pairs evidence — built over ALL
  // cards so a peer is resolvable even if it were filtered elsewhere.
  const byId = new Map(cards.map((c) => [c && c.identity_key, c]));

  // ORIGIN-RESCUE (d): genuine solvers who got copied FROM. Computed once over the
  // cross-pass meta; applied per-card below (only overrides an EXCLUDE — integrity
  // still gates everyone else).
  const originRescues = computeOriginRescues(meta, byId);

  const enriched = participants.map((card) => {
    const rec = recommendFor(card);
    const flags = Array.isArray(card.flags) ? card.flags.map(annotateFlag) : [];
    const t = (card && card.talent) || {};
    // RESCUE override: a confirmed/excluded candidate who is the genuine ORIGIN of
    // a clone group (earliest submit + typed it + >=2 arcs + no foreign paste) is
    // reclassified into the SEPARATE visible GENUINE_COPIED bucket — talent KEPT,
    // integrity demoted to a NOTE. Only ever lifts an EXCLUDE; never touches a
    // candidate the integrity gate would otherwise hire/hold/below-bar.
    const rescue = rec.bucket === BUCKET.EXCLUDE_INTEGRITY ? originRescues.get(card.identity_key) : null;
    const bucket = rescue ? BUCKET.GENUINE_COPIED : rec.bucket;
    const reason = rescue
      ? `Genuine solver — their work was copied. ${rescue.chain}. Typed it themselves with ${rescue.arcs} genuine solve arc${rescue.arcs === 1 ? "" : "s"} and no foreign paste, submitted first; integrity flag is a note, not a block.`
      : rec.reason;
    return {
      identity_key: card.identity_key || "",
      name: displayName(card),
      candidate_id: card.candidate_id || card.username_norm || "",
      composite: rec.composite,
      total_score: Number(t.total_score) || 0,
      max_total: Number(t.max_total) || 0,
      n_solved_full: Number(t.n_solved_full) || 0,
      hardest_tier: t.hardest_tier || "none",
      talent_tier: rec.talent_tier,
      integrity_tier: rec.integrity_tier,
      confidence: (card.coverage && card.coverage.confidence) || "",
      missing_signals: missingSignals(card),
      bucket,
      bucket_label: (BUCKET_META[bucket] || {}).label || bucket,
      reason,
      // origin-chain surfaced separately so the rescue is auditable per-person.
      origin_chain: rescue ? rescue.chain : null,
      copied_by: rescue ? rescue.copied_by.slice() : [],
      flags,
      case: buildCase(card, bucket, flags),
      peer_evidence: peerEvidenceFor(card.identity_key, meta, byId),
      // surface the strongest (non-weak) integrity finding first for the dossier header
      top_finding: flags.filter((f) => !f.weak && f.severity === "critical")[0] || null,
      one_line: (card.tiers && card.tiers.one_line) || "",
    };
  });

  // TALENT rank: composite desc, tiebreak raw score desc, then name (stable).
  const ranked = [...enriched].sort(
    (a, b) => b.composite - a.composite || b.total_score - a.total_score || a.name.localeCompare(b.name)
  );
  ranked.forEach((r, i) => (r.talent_rank = i + 1));

  // RAW-score rank: total_score desc, tiebreak composite, then name.
  const byScore = [...enriched].sort(
    (a, b) => b.total_score - a.total_score || b.composite - a.composite || a.name.localeCompare(b.name)
  );
  byScore.forEach((r, i) => (r.raw_rank = i + 1)); // same object refs as `ranked`
  // SHADOW-LEADERBOARD movement: +ve => the integrity-adjusted ranking lifts this
  // candidate ABOVE their raw-score position (genuine work a leaderboard buried);
  // -ve => the leaderboard over-rates them (score inflated by copying/gaming).
  enriched.forEach((r) => (r.rank_delta = r.raw_rank - r.talent_rank));

  const hires = ranked.filter((r) => isHireBucket(r.bucket));
  const genuineCopied = ranked.filter((r) => r.bucket === BUCKET.GENUINE_COPIED);
  const hold = ranked.filter((r) => r.bucket === BUCKET.HOLD_REVIEW);
  const excluded = ranked.filter((r) => r.bucket === BUCKET.EXCLUDE_INTEGRITY);
  const belowBar = ranked.filter((r) => r.bucket === BUCKET.BELOW_BAR);

  // SHORTLIST DEPTH = how many we'd hire = the size of the hire set. The
  // raw-score comparison uses the SAME depth so it is apples-to-apples:
  //   missedByRawScore = genuine hires NOT in the top-`depth` of the raw board
  //                      (talent a leaderboard underrates — copiers/gamers above
  //                      them push them past a naive cut).
  //   rawScoreTraps    = names in the top-`depth` of the raw board that are NOT
  //                      hires (excluded/held/below) — a leaderboard hire would
  //                      WRONGLY pick them. Each carries why_not.
  const depth = hires.length;
  const rawTopIds = new Set(byScore.slice(0, depth).map((r) => r.identity_key));
  const hireIds = new Set(hires.map((r) => r.identity_key));

  const missedByRawScore = hires
    .filter((r) => !rawTopIds.has(r.identity_key))
    .sort((a, b) => a.talent_rank - b.talent_rank);

  const rawScoreTraps = byScore
    .slice(0, depth)
    .filter((r) => !hireIds.has(r.identity_key))
    .map((r) => ({
      ...r,
      why_not:
        r.bucket === BUCKET.EXCLUDE_INTEGRITY
          ? "confirmed copying"
          : r.bucket === BUCKET.GENUINE_COPIED
            ? "genuine solver whose work was copied — surfaced separately, not in the default hire set"
            : r.bucket === BUCKET.HOLD_REVIEW
              ? "needs integrity review (not a confirmed violation)"
              : (r.flags.find((f) => f.code === "partial_gamer") ? "stub-gaming (partial credit, little real solving)" : "talent below bar on genuine work"),
    }));

  const counts = {
    total_docs: cards.length,
    participants: participants.length,
    phantoms,
    strong_hire: enriched.filter((r) => r.bucket === BUCKET.STRONG_HIRE).length,
    hire_deskcheck: enriched.filter((r) => r.bucket === BUCKET.HIRE_DESKCHECK).length,
    solid_hire: enriched.filter((r) => r.bucket === BUCKET.SOLID_HIRE).length,
    genuine_copied: genuineCopied.length,
    hold_review: hold.length,
    exclude_integrity: excluded.length,
    below_bar: belowBar.length,
    hires: hires.length,
  };

  return {
    version: RECOMMEND_VERSION,
    contest_slug: (meta && meta.contest_slug) || (cards[0] && cards[0].contest_slug) || "",
    generated_from: (meta && meta.computed_at) || (cards[0] && cards[0].computed_at) || "",
    calibration: CALIBRATION,
    counts,
    ranked,
    hires,
    genuineCopied,
    hold,
    excluded,
    belowBar,
    missedByRawScore,
    rawScoreTraps,
  };
}
