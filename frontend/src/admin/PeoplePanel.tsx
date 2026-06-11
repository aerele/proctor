// frontend/src/admin/PeoplePanel.tsx
// S-J: the People tab (vision §2.14, surface A5) — the cross-round person view.
// Directory search (by college / id / name) → click a person → cross-round
// scorecard: one row per contest the person attempted (status, score, integrity,
// selection), reading LIVE data where it exists and FALLING BACK to the frozen
// final_snapshot after a purge (rows marked from a purged/archived contest,
// vision §10.2). Exportable CSV. ADMIN-ONLY. Deliberately NOT scoped to the
// global contest selector — the People view spans rounds by design.
import { AlertTriangle, ArrowLeft, Award, Download, Flag, RefreshCw, Search, ShieldAlert, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetchPeople, fetchPersonScorecard } from "../api";
import {
  buildScorecardCsv, filterDirectoryRows, rowSourceLabel, scorecardSummary,
  type DirectoryPerson, type PeopleDirectoryResponse, type PersonScorecardResponse,
  type ScorecardRow, type SelectionStatus
} from "../people/computePeople";

const SELECTION_LABELS: Record<SelectionStatus, string> = {
  none: "Unmarked", shortlisted: "Shortlisted", selected: "Selected", rejected: "Rejected"
};
const SELECTION_TONE: Record<SelectionStatus, string> = {
  none: "border-line bg-white text-muted",
  shortlisted: "border-warning/40 bg-warning/10 text-warning",
  selected: "border-accent/40 bg-accent/10 text-accent",
  rejected: "border-danger/40 bg-danger/10 text-danger"
};

function VerdictBadge({ verdict }: { verdict: ScorecardRow["integrity"]["review_verdict"] }) {
  if (verdict === "flagged") return <span className="inline-flex items-center gap-1 rounded-md border border-danger/40 bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger"><Flag size={12} /> Flagged</span>;
  if (verdict === "cleared") return <span className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">Cleared</span>;
  return <span className="text-xs text-muted">—</span>;
}

function SourceBadge({ row }: { row: ScorecardRow }) {
  const label = rowSourceLabel(row);
  if (label === "purged") return <span className="inline-flex items-center gap-1 rounded-md border border-muted/40 bg-muted/10 px-2 py-0.5 text-xs font-medium text-muted" title="Numbers from a frozen snapshot — this contest's evidence was purged">Purged · snapshot</span>;
  if (label === "snapshot") return <span className="inline-flex items-center gap-1 rounded-md border border-muted/40 bg-muted/10 px-2 py-0.5 text-xs font-medium text-muted" title="Numbers from the selection-done snapshot">Snapshot</span>;
  return <span className="text-xs text-accent">Live</span>;
}

