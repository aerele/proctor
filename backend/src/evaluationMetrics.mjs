// backend/src/evaluationMetrics.mjs
//
// Pure deterministic metric catalog (D1–D17) + tier/composite derivation +
// cross-candidate analysis. Imports ONLY the two sibling pure modules.
//
// Contract: /tmp/eval-contract.md §evaluationMetrics. All D-number constants
// live in the single THRESHOLDS block below, commented with their D-numbers.

import {
  REPLAY,
  collapseWs,
  normalizedLineDistance,
  replaySession,
} from "./evaluationReplay.mjs";
import {
  makeHardness,
  coreExact,
  artifacts,
  provenance,
  analyzeClones,
} from "./evaluationClone.mjs";

export const EVALUATOR_VERSION = "1";

export const THRESHOLDS = {
  // D3 — switch-away → paste correlation window (paste/burst within 10s of episode end).
  AWAY_PASTE_WINDOW_MS: 10000,
  // D4 — typing cadence.
  SUPERHUMAN_CPS: 14, // ≥14 chars/s sustained ⇒ superhuman
  SUPERHUMAN_RUN: 25, // over a run of ≥25 consecutive single-char inserts
  METRONOMIC_CV: 0.15, // coefficient-of-variation < 0.15 ⇒ metronomic (replayer tell)
  METRONOMIC_MIN_KEYS: 40, // over ≥40 keystrokes
  // D10 — zero-effort solve.
  ZERO_EFFORT_ACTIVE_MS: 120000, // active_ms < 120s
  ZERO_EFFORT_TYPED_FRAC: 0.15, // typed_chars < 0.15 × |code|
  // D1 — overall paste ratio flag across scoring problems.
  PASTE_RATIO_FLAG: 0.6,
  // D12 — stub-delta partial gamer.
  STUB_DELTA_LINES: 10,
  // D13 — honest reach.
  REACH_MIN_SUBMITS: 2,
  REACH_MIN_ACTIVE_MS: 600000, // ≥10 min
  REACH_MAX_PASTE: 0.3,
  // D6 — inter-candidate paste-content matching minimum length.
  FOREIGN_PASTE_MATCH_MIN: 80,
  // D2/integrity-confirmed — full-solution foreign paste length.
  FULL_SOLUTION_PASTE_LEN: 300,
  // D16a — silent editor gap while session active (coverage; lowers confidence).
  SILENT_GAP_MS: 300000, // 5 min
  // D16b — replay-vs-submission normalized line distance mismatch.
  MISMATCH: 0.15,
  // D15 — premeditated clipboard: foreign-paste match length.
  CLIPBOARD_MATCH_MIN: 40,
};

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------
export function identityKeyOf(x) {
  if (!x) return "";
  return String(x.person_id || x.username_norm || "");
}

// ---------------------------------------------------------------------------
// D17/D3 — shell away-episodes
// ---------------------------------------------------------------------------
// Returns [{t0, t1, kind}] in ms. Pairs window_blur/visibility(hidden) with the
// next window_focus/visibility(visible)/page_hide-close; treats
// switch_away_episode {duration_ms} as a standalone episode ending at its ts;
// fullscreen_exit with detail.expected!==true as a (zero-width) episode.
export function awayEpisodes(shellEvents) {
  const out = [];
  let openAt = null; // ms when we went away
  for (const ev of shellEvents || []) {
    const ts = Date.parse(ev.timestamp);
    const tsMs = Number.isFinite(ts) ? ts : null;
    const type = ev.type;
    const detail = ev.detail || {};
    const sig = classifyAway(ev);
    if (type === "switch_away_episode") {
      const dur = detail.duration_ms | 0;
      if (tsMs != null) out.push({ t0: tsMs - dur, t1: tsMs, kind: "switch_away_episode" });
      continue;
    }
    if (type === "fullscreen_exit") {
      // expected===true is benign; only count real exits.
      if (detail.expected !== true && tsMs != null) {
        out.push({ t0: tsMs, t1: tsMs, kind: "fullscreen_exit" });
      }
      continue;
    }
    if (sig === "away") {
      if (openAt == null && tsMs != null) openAt = tsMs;
    } else if (sig === "back") {
      if (openAt != null && tsMs != null) {
        out.push({ t0: openAt, t1: tsMs, kind: "blur" });
        openAt = null;
      }
    }
  }
  // Dangling away with no return: close at last event time.
  if (openAt != null) out.push({ t0: openAt, t1: openAt, kind: "blur" });
  return out;
}

function classifyAway(ev) {
  const type = ev.type;
  if (type === "window_blur") return "away";
  if (type === "window_focus") return "back";
  if (type === "page_hide") return "away";
  if (type === "visibility_change") {
    // Contract: detail.state; real data sometimes uses top-level visibility_state.
    const state = (ev.detail && ev.detail.state) || ev.visibility_state;
    return state === "hidden" ? "away" : "back";
  }
  return null;
}

// ---------------------------------------------------------------------------
// D4 — typing cadence
// ---------------------------------------------------------------------------
export function computeCadence(singleCharTsByProblem) {
  const gaps = [];
  const superhuman = [];
  // For metronomic CV, gather the longest run of keystroke gaps across problems.
  let allRunGaps = []; // gaps within runs (used for CV over ≥40 keys)
  for (const pid of Object.keys(singleCharTsByProblem || {})) {
    const ts = (singleCharTsByProblem[pid] || []).slice().sort((a, b) => a - b);
    // Build runs broken by gaps > 2s.
    let runStart = 0;
    for (let i = 1; i <= ts.length; i++) {
      const broken = i === ts.length || ts[i] - ts[i - 1] > 2000;
      if (i < ts.length) {
        const g = ts[i] - ts[i - 1];
        if (g <= 2000) gaps.push(g);
      }
      if (broken) {
        const run = ts.slice(runStart, i);
        if (run.length >= 2) {
          const runGaps = [];
          for (let k = 1; k < run.length; k++) runGaps.push(run[k] - run[k - 1]);
          allRunGaps = allRunGaps.concat(runGaps);
          // Superhuman: ≥25 consecutive single-char inserts at ≥14 chars/s.
          if (run.length >= THRESHOLDS.SUPERHUMAN_RUN) {
            const spanMs = run[run.length - 1] - run[0];
            const cps = spanMs > 0 ? ((run.length - 1) * 1000) / spanMs : Infinity;
            if (cps >= THRESHOLDS.SUPERHUMAN_CPS) {
              superhuman.push({ problem_id: pid, ts: run[0], run_len: run.length, cps: round2(cps) });
            }
          }
        }
        runStart = i;
      }
    }
  }
  const median_ikg_ms = gaps.length ? median(gaps) : 0;
  const p95_ikg_ms = gaps.length ? percentile(gaps, 95) : 0;
  const n_keystrokes = totalKeystrokes(singleCharTsByProblem);
  // Metronomic: CV < 0.15 over ≥40 keystrokes (using run gaps).
  let metronomic = false;
  if (allRunGaps.length >= THRESHOLDS.METRONOMIC_MIN_KEYS - 1) {
    const m = mean(allRunGaps);
    if (m > 0) {
      const sd = stddev(allRunGaps, m);
      const cv = sd / m;
      metronomic = cv < THRESHOLDS.METRONOMIC_CV;
    }
  }
  return {
    median_ikg_ms,
    p95_ikg_ms,
    n_keystrokes,
    superhuman_bursts: superhuman,
    metronomic,
  };
}

function totalKeystrokes(byProblem) {
  let n = 0;
  for (const pid of Object.keys(byProblem || {})) n += (byProblem[pid] || []).length;
  return n;
}

