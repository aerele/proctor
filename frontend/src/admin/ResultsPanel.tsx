// frontend/src/admin/ResultsPanel.tsx
// S-J: the Results tab (vision §2.14, surface A6) — the post-exam admin surface.
// ADMIN-ONLY: candidates never see others' scores (hiring context). A ranked
// table (rank + label-driven id + name + college + total + per-problem best +
// integrity column + selection) with filters (college / room / score /
// no-critical-alerts / text / selection), bulk selection transitions driving
// shortlisted/selected/rejected, a "Mark selection done" action that stamps the
// retention clock, and CSV export. App.tsx touchpoints stay minimal: import +
// nav tab + a render branch, scoped by the global contest selector.
import { AlertTriangle, Award, BrainCircuit, CheckCircle2, ChevronDown, ChevronRight, Download, Flag, RefreshCw, ShieldAlert, Users } from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  adminContestEvaluate, adminContestEvaluations, fetchContestResults, markSelectionDone, setContestSelection,
  type ContestScorecard
} from "../api";
import {
  buildResultsCsv, canMarkSelectionDone, countUnmatched, evalFlagsLabel, filterResultRows, selectionCounts,
  type ContestResultsResponse, type EvalIntegrityFilter, type EvalTalentFilter,
  type ResultFilters, type ResultRow, type RowEvaluation, type SelectionStatus
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

// P1 candidate-evaluation tier presentation. Talent reads "good→bad" on the
// accent/ink scale; integrity escalates clean→confirmed on the danger scale —
// same border/bg/text chip vocabulary as the selection + verdict badges.
const TALENT_LABEL: Record<RowEvaluation["talent_tier"], string> = { strong: "Strong", moderate: "Moderate", weak: "Weak" };
const TALENT_TONE: Record<RowEvaluation["talent_tier"], string> = {
  strong: "border-accent/40 bg-accent/10 text-accent",
  moderate: "border-ink/20 bg-ink/5 text-ink",
  weak: "border-line bg-white text-muted"
};
const INTEGRITY_LABEL: Record<RowEvaluation["integrity_tier"], string> = { clean: "Clean", watch: "Watch", flag: "Flag", confirmed: "Confirmed" };
const INTEGRITY_TONE: Record<RowEvaluation["integrity_tier"], string> = {
  clean: "border-accent/40 bg-accent/10 text-accent",
  watch: "border-warning/40 bg-warning/10 text-warning",
  flag: "border-danger/40 bg-danger/10 text-danger",
  confirmed: "border-danger/60 bg-danger/20 text-danger"
};
// Severity tone for the evidence-drawer flag list (mirrors the integrity column chips).
const FLAG_SEVERITY_TONE: Record<ContestScorecard["flags"][number]["severity"], string> = {
  critical: "border-danger/40 bg-danger/10 text-danger",
  warning: "border-warning/40 bg-warning/10 text-warning",
  info: "border-line bg-white text-muted"
};
const TALENT_FILTERS: EvalTalentFilter[] = ["all", "strong", "moderate", "weak"];
const INTEGRITY_FILTERS: EvalIntegrityFilter[] = ["all", "clean", "watch", "flag", "confirmed"];

// The Talent column cell: tier badge + the sortable composite number ("—" when
// the row has no scorecard, incl. unmatched rows the evaluator never scored).
function TalentCell({ evaluation }: { evaluation: RowEvaluation | null }) {
  if (!evaluation) return <span className="text-xs text-muted">—</span>;
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${TALENT_TONE[evaluation.talent_tier]}`}>{TALENT_LABEL[evaluation.talent_tier]}</span>
      <span className="font-mono text-xs text-muted" title="Talent composite (0–100)">{evaluation.composite}</span>
    </div>
  );
}

// The Eval-Integrity column cell: tier badge + compact "2C/1W" flag counts +
// a confidence dot (green high / amber medium / grey low).
const CONFIDENCE_DOT: Record<RowEvaluation["confidence"], string> = { high: "bg-accent", medium: "bg-warning", low: "bg-line" };
function EvalIntegrityCell({ evaluation }: { evaluation: RowEvaluation | null }) {
  if (!evaluation) return <span className="text-xs text-muted">—</span>;
  const f = evaluation.flags_by_severity;
  const counts = [f.critical ? `${f.critical}C` : "", f.warning ? `${f.warning}W` : "", f.info ? `${f.info}I` : ""].filter(Boolean).join("/");
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${INTEGRITY_TONE[evaluation.integrity_tier]}`}>{INTEGRITY_LABEL[evaluation.integrity_tier]}</span>
      {counts ? <span className="font-mono text-xs text-muted" title={evalFlagsLabel(f)}>{counts}</span> : null}
      <span className={`inline-block h-2 w-2 rounded-full ${CONFIDENCE_DOT[evaluation.confidence]}`} title={`Confidence: ${evaluation.confidence}`} />
    </div>
  );
}

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

