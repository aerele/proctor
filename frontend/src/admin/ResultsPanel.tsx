// frontend/src/admin/ResultsPanel.tsx
// S-J: the Results tab (vision §2.14, surface A6) — the post-exam admin surface.
// ADMIN-ONLY: candidates never see others' scores (hiring context). A ranked
// table (rank + label-driven id + name + college + total + per-problem best +
// integrity column + selection) with filters (college / room / score /
// no-critical-alerts / text / selection), bulk selection transitions driving
// shortlisted/selected/rejected, a "Mark selection done" action that stamps the
// retention clock, and CSV export. App.tsx touchpoints stay minimal: import +
// nav tab + a render branch, scoped by the global contest selector.
import { AlertTriangle, Award, CheckCircle2, Download, Flag, RefreshCw, ShieldAlert, Users } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchContestResults, markSelectionDone, setContestSelection } from "../api";
import {
  buildResultsCsv, canMarkSelectionDone, filterResultRows, selectionCounts,
  type ContestResultsResponse, type ResultFilters, type ResultRow, type SelectionStatus
} from "../results/computeResults";

const SELECTION_LABELS: Record<SelectionStatus, string> = {
  none: "Unmarked", shortlisted: "Shortlisted", selected: "Selected", rejected: "Rejected"
};
const SELECTION_TONE: Record<SelectionStatus, string> = {
  none: "border-line bg-white text-muted",
  shortlisted: "border-warning/40 bg-warning/10 text-warning",
  selected: "border-accent/40 bg-accent/10 text-accent",
  rejected: "border-danger/40 bg-danger/10 text-danger"
};
// The bulk-action targets (none = "unmark"). Shown as buttons over the selected set.
const BULK_ACTIONS: SelectionStatus[] = ["shortlisted", "selected", "rejected", "none"];