// ---------------------------------------------------------------------------
// D3 — correlate away episodes with pastes/bursts
// ---------------------------------------------------------------------------
export function correlateAwayPastes(pastes, bursts, episodes) {
  const out = [];
  const eps = episodes || [];
  function nearestEpisode(ts) {
    // within 10s after an episode end, OR during an episode → return {after_away_ms}
    let best = null;
    for (const e of eps) {
      if (ts >= e.t0 && ts <= e.t1) {
        // during episode
        return { after_away_ms: 0, episode: e };
      }
      if (ts > e.t1 && ts - e.t1 <= THRESHOLDS.AWAY_PASTE_WINDOW_MS) {
        const d = ts - e.t1;
        if (best == null || d < best.after_away_ms) best = { after_away_ms: d, episode: e };
      }
    }
    return best;
  }
  for (const p of pastes || []) {
    if (p.ts == null) continue;
    const hit = nearestEpisode(p.ts);
    if (hit) out.push({ problem_id: p.problem_id, ts: p.ts, len: p.len, after_away_ms: hit.after_away_ms, kind: "paste" });
  }
  for (const b of bursts || []) {
    if (b.ts == null) continue;
    const hit = nearestEpisode(b.ts);
    if (hit) out.push({ problem_id: b.problem_id, ts: b.ts, len: b.chars, after_away_ms: hit.after_away_ms, kind: "burst" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// D12 — stub-delta (line-level edit distance, raw line count not normalized)
// ---------------------------------------------------------------------------
export function stubDeltaLines(finalCode, stub) {
  const a = String(finalCode == null ? "" : finalCode).split("\n");
  const b = String(stub == null ? "" : stub).split("\n");
  return rawLineLevenshtein(trimTrailingEmpty(a), trimTrailingEmpty(b));
}

function trimTrailingEmpty(lines) {
  const out = lines.slice();
  while (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out;
}

function rawLineLevenshtein(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      cur[j] = Math.min(del, ins, sub);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[m];
}

// ---------------------------------------------------------------------------
// buildScorecard — the per-candidate assembly
// ---------------------------------------------------------------------------
export function buildScorecard(input) {
  const {
    contest_slug,
    identity = {},
    sessions = [],
    submissions = [],
    editorEvents = [],
    shellEvents = [],
    problemPoints = {},
    stubsByProblem = {},
    hardness = () => "easy",
    maxTotal = 0,
    clipboardEntries = [],
  } = input;

  const identity_key = identityKeyOf(identity);
  const session_ids = sessions.map((s) => s.session_id).filter(Boolean);

  // Gather stubs (all problems). extraSelfTexts is intentionally empty here:
  // seeding it with this identity's submission sources would mark a foreign
  // paste benign the moment the candidate submits the pasted code (the
  // submission IS the pasted blob). "Own prior content" / removed-blob history
  // tracked inside replaySession already covers genuine self-moves.
  const allStubs = [];
  for (const pid of Object.keys(stubsByProblem)) {
    for (const s of stubsByProblem[pid] || []) allStubs.push(s);
  }
  const extraSelfTexts = input.extraSelfTexts || [];

  // ---- replay ----
  const replay = replaySession(editorEvents, { stubs: allStubs, extraSelfTexts });

  // ---- away episodes + correlations + cadence ----
  const episodes = awayEpisodes(shellEvents);
  const cadence = computeCadence(replay.single_char_ts_by_problem);
  const awayCorr = correlateAwayPastes(replay.pastes, replay.bursts, episodes);
  const awayCorrByPasteTs = new Map();
  for (const c of awayCorr) {
    if (c.kind === "paste") awayCorrByPasteTs.set(`${c.problem_id}::${c.ts}`, c.after_away_ms);
  }

  // ---- foreign pastes (D2) ----
  const foreign_pastes = [];
  for (const p of replay.pastes) {
    if (!p.foreign) continue;
    const after = awayCorrByPasteTs.has(`${p.problem_id}::${p.ts}`)
      ? awayCorrByPasteTs.get(`${p.problem_id}::${p.ts}`)
      : null;
    foreign_pastes.push({
      problem_id: p.problem_id,
      ts: tsIso(p.ts),
      len: p.len,
      preview: (p.preview || "").slice(0, 200),
      after_away_ms: after,
      truncated: p.truncated === true,
    });
  }

  // ---- per-problem submission stats ----
  const byProblemSubs = new Map();
  for (const s of submissions) {
    const pid = s.problem_id;
    if (!byProblemSubs.has(pid)) byProblemSubs.set(pid, []);
    byProblemSubs.get(pid).push(s);
  }

  // Run/submit counts from replay marks.
  const runCountByProblem = new Map();
  const submitCountByProblem = new Map();
  for (const r of replay.run_marks) inc(runCountByProblem, r.problem_id);
  for (const s of replay.submit_marks) inc(submitCountByProblem, s.problem_id);

  // typed/pasted overall.
  const typedByProblem = replay.typed_chars_by_problem;
  const pastedByProblem = replay.pasted_chars_by_problem;
  let totalTyped = 0;
  let totalPasted = 0;
  for (const k of Object.keys(typedByProblem)) totalTyped += typedByProblem[k] || 0;
  for (const k of Object.keys(pastedByProblem)) totalPasted += pastedByProblem[k] || 0;

  // All problem ids that appear anywhere (submissions, points, replay).
  const allPids = new Set();
  for (const pid of Object.keys(problemPoints)) allPids.add(pid);
  for (const pid of byProblemSubs.keys()) allPids.add(pid);
  for (const pid of Object.keys(replay.problems)) allPids.add(pid);

  const per_problem = {};
  const zero_effort_solves = [];
  const honest_reach = [];
  const first_attempt_solves = [];
  const languagesSet = new Set();
  const flags = [];

  let total_score = 0;
  let gamedPartialPoints = 0; // D12: partial credit earned with a near-stub submit
  let n_solved_full = 0;
  let n_medplus_solved = 0;
  let hardestRank = 0; // 0 none,1 easy,2 med,3 hard
  const tierRank = { none: 0, easy: 1, med: 2, hard: 3 };

  for (const pid of allPids) {
    const subs = (byProblemSubs.get(pid) || []).slice();
    // sort by created_at ascending (caller sorts, but be defensive)
    subs.sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0));
    const maxPoints = problemPoints[pid] != null ? problemPoints[pid] : subForMaxPoints(subs);
    const tier = hardness(pid);

    let best_score = 0;
    let wrong_before_solve = 0;
    let solvedFull = false;
    let firstAcceptIdx = -1;
    const score_climb = [];
    let runningBest = -1;
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i];
      if (s.language) languagesSet.add(s.language);
      const sc = num(s.score);
      if (sc > best_score) best_score = sc;
      if (sc > runningBest) {
        if (runningBest >= 0) score_climb.push(sc);
        else score_climb.push(sc);
        runningBest = sc;
      }
      const accepted = s.verdict === "accepted";
      if (accepted && firstAcceptIdx < 0) firstAcceptIdx = i;
      if (!accepted && firstAcceptIdx < 0) wrong_before_solve += 1;
      if (accepted && num(s.max_points || maxPoints) > 0 && sc >= num(s.max_points || maxPoints)) {
        solvedFull = true;
      }
    }
    // best_score caps at maxPoints if maxPoints known.
    const effMax = num(maxPoints);
    if (effMax > 0 && best_score >= effMax) solvedFull = true;

    const active_ms = replay.active_ms_by_problem[pid] || 0;
    const typed = typedByProblem[pid] || 0;
    const pasted = pastedByProblem[pid] || 0;
    const paste_ratio = pasted / Math.max(1, typed + pasted);
    const runs = runCountByProblem.get(pid) || 0;
    const submitsReplay = submitCountByProblem.get(pid) || 0;
    const submits = submitsReplay > 0 ? submitsReplay : subs.length;

    // stub-delta: min across this problem's stubs.
    const finalContent = replay.problems[pid] ? replay.problems[pid].final_content : "";
    const fallbackFinal = finalContent || (subs.length ? subs[subs.length - 1].source_code || "" : "");
    let stub_delta_lines = null;
    const stubs = stubsByProblem[pid] || [];
    if (stubs.length && (fallbackFinal || finalContent)) {
      let mn = Infinity;
      for (const st of stubs) {
        const d = stubDeltaLines(fallbackFinal, st);
        if (d < mn) mn = d;
      }
      stub_delta_lines = Number.isFinite(mn) ? mn : null;
    }

    // |code| for D10 = the size of the submitted solution (the work the score
    // represents), preferring the accepted source, then the largest submission,
    // then the replayed final state.
    const acceptedSub = subs.find((s) => s.verdict === "accepted");
    const codeLen =
      (acceptedSub && (acceptedSub.source_code || "").length) ||
      maxSubLen(subs) ||
      (fallbackFinal || "").length;

    // genuine_arc
    const typedMajority = typed >= pasted;
    const zeroEffort =
      solvedFull &&
      tier !== "easy" &&
      active_ms < THRESHOLDS.ZERO_EFFORT_ACTIVE_MS &&
      typed < THRESHOLDS.ZERO_EFFORT_TYPED_FRAC * Math.max(1, codeLen);
    const genuine_arc =
      solvedFull &&
      paste_ratio < 0.5 &&
      !zeroEffort &&
      (wrong_before_solve >= 1 || runs >= 2 || typedMajority);

    if (zeroEffort) {
      zero_effort_solves.push(pid);
      flags.push({
        code: "zero_effort_solve",
        severity: "critical",
        problem_id: pid,
        evidence: `Accepted ${tier} solve with only ${active_ms}ms active editing and ${typed} typed chars (code ${codeLen} chars).`,
      });
    }

    // D12 partial gamer. Severity "info" (v1 default, KPR 2026-06-12 review):
    // gaming partial credit off a near-stub submit is a TALENT honesty signal
    // (the KEC gem-gamer lesson) — it discounts the composite below and gates
    // honest-reach, but it is not cheating evidence, so it must not drag the
    // orthogonal integrity axis to "watch" on its own.
    if (best_score > 0 && effMax > 0 && best_score < effMax && stub_delta_lines != null && stub_delta_lines < THRESHOLDS.STUB_DELTA_LINES) {
      gamedPartialPoints += best_score;
      flags.push({
        code: "partial_gamer",
        severity: "info",
        problem_id: pid,
        evidence: `Partial score ${best_score}/${effMax} with only ${stub_delta_lines} lines changed from stub.`,
      });
    }

    // D13 honest reach (unsolved problem, real reach)
    if (!solvedFull && submits >= THRESHOLDS.REACH_MIN_SUBMITS && active_ms >= THRESHOLDS.REACH_MIN_ACTIVE_MS && paste_ratio < THRESHOLDS.REACH_MAX_PASTE) {
      honest_reach.push(pid);
    }

    // D14 first-attempt solves: first submit accepted with no prior failed run/submit.
    if (firstAcceptIdx === 0 && wrong_before_solve === 0 && (subs[0] && subs[0].verdict === "accepted")) {
      first_attempt_solves.push(pid);
    }

    if (solvedFull) {
      n_solved_full += 1;
      if (tier === "med" || tier === "hard") n_medplus_solved += 1;
      if (tierRank[tier] > hardestRank) hardestRank = tierRank[tier];
    }
    total_score += best_score;

    per_problem[pid] = {
      best_score,
      max_points: effMax,
      active_ms,
      runs,
      submits,
      wrong_before_solve,
      score_climb,
      paste_ratio: round4(paste_ratio),
      stub_delta_lines,
      genuine_arc,
      // _tier: difficulty bucket of this problem, used by tier recount in
      // deriveTiers (survives JSON round-trip so applyCrossPatches can recompute).
      _tier: tier,
    };
  }

  const hardest_tier = hardestRank === 0 ? "none" : invTier(hardestRank);

  // overall paste ratio across scoring problems (problems with maxPoints>0).
  let scoringTyped = 0;
  let scoringPasted = 0;
  for (const pid of allPids) {
    if (num(problemPoints[pid]) > 0 || (per_problem[pid] && per_problem[pid].max_points > 0)) {
      scoringTyped += typedByProblem[pid] || 0;
      scoringPasted += pastedByProblem[pid] || 0;
    }
  }
  const overallScoringPasteRatio = scoringPasted / Math.max(1, scoringTyped + scoringPasted);
  const paste_ratio = totalPasted / Math.max(1, totalTyped + totalPasted);

  if (overallScoringPasteRatio > THRESHOLDS.PASTE_RATIO_FLAG) {
    flags.push({
      code: "high_paste_ratio",
      severity: "critical",
      problem_id: null,
      evidence: `Overall paste ratio ${round2(overallScoringPasteRatio)} across scoring problems exceeds ${THRESHOLDS.PASTE_RATIO_FLAG}.`,
    });
  }

  // ---- D2 foreign-paste flags ----
  for (const fp of foreign_pastes) {
    const afterAway = fp.after_away_ms != null;
    if (afterAway) {
      flags.push({
        code: "foreign_paste_after_away",
        severity: "critical",
        problem_id: fp.problem_id,
        evidence: `Foreign paste of ${fp.len} chars ${fp.after_away_ms}ms after a switch-away episode.`,
      });
    } else {
      flags.push({
        code: "foreign_paste",
        severity: "warning",
        problem_id: fp.problem_id,
        evidence: `Foreign paste of ${fp.len} chars not seen earlier in this session.`,
      });
    }
  }

  // ---- D4 cadence flags ----
  if (cadence.superhuman_bursts.length) {
    const b = cadence.superhuman_bursts[0];
    flags.push({
      code: "superhuman_cadence",
      severity: "warning",
      problem_id: b.problem_id,
      evidence: `Run of ${b.run_len} keystrokes at ${b.cps} chars/s (≥${THRESHOLDS.SUPERHUMAN_CPS}).`,
    });
  }
  if (cadence.metronomic) {
    flags.push({
      code: "metronomic_cadence",
      severity: "warning",
      problem_id: null,
      evidence: `Keystroke inter-key gaps show CV<${THRESHOLDS.METRONOMIC_CV} over ≥${THRESHOLDS.METRONOMIC_MIN_KEYS} keys (replayer-like).`,
    });
  }

  // ---- D9 artifacts + provenance over submission sources ----
  const artifactsAgg = {};
  const provenanceHits = [];
  for (const s of submissions) {
    const code = s.source_code || "";
    if (!code) continue;
    for (const a of artifacts(code)) artifactsAgg[a] = (artifactsAgg[a] || 0) + 1;
    for (const p of provenance(code)) provenanceHits.push({ problem_id: s.problem_id, name: p });
  }

  // ---- D16b replay-vs-submission mismatch ----
  const replay_mismatches = [];
  let telemetry_tampered = false;
  const editorCoveragePresent = replay.events_n > 0;
  // Problems that actually have editor events (for the zero-coverage exclusion).
  const problemsWithEvents = new Set(Object.keys(replay.problems));
  for (const s of submissions) {
    const pid = s.problem_id;
    const src = s.source_code || "";
    if (!src) continue;
    const subTs = Date.parse(s.created_at || 0);
    // nearest snapshot for this problem within ±120s
    let best = null;
    for (const snap of replay.submit_snapshots) {
      if (snap.problem_id !== pid) continue;
      if (snap.ts == null) continue;
      const dt = Math.abs(snap.ts - subTs);
      if (dt <= 120000 && (best == null || dt < best.dt)) best = { snap, dt };
    }
    if (!best) continue;
    // accept exact collapsed equality
    const snapCollapsed = collapseWs(best.snap.content);
    if (snapCollapsed === collapseWs(src)) continue;
    const dist = normalizedLineDistance(best.snap.content, src);
    if (dist > THRESHOLDS.MISMATCH) {
      // EMPTY-SNAPSHOT GUARD (KPR 2026-06-12): a near-empty replayed buffer
      // means the base content (the pre-seeded stub) was never captured — the
      // candidate barely touched this problem and the capture has no base to
      // replay. Telemetry suppression cannot produce this shape (suppression
      // removes the events; here the events exist but the base doesn't), so a
      // mismatch against a near-empty snapshot is coverage, never tamper.
      const substantive = snapCollapsed.length >= 30;
      replay_mismatches.push({ problem_id: pid, submission_id: s._id || null, distance: round4(dist), ts: tsIso(best.snap.ts), snapshot_empty: !substantive });
    }
  }
  // ≥1 mismatch with editor coverage present ⇒ telemetry_tampered (critical).
  // BUT no mismatch flag when the problem has zero editor events.
  // GLITCH GATE (real-data hardening, KPR 2026-06-12): some sessions never
  // capture the initial stub load (Monaco init race / mid-session reload
  // restoring a draft without events), so the replay reconstructs keystroke
  // deltas over the wrong base — every snapshot then "mismatches" at 0.85+
  // while the candidate did nothing wrong. Those replays self-identify via
  // glitches > 0 (range/deletedLen disagreement during apply). A mismatch is
  // TAMPER EVIDENCE only when this problem's replay was glitch-free; glitchy
  // mismatches degrade coverage/confidence instead (plan D16c: telemetry
  // problems lower confidence, never raise a cheat flag alone).
  const glitchFree = (pid) => (replay.problems[pid]?.glitches || 0) === 0;
  const realMismatches = replay_mismatches.filter((m) => problemsWithEvents.has(m.problem_id) && glitchFree(m.problem_id) && !m.snapshot_empty);
  if (realMismatches.length && editorCoveragePresent) {
    telemetry_tampered = true;
    flags.push({
      code: "telemetry_tampered",
      severity: "critical",
      problem_id: realMismatches[0].problem_id,
      evidence: `Submitted code differs from replayed editor state (line-distance ${realMismatches[0].distance}>${THRESHOLDS.MISMATCH}).`,
    });
  }

  // ---- D15 premeditated clipboard ----
  let premeditated_clipboard = false;
  const firstForeign = replay.pastes.find((p) => p.foreign && collapseWs(p.text).length >= THRESHOLDS.CLIPBOARD_MATCH_MIN);
  if (firstForeign) {
    const fc = collapseWs(firstForeign.text);
    for (const entry of clipboardEntries || []) {
      const ce = collapseWs(entry);
      if (ce.length < THRESHOLDS.CLIPBOARD_MATCH_MIN) continue;
      if (ce.includes(fc) || fc.includes(ce)) {
        premeditated_clipboard = true;
        break;
      }
    }
  }
  if (premeditated_clipboard) {
    flags.push({
      code: "premeditated_clipboard",
      severity: "critical",
      problem_id: firstForeign ? firstForeign.problem_id : null,
      evidence: `Entry-clipboard snapshot matches the first foreign paste (premeditated).`,
    });
  }

  // ---- integrity rollups (D17) ----
  const tab_away_total_ms = episodes.reduce((a, e) => a + Math.max(0, e.t1 - e.t0), 0);
  const away_episode_count = episodes.length;
  let fullscreen_violations = countFullscreenViolations(shellEvents);
  if (fullscreen_violations === 0) {
    fullscreen_violations = Math.max(0, ...sessions.map((s) => num(s.fullscreen_exit_count)), 0);
  }
  const ip_change_count = Math.max(0, ...sessions.map((s) => num(s.ip_change_count)), 0);

  // ---- talent composite + tiers ----
  const composite = computeComposite({
    total_score,
    gamedPartialPoints,
    maxTotal,
    per_problem,
    problemPoints,
    hardness,
    allPids,
    n_solved_full,
    honest_reach,
  });

  // away_paste_correlations output (D3) for integrity block.
  const away_paste_correlations = awayCorr.map((c) => ({
    problem_id: c.problem_id,
    ts: tsIso(c.ts),
    len: c.len,
    after_away_ms: c.after_away_ms,
    kind: c.kind,
  }));

  // ---- coverage / confidence ----
  const coverage = computeCoverage({
    editorEvents,
    shellEvents,
    submissions,
    sessions,
    replay,
  });
  // Glitch-gated mismatches (see D16b above): replay base was wrong for these
  // problems — record as coverage gaps so confidence drops instead of a flag.
  const glitchyMismatchPids = [...new Set(replay_mismatches
    .filter((m) => (replay.problems[m.problem_id]?.glitches || 0) > 0 || m.snapshot_empty)
    .map((m) => m.problem_id))];
  for (const pid of glitchyMismatchPids) {
    coverage.gaps.push(`replay_base_unreliable:${pid}`);
  }
  if (coverage.gaps.length > 2) coverage.confidence = "low";
  else if (coverage.gaps.length > 0 && coverage.confidence === "high") coverage.confidence = "medium";

  // ---- tiers ----
  const integrity = {
    typed_chars: totalTyped,
    pasted_chars: totalPasted,
    paste_ratio: round4(paste_ratio),
    foreign_pastes,
    away_paste_correlations,
    cadence,
    zero_effort_solves,
    clone_cluster_refs: [],
    recurring_pair_refs: [],
    paste_match_edges: [],
    artifacts: artifactsAgg,
    provenance_hits: provenanceHits,
    tab_away_total_ms,
    away_episode_count,
    fullscreen_violations,
    ip_change_count,
    replay_mismatches,
    telemetry_tampered,
  };

  const talent = {
    composite,
    total_score,
    max_total: maxTotal,
    n_solved_full,
    n_medplus_solved,
    hardest_tier,
    per_problem,
    honest_reach,
    first_attempt_solves,
    languages: [...languagesSet],
  };

  // cross_inputs for the cross-candidate pass (kept small & bounded).
  const cross_inputs = buildCrossInputs({
    foreign_pastes: replay.pastes.filter((p) => p.foreign),
    replay,
    sessions,
    submissions,
    allPids,
    stubsByProblem,
  });

  const derived = deriveTiers({ flags, talent, integrity });

  return {
    schema_version: 1,
    evaluator_version: EVALUATOR_VERSION,
    computed_at: new Date().toISOString(),
    contest_slug,
    person_id: identity.person_id != null ? identity.person_id : null,
    username_norm: identity.username_norm || null,
    candidate_id: identity.candidate_id || null,
    name: identity.name || null,
    identity_key,
    session_ids,
    coverage,
    talent: { ...talent, composite: derived.composite },
    integrity,
    flags,
    tiers: derived.tiers,
    llm: { judgments_pending: [], verdicts: {} },
    recommended_action: null,
    cross_inputs,
  };
}

// ---------------------------------------------------------------------------
// composite + tiers
// ---------------------------------------------------------------------------
// composite = round(55*score_frac + 20*hardness_frac + 15*genuine_frac + 10*reach_frac)
//   score_frac    = total/maxTotal
//   hardness_frac = Σweight(solved-full)/Σweight(all problems), easy=1 med=2 hard=4
//   genuine_frac  = genuine-arc full-solves / max(1, n_solved_full)
//   reach_frac    = min(1, honest_reach/2)
// integrity confirmed ⇒ composite = min(composite, 20).
const TIER_WEIGHT = { easy: 1, med: 2, hard: 4 };
function computeComposite({ total_score, gamedPartialPoints = 0, maxTotal, per_problem, problemPoints, hardness, allPids, n_solved_full, honest_reach }) {
  // KEC gem-gamer discount (v1, KPR 2026-06-12 review): partial points earned
  // on partial_gamer-flagged problems (near-stub submits) are not talent
  // evidence — exclude them from score_frac so a 7-problem stub-gamer cannot
  // outrank a genuine 2-problem solver on the composite.
  const score_frac = maxTotal > 0 ? Math.max(0, total_score - gamedPartialPoints) / maxTotal : 0;
  let weightAll = 0;
  let weightSolved = 0;
  for (const pid of allPids) {
    const w = TIER_WEIGHT[hardness(pid)] || 1;
    // count problems that are scoring (have points) for the denominator.
    const isScoring = num(problemPoints[pid]) > 0 || (per_problem[pid] && per_problem[pid].max_points > 0);
    if (isScoring) weightAll += w;
    const pp = per_problem[pid];
    if (pp && pp.max_points > 0 && pp.best_score >= pp.max_points) weightSolved += w;
  }
  const hardness_frac = weightAll > 0 ? weightSolved / weightAll : 0;
  let genuineSolves = 0;
  for (const pid of allPids) {
    const pp = per_problem[pid];
    if (pp && pp.genuine_arc) genuineSolves += 1;
  }
  const genuine_frac = genuineSolves / Math.max(1, n_solved_full);
  const reach_frac = Math.min(1, honest_reach.length / 2);
  return Math.round(55 * score_frac + 20 * hardness_frac + 15 * genuine_frac + 10 * reach_frac);
}

function deriveTiers({ flags, talent, integrity }) {
  const hasCode = (c) => flags.some((f) => f.code === c);
  const criticalFlags = flags.filter((f) => f.severity === "critical");
  const warningFlags = flags.filter((f) => f.severity === "warning");

  // integrity tier
  let integrityTier = "clean";
  // confirmed ⇔ conclusive recurring pair OR telemetry_tampered OR full-solution
  // foreign-paste after-away on an accepted problem. (Recurring-pair confirmation
  // is injected by applyCrossPatches; here we read the integrity flags.)
  const conclusiveRecurring = hasCode("recurring_pair_conclusive");
  const fullSolnAfterAway = integrity.foreign_pastes.some(
    (fp) => fp.after_away_ms != null && fp.len >= THRESHOLDS.FULL_SOLUTION_PASTE_LEN
  );
  if (conclusiveRecurring || integrity.telemetry_tampered || fullSolnAfterAway) {
    integrityTier = "confirmed";
  } else if (criticalFlags.length > 0) {
    integrityTier = "flag";
  } else if (warningFlags.length > 0) {
    integrityTier = "watch";
  } else {
    integrityTier = "clean";
  }

  // talent tier
  // strong ⇔ ≥1 hard OR ≥2 med solved with genuine arcs; moderate ⇔ ≥1 med+
  // genuine OR strong_gem; else weak.
  const genuineHard = countGenuine(talent, "hard");
  const genuineMed = countGenuine(talent, "med");
  const genuineMedPlus = genuineHard + genuineMed;
  const strongGem = hasCode("strong_gem");
  let talentTier = "weak";
  if (genuineHard >= 1 || genuineMed >= 2) talentTier = "strong";
  else if (genuineMedPlus >= 1 || strongGem) talentTier = "moderate";
  else talentTier = "weak";

  // GATE: confirmed integrity ⇒ talent forced weak + composite ≤20.
  let composite = talent.composite;
  if (integrityTier === "confirmed") {
    talentTier = "weak";
    composite = Math.min(composite, 20);
  }

  const one_line = buildOneLine({ talentTier, integrityTier, talent, integrity, flags, composite });

  return {
    tiers: { talent: talentTier, integrity: integrityTier, one_line },
    composite,
  };
}

function countGenuine(talent, tier) {
  let n = 0;
  // We rely on hardest tracking via per_problem; tier mapping is via the talent
  // hardest_tier and per-problem. We re-derive per-problem tier by max_points
  // not directly available — but genuine_arc already implies full solve; the
  // tier per problem we infer from the scorecard's per_problem only via a parallel
  // map. To keep this pure, we recompute using the hardness passed at build time
  // — but deriveTiers has no hardness fn. Instead, count genuine arcs and trust
  // the caller's tier bucketing recorded on per_problem via `_tier`.
  for (const pid of Object.keys(talent.per_problem)) {
    const pp = talent.per_problem[pid];
    if (pp && pp.genuine_arc && pp._tier === tier) n += 1;
  }
  return n;
}

function buildOneLine({ talentTier, integrityTier, talent, integrity, flags, composite }) {
  const crit = flags.filter((f) => f.severity === "critical").length;
  const warn = flags.filter((f) => f.severity === "warning").length;
  const parts = [];
  parts.push(`talent=${talentTier}(${composite})`);
  parts.push(`integrity=${integrityTier}`);
  parts.push(`solved=${talent.n_solved_full}/${Object.keys(talent.per_problem).length}`);
  parts.push(`paste=${Math.round(integrity.paste_ratio * 100)}%`);
  if (crit) parts.push(`${crit} critical`);
  if (warn) parts.push(`${warn} warning`);
  const top = flags.find((f) => f.severity === "critical") || flags.find((f) => f.severity === "warning");
  if (top) parts.push(top.code);
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// coverage / confidence
// ---------------------------------------------------------------------------
function computeCoverage({ editorEvents, shellEvents, submissions, sessions, replay }) {
  const editor_events_n = editorEvents.length;
  const shell_events_n = shellEvents.length;
  const submissions_n = submissions.length;
  const sessions_n = sessions.length;
  const gaps = [];
  // D16a: >5min silent editor stream while a session is active. Approximate by
  // scanning consecutive editor-event gaps inside the active span.
  let prev = null;
  for (const ev of editorEvents) {
    const ts = Date.parse(ev.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (prev != null && ts - prev > THRESHOLDS.SILENT_GAP_MS) {
      gaps.push({ from: tsIso(prev), to: tsIso(ts), ms: ts - prev });
    }
    prev = ts;
  }
  let confidence;
  if (editor_events_n === 0 || gaps.length > 2) confidence = "low";
  else if (editor_events_n > 0 && gaps.length === 0) confidence = "high";
  else confidence = "medium";
  return { editor_events_n, shell_events_n, submissions_n, sessions_n, gaps, confidence };
}

// ---------------------------------------------------------------------------
// cross_inputs
// ---------------------------------------------------------------------------
function buildCrossInputs({ foreign_pastes, replay, sessions, submissions, allPids, stubsByProblem = {} }) {
  const foreign_paste_texts = [];
  for (const p of foreign_pastes) {
    const t = collapseWs(p.text).slice(0, 500);
    if (t) foreign_paste_texts.push(t);
    if (foreign_paste_texts.length >= 20) break;
  }
  const final_content_norms = {};
  for (const pid of Object.keys(replay.problems)) {
    final_content_norms[pid] = coreExact(replay.problems[pid].final_content || "").slice(0, 20000);
  }
  // accepted_norms: coreExact of ACCEPTED submitted sources per problem (the
  // authoritative text for cross-candidate clone matching — replay-derived
  // final_content_norms can be desynced when the initial stub load was never
  // captured; submitted source never is). Bounded: ≤3 per problem.
  const accepted_norms = {};
  for (const s of submissions) {
    if (s.verdict !== "accepted") continue;
    const src = s.source_code || "";
    if (!src) continue;
    const norm = coreExact(src).slice(0, 20000);
    if (norm.length < 15) continue;
    if (!accepted_norms[s.problem_id]) accepted_norms[s.problem_id] = [];
    if (accepted_norms[s.problem_id].length < 3) accepted_norms[s.problem_id].push(norm);
  }
  // failed_norms: coreExact of non-accepted submission sources per problem.
  // NEAR-STUB EXCLUSION (real-data hardening, KPR 2026-06-12): unmodified or
  // barely-modified stubs and trivial one-line guesses converge across many
  // honest candidates (5-person "clusters" of the bare java stub; a 7-person
  // cluster of `return n-k;`). Identical FAILED code is only low-FP copying
  // evidence when the shared code is substantive — i.e. meaningfully diverged
  // from every stub (line-delta ≥ STUB_DELTA_LINES, the same threshold D12
  // uses to call something "still the stub").
  const failed_norms = {};
  for (const s of submissions) {
    if (s.verdict === "accepted") continue;
    const src = s.source_code || "";
    if (!src) continue;
    const norm = coreExact(src);
    if (norm.length < 15) continue;
    const stubs = stubsByProblem[s.problem_id] || [];
    const nearStub = stubs.some((stub) => stubDeltaLines(src, stub) < THRESHOLDS.STUB_DELTA_LINES);
    if (nearStub) continue;
    if (!failed_norms[s.problem_id]) failed_norms[s.problem_id] = [];
    failed_norms[s.problem_id].push(norm);
  }
  const room = sessions.length ? sessions[0].room || "" : "";
  const ips = [];
  for (const s of sessions) {
    if (s.start_ip) ips.push(s.start_ip);
    if (s.current_ip && s.current_ip !== s.start_ip) ips.push(s.current_ip);
  }
  const submit_times = [];
  for (const s of submissions) {
    submit_times.push({ problem_id: s.problem_id, ts: s.created_at || null, verdict: s.verdict || null });
  }
  return { foreign_paste_texts, final_content_norms, accepted_norms, failed_norms, room, ips, submit_times };
}

// ---------------------------------------------------------------------------
// fullscreen / helpers
// ---------------------------------------------------------------------------
function countFullscreenViolations(shellEvents) {
  let n = 0;
  for (const ev of shellEvents || []) {
    if (ev.type === "fullscreen_exit" && !(ev.detail && ev.detail.expected === true)) n += 1;
  }
  return n;
}

function inc(map, k) {
  map.set(k, (map.get(k) || 0) + 1);
}
function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function subForMaxPoints(subs) {
  let mx = 0;
  for (const s of subs) mx = Math.max(mx, num(s.max_points));
  return mx;
}
function maxSubLen(subs) {
  let mx = 0;
  for (const s of subs) mx = Math.max(mx, (s.source_code || "").length);
  return mx;
}
function invTier(rank) {
  return rank === 3 ? "hard" : rank === 2 ? "med" : rank === 1 ? "easy" : "none";
}
function tsIso(ms) {
  if (ms == null) return null;
  return new Date(ms).toISOString();
}
function round2(x) {
  return Math.round(x * 100) / 100;
}
function round4(x) {
  return Math.round(x * 10000) / 10000;
}
function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const n = a.length;
  if (n === 0) return 0;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}
function percentile(arr, p) {
  const a = arr.slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const idx = Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1);
  return a[Math.max(0, idx)];
}
function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const x of arr) s += x;
  return s / arr.length;
}
function stddev(arr, m) {
  if (arr.length < 2) return 0;
  let s = 0;
  for (const x of arr) s += (x - m) * (x - m);
  return Math.sqrt(s / arr.length);
}

