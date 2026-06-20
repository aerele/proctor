// frontend/src/admin/views/AttendancePanel.tsx
// Roster-based attendance panel, extracted verbatim from App.tsx (F3).
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Download, RefreshCw, UserCheck, Users } from "lucide-react";
import { fetchAttendance } from "../../api";
import { buildAbsenteesCsv, type AttendanceReport } from "../../attendance/computeAttendance";
import { StatCard } from "../../ui/StatCard";

// not-taken counts (in-progress vs completed) + the absentee list with CSV export.
// Self-contained (own load/error state, like ContestEvalAlertTypesSection): loads
// when the tab mounts and when the global contest filter changes; manual Refresh
// only — NO auto-poll (each call scans the whole roster + session set). Degrades
// to "not deployed yet" when fetchAttendance returns null (endpoint 404).
export function AttendancePanel({ password, contestSlug }: { password: string; contestSlug: string }) {
  const [report, setReport] = useState<AttendanceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await fetchAttendance(password, contestSlug || undefined);
      if (next === null) {
        setUnavailable(true);
        setReport(null);
        return;
      }
      setUnavailable(false);
      setReport(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable per render inputs
  }, [contestSlug]);

  const downloadCsv = () => {
    if (!report || !report.configured) return;
    const csv = buildAbsenteesCsv(report.absentees);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "absentees.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const needle = filter.trim().toLowerCase();
  const rows = report && report.configured
    ? report.absentees.filter(
        (a) =>
          !needle ||
          a.unique_id.toLowerCase().includes(needle) ||
          a.name.toLowerCase().includes(needle) ||
          a.roll_number.toLowerCase().includes(needle) ||
          a.room.toLowerCase().includes(needle)
      )
    : [];

  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <UserCheck size={20} />
            <div>
              <h1 className="text-2xl font-semibold">Attendance</h1>
              <p className="mt-1 text-sm text-muted">
                Roster-based attendance{contestSlug ? <> for contest <span className="font-mono font-medium">{contestSlug}</span></> : null}: who has taken the test, who is still in it, and who never showed up. Loads on open; Refresh to update.
              </p>
            </div>
          </div>
          <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      {error ? <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div> : null}

      {unavailable ? (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          <AlertTriangle size={16} className="mr-2 inline" />
          The attendance endpoint is not deployed yet. Deploy the backend to enable attendance stats.
        </div>
      ) : report === null ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">{loading ? "Loading attendance…" : "No attendance loaded yet."}</div>
      ) : !report.configured ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">
          No student roster is configured, so attendance cannot be computed. Upload a roster in Settings → Candidate roster first.
        </div>
      ) : (
        <>
          {/* KPR 2026-06-12: enrollment-spine fallback after a roster clear — say so explicitly. */}
          {report.source === "enrollments" && report.note ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
              <AlertTriangle size={16} className="mr-2 inline" />{report.note}
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard label="On roster" value={report.roster_total} tone="ink" icon={<Users size={18} />} />
            <StatCard label="Taken" value={report.taken.total} tone="accent" icon={<UserCheck size={18} />} />
            <StatCard label="In progress" value={report.taken.in_progress} tone="warning" icon={<Clock size={18} />} />
            <StatCard label="Completed" value={report.taken.completed} tone="muted" icon={<CheckCircle2 size={18} />} />
            <StatCard label="Not taken" value={report.not_taken} tone="danger" icon={<AlertTriangle size={18} />} />
          </div>

          {report.unmatched_sessions > 0 ? (
            <p className="inline-flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertTriangle size={14} /> {report.unmatched_sessions} session{report.unmatched_sessions === 1 ? "" : "s"} could not be tied to the roster (started before the roster was uploaded, or under a replaced roster) — not counted as attendance.
            </p>
          ) : null}

          <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Absentees</h2>
                <p className="mt-1 text-xs text-muted">
                  {report.not_taken} roster student{report.not_taken === 1 ? "" : "s"} with no session — as of {new Date(report.generated_at).toLocaleString()}.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  className="focus-ring h-9 rounded-md border border-line px-3 text-sm"
                  placeholder="Filter by ID, name, roll, room"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
                <button
                  className="focus-ring inline-flex h-9 items-center justify-center gap-2 rounded-md border border-line px-3 text-sm font-medium disabled:opacity-50"
                  onClick={downloadCsv}
                  disabled={report.not_taken === 0}
                >
                  <Download size={14} /> Download CSV
                </button>
              </div>
            </div>

            {report.not_taken === 0 ? (
              <p className="mt-4 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent">Full house — every roster student has a session.</p>
            ) : rows.length === 0 ? (
              <p className="mt-4 text-sm text-muted">No absentees match this filter.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                      <th className="px-4 py-3 font-semibold">Unique ID</th>
                      <th className="px-4 py-3 font-semibold">Name</th>
                      <th className="px-4 py-3 font-semibold">Roll number</th>
                      <th className="px-4 py-3 font-semibold">Room</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => (
                      <tr key={a.unique_id} className="border-b border-line/60 last:border-0">
                        <td className="px-4 py-3 font-mono text-xs font-semibold text-ink">{a.unique_id}</td>
                        <td className="px-4 py-3">{a.name || "—"}</td>
                        <td className="px-4 py-3 text-muted">{a.roll_number || "—"}</td>
                        <td className="px-4 py-3 text-muted">{a.room || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
