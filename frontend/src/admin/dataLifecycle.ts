// Wave7-H: PURE decision/formatting logic for the admin Data-lifecycle section.
//
// The section has three sub-flows — EXPORT, the TRIPLE-GATED PURGE, and the
// evidence-RETENTION countdown — plus the derived lifecycle phase badge. The
// gate-enable logic and the countdown formatting are extracted here as pure
// functions (the frontend suite has no jsdom render harness) and unit-tested in
// dataLifecycle.test.ts. The UI in ContestsPanel renders from these; this module
// is the single source of truth and MIRRORS the server's gate exactly.
//
// Spec: docs/superpowers/specs/2026-06-10-f10-product-vision.md
//   §2.16 export → triple-gated purge → tombstone; selection-done → retention sweep
//   §2.9  purge-survivor (enrollments + final_snapshot retained; the contest doc
//         stays as a tombstone, Results/People still read via final_snapshot)
//   §7    derived phase ladder: Draft → Scheduled → Live → Ended → Selection done
//         → Evidence purged → Purged → Archived
// Backend gate authority: backend/src/dataLifecycle.mjs evaluatePurgeGate().

import type { ContestStatus } from "../types";

export const DAY_MS = 24 * 60 * 60 * 1000;

// Read-time fallback when a contest has no/garbage retention window — must match
// the backend DEFAULT_RETENTION_DAYS (dataLifecycle.mjs) so the UI countdown and
// the server sweep agree.
export const DEFAULT_RETENTION_DAYS = 4;

/** The lifecycle-relevant subset of a contest the section reads. A superset of
 *  ContestSummary's lifecycle stamps (all optional on the wire; legacy synth and
 *  pre-lifecycle contests omit them). */
export type LifecycleContest = {
  slug: string;
  status: ContestStatus;
  legacy?: boolean;
  start_at?: string | null;
  end_at?: string | null;
  last_export_at?: string | null;
  selection_done_at?: string | null;
  evidence_retention_days?: number | null;
  evidence_purged_at?: string | null;
  db_purged_at?: string | null;
  purged_at?: string | null;
};

// ---- the triple gate (PURE; mirrors evaluatePurgeGate server-side) -----------
//
// The UI is NOT the authority — the server re-checks every gate — but the UI
// must DISABLE the dangerous button until all three pass so the admin can never
// fire a request that the server will only reject. The three gates, in order:
//   (1) a prior successful export exists       (last_export_at present)
//   (2) the "I understand…" checkbox is ticked (explicit confirm)
//   (3) the typed contest slug echoes EXACTLY  (trimmed, case-sensitive)
// A tombstoned contest short-circuits to alreadyPurged (the gate is moot).
export type PurgeGateState = {
  /** gate 1 — an export has been produced. */
  exportDone: boolean;
  /** the confirm checkbox is reachable (i.e. export exists). */
  canConfirm: boolean;
  /** gate 2 — the "I understand" checkbox is ticked. */
  confirmed: boolean;
  /** gate 3 — the typed slug matches exactly. */
  slugMatches: boolean;
  /** all three gates pass → the final Purge button is enabled. */
  canPurge: boolean;
  /** the contest is already a tombstone (purge is a no-op). */
  alreadyPurged: boolean;
  /** the next action that unblocks the flow (drives the inline hint). */
  nextStep: "export" | "confirm" | "slug" | "ready" | "purged";
};

export function purgeGateState({ contest, confirmed, typedSlug }: {
  contest: LifecycleContest;
  confirmed: boolean;
  typedSlug: string;
}): PurgeGateState {
  const alreadyPurged = Boolean(contest.purged_at || contest.db_purged_at);
  const exportDone = Boolean(contest.last_export_at);
  const slugMatches = typeof typedSlug === "string" && typedSlug.trim() === contest.slug;
  const confirmedFlag = confirmed === true;

  if (alreadyPurged) {
    return { exportDone, canConfirm: exportDone, confirmed: confirmedFlag, slugMatches, canPurge: false, alreadyPurged: true, nextStep: "purged" };
  }

  const canPurge = exportDone && confirmedFlag && slugMatches;
  // First-unmet gate, in the server's gate order, surfaces the clearest hint.
  const nextStep: PurgeGateState["nextStep"] =
    !exportDone ? "export"
    : !confirmedFlag ? "confirm"
    : !slugMatches ? "slug"
    : "ready";

  return { exportDone, canConfirm: exportDone, confirmed: confirmedFlag, slugMatches, canPurge, alreadyPurged: false, nextStep };
}

function resolveRetentionDays(raw: number | null | undefined): number {
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) return DEFAULT_RETENTION_DAYS;
  return num;
}