// ===========================================================================
// CROSS-CANDIDATE ANALYSIS
// ===========================================================================
export function crossCandidateAnalysis({ candidates, problems }) {
  const problemList = problems || [];
  // hardness from accepted-solver counts.
  const solvedCount = new Map();
  for (const c of candidates) {
    const accepted = new Set();
    for (const s of c.submissions || []) {
      if (s.verdict === "accepted") accepted.add(s.problem_id);
    }
    for (const pid of accepted) solvedCount.set(pid, (solvedCount.get(pid) || 0) + 1);
  }
  const challenges = problemList.map((p) => ({ slug: p.problem_id || p.slug, solved: solvedCount.get(p.problem_id || p.slug) || 0 }));
  // ensure every pid referenced has a challenge entry
  const challengeSet = new Set(challenges.map((c) => c.slug));
  for (const pid of solvedCount.keys()) {
    if (!challengeSet.has(pid)) {
      challenges.push({ slug: pid, solved: solvedCount.get(pid) || 0 });
      challengeSet.add(pid);
    }
  }
  const hardness = makeHardness(challenges);
  const hardnessMap = {};
  for (const c of challenges) hardnessMap[c.slug] = hardness(c.slug);

  // ---- adapt to analyzeClones meta over ACCEPTED submissions ----
  const subsMeta = [];
  const codeMap = new Map();
  let sid = 0;
  // contest start = earliest submission time, for tfs (minutes from start).
  let contestStart = Infinity;
  for (const c of candidates) {
    for (const s of c.submissions || []) {
      const t = Date.parse(s.created_at || 0);
      if (Number.isFinite(t)) contestStart = Math.min(contestStart, t);
    }
  }
  if (!Number.isFinite(contestStart)) contestStart = 0;

  // leaderboard: sort identities by total score desc.
  const totals = candidates.map((c) => ({
    user: c.identityKey,
    total: candidateTotalScore(c),
  }));
  totals.sort((a, b) => b.total - a.total);
  const leaderboard = totals.map((t, i) => ({ user: t.user, rank: i + 1 }));

  for (const c of candidates) {
    for (const s of c.submissions || []) {
      const id = `s${sid++}`;
      const created = Math.floor((Date.parse(s.created_at || 0) || 0) / 1000);
      const tfs = Number.isFinite(Date.parse(s.created_at || 0))
        ? (Date.parse(s.created_at) - contestStart) / 60000
        : null;
      subsMeta.push({
        id,
        user: c.identityKey,
        ch: s.problem_id,
        status: s.verdict === "accepted" ? "Accepted" : "Wrong Answer",
        score: num(s.score),
        tfs,
        created,
        lang: s.language || null,
      });
      codeMap.set(id, s.source_code || "");
    }
  }

  const meta = { submissions: subsMeta, challenges, leaderboard };
  const clone = analyzeClones(meta, codeMap);

  // ---- failed-submission clustering (non-accepted, coreExact len≥15) ----
  const failedClusters = computeFailedClusters(candidates, hardness);

  // ---- D6 paste-match edges ----
  const paste_match_edges = computePasteMatchEdges(candidates);

  // ---- D8/N9 tight annotation + submit clusters ----
  const roomByKey = new Map();
  const ipsByKey = new Map();
  for (const c of candidates) {
    roomByKey.set(c.identityKey, (c.room || "").trim());
    ipsByKey.set(c.identityKey, c.ips || []);
  }
  const tightAnnotated = (clone.tight || []).map((t) => {
    const ra = roomByKey.get(t.a) || "";
    const rb = roomByKey.get(t.b) || "";
    const same_room = !!ra && ra === rb;
    const same_ip_prefix = ipPrefixOverlap(ipsByKey.get(t.a) || [], ipsByKey.get(t.b) || []);
    return { ...t, same_room, same_ip_prefix };
  });

  const submit_clusters = computeSubmitClusters(candidates, hardness, roomByKey);

  // ---- patches per identity ----
  const patches = new Map();
  for (const c of candidates) patches.set(c.identityKey, emptyPatch());

  // clone cluster refs (exact + skeleton)
  attachClusterRefs(patches, clone.exact_clusters, "exact", hardnessMap);
  attachClusterRefs(patches, clone.skeleton_clusters, "skeleton", hardnessMap);
  attachFailedClusterRefs(patches, failedClusters);

  // recurring pairs
  for (const rp of clone.recurring_pairs || []) {
    const conclusive = rp.n_problems >= 2 || rp.n_hard >= 1;
    const [a, b] = rp.pair;
    attachRecurringRef(patches, a, b, rp, conclusive);
    attachRecurringRef(patches, b, a, rp, conclusive);
  }

  // paste-match edges (recipient gets a directed_paste_match flag)
  for (const e of paste_match_edges) {
    const pTo = patches.get(e.to);
    if (pTo) pTo.paste_match_edges.push(e);
    const pFrom = patches.get(e.from);
    if (pFrom) pFrom.paste_match_edges.push(e);
  }

  // tight refs
  for (const t of tightAnnotated) {
    pushTight(patches, t.a, t);
    pushTight(patches, t.b, t);
  }

  // ---- derive flags + escalation per patch ----
  for (const [key, patch] of patches) {
    deriveCrossFlags(key, patch);
  }

  const meta_doc = {
    schema_version: 1,
    evaluator_version: EVALUATOR_VERSION,
    contest_slug: candidates.length ? candidates[0].scorecard?.contest_slug : null,
    computed_at: new Date().toISOString(),
    hardness: hardnessMap,
    clusters: {
      exact: clone.exact_clusters,
      skeleton: clone.skeleton_clusters,
      failed: failedClusters,
    },
    recurring_pairs: clone.recurring_pairs,
    tight: tightAnnotated,
    paste_match_edges,
    submit_clusters,
    cohort: buildCohort(candidates),
  };

  return { meta: meta_doc, patches };
}

