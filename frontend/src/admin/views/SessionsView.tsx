// frontend/src/admin/views/SessionsView.tsx
// Sessions drill-down table + status options, extracted verbatim from App.tsx (F3).
import { AlertTriangle, CheckCircle2, RefreshCw, Users } from "lucide-react";
import type { RecordingSession } from "../../types";
import type { SessionsStatusFilter } from "../../sessionFilters";
import { candidateIdOf } from "../../identity";
import { SESSION_ACTION_INFO } from "../alertActions";
import { FilterSelect } from "../../ui/FilterSelect";
import { ActionTooltip } from "../../ui/ActionTooltip";

// A2: status-filter options for the Sessions drill-down. "disconnected" has no
// literal session-doc status (derived liveness), so the list treats it as the
// active sessions and the view shows an explanatory note.
const SESSIONS_STATUS_OPTIONS: Array<{ value: SessionsStatusFilter; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "active", label: "Live" },
  { value: "disconnected", label: "Disconnected" },
  { value: "locked", label: "Locked" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "ended", label: "Finished" }
];

// A2/A4: the GCS-free SESSIONS drill-down — a lightweight table of sessions from
// fetchSessionsList (ALL session docs classified server-side to match the stat
// cards), scoped to the global contest filter and room. The status filter is now
// SERVER-side: changing it reloads from the server, so the rows already arrive
// status-filtered and we render them directly (no client-side double-filtering).
// When filtered to pending_approval, each row shows an Approve quick action (A4) —
// which now reaches zero-chunk pending_approval sessions. Opened by clicking a stat
// card on the Live stats dashboard.
export function SessionsView({ sessions, loading, unavailable, statusFilter, onStatusFilterChange, contestSlug, onRefresh, onApprove, onOpenDetail }: {
  sessions: RecordingSession[] | null;
  loading: boolean;
  unavailable: boolean;
  statusFilter: SessionsStatusFilter;
  onStatusFilterChange: (status: SessionsStatusFilter) => void;
  contestSlug: string;
  onRefresh: () => void;
  onApprove: (session: RecordingSession) => void;
  /** F6.3: clicking a row opens the session detail card. */
  onOpenDetail: (session: RecordingSession) => void;
}) {
  // The server already returns the rows status-filtered (classified to match the
  // stat-card counts), so render them directly — no client-side re-filtering.
  const rows = sessions ?? [];

  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Users size={20} />
            <div>
              <h1 className="text-2xl font-semibold">Sessions</h1>
              <p className="mt-1 text-sm text-muted">
                Drill into sessions by status{contestSlug ? <> for contest <span className="font-mono font-medium">{contestSlug}</span></> : null}. Click a stat card on Live stats to jump straight to a status, or click a row for the full detail card.
              </p>
            </div>
          </div>
          <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <FilterSelect
            label="Status"
            value={statusFilter}
            options={SESSIONS_STATUS_OPTIONS}
            onChange={(value) => onStatusFilterChange(value as SessionsStatusFilter)}
          />
          <p className="text-xs text-muted">
            Showing <span className="font-medium text-ink">{rows.length}</span> session{rows.length === 1 ? "" : "s"}.
          </p>
        </div>
        {statusFilter === "disconnected" ? (
          <p className="mt-3 inline-flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle size={14} /> "Disconnected" is a derived liveness state — the server classifies these as active sessions whose latest liveness signal has gone stale.
          </p>
        ) : null}
      </div>

      {unavailable ? (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          <AlertTriangle size={16} className="mr-2 inline" />
          The sessions-list endpoint is not deployed yet, so the Sessions list is unavailable. Live stats still work; deploy the sessions-list API to enable this drill-down.
        </div>
      ) : sessions === null ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">{loading ? "Loading sessions…" : "No sessions loaded yet."}</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">No sessions match this status.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel shadow-subtle">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-semibold">Candidate</th>
                <th className="px-4 py-3 font-semibold">Room</th>
                <th className="px-4 py-3 font-semibold">Contest</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Chunks</th>
                <th className="px-4 py-3 font-semibold">Started</th>
                {statusFilter === "pending_approval" ? <th className="px-4 py-3 font-semibold">Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                // F6.3: the whole row opens the detail card (cursor + hover make
                // it discoverable); the Approve quick action stops propagation.
                <tr
                  key={s.session_id}
                  onClick={() => onOpenDetail(s)}
                  title="Open session detail"
                  className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-ink/5"
                >
                  <td className="px-4 py-3">
                    <div className="font-semibold text-ink">
                      {candidateIdOf(s)}
                      {s.identity_unresolved ? (
                        <span
                          className="ml-2 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning"
                          title="The typed ID matched no enrolled person (roster cleared / never matched) — this session is keyed anonymously and its scores appear as an unmatched identity on Results."
                        >
                          identity unresolved
                        </span>
                      ) : null}
                    </div>
                    {s.name ? <div className="text-xs text-muted">{s.name}</div> : null}
                  </td>
                  <td className="px-4 py-3 text-muted">{s.room || "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">{s.contest_slug || "—"}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full border border-line px-2.5 py-0.5 text-xs font-medium text-ink">{s.status}</span>
                  </td>
                  {/* LT-7: show the GROUND-TRUTH stored-chunk count (the real number
                      of objects in GCS, matching the detail card) when the list was
                      loaded with it; fall back to the mint chunk_count for the cheap
                      auto-poll path / older backends. */}
                  <td className="px-4 py-3 font-mono text-muted">{s.stored_chunk_count ?? s.chunk_count}</td>
                  <td className="px-4 py-3 text-xs text-muted">{s.created_at ? new Date(s.created_at).toLocaleString() : "—"}</td>
                  {statusFilter === "pending_approval" ? (
                    <td className="px-4 py-3">
                      {/* F6 review: same explanatory tooltip as every other Approve. */}
                      <ActionTooltip tip={SESSION_ACTION_INFO.approve.tooltip}>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onApprove(s);
                          }}
                          disabled={s.status !== "pending_approval"}
                          className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/40 disabled:opacity-50"
                        >
                          <CheckCircle2 size={14} /> Approve
                        </button>
                      </ActionTooltip>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