function ResultStatCard({ label, value, tone, icon }: { label: string; value: number | string; tone: string; icon: ReactNode }) {
  return (
    <div className={`rounded-lg border p-5 shadow-subtle ${tone}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
        {icon}
      </div>
      <p className="mt-3 text-3xl font-semibold text-ink">{value}</p>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: ResultRow["integrity"]["review_verdict"] }) {
  if (verdict === "flagged") return <span className="inline-flex items-center gap-1 rounded-md border border-danger/40 bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger"><Flag size={12} /> Flagged</span>;
  if (verdict === "cleared") return <span className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent"><CheckCircle2 size={12} /> Cleared</span>;
  return <span className="text-xs text-muted">—</span>;
}

export function ResultsPanel({ password, contestSlug }: { password: string; contestSlug: string }) {
  const [data, setData] = useState<ContestResultsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState<ResultFilters>({});

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await fetchContestResults(password, contestSlug);
      if (next === null) { setUnavailable(true); setData(null); return; }
      setUnavailable(false);
      setData(next);
      setSelectedIds(new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable per inputs
  }, [contestSlug]);

  const configured = data?.configured === true;
  const rows = configured ? data.rows : [];
  const problems = configured ? data.problems : [];
  const colleges = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) if (row.college_norm) map.set(row.college_norm, row.college || row.college_norm);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);
  const roomOptions = useMemo(() => [...new Set(rows.map((r) => r.room).filter(Boolean))].sort(), [rows]);
  const visibleRows = useMemo(() => filterResultRows(rows, filters), [rows, filters]);
  const counts = useMemo(() => selectionCounts(rows), [rows]);

  const visibleIds = visibleRows.map((r) => r.person_id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

  const toggleRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const id of visibleIds) next.delete(id);
      else for (const id of visibleIds) next.add(id);
      return next;
    });
  };

  const applySelection = async (status: SelectionStatus) => {
    if (!configured || selectedIds.size === 0) return;
    setBusy(true);
    setError("");
    try {
      await setContestSelection(password, { contest: data.contest_slug, person_ids: [...selectedIds], selection_status: status });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const onMarkSelectionDone = async () => {
    if (!configured) return;
    if (!window.confirm(
      "Mark selection done?\n\nThis freezes each candidate's final score + selection into a snapshot that survives a later data purge, and starts the evidence-retention clock. You can still change selections afterward, but the snapshot is taken now."
    )) return;
    setBusy(true);
    setError("");
    try {
      await markSelectionDone(password, data.contest_slug);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const downloadCsv = () => {
    if (!configured) return;
    const csv = buildResultsCsv(visibleRows, problems);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `results-${data.contest_slug}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // FIX-B3 #3: gate "Mark selection done" on at least one persisted final
  // verdict (Selected OR Rejected) — the precondition the disabled tooltip now
  // states. "Shortlisted"/unset don't count as a final decision.
  const canFinalizeSelection = configured && canMarkSelectionDone(rows);

  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Award size={20} />
            <div>
              <h1 className="text-2xl font-semibold">Results</h1>
              <p className="mt-1 text-sm text-muted">
                Ranked results{contestSlug ? <> for contest <span className="font-mono font-medium">{contestSlug}</span></> : null}: score, per-problem breakdown, integrity evidence, and selection. Admin-only — candidates never see each other's scores. Loads on open; Refresh to update.
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
          The results endpoint is not deployed yet. Deploy the backend to enable the Results tab.
        </div>
      ) : data === null ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">{loading ? "Loading results…" : "No results loaded yet."}</div>
      ) : !configured ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">
          Results are available for person-mode contests with a roster. Pick a contest in the selector above, or upload a roster on the contest's detail page first.
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <ResultStatCard label="Candidates" value={rows.length} tone="border-ink/20 bg-ink/5 text-ink" icon={<Users size={18} />} />
            <ResultStatCard label="Shortlisted" value={counts.shortlisted} tone="border-warning/40 bg-warning/5 text-warning" icon={<Flag size={18} />} />
            <ResultStatCard label="Selected" value={counts.selected} tone="border-accent/30 bg-accent/5 text-accent" icon={<CheckCircle2 size={18} />} />
            <ResultStatCard label="Rejected" value={counts.rejected} tone="border-danger/30 bg-danger/5 text-danger" icon={<ShieldAlert size={18} />} />
            <ResultStatCard label="Top score" value={rows[0]?.total ?? 0} tone="border-line bg-white text-muted" icon={<Award size={18} />} />
          </div>

          {data.selection_done_at ? (
            <p className="inline-flex items-center gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent">
              <CheckCircle2 size={14} /> Selection marked done at {new Date(data.selection_done_at).toLocaleString()}. Snapshots are frozen and the evidence-retention clock is running.
            </p>
          ) : null}

          <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
            {/* Filters */}
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col text-xs font-medium text-muted">
                Search
                <input className="focus-ring mt-1 h-9 w-44 rounded-md border border-line px-3 text-sm text-ink" placeholder="ID or name" value={filters.search ?? ""} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} />
              </label>
              {colleges.length > 1 ? (
                <label className="flex flex-col text-xs font-medium text-muted">
                  College
                  <select className="focus-ring mt-1 h-9 rounded-md border border-line px-2 text-sm text-ink" value={filters.college ?? ""} onChange={(e) => setFilters((f) => ({ ...f, college: e.target.value }))}>
                    <option value="">All</option>
                    {colleges.map(([norm, name]) => <option key={norm} value={norm}>{name}</option>)}
                  </select>
                </label>
              ) : null}
              {roomOptions.length > 0 ? (
                <label className="flex flex-col text-xs font-medium text-muted">
                  Room
                  <select className="focus-ring mt-1 h-9 rounded-md border border-line px-2 text-sm text-ink" value={filters.room ?? ""} onChange={(e) => setFilters((f) => ({ ...f, room: e.target.value }))}>
                    <option value="">All</option>
                    {roomOptions.map((room) => <option key={room} value={room}>{room}</option>)}
                  </select>
                </label>
              ) : null}
              <label className="flex flex-col text-xs font-medium text-muted">
                Min score
                <input type="number" className="focus-ring mt-1 h-9 w-24 rounded-md border border-line px-3 text-sm text-ink" placeholder="any" value={filters.minScore ?? ""} onChange={(e) => setFilters((f) => ({ ...f, minScore: e.target.value === "" ? null : Number(e.target.value) }))} />
              </label>
              <label className="flex flex-col text-xs font-medium text-muted">
                Selection
                <select className="focus-ring mt-1 h-9 rounded-md border border-line px-2 text-sm text-ink" value={filters.selection ?? ""} onChange={(e) => setFilters((f) => ({ ...f, selection: e.target.value as SelectionStatus | "" }))}>
                  <option value="">All</option>
                  {(["none", "shortlisted", "selected", "rejected"] as SelectionStatus[]).map((s) => <option key={s} value={s}>{SELECTION_LABELS[s]}</option>)}
                </select>
              </label>
              <label className="mb-1 inline-flex items-center gap-2 text-xs font-medium text-muted">
                <input type="checkbox" checked={Boolean(filters.noCritical)} onChange={(e) => setFilters((f) => ({ ...f, noCritical: e.target.checked }))} />
                No critical alerts
              </label>
              <button className="focus-ring mb-1 inline-flex h-9 items-center justify-center gap-2 rounded-md border border-line px-3 text-sm font-medium disabled:opacity-50" onClick={downloadCsv}>
                <Download size={14} /> Export CSV
              </button>
            </div>

            {/* Bulk-selection toolbar */}
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line/60 pt-4">
              <span className="text-sm font-medium text-ink">{selectedIds.size} selected</span>
              {BULK_ACTIONS.map((status) => (
                <button
                  key={status}
                  className="focus-ring inline-flex h-9 items-center justify-center rounded-md border border-line px-3 text-sm font-medium disabled:opacity-50"
                  disabled={busy || selectedIds.size === 0}
                  onClick={() => void applySelection(status)}
                >
                  {status === "none" ? "Unmark" : `Mark ${SELECTION_LABELS[status].toLowerCase()}`}
                </button>
              ))}
              <span className="ml-auto" />
              <button
                className="focus-ring inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white disabled:opacity-50"
                disabled={busy || !canFinalizeSelection}
                onClick={() => void onMarkSelectionDone()}
                title={!canFinalizeSelection ? "Mark at least one candidate Selected or Rejected first" : "Freeze snapshots + start the retention clock"}
              >
                <CheckCircle2 size={14} /> Mark selection done
              </button>
            </div>

            {/* Ranked table */}
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                    <th className="px-2 py-3"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="Select all visible" /></th>
                    <th className="px-3 py-3 font-semibold">#</th>
                    <th className="px-3 py-3 font-semibold">Candidate</th>
                    <th className="px-3 py-3 font-semibold text-right">Total</th>
                    {problems.map((p) => <th key={p.problem_id} className="px-3 py-3 font-semibold text-right" title={p.problem_id}>{p.title}</th>)}
                    <th className="px-3 py-3 font-semibold">Integrity</th>
                    <th className="px-3 py-3 font-semibold">Selection</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length === 0 ? (
                    <tr><td colSpan={5 + problems.length} className="px-3 py-6 text-center text-sm text-muted">No candidates match these filters.</td></tr>
                  ) : visibleRows.map((row) => (
                    <tr key={row.person_id} className={`border-b border-line/60 last:border-0 ${selectedIds.has(row.person_id) ? "bg-ink/5" : ""}`}>
                      <td className="px-2 py-3"><input type="checkbox" checked={selectedIds.has(row.person_id)} onChange={() => toggleRow(row.person_id)} aria-label={`Select ${row.candidate_id}`} /></td>
                      <td className="px-3 py-3 font-semibold text-ink">{row.rank}</td>
                      <td className="px-3 py-3">
                        <div className="font-medium text-ink">{row.name || "—"}</div>
                        <div className="font-mono text-xs text-muted">{row.display_id}{row.from_snapshot ? <span className="ml-2 rounded bg-line/60 px-1 text-[10px] uppercase tracking-wide">snapshot</span> : null}</div>
                      </td>
                      <td className="px-3 py-3 text-right font-semibold text-ink">{row.total}</td>
                      {problems.map((p) => {
                        const cell = row.per_problem.find((c) => c.problem_id === p.problem_id);
                        const score = cell?.best_score ?? 0;
                        const full = cell ? score >= cell.max_points && cell.max_points > 0 : false;
                        return <td key={p.problem_id} className={`px-3 py-3 text-right ${full ? "font-semibold text-accent" : score > 0 ? "text-ink" : "text-muted"}`}>{score}</td>;
                      })}
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap items-center gap-1">
                          {row.integrity.alerts_by_severity.critical > 0 ? <span className="inline-flex items-center gap-1 rounded-md border border-danger/40 bg-danger/10 px-1.5 py-0.5 text-xs font-medium text-danger" title="critical alerts">{row.integrity.alerts_by_severity.critical}C</span> : null}
                          {row.integrity.alerts_by_severity.warning > 0 ? <span className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning" title="warning alerts">{row.integrity.alerts_by_severity.warning}W</span> : null}
                          {row.integrity.alerts_by_severity.info > 0 ? <span className="rounded-md border border-line px-1.5 py-0.5 text-xs text-muted" title="info alerts">{row.integrity.alerts_by_severity.info}I</span> : null}
                          {row.integrity.total_alerts === 0 && row.integrity.review_verdict === "none" ? <span className="text-xs text-muted">clear</span> : null}
                          <VerdictBadge verdict={row.integrity.review_verdict} />
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${SELECTION_TONE[row.selection_status]}`}>{SELECTION_LABELS[row.selection_status]}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