function emptyPatch() {
  return {
    clone_cluster_refs: [],
    recurring_pair_refs: [],
    paste_match_edges: [],
    tight_refs: [],
    flags: [],
    integrity_escalation: null,
  };
}

function candidateTotalScore(c) {
  // prefer scorecard total_score; else sum best score per problem.
  if (c.scorecard && c.scorecard.talent && typeof c.scorecard.talent.total_score === "number") {
    return c.scorecard.talent.total_score;
  }
  const best = new Map();
  for (const s of c.submissions || []) {
    best.set(s.problem_id, Math.max(best.get(s.problem_id) || 0, num(s.score)));
  }
  let t = 0;
  for (const v of best.values()) t += v;
  return t;
}

function attachClusterRefs(patches, clusters, kind, hardnessMap) {
  for (const g of clusters || []) {
    const users = [...new Set(g.members.map((m) => m.user))];
    for (const u of users) {
      const patch = patches.get(u);
      if (!patch) continue;
      const others = users.filter((x) => x !== u);
      patch.clone_cluster_refs.push({
        problem_id: g.ch,
        kind,
        n_users: g.n_users,
        hardness: g.hardness || hardnessMap[g.ch] || "easy",
        others,
      });
    }
  }
}

function attachFailedClusterRefs(patches, failedClusters) {
  for (const g of failedClusters) {
    for (const u of g.identities) {
      const patch = patches.get(u);
      if (!patch) continue;
      const others = g.identities.filter((x) => x !== u);
      patch.clone_cluster_refs.push({
        problem_id: g.problem_id,
        kind: "failed",
        n_users: g.identities.length,
        hardness: g.hardness,
        others,
      });
    }
  }
}