// P1: the per-row expandable evidence drawer. Shows tiers.one_line + the
// scorecard's flag list (severity chip + code + evidence line). Falls back
// gracefully while the corpus is loading and for rows with no scorecard.
function EvidenceDrawer({ evaluation, scorecard, loading }: { evaluation: RowEvaluation | null; scorecard: ContestScorecard | null; loading: boolean }) {
  // The row's one-line summary is available off the row's own evaluation even
  // before the (heavier) full scorecard corpus arrives.
  const oneLine = scorecard?.tiers.one_line || evaluation?.one_line || "";
  if (!evaluation && !scorecard) {
    return <p className="text-xs text-muted">No evaluation for this candidate. Run “Evaluate contest” to score the cohort.</p>;
  }
  return (
    <div className="space-y-2">
      {oneLine ? <p className="text-sm text-ink">{oneLine}</p> : null}
      {loading ? (
        <p className="text-xs text-muted">Loading evidence…</p>
      ) : scorecard && scorecard.flags.length > 0 ? (
        <ul className="space-y-1">
          {scorecard.flags.map((flag, i) => (
            <li key={`${flag.code}:${i}`} className="flex items-start gap-2 text-xs">
              <span className={`mt-0.5 inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 font-medium uppercase tracking-wide ${FLAG_SEVERITY_TONE[flag.severity]}`}>{flag.severity}</span>
              <span className="font-mono text-muted">{flag.code}{flag.problem_id ? <span className="ml-1 text-line">· {flag.problem_id}</span> : null}</span>
              <span className="text-ink">{flag.evidence}</span>
            </li>
          ))}
        </ul>
      ) : scorecard ? (
        <p className="text-xs text-muted">No integrity flags raised for this candidate.</p>
      ) : null}
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
  // P1 candidate-evaluation: the "Evaluate contest" batch loop progress, the
  // lazily-fetched scorecard corpus (keyed by identity), and the set of
  // expanded evidence drawers. evalsByKey===null = not fetched yet.
  const [evalRunning, setEvalRunning] = useState(false);
  const [evalProgress, setEvalProgress] = useState(0);
  const [evalsByKey, setEvalsByKey] = useState<Map<string, ContestScorecard> | null>(null);
  const [evalsLoading, setEvalsLoading] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

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
    // A new contest invalidates the cached scorecard corpus + open drawers.
    setEvalsByKey(null);
    setExpandedRows(new Set());
    setEvalProgress(0);
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
  // KPR 2026-06-12: unmatched submitter rows (identities not on the roster).
  const unmatchedTotal = useMemo(() => countUnmatched(rows), [rows]);

  // Selection operates on enrollments — unmatched rows have no person_id, so
  // they are excluded from select-all and their checkboxes are disabled.
  const visibleIds = visibleRows.filter((r) => !r.unmatched).map((r) => r.person_id);
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

  // The scorecard join key: person_id for enrolled rows, username_norm for
  // unmatched ones — the SAME identity_key the backend stamps on each scorecard.
  const rowKey = (row: ResultRow) => row.person_id || row.username_norm || "";

  // P1: "Evaluate contest" — loop the batch endpoint carrying the returned
  // cursor until done:true, surfacing the running evaluated count, then refetch
  // results (so the new scorecards land on the rows) and drop the stale corpus.
  const onEvaluate = async () => {
    if (!configured || evalRunning) return;
    setEvalRunning(true);
    setEvalProgress(0);
    setError("");
    try {
      let cursor: string | null | undefined;
      let total = 0;
      // Bounded loop guard: even a large cohort terminates well under this.
      for (let guard = 0; guard < 10000; guard += 1) {
        const res = await adminContestEvaluate(password, { contest: data.contest_slug, cursor });
        total += res.evaluated;
        setEvalProgress(total);
        if (res.done) break;
        cursor = res.cursor;
      }
      // Fresh scorecards exist now — invalidate the cached corpus + reload rows.
      setEvalsByKey(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setEvalRunning(false);
    }
  };

  // P1: lazily fetch the scorecard corpus the FIRST time any evidence drawer
  // opens, cache it keyed by identity, and reuse for every subsequent drawer.
  const ensureScorecards = async (): Promise<Map<string, ContestScorecard> | null> => {
    if (evalsByKey) return evalsByKey;
    if (!configured) return null;
    setEvalsLoading(true);
    try {
      const res = await adminContestEvaluations(password, data.contest_slug);
      const map = new Map<string, ContestScorecard>();
      for (const card of res.evaluations) map.set(card.identity_key, card);
      setEvalsByKey(map);
      return map;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setEvalsLoading(false);
    }
  };

  const toggleDrawer = (key: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else { next.add(key); void ensureScorecards(); }
      return next;
    });
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

          {/* KPR 2026-06-12: unmatched submitters are shown LOUDLY, never dropped. */}
          {unmatchedTotal > 0 ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
              <AlertTriangle size={16} className="mr-2 inline" />
              <span className="font-semibold">{unmatchedTotal} submitter{unmatchedTotal === 1 ? "" : "s"} not on the roster</span>
              {" — scores shown from submissions. "}
              They joined without a roster match (for example after a roster clear), so their identity is the ID typed at login, not a verified roster person. Rows are badged "unmatched identity" and excluded from selection actions.
            </div>
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
              {/* P1 candidate-evaluation tier filters. "All" is the no-op; any
                  other pick drops rows without a matching scorecard. */}
              <label className="flex flex-col text-xs font-medium text-muted">
                Talent
                <select className="focus-ring mt-1 h-9 rounded-md border border-line px-2 text-sm text-ink" value={filters.evalTalent ?? "all"} onChange={(e) => setFilters((f) => ({ ...f, evalTalent: e.target.value as EvalTalentFilter }))}>
                  {TALENT_FILTERS.map((t) => <option key={t} value={t}>{t === "all" ? "All" : TALENT_LABEL[t]}</option>)}
                </select>
              </label>
              <label className="flex flex-col text-xs font-medium text-muted">
                Eval integrity
                <select className="focus-ring mt-1 h-9 rounded-md border border-line px-2 text-sm text-ink" value={filters.evalIntegrity ?? "all"} onChange={(e) => setFilters((f) => ({ ...f, evalIntegrity: e.target.value as EvalIntegrityFilter }))}>
                  {INTEGRITY_FILTERS.map((t) => <option key={t} value={t}>{t === "all" ? "All" : INTEGRITY_LABEL[t]}</option>)}
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
              {/* P1: run the cheating + talent evaluator over the whole contest.
                  Loops the batch endpoint to completion, then refetches rows. */}
              <button
                className="focus-ring inline-flex h-9 items-center justify-center gap-2 rounded-md border border-line px-3 text-sm font-medium disabled:opacity-50"
                disabled={busy || evalRunning}
                onClick={() => void onEvaluate()}
                title="Run the cheating + talent evaluator over this contest's submissions and telemetry"
              >
                <BrainCircuit size={14} className={evalRunning ? "animate-pulse" : undefined} />
                {evalRunning ? `Evaluating ${evalProgress}…` : "Evaluate contest"}
              </button>
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
                    <th className="px-1 py-3" aria-label="Evidence" />
                    <th className="px-3 py-3 font-semibold">#</th>
                    <th className="px-3 py-3 font-semibold">Candidate</th>
                    <th className="px-3 py-3 font-semibold text-right">Total</th>
                    {problems.map((p) => <th key={p.problem_id} className="px-3 py-3 font-semibold text-right" title={p.problem_id}>{p.title}</th>)}
                    <th className="px-3 py-3 font-semibold" title="Talent tier + 0–100 composite from the evaluator">Talent</th>
                    <th className="px-3 py-3 font-semibold" title="Evaluator integrity tier + flag counts + confidence">Eval integrity</th>
                    <th className="px-3 py-3 font-semibold">Integrity</th>
                    <th className="px-3 py-3 font-semibold">Selection</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length === 0 ? (
                    <tr><td colSpan={9 + problems.length} className="px-3 py-6 text-center text-sm text-muted">No candidates match these filters.</td></tr>
                  ) : visibleRows.map((row) => {
                    const key = rowKey(row);
                    const expanded = expandedRows.has(key);
                    const scorecard = evalsByKey?.get(key) ?? null;
                    return (
                    <Fragment key={row.person_id || `unmatched:${row.username_norm ?? row.candidate_id}`}>
                    <tr className={`border-b border-line/60 last:border-0 ${expanded ? "" : ""} ${selectedIds.has(row.person_id) && !row.unmatched ? "bg-ink/5" : ""}`}>
                      <td className="px-2 py-3"><input type="checkbox" checked={!row.unmatched && selectedIds.has(row.person_id)} onChange={() => toggleRow(row.person_id)} disabled={Boolean(row.unmatched)} aria-label={`Select ${row.candidate_id}`} title={row.unmatched ? "Unmatched identity — not an enrollment, selection actions unavailable" : undefined} /></td>
                      <td className="px-1 py-3">
                        <button className="focus-ring inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:text-ink" onClick={() => toggleDrawer(key)} aria-label={expanded ? `Hide evidence for ${row.candidate_id}` : `Show evidence for ${row.candidate_id}`} aria-expanded={expanded} title="Evaluator evidence">
                          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td className="px-3 py-3 font-semibold text-ink">{row.rank}</td>
                      <td className="px-3 py-3">
                        <div className="font-medium text-ink">{row.name || "—"}</div>
                        <div className="font-mono text-xs text-muted">
                          {row.display_id}
                          {row.from_snapshot ? <span className="ml-2 rounded bg-line/60 px-1 text-[10px] uppercase tracking-wide">snapshot</span> : null}
                          {row.unmatched ? <span className="ml-2 rounded border border-warning/40 bg-warning/10 px-1 text-[10px] uppercase tracking-wide text-warning" title="This identity matched no roster enrollment — score computed from submissions; identity is as typed at login.">unmatched identity</span> : null}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-semibold text-ink">{row.total}</td>
                      {problems.map((p) => {
                        const cell = row.per_problem.find((c) => c.problem_id === p.problem_id);
                        const score = cell?.best_score ?? 0;
                        const full = cell ? score >= cell.max_points && cell.max_points > 0 : false;
                        return <td key={p.problem_id} className={`px-3 py-3 text-right ${full ? "font-semibold text-accent" : score > 0 ? "text-ink" : "text-muted"}`}>{score}</td>;
                      })}
                      {/* P1: Talent + Eval-Integrity cells — render "—" for evaluation:null
                          (unevaluated rows AND unmatched rows without scorecards). */}
                      <td className="px-3 py-3"><TalentCell evaluation={row.evaluation} /></td>
                      <td className="px-3 py-3"><EvalIntegrityCell evaluation={row.evaluation} /></td>
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
                    {expanded ? (
                      <tr className="border-b border-line/60 bg-ink/[0.02]">
                        <td colSpan={9 + problems.length} className="px-4 py-3">
                          <EvidenceDrawer evaluation={row.evaluation} scorecard={scorecard} loading={evalsLoading && !scorecard} />
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
