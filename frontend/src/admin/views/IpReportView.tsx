// frontend/src/admin/views/IpReportView.tsx
// IP report view + drill-down candidate row + scope options, extracted verbatim
// from App.tsx (F3).
import { Fragment, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, Network, RefreshCw } from "lucide-react";
import { candidateIdOf } from "../../identity";
import { validSessionActionsFor } from "../alertActions";
import type { IpReportCandidate, IpReportResponse, IpReportScope, SessionAction } from "../../types";
import { FilterSelect } from "../../ui/FilterSelect";
import { ActionButtons } from "../actions";

// S7: scope options for the IP report — "live" (non-ended = logged-in users)
// vs "all" (adds ended sessions for after-the-exam forensics).
const IP_SCOPE_OPTIONS: Array<{ value: IpReportScope; label: string }> = [
  { value: "live", label: "Logged-in (live)" },
  { value: "all", label: "All sessions" }
];

// S7: IP-wise report of logged-in users — the proxy-detection signal surface.
// One row per IP, biggest clusters first: on campus, rooms collapse to a few
// NAT IPs with many users, so an unexpected solo IP (off-campus candidate) or
// an unexpected cluster (many candidates through one box) stands out. Rows
// with 2+ distinct users get a warning tint; candidates whose IP changed
// mid-exam get a warning icon. Interpretation stays with the admin — the
// report never auto-flags.
export function IpReportView({ report, loading, unavailable, scope, onScopeChange, contestSlug, onRefresh, onAction, onOpenSessionCard }: {
  report: IpReportResponse | null;
  loading: boolean;
  unavailable: boolean;
  scope: IpReportScope;
  onScopeChange: (scope: IpReportScope) => void;
  contestSlug: string;
  onRefresh: () => void;
  /** F8.1: status-valid session actions from the drill-down rows. */
  onAction: (action: SessionAction, opts: { sessionId?: string; usernames?: string[] }) => void;
  /** F8.1: jump to the Sessions tab with this candidate's detail card open. */
  onOpenSessionCard: (candidate: IpReportCandidate) => void;
}) {
  // F8.1: which IP rows are expanded into their candidate-session drill-down.
  // A Set keyed by IP so several clusters can be open at once; survives the
  // 'report' object being replaced by a refresh.
  const [expandedIps, setExpandedIps] = useState<Set<string>>(new Set());
  const toggleIp = (ip: string) => {
    setExpandedIps((current) => {
      const next = new Set(current);
      if (next.has(ip)) next.delete(ip);
      else next.add(ip);
      return next;
    });
  };
  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Network size={20} />
            <div>
              <h1 className="text-2xl font-semibold">IP report</h1>
              <p className="mt-1 text-sm text-muted">
                IP-wise count of logged-in users{contestSlug ? <> for contest <span className="font-mono font-medium">{contestSlug}</span></> : null}. Many candidates on one unexpected IP — or a candidate on an IP nobody else uses — is a proxy/off-campus signal; a shared campus NAT is normal.
              </p>
            </div>
          </div>
          <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <FilterSelect label="Scope" value={scope} options={IP_SCOPE_OPTIONS} onChange={(value) => onScopeChange(value as IpReportScope)} />
          {report ? (
            <p className="text-xs text-muted">
              <span className="font-medium text-ink">{report.distinct_ips}</span> distinct IP{report.distinct_ips === 1 ? "" : "s"} across{" "}
              <span className="font-medium text-ink">{report.total_sessions}</span> session{report.total_sessions === 1 ? "" : "s"} ·{" "}
              <span className="font-medium text-ink">{report.multi_user_ips}</span> multi-user IP{report.multi_user_ips === 1 ? "" : "s"} ·{" "}
              <span className="font-medium text-ink">{report.ip_changed_sessions}</span> session{report.ip_changed_sessions === 1 ? "" : "s"} with a mid-exam IP change
            </p>
          ) : null}
        </div>
      </div>

      {unavailable ? (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          <AlertTriangle size={16} className="mr-2 inline" />
          The ip-report endpoint is not deployed yet, so the IP report is unavailable. Deploy the backend to enable it.
        </div>
      ) : report === null ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">{loading ? "Loading IP report…" : "No report loaded yet."}</div>
      ) : report.ips.length === 0 ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">No sessions match this scope.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel shadow-subtle">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-semibold">IP address</th>
                <th className="px-4 py-3 font-semibold">Users</th>
                <th className="px-4 py-3 font-semibold">Sessions</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Rooms</th>
                <th className="px-4 py-3 font-semibold">Candidates</th>
              </tr>
            </thead>
            <tbody>
              {report.ips.map((entry) => (
                <Fragment key={entry.ip}>
                  {/* F8.1: the row is the drill-down toggle (cursor + chevron
                      make it discoverable, like the Sessions rows). */}
                  <tr
                    onClick={() => toggleIp(entry.ip)}
                    title={expandedIps.has(entry.ip) ? "Hide candidate sessions" : "Show candidate sessions"}
                    aria-expanded={expandedIps.has(entry.ip)}
                    className={`cursor-pointer border-b border-line/60 last:border-0 hover:bg-ink/5 ${entry.users >= 2 ? "bg-warning/5" : ""}`}
                  >
                    <td className="px-4 py-3 font-mono text-ink">
                      <span className="inline-flex items-center gap-1.5">
                        {expandedIps.has(entry.ip) ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
                        {entry.ip}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-semibold text-ink">{entry.users}</td>
                    <td className="px-4 py-3 font-mono text-muted">{entry.sessions}</td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {entry.active ? <span className="mr-2">{entry.active} live</span> : null}
                      {entry.locked ? <span className="mr-2">{entry.locked} locked</span> : null}
                      {entry.pending_approval ? <span className="mr-2">{entry.pending_approval} pending</span> : null}
                      {entry.ended ? <span>{entry.ended} ended</span> : null}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">{entry.rooms.length ? entry.rooms.join(", ") : "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        {entry.candidates.map((candidate) => (
                          <span
                            key={candidate.session_id}
                            className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-ink"
                            title={`${candidate.name || candidateIdOf(candidate)} · ${candidate.status}${candidate.ip_change_count > 0 ? ` · IP changed ${candidate.ip_change_count}×` : ""}`}
                          >
                            {candidateIdOf(candidate)}
                            {candidate.ip_change_count > 0 ? <AlertTriangle size={12} className="text-warning" /> : null}
                          </span>
                        ))}
                        {entry.candidates_truncated ? <span className="text-xs text-muted">+{entry.sessions - entry.candidates.length} more</span> : null}
                      </div>
                    </td>
                  </tr>
                  {/* F8.1 drill-down: the candidate sessions on this IP with
                      status-valid actions (same validity table as everywhere)
                      and a session-card deep link per candidate. */}
                  {expandedIps.has(entry.ip) ? (
                    <tr className="border-b border-line/60 last:border-0">
                      <td colSpan={6} className="bg-ink/[0.03] px-4 py-3">
                        <div className="space-y-2">
                          {entry.candidates.map((candidate) => (
                            <IpCandidateRow
                              key={candidate.session_id}
                              candidate={candidate}
                              onAction={onAction}
                              onOpenSessionCard={onOpenSessionCard}
                            />
                          ))}
                          {entry.candidates_truncated ? (
                            <p className="text-xs text-muted">Showing the newest {entry.candidates.length} of {entry.sessions} sessions on this IP.</p>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
          {report.ips_truncated ? (
            <p className="border-t border-line px-4 py-3 text-xs text-muted">Showing the {report.ips.length} largest IP groups; more exist beyond the cap.</p>
          ) : null}
        </div>
      )}
    </section>
  );
}

// F8.1: one candidate session inside an expanded IP-report row — identity
// (name, roster id, room), a status badge, the session start time, the
// status-VALID session actions (validSessionActionsFor — same table as the
// alerts console / session card), and an "Open session card" deep link.
function IpCandidateRow({ candidate, onAction, onOpenSessionCard }: {
  candidate: IpReportCandidate;
  onAction: (action: SessionAction, opts: { sessionId?: string; usernames?: string[] }) => void;
  onOpenSessionCard: (candidate: IpReportCandidate) => void;
}) {
  const actions = validSessionActionsFor(candidate.status);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-white/70 p-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
        <div className="min-w-36">
          <div className="text-sm font-semibold text-ink">{candidate.name || candidateIdOf(candidate)}</div>
          <div className="font-mono text-xs text-muted">{candidateIdOf(candidate)}</div>
        </div>
        <span className="text-xs text-muted">Roster ID <span className="font-mono font-medium text-ink">{candidate.roster_unique_id || "—"}</span></span>
        <span className="text-xs text-muted">Room <span className="font-medium text-ink">{candidate.room || "—"}</span></span>
        <span className="rounded-full border border-line px-2.5 py-0.5 text-xs font-medium text-ink">{candidate.status}</span>
        <span className="text-xs text-muted">Started <span className="font-medium text-ink">{candidate.created_at ? new Date(candidate.created_at).toLocaleString() : "—"}</span></span>
        {candidate.ip_change_count > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2.5 py-0.5 text-xs font-medium text-warning">
            <AlertTriangle size={12} /> IP changed {candidate.ip_change_count}×
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {actions.length ? (
          <ActionButtons onAction={onAction} sessionId={candidate.session_id} actions={actions} />
        ) : (
          <span className="text-xs text-muted">{candidate.status === "ended" ? "Ended — view-only." : "No session actions apply."}</span>
        )}
        <button
          type="button"
          onClick={() => onOpenSessionCard(candidate)}
          className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/40"
        >
          Open session card <ExternalLink size={12} />
        </button>
      </div>
    </div>
  );
}