function attachRecurringRef(patches, self, other, rp, conclusive) {
  const patch = patches.get(self);
  if (!patch) return;
  patch.recurring_pair_refs.push({
    other,
    n_problems: rp.n_problems,
    problems: rp.problems,
    n_hard: rp.n_hard,
    conclusive,
  });
}

function pushTight(patches, key, t) {
  const patch = patches.get(key);
  if (!patch) return;
  patch.tight_refs.push(t);
}

// failed-submission clustering: identical coreExact non-accepted code per
// problem, len≥15, >1 distinct identity. PREFERS the candidate's persisted
// cross_inputs.failed_norms (already near-stub-filtered at buildScorecard
// time — see buildCrossInputs) so convergent bare-stub/trivial-guess code
// never clusters; raw submissions are only a fallback for callers that did
// not run buildScorecard (no stub knowledge → no filtering possible).
function computeFailedClusters(candidates, hardness) {
  // problem → norm → Set(identityKey)
  const byProblem = new Map();
  const add = (pid, norm, key) => {
    if (!norm || norm.length < 15) return;
    if (!byProblem.has(pid)) byProblem.set(pid, new Map());
    const m = byProblem.get(pid);
    if (!m.has(norm)) m.set(norm, new Set());
    m.get(norm).add(key);
  };
  for (const c of candidates) {
    const ci = c.cross_inputs || (c.scorecard && c.scorecard.cross_inputs) || null;
    if (ci && ci.failed_norms) {
      for (const pid of Object.keys(ci.failed_norms)) {
        for (const norm of ci.failed_norms[pid] || []) add(pid, norm, c.identityKey);
      }
      continue;
    }
    for (const s of c.submissions || []) {
      if (s.verdict === "accepted") continue;
      const src = s.source_code || "";
      if (!src) continue;
      add(s.problem_id, coreExact(src), c.identityKey);
    }
  }
  const out = [];
  for (const [pid, m] of byProblem) {
    for (const [norm, ids] of m) {
      if (ids.size > 1) {
        out.push({ problem_id: pid, identities: [...ids], n_users: ids.size, hardness: hardness(pid), norm_preview: norm.slice(0, 80) });
      }
    }
  }
  return out;
}

