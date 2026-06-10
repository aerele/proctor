// S7 — pure IP-report grouping for the DEMO branch of fetchIpReport (api.ts).
// Mirrors backend/src/ipReport.mjs semantics so the demo admin console behaves
// like production. Vitest-covered (ipReport.test.ts).
import type { IpReportCandidate, IpReportEntry } from "./types";

export const IP_REPORT_IPS_LIMIT = 200;
export const IP_REPORT_CANDIDATES_LIMIT = 25;

// The minimal session projection the grouping needs. `ip` is the demo-assigned
// current IP (the backend's current_ip || start_ip equivalent).
export type IpRow = {
  session_id: string;
  hackerrank_username: string;
  name: string;
  room: string;
  status: string;
  created_at: string;
  ip: string;
  start_ip?: string;
  ip_change_count?: number;
  /** F8.1: roster identity for the drill-down rows ("" / absent = legacy). */
  roster_unique_id?: string;
};

export function groupIpEntries(rows: IpRow[]): IpReportEntry[] {
  const byIp = new Map<string, IpRow[]>();
  for (const row of rows) {
    const ip = (row.ip || "").trim() || "unknown";
    const bucket = byIp.get(ip) ?? [];
    bucket.push(row);
    byIp.set(ip, bucket);
  }

  const entries: IpReportEntry[] = [...byIp.entries()].map(([ip, bucket]) => {
    const users = new Set(
      bucket.map((row) => row.hackerrank_username.trim().toLowerCase()).filter(Boolean)
    );
    const rooms = [...new Set(bucket.map((row) => (row.room || "").trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    const counts = { active: 0, locked: 0, pending_approval: 0, ended: 0 };
    for (const row of bucket) {
      if (row.status in counts) counts[row.status as keyof typeof counts] += 1;
    }
    const candidates: IpReportCandidate[] = bucket
      .slice()
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
      .slice(0, IP_REPORT_CANDIDATES_LIMIT)
      .map((row) => ({
        session_id: row.session_id,
        hackerrank_username: row.hackerrank_username,
        name: row.name,
        roster_unique_id: row.roster_unique_id ?? "",
        room: row.room,
        status: row.status,
        created_at: row.created_at,
        start_ip: row.start_ip ?? row.ip,
        ip_change_count: row.ip_change_count ?? 0
      }));
    return {
      ip,
      sessions: bucket.length,
      users: users.size,
      active: counts.active,
      locked: counts.locked,
      pending_approval: counts.pending_approval,
      ended: counts.ended,
      rooms,
      candidates,
      candidates_truncated: bucket.length > IP_REPORT_CANDIDATES_LIMIT
    };
  });

  // Biggest clusters first; deterministic tie-breaks (mirrors the backend).
  return entries.sort((a, b) => b.users - a.users || b.sessions - a.sessions || a.ip.localeCompare(b.ip));
}

export function summarizeIpEntries(entries: IpReportEntry[], rows: IpRow[]) {
  return {
    total_sessions: rows.length,
    distinct_ips: entries.length,
    multi_user_ips: entries.filter((entry) => entry.users >= 2).length,
    ip_changed_sessions: rows.filter((row) => (row.ip_change_count ?? 0) > 0).length
  };
}
