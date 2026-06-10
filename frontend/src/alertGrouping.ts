// F6 item 2 / TG msg 1581 — pure alert GROUPING for the alerts console "Group
// by" control: none (flat, default) | candidate | type. Groups preserve the
// input's newest-first order (a group sits where its newest alert sits), carry
// the per-group id list for the existing selection model (alertSelection.ts),
// and a worst-severity chip for the section header. No React, no IO —
// vitest-covered (alertGrouping.test.ts).
import { normalizeJoinUsername } from "./admin/alertActions";
import { candidateIdOf } from "./identity";
import type { AlertSeverity } from "./types";

export type AlertGroupBy = "none" | "candidate" | "type";

/** The minimal alert shape grouping needs (Alert satisfies it). */
export type GroupableAlert = {
  id: string;
  type: string;
  severity: AlertSeverity;
  hackerrank_username: string;
  /** S-A accept-both: newer backends may deliver candidate_id too. */
  candidate_id?: string;
  /** Lowercase/sanitized form when the alert carries one. */
  username_norm?: string;
};

export type AlertGroup<T extends GroupableAlert = GroupableAlert> = {
  /** Stable grouping key (normalized identity value / alert type). */
  key: string;
  /** Header label: the first-seen RAW candidate ID, or the type. */
  label: string;
  worstSeverity: AlertSeverity;
  alerts: T[];
  /** alerts' ids in order — the group-select scope for alertSelection.ts. */
  ids: string[];
};

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** The highest-ranked severity in the list (header chip). */
export function worstSeverity(severities: AlertSeverity[]): AlertSeverity {
  let worst: AlertSeverity = "info";
  for (const severity of severities) {
    if (SEVERITY_RANK[severity] < SEVERITY_RANK[worst]) worst = severity;
  }
  return worst;
}

/**
 * Group alerts by candidate (normalized username — same join key the status
 * join uses, so raw-casing variants collapse) or by type. Groups appear in
 * first-appearance order over the newest-first input.
 */
export function groupAlerts<T extends GroupableAlert>(
  alerts: T[],
  groupBy: Exclude<AlertGroupBy, "none">
): Array<AlertGroup<T>> {
  const groups = new Map<string, AlertGroup<T>>();
  for (const alert of alerts) {
    const key =
      groupBy === "candidate"
        ? alert.username_norm || normalizeJoinUsername(candidateIdOf(alert))
        : alert.type;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: groupBy === "candidate" ? candidateIdOf(alert) : alert.type,
        worstSeverity: alert.severity,
        alerts: [],
        ids: []
      };
      groups.set(key, group);
    }
    group.alerts.push(alert);
    group.ids.push(alert.id);
    group.worstSeverity = worstSeverity([group.worstSeverity, alert.severity]);
  }
  return [...groups.values()];
}