// D6: foreign paste (collapsed ≥80) of B matched against other candidates' final
// content norms + submission norms. Note norms are coreExact; so we normalize the
// paste with coreExact before matching. Directed edge to=paster, from=owner.
function computePasteMatchEdges(candidates) {
  const edges = [];
  // Build owner index: identity → pid → [{norm, beforeTs|null, accepted}]
  const owners = candidates.map((c) => {
    const finals = c.cross_inputs ? c.cross_inputs.final_content_norms : (c.scorecard && c.scorecard.cross_inputs ? c.scorecard.cross_inputs.final_content_norms : {});
    const finalNorms = finals || {};
    const subNorms = []; // {pid, norm, ts, accepted}
    for (const s of c.submissions || []) {
      const norm = coreExact(s.source_code || "");
      if (norm.length < 15) continue;
      subNorms.push({ pid: s.problem_id, norm, ts: Date.parse(s.created_at || 0) || null, accepted: s.verdict === "accepted" });
    }
    return { key: c.identityKey, finalNorms, subNorms };
  });

  for (const c of candidates) {
    const pastes = (c.pastes || []).filter((p) => collapseWs(p.text || "").length >= THRESHOLDS.FOREIGN_PASTE_MATCH_MIN);
    for (const p of pastes) {
      const pasteNorm = coreExact(p.text || "");
      if (pasteNorm.length < 15) continue;
      const pasteTs = typeof p.ts === "number" ? p.ts : Date.parse(p.ts || 0) || null;
      for (const owner of owners) {
        if (owner.key === c.identityKey) continue;
        // match against final content norms
        let matched = false;
        let provable = false;
        const fn = owner.finalNorms[p.problem_id];
        if (fn && fn.includes(pasteNorm)) matched = true;
        // match against submission sources (any problem) + provability
        for (const sn of owner.subNorms) {
          if (sn.norm.includes(pasteNorm)) {
            matched = true;
            if (sn.ts != null && pasteTs != null && sn.ts < pasteTs) provable = true;
            if (sn.accepted && sn.ts != null && pasteTs != null && sn.ts < pasteTs) provable = true;
          }
        }
        if (matched) {
          edges.push({
            from: owner.key,
            to: c.identityKey,
            problem_id: p.problem_id,
            ts: tsIso(pasteTs),
            len: p.len || (p.text || "").length,
            provable,
          });
          break; // one edge per paste
        }
      }
    }
  }
  return edges;
}