export function PeoplePanel({ password }: { password: string }) {
  const [directory, setDirectory] = useState<PeopleDirectoryResponse | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [college, setCollege] = useState("");

  const [selectedPerson, setSelectedPerson] = useState<DirectoryPerson | null>(null);
  const [scorecard, setScorecard] = useState<PersonScorecardResponse | null>(null);
  const [cardLoading, setCardLoading] = useState(false);

  const loadDirectory = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await fetchPeople(password, { search, college });
      if (next === null) { setUnavailable(true); setDirectory(null); return; }
      setUnavailable(false);
      setDirectory(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDirectory();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only; search re-filters client-side
  }, []);

  const openPerson = async (person: DirectoryPerson) => {
    setSelectedPerson(person);
    setScorecard(null);
    setCardLoading(true);
    setError("");
    try {
      setScorecard(await fetchPersonScorecard(password, person.person_id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCardLoading(false);
    }
  };

  const closePerson = () => { setSelectedPerson(null); setScorecard(null); };

  const colleges = directory?.configured ? directory.colleges : [];
  const allPeople = directory?.configured ? directory.people : [];
  // Instant client-side typeahead over the loaded directory; the backend reload
  // button re-fetches from the server for a fresh population.
  const visiblePeople = useMemo(() => filterDirectoryRows(allPeople, { search, college }), [allPeople, search, college]);

  const card = scorecard?.configured === true ? scorecard : null;
  const summary = useMemo(() => (card ? scorecardSummary(card.rows) : null), [card]);

  const downloadCsv = () => {
    if (!card) return;
    const csv = buildScorecardCsv({ unique_id: card.person.unique_id, name: card.person.name, college: card.person.college }, card.rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scorecard-${card.person.person_id}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Users size={20} />
            <div>
              <h1 className="text-2xl font-semibold">People</h1>
              <p className="mt-1 text-sm text-muted">
                Every candidate across all rounds, keyed by college + ID. Search the directory, then open a person for their cross-round scorecard. Scores from purged contests stay visible as snapshots.
              </p>
            </div>
          </div>
          <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={() => void loadDirectory()} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      {error ? <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div> : null}

      {unavailable ? (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          <AlertTriangle size={16} className="mr-2 inline" />
          The People endpoint is not deployed yet. Deploy the backend to enable the People tab.
        </div>
      ) : selectedPerson ? (
        // ---- person scorecard page ----
        <div className="space-y-4">
          <button className="focus-ring inline-flex items-center gap-2 text-sm font-medium text-muted hover:text-ink" onClick={closePerson}>
            <ArrowLeft size={16} /> Back to directory
          </button>
          <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">{selectedPerson.name || selectedPerson.unique_id}</h2>
                <p className="mt-1 text-sm text-muted">
                  <span className="font-mono font-medium">{selectedPerson.unique_id}</span> · {selectedPerson.college}
                </p>
              </div>
              {card ? (
                <button className="focus-ring inline-flex h-9 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium hover:bg-bg" onClick={downloadCsv}>
                  <Download size={15} /> Export CSV
                </button>
              ) : null}
            </div>
            {summary ? (
              <div className="mt-4 flex flex-wrap gap-3 text-sm">
                <span className="rounded-md border border-line bg-white px-3 py-1"><b>{summary.rounds}</b> round{summary.rounds === 1 ? "" : "s"}</span>
                <span className="rounded-md border border-line bg-white px-3 py-1">Best <b>{summary.best_total}</b></span>
                <span className="rounded-md border border-accent/40 bg-accent/10 px-3 py-1 text-accent"><b>{summary.selected}</b> selected</span>
                <span className="rounded-md border border-danger/40 bg-danger/10 px-3 py-1 text-danger"><b>{summary.rejected}</b> rejected</span>
                {summary.flagged > 0 ? <span className="rounded-md border border-danger/40 bg-danger/10 px-3 py-1 text-danger"><ShieldAlert size={13} className="mr-1 inline" /><b>{summary.flagged}</b> flagged</span> : null}
              </div>
            ) : null}
          </div>

          {cardLoading ? (
            <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">Loading scorecard…</div>
          ) : !card ? (
            <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">No scorecard for this person yet.</div>
          ) : card.rows.length === 0 ? (
            <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">This person has not attempted any contest yet.</div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line bg-panel shadow-subtle">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                    <th className="px-4 py-3">Contest</th>
                    <th className="px-4 py-3">Source</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3">Integrity</th>
                    <th className="px-4 py-3">Review</th>
                    <th className="px-4 py-3">Selection</th>
                  </tr>
                </thead>
                <tbody>
                  {card.rows.map((row) => (
                    <tr key={row.contest_slug} className="border-b border-line/60 last:border-0">
                      <td className="px-4 py-3">
                        <div className="font-medium">{row.contest_name}</div>
                        <div className="font-mono text-xs text-muted">{row.contest_slug}{row.source === "carry_over" ? " · carry-over" : ""}</div>
                      </td>
                      <td className="px-4 py-3"><SourceBadge row={row} /></td>
                      <td className="px-4 py-3 text-right font-semibold">{row.total}</td>
                      <td className="px-4 py-3">
                        {row.integrity.has_critical ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-danger"><ShieldAlert size={13} /> {row.integrity.alerts_by_severity.critical} critical</span>
                        ) : row.integrity.total_alerts > 0 ? (
                          <span className="text-xs text-warning">{row.integrity.alerts_by_severity.warning} warning</span>
                        ) : <span className="text-xs text-muted">clean</span>}
                      </td>
                      <td className="px-4 py-3"><VerdictBadge verdict={row.integrity.review_verdict} /></td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${SELECTION_TONE[row.selection_status]}`}>
                          {SELECTION_LABELS[row.selection_status]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        // ---- directory ----
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel p-4 shadow-subtle">
            <div className="relative flex-1 min-w-[220px]">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                className="focus-ring h-10 w-full rounded-md border border-line bg-white pl-9 pr-3 text-sm"
                placeholder="Search by ID or name"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="Search people by ID or name"
              />
            </div>
            <select className="focus-ring h-10 rounded-md border border-line bg-white px-3 text-sm" value={college} onChange={(event) => setCollege(event.target.value)} aria-label="Filter by college">
              <option value="">All colleges</option>
              {colleges.map((option) => <option key={option.college_norm} value={option.college_norm}>{option.name}</option>)}
            </select>
          </div>

          {loading && allPeople.length === 0 ? (
            <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">Loading directory…</div>
          ) : visiblePeople.length === 0 ? (
            <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">
              {allPeople.length === 0 ? "No people yet. Upload a person-mode contest roster, or adopt a legacy contest from its detail page." : "No people match your search."}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line bg-panel shadow-subtle">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                    <th className="px-4 py-3">ID</th>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">College</th>
                    <th className="px-4 py-3 text-right">Rounds</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {visiblePeople.map((person) => (
                    <tr key={person.person_id} className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-bg" onClick={() => void openPerson(person)}>
                      <td className="px-4 py-3 font-mono font-medium">{person.unique_id}</td>
                      <td className="px-4 py-3">{person.name || <span className="text-muted">—</span>}</td>
                      <td className="px-4 py-3">{person.college}</td>
                      <td className="px-4 py-3 text-right">{person.contest_count}</td>
                      <td className="px-4 py-3 text-right">
                        <button className="focus-ring inline-flex items-center gap-1 text-xs font-medium text-accent" onClick={(event) => { event.stopPropagation(); void openPerson(person); }}>
                          <Award size={13} /> Scorecard
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
