// Rule 11 — D16b replay-vs-submission mismatch. Relocated from
// evaluationMetrics.mjs:620-675 (the detector) PLUS the glitchy-mismatch →
// coverage-gap routing from :742-747 (spec §5 option (a): keep all tamper logic
// in one rule).
//
// NO availability gate: the old code ALWAYS wrote integrity.replay_mismatches
// (array, may be empty) and integrity.telemetry_tampered (bool, default false),
// so gating-and-skipping would drop those fields and change bytes. The
// editor-coverage condition lives INSIDE the logic (realMismatches.length &&
// editorCoveragePresent), exactly as before. The empty-snapshot guard (:650) and
// the glitch gate (:665-666) are preserved verbatim.

import { collapseWs, normalizedLineDistance } from "../../evaluationReplay.mjs";

/** @type {import("../types.mjs").Rule} */
export const replayTamper = {
  id: "replay_tamper",
  category: "integrity",
  scope: "session",
  needs: [],
  weight: 90,
  fn(features, ctx) {
    const { mismatch: MISMATCH } = ctx.config;
    const replay = features.replay;
    const submissions = features.submissions;
    const editorCoveragePresent = features.editorCoveragePresent;
    const problemsWithEvents = features.problemsWithEvents;

    const replay_mismatches = [];
    let telemetry_tampered = false;

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
      if (dist > MISMATCH) {
        // EMPTY-SNAPSHOT GUARD (real-data hardening): a near-empty replayed buffer
        // means the base content (the pre-seeded stub) was never captured.
        const substantive = snapCollapsed.length >= 30;
        replay_mismatches.push({ problem_id: pid, submission_id: s._id || null, distance: round4(dist), ts: tsIso(best.snap.ts), snapshot_empty: !substantive });
      }
    }

    // GLITCH GATE (real-data hardening): a mismatch is TAMPER EVIDENCE only when
    // this problem's replay was glitch-free; glitchy mismatches degrade
    // coverage/confidence instead.
    const glitchFree = (pid) => (replay.problems[pid]?.glitches || 0) === 0;
    const realMismatches = replay_mismatches.filter((m) => problemsWithEvents.has(m.problem_id) && glitchFree(m.problem_id) && !m.snapshot_empty);

    const out = [];
    if (realMismatches.length && editorCoveragePresent) {
      telemetry_tampered = true;
      out.push({
        kind: "flag",
        code: "telemetry_tampered",
        severity: "critical",
        problem_id: realMismatches[0].problem_id,
        evidence: `Submitted code differs from replayed editor state (line-distance ${realMismatches[0].distance}>${MISMATCH}).`,
      });
    }

    // Glitch-gated mismatches → coverage gaps (replay base was wrong for these
    // problems); confidence drops instead of a flag. (Relocated from :742-747.)
    const glitchyMismatchPids = [...new Set(replay_mismatches
      .filter((m) => (replay.problems[m.problem_id]?.glitches || 0) > 0 || m.snapshot_empty)
      .map((m) => m.problem_id))];

    out.push({ kind: "integrity", field: "replay_mismatches", value: replay_mismatches });
    out.push({ kind: "integrity", field: "telemetry_tampered", value: telemetry_tampered });
    for (const pid of glitchyMismatchPids) out.push({ kind: "coverage_gap", value: `replay_base_unreliable:${pid}` });
    return out;
  },
};

function tsIso(ms) {
  if (ms == null) return null;
  return new Date(ms).toISOString();
}
function round4(x) {
  return Math.round(x * 10000) / 10000;
}