// N9: per problem, accepted submissions sorted by time; any window of ≥3 distinct
// identities within 60s ⇒ cluster.
function computeSubmitClusters(candidates, hardness, roomByKey) {
  const byProblem = new Map();
  for (const c of candidates) {
    for (const s of c.submissions || []) {
      if (s.verdict !== "accepted") continue;
      const ts = Date.parse(s.created_at || 0);
      if (!Number.isFinite(ts)) continue;
      if (!byProblem.has(s.problem_id)) byProblem.set(s.problem_id, []);
      byProblem.get(s.problem_id).push({ key: c.identityKey, ts });
    }
  }
  const out = [];
  for (const [pid, arr] of byProblem) {
    arr.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < arr.length; i++) {
      const window = [arr[i]];
      const ids = new Set([arr[i].key]);
      for (let j = i + 1; j < arr.length; j++) {
        if (arr[j].ts - arr[i].ts > 60000) break;
        window.push(arr[j]);
        ids.add(arr[j].key);
      }
      if (ids.size >= 3) {
        const identities = [...ids];
        const rooms = [...new Set(identities.map((k) => roomByKey.get(k) || "").filter(Boolean))];
        out.push({ problem_id: pid, t0: tsIso(arr[i].ts), identities, rooms });
        break; // one cluster per problem (earliest window)
      }
    }
  }
  return out;
}