// ---- retention status / countdown (PURE) ------------------------------------
//
// The evidence-retention clock starts at selection_done_at and runs
// evidence_retention_days; the daily sweep deletes recordings once past the
// window and stamps evidence_purged_at. This formats the human story:
//   - clock not started (no selection_done_at)
//   - "recordings auto-delete in N days" (mid-window; daysRemaining ceils so the
//     count never reads 0 while evidence still exists)
//   - "due for deletion" (past the window, sweep not yet run)
//   - "evidence deleted" (evidence_purged_at stamped — wins over any countdown)
export type RetentionStatus = {
  started: boolean;
  purged: boolean;
  /** past the retention window but not yet swept (the next sweep will catch it). */
  due: boolean;
  retentionDays: number;
  /** whole days until the window elapses (ceil; 0 once due). */
  daysRemaining: number;
  /** ISO instant evidence becomes eligible for deletion. */
  deleteAt: string | null;
  /** the human label rendered next to the status. */
  label: string;
};

export function retentionStatus({ contest, now }: { contest: LifecycleContest; now: string }): RetentionStatus {
  const retentionDays = resolveRetentionDays(contest.evidence_retention_days);

  if (contest.evidence_purged_at) {
    return { started: true, purged: true, due: false, retentionDays, daysRemaining: 0, deleteAt: null, label: "Evidence deleted — recordings have been swept; scores and selection are retained." };
  }

  const doneMs = Date.parse(String(contest.selection_done_at || ""));
  if (!Number.isFinite(doneMs)) {
    return { started: false, purged: false, due: false, retentionDays, daysRemaining: 0, deleteAt: null, label: "Retention clock not started — recordings are kept until you Mark selection done." };
  }

  const deleteMs = doneMs + retentionDays * DAY_MS;
  const deleteAt = new Date(deleteMs).toISOString();
  const nowMs = Date.parse(String(now));
  const remainingMs = deleteMs - (Number.isFinite(nowMs) ? nowMs : Date.now());

  if (remainingMs <= 0) {
    return { started: true, purged: false, due: true, retentionDays, daysRemaining: 0, deleteAt, label: "Recordings are due for deletion — the next retention sweep will remove them." };
  }

  // Ceil so a partial final day still reads "1 day", never 0, while evidence lives.
  const daysRemaining = Math.ceil(remainingMs / DAY_MS);
  const unit = daysRemaining === 1 ? "day" : "days";
  return { started: true, purged: false, due: false, retentionDays, daysRemaining, deleteAt, label: `Recordings auto-delete in ${daysRemaining} ${unit}.` };
}

// ---- derived lifecycle phase badge (PURE; vision §7 ladder) ------------------
//
// Stored status stays the minimal three (draft/open/archived); the richer phase
// is DERIVED here for the lifecycle badge/timeline, never multiplied into stored
// state. Priority is "most-progressed wins": purged > evidence_purged >
// selection_done > (open: live/scheduled/ended) > draft/archived.
export type LifecyclePhaseKey =
  | "draft" | "scheduled" | "live" | "ended"
  | "selection_done" | "evidence_purged" | "purged" | "archived";

export type LifecyclePhase = {
  key: LifecyclePhaseKey;
  label: string;
  /** the contest is a DB tombstone (heavy data deleted; Results/People read via final_snapshot). */
  tombstone: boolean;
};

const PHASE_LABELS: Record<LifecyclePhaseKey, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  live: "Live",
  ended: "Ended",
  selection_done: "Selection done",
  evidence_purged: "Evidence purged",
  purged: "Purged",
  archived: "Archived"
};

export function lifecyclePhase(contest: LifecycleContest, now: string): LifecyclePhase {
  const phase = (key: LifecyclePhaseKey, tombstone = false): LifecyclePhase => ({ key, label: PHASE_LABELS[key], tombstone });

  // Most-progressed lifecycle stamps win (a purged contest is purged regardless
  // of its stored status).
  if (contest.purged_at || contest.db_purged_at) return phase("purged", true);
  if (contest.evidence_purged_at) return phase("evidence_purged");
  if (contest.selection_done_at) return phase("selection_done");

  if (contest.status === "draft") return phase("draft");
  if (contest.status === "archived") return phase("archived");

  // status === "open": resolve scheduled/live/ended from the window.
  const nowMs = Date.parse(String(now));
  const startMs = Date.parse(String(contest.start_at || ""));
  const endMs = Date.parse(String(contest.end_at || ""));
  if (Number.isFinite(nowMs)) {
    if (Number.isFinite(startMs) && nowMs < startMs) return phase("scheduled");
    if (Number.isFinite(endMs) && nowMs > endMs) return phase("ended");
  }
  return phase("live");
}
