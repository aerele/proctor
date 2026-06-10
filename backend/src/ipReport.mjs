// backend/src/ipReport.mjs — S7: pure IP-wise aggregation over session docs.
//
// The handler already captures the client IP at session start (start_ip) and
// refreshes it on every heartbeat (current_ip) — see getClientIp() in
// handler.mjs. This module only GROUPS already-stored docs; it does no I/O and
// reads no env, so it is unit-tested directly without the handler fakes.

// Caps keep the admin response bounded no matter how pathological the data:
// at most this many IP groups per response (sorted FIRST, so the biggest
// clusters always make the cut) and at most this many candidate rows per IP.
export const IP_REPORT_IPS_LIMIT = 200;
export const IP_REPORT_CANDIDATES_LIMIT = 25;

// The IP a session is grouped under: the most recent one observed (current_ip,
// refreshed by heartbeats), falling back to start_ip for sessions that never
// heartbeat, then "unknown" for legacy docs that predate IP capture.
export function reportIp(doc) {
  const ip = String(doc.current_ip || doc.start_ip || "").trim();
  return ip || "unknown";
}

// Group session docs into the IP report (spec §5). Counts are data, not
// verdicts: distinct users via username_norm, per-status session counts,
// distinct rooms, and a bounded newest-first candidate sample per IP. Sorted
// users desc → sessions desc → ip asc so clusters lead deterministically.
export function buildIpReport(docs) {
  const byIp = new Map();
  let ipChangedSessions = 0;

  for (const doc of docs) {
    const ip = reportIp(doc);
    if (Number(doc.ip_change_count || 0) > 0) ipChangedSessions += 1;
    let entry = byIp.get(ip);
    if (!entry) {
      entry = {
        ip,
        docs: [],
        users: new Set(),
        rooms: new Set(),
        counts: { active: 0, locked: 0, pending_approval: 0, ended: 0 }
      };
      byIp.set(ip, entry);
    }
    entry.docs.push(doc);
    if (doc.username_norm) entry.users.add(doc.username_norm);
    const room = String(doc.room || "").trim();
    if (room) entry.rooms.add(room);
    if (Object.hasOwn(entry.counts, doc.status)) entry.counts[doc.status] += 1;
  }

  const ips = [...byIp.values()]
    .map((entry) => ({
      ip: entry.ip,
      sessions: entry.docs.length,
      users: entry.users.size,
      active: entry.counts.active,
      locked: entry.counts.locked,
      pending_approval: entry.counts.pending_approval,
      ended: entry.counts.ended,
      rooms: [...entry.rooms].sort((a, b) => a.localeCompare(b)),
      candidates: entry.docs
        .slice()
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
        .slice(0, IP_REPORT_CANDIDATES_LIMIT)
        .map((doc) => ({
          session_id: doc.session_id || "",
          hackerrank_username: doc.hackerrank_username || "",
          name: doc.name || "",
          // F8.1: the roster identity for the drill-down rows ("" for legacy
          // pre-roster sessions — the UI falls back to the username).
          roster_unique_id: doc.roster_unique_id || "",
          room: doc.room || "",
          status: doc.status || "",
          created_at: doc.created_at || "",
          start_ip: doc.start_ip || "",
          ip_change_count: Number(doc.ip_change_count || 0)
        })),
      candidates_truncated: entry.docs.length > IP_REPORT_CANDIDATES_LIMIT
    }))
    .sort((a, b) => b.users - a.users || b.sessions - a.sessions || a.ip.localeCompare(b.ip));

  return {
    total_sessions: docs.length,
    distinct_ips: byIp.size,
    // Computed BEFORE the group cap so the summary stays truthful even when
    // the ips array is truncated.
    multi_user_ips: ips.filter((entry) => entry.users >= 2).length,
    ip_changed_sessions: ipChangedSessions,
    ips: ips.slice(0, IP_REPORT_IPS_LIMIT),
    ips_truncated: byIp.size > IP_REPORT_IPS_LIMIT
  };
}