function ipPrefixOverlap(ipsA, ipsB) {
  const pa = new Set((ipsA || []).map(ipPrefix24).filter(Boolean));
  for (const ip of ipsB || []) {
    const p = ipPrefix24(ip);
    if (p && pa.has(p)) return true;
  }
  return false;
}
function ipPrefix24(ip) {
  if (!ip || typeof ip !== "string") return null;
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\./);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

function deriveCrossFlags(key, patch) {
  const flags = [];
  let escalation = null;

  // recurring pair → critical + confirmed escalation.
  const conclusive = patch.recurring_pair_refs.filter((r) => r.conclusive);
  if (conclusive.length) {
    const r = conclusive[0];
    flags.push({
      code: "recurring_pair_conclusive",
      severity: "critical",
      problem_id: null,
      evidence: `Recurring identical code with ${r.other} across ${r.n_problems} problems (${r.n_hard} hard) — conclusive.`,
    });
    escalation = "confirmed";
  }

  // hard clone cluster → critical; any clone → warning.
  const exactSkel = patch.clone_cluster_refs.filter((r) => r.kind === "exact" || r.kind === "skeleton");
  const hardClones = exactSkel.filter((r) => r.hardness === "hard");
  if (hardClones.length) {
    const r = hardClones[0];
    flags.push({
      code: "hard_clone_cluster",
      severity: "critical",
      problem_id: r.problem_id,
      evidence: `Member of a HARD ${r.kind} clone cluster on ${r.problem_id} with ${r.others.join(", ")}.`,
    });
  } else if (exactSkel.length) {
    const r = exactSkel[0];
    flags.push({
      code: "clone_cluster",
      severity: "warning",
      problem_id: r.problem_id,
      evidence: `Member of a ${r.kind} clone cluster on ${r.problem_id} with ${r.others.join(", ")}.`,
    });
  }

  // failed-clone → warning (critical if ≥2 shared failed problems with same other).
  const failed = patch.clone_cluster_refs.filter((r) => r.kind === "failed");
  if (failed.length) {
    // count shared problems per other identity
    const sharedByOther = new Map();
    for (const r of failed) {
      for (const o of r.others) {
        if (!sharedByOther.has(o)) sharedByOther.set(o, new Set());
        sharedByOther.get(o).add(r.problem_id);
      }
    }
    let critical = false;
    let worstOther = null;
    for (const [o, set] of sharedByOther) {
      if (set.size >= 2) {
        critical = true;
        worstOther = o;
        break;
      }
    }
    if (critical) {
      flags.push({
        code: "failed_clone_cluster",
        severity: "critical",
        problem_id: failed[0].problem_id,
        evidence: `Identical failed code with ${worstOther} on ≥2 problems.`,
      });
    } else {
      flags.push({
        code: "failed_clone_cluster",
        severity: "warning",
        problem_id: failed[0].problem_id,
        evidence: `Identical failed code with ${failed[0].others.join(", ")} on ${failed[0].problem_id}.`,
      });
    }
  }

  // directed paste-match → critical for receiving side.
  const incoming = patch.paste_match_edges.filter((e) => e.to === key);
  if (incoming.length) {
    const e = incoming[0];
    flags.push({
      code: "directed_paste_match",
      severity: "critical",
      problem_id: e.problem_id,
      evidence: `Pasted ${e.from}'s ${e.problem_id} content${e.provable ? " (owner had it earlier — directed)" : ""}.`,
    });
  }

  patch.flags = flags;
  patch.integrity_escalation = escalation || (flags.some((f) => f.severity === "critical") ? "flag" : null);
}

function buildCohort(candidates) {
  const medians = [];
  const pasteRatios = [];
  for (const c of candidates) {
    const cad = c.scorecard && c.scorecard.integrity ? c.scorecard.integrity.cadence : null;
    if (cad && typeof cad.median_ikg_ms === "number") medians.push(cad.median_ikg_ms);
    const pr = c.scorecard && c.scorecard.integrity ? c.scorecard.integrity.paste_ratio : null;
    if (typeof pr === "number") pasteRatios.push(pr);
  }
  return {
    n: candidates.length,
    typing: { median_ikg_ms_dist: distStats(medians) },
    paste_ratio_dist: distStats(pasteRatios),
  };
}
function distStats(arr) {
  if (!arr.length) return { n: 0, p50: 0, p95: 0, mean: 0 };
  return { n: arr.length, p50: median(arr), p95: percentile(arr, 95), mean: round4(mean(arr)) };
}

// ---------------------------------------------------------------------------
// applyCrossPatches — merge a patch into a scorecard, re-derive tiers/composite.
// ---------------------------------------------------------------------------
export function applyCrossPatches(scorecard, patch) {
  if (!patch) return scorecard;
  const sc = JSON.parse(JSON.stringify(scorecard));
  sc.integrity.clone_cluster_refs = patch.clone_cluster_refs || [];
  sc.integrity.recurring_pair_refs = patch.recurring_pair_refs || [];
  sc.integrity.paste_match_edges = (patch.paste_match_edges || []).filter((e) => e.to === sc.identity_key || e.from === sc.identity_key);

  // append new flags, dedupe by code+problem_id+evidence.
  const seen = new Set(sc.flags.map((f) => `${f.code}|${f.problem_id}|${f.evidence}`));
  for (const f of patch.flags || []) {
    const k = `${f.code}|${f.problem_id}|${f.evidence}`;
    if (!seen.has(k)) {
      sc.flags.push(f);
      seen.add(k);
    }
  }

  // re-derive tiers + composite + one_line. Need per_problem tier tags for the
  // talent recount; reconstruct from the scorecard.
  tagPerProblemTiers(sc);
  const derived = deriveTiers({ flags: sc.flags, talent: sc.talent, integrity: sc.integrity });
  sc.talent.composite = derived.composite;
  sc.tiers = derived.tiers;
  return sc;
}

// deriveTiers' countGenuine reads pp._tier; buildScorecard must also tag them.
// We tag here from hardest_tier heuristic is unsafe; instead store per-problem
// tier when available. Since the scorecard doesn't persist per-problem tier, we
// can't recover it post-hoc — so buildScorecard tags _tier on per_problem, and
// JSON round-trip preserves it. This function is a no-op safety net.
function tagPerProblemTiers(sc) {
  // per_problem entries already carry _tier from buildScorecard; nothing to do.
  // (kept for clarity / future use.)
  void sc;
}
