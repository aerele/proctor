// frontend/src/admin/views/settings.tsx
// Admin Settings sub-sections (candidate roster, proctor alert types, contest-eval
// alert types reference, review roster), extracted verbatim from App.tsx (F3).
import { Fragment, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bell, Download, ListChecks, RefreshCw, Search, UploadCloud, Users, X } from "lucide-react";
import { clearRoster, fetchRosterStatus, parseRosterInput, uploadRoster } from "../../api";
import type { ApiError } from "../../api";
import { parseRoster, suggestMapping, type ParsedRoster, type RosterFieldMapping } from "../../roster/parseRoster";
import { ROSTER_TEMPLATE_COLUMNS, buildRosterTemplateCsv } from "../../roster/rosterTemplate";
import { buildCollegeResolutions } from "../../roster/personRoster";
import type { AlertSettings, AlertSeverity, CollegeResolution, KnownCollege, NewCollegePreview, ProctorAlertTypeConfig, ReviewRosterSummary, RosterDuplicate, RosterStatus } from "../../types";

// Read-only reference list — contest-eval alert types are configured in
// monitoring/alert-config.json, NOT through this console.
const CONTEST_EVAL_ALERT_TYPES = ["peer_copy_cluster", "recurring_pair", "web_paste", "first_attempt_solve", "tough_first_attempt"] as const;

// SETTINGS tab — S2 candidate roster upload. The admin picks a CSV/TSV file, we
// parse it CLIENT-SIDE (roster/parseRoster.ts), preview the first rows, choose
// the unique-ID column (+ optional identity-field mappings, pre-suggested from
// the headers), and POST structured rows to /api/admin/roster. While a roster
// is configured, student login REQUIRES a roster match (enforced server-side).
//
// S-C: when `contestSlug` names a person contest the upload goes down the
// person-layer pipeline — the college column is COMPULSORY, unknown colleges
// block on a map-or-confirm panel (vision §2.2), and duplicate (college,
// unique_id) rows hard-reject the whole file with row numbers (vision §2.8).
export function CandidateRosterSection({ password, contestSlug }: { password: string; contestSlug: string }) {
  const [status, setStatus] = useState<RosterStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [parsed, setParsed] = useState<ParsedRoster | null>(null);
  const [fileName, setFileName] = useState("");
  const [uniqueIdColumn, setUniqueIdColumn] = useState("");
  const [mapping, setMapping] = useState<RosterFieldMapping>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  // F-D (KPR 2026-06-12): warn-only unique-ID shape warnings from the upload.
  const [idWarnings, setIdWarnings] = useState<string[]>([]);
  // S-C panels: the college map-or-confirm gate + per-college decisions
  // ("" = create new, otherwise the existing college_norm to map onto), and
  // the duplicate hard-reject rows.
  const [collegeGate, setCollegeGate] = useState<{ new_colleges: NewCollegePreview[]; known_colleges: KnownCollege[] } | null>(null);
  const [collegeDecisions, setCollegeDecisions] = useState<Record<string, string>>({});
  const [duplicates, setDuplicates] = useState<RosterDuplicate[] | null>(null);

  const contest = contestSlug.trim();

  const resetPanels = () => {
    setCollegeGate(null);
    setCollegeDecisions({});
    setDuplicates(null);
    setIdWarnings([]);
  };

  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await fetchRosterStatus(password, contest || undefined);
      if (next === null) setUnavailable(true);
      else {
        setUnavailable(false);
        setStatus(next);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    resetPanels();
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contest]);

  const onFile = async (file: File | null) => {
    setMessage("");
    setError("");
    resetPanels();
    if (!file) return;
    const text = await file.text();
    const result = parseRoster(text);
    if (!result.columns.length || !result.rows.length) {
      setParsed(null);
      setError(result.errors[0] || "Could not read any rows from that file.");
      return;
    }
    const suggestion = suggestMapping(result.columns);
    setParsed(result);
    setFileName(file.name);
    setUniqueIdColumn(suggestion.uniqueIdColumn);
    setMapping(suggestion.mapping);
  };

  const upload = async (resolutions?: Record<string, CollegeResolution>) => {
    if (!parsed || !uniqueIdColumn) return;
    setBusy(true);
    setMessage("");
    setError("");
    setDuplicates(null);
    try {
      const response = await uploadRoster(password, {
        ...(contest ? { contest } : {}),
        unique_id_column: uniqueIdColumn,
        columns: parsed.columns,
        column_mapping: mapping,
        rows: parsed.rows,
        ...(resolutions ? { college_resolutions: resolutions } : {})
      });
      if (response === null) {
        setUnavailable(true);
        return;
      }
      // S-C college gate: the upload BLOCKED on unknown colleges — render the
      // map-or-confirm panel and keep the parsed file for the re-post.
      if (response.needs_college_confirmation) {
        setCollegeGate({ new_colleges: response.new_colleges ?? [], known_colleges: response.known_colleges ?? [] });
        setCollegeDecisions(Object.fromEntries((response.new_colleges ?? []).map((c) => [c.college_norm, ""])));
        return;
      }
      resetPanels();
      setIdWarnings((response.id_shape_warnings ?? []).map((w) => w.message));
      const skipped = response.skipped ?? [];
      const personSummary = contest && response.enrollments
        ? ` Colleges created: ${(response.colleges_created ?? []).length}; enrollments +${response.enrollments.created}/${response.enrollments.reactivated} reactivated/${response.enrollments.removed} removed.`
        : "";
      const ambiguous = (response.ambiguous_ids ?? []).length;
      setMessage(
        `Roster saved: ${response.count ?? 0} students` +
        (skipped.length ? `; ${skipped.length} row(s) skipped (${summarizeSkipped(skipped)})` : "") +
        (ambiguous ? `; ${ambiguous} id(s) exist under multiple colleges — those candidates pick their college at login` : "") +
        ". Student login now requires a roster match." + personSummary
      );
      setParsed(null);
      setFileName("");
      await refresh();
    } catch (cause) {
      const apiError = cause as ApiError;
      // S-C duplicate hard-reject: the whole file bounced — show the rows.
      if (apiError?.code === "duplicate_unique_ids" && Array.isArray(apiError.body?.duplicates)) {
        setDuplicates(apiError.body.duplicates as RosterDuplicate[]);
        setError("Duplicate candidates in the file — fix the rows below and re-upload. Nothing was saved.");
        return;
      }
      if (apiError?.code === "college_required" && Array.isArray(apiError.body?.rows)) {
        setError(`The college cell is blank on row(s) ${(apiError.body.rows as number[]).join(", ")} — every row needs a college. Nothing was saved.`);
        return;
      }
      if (apiError?.code === "college_column_required") {
        setError("This contest requires a college column — map one under \"College column\" (or add a 'college' header to the file).");
        return;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const confirmColleges = () => {
    if (!collegeGate) return;
    void upload(buildCollegeResolutions(collegeDecisions));
  };

  const clear = async () => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      // F-B (KPR 2026-06-12): a LIVE contest with sessions/enrollments refuses
      // the clear until the admin types the contest slug — the server's 409
      // carries the exact consequence, shown verbatim in the dialog.
      let response: { ok: boolean } | null;
      try {
        response = await clearRoster(password, contest || undefined);
      } catch (cause) {
        const apiError = cause as ApiError;
        if (apiError?.code !== "roster_clear_confirmation_required" || !contest) throw cause;
        const consequence = String(
          (apiError.body as { consequence?: string } | undefined)?.consequence
          ?? "Existing sessions are keyed to roster persons; new joins will be keyed anonymously; Results will split."
        );
        const typed = window.prompt(`${consequence}

Type the contest slug "${contest}" to clear the roster anyway:`);
        if (typed === null || typed.trim() === "") return;
        response = await clearRoster(password, contest, typed.trim());
      }
      if (response === null) {
        setUnavailable(true);
        return;
      }
      setMessage(contest
        ? `Roster for contest "${contest}" cleared. Enrollments are kept — a re-upload reconciles them. Students joining from now on are keyed anonymously unless their typed ID exactly matches an enrolled person.`
        : "Roster cleared — student login no longer requires a roster match.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  // F8.3: client-side template download — headers are EXACTLY the parser's
  // accepted names (compulsory first), so the filled file re-uploads with
  // every column auto-mapped and unique_id pre-picked as the ID column.
  const downloadTemplate = () => {
    const blob = new Blob([buildRosterTemplateCsv()], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "roster-template.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const compulsoryHeaders = ROSTER_TEMPLATE_COLUMNS.filter((column) => column.required).map((column) => column.header);
  const optionalHeaders = ROSTER_TEMPLATE_COLUMNS.filter((column) => !column.required).map((column) => column.header);

  const mappingSelect = (field: keyof RosterFieldMapping, label: string) => (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <select
        className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
        value={mapping[field] ?? ""}
        onChange={(event) => setMapping({ ...mapping, [field]: event.target.value || undefined })}
      >
        <option value="">— not in this file —</option>
        {(parsed?.columns ?? []).map((column) => (
          <option key={column} value={column}>{column}</option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Users size={20} />
          <div>
            <h2 className="text-2xl font-semibold">Candidate roster</h2>
            <p className="mt-1 text-sm text-muted">
              Upload the student list (CSV/TSV, any columns) and pick the unique-ID column. While a roster is active, students must match it to log in.
            </p>
          </div>
        </div>
        <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line px-4 text-sm font-medium disabled:opacity-50" onClick={() => void refresh()} disabled={busy}>
          <RefreshCw size={16} className={busy ? "animate-spin" : undefined} /> Reload
        </button>
      </div>

      {unavailable ? (
        <div className="rounded-lg border border-line bg-white p-4 text-sm text-muted">
          The roster endpoints are not deployed on this backend yet.
        </div>
      ) : (
        <>
          <div className="rounded-md border border-line bg-white/60 p-3 text-sm">
            {contest ? (
              <div className="mb-1">
                <span className="font-semibold">Contest roster:</span> <span className="font-mono">{contest}</span>
                <span className="text-muted"> (from the contest filter above; the college column is compulsory)</span>
              </div>
            ) : null}
            {status?.configured ? (
              <span>
                <span className="font-semibold text-accent">Roster active:</span> {status.count} students · ID column <span className="font-mono">{status.unique_id_column}</span>
                {status.college_column ? <span> · college column <span className="font-mono">{status.college_column}</span></span> : null}
                {status.updated_at ? <span className="text-muted"> · updated {new Date(status.updated_at).toLocaleString()}</span> : null}
              </span>
            ) : (
              <span className="text-muted">
                {contest ? "No roster uploaded for this contest yet." : "No roster uploaded — student login is open (legacy form)."}
              </span>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label className="focus-ring inline-flex cursor-pointer items-center gap-2 rounded-md border border-line px-4 py-2 text-sm font-medium">
              <UploadCloud size={16} /> Choose roster file (.csv / .tsv)
              <input
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
                className="hidden"
                onChange={(event) => void onFile(event.target.files?.[0] ?? null)}
              />
            </label>
            {/* F8.3: pre-named template so colleges never need the column-mapping UI. */}
            <button
              type="button"
              onClick={downloadTemplate}
              className="focus-ring inline-flex items-center gap-2 rounded-md border border-line px-4 py-2 text-sm font-medium text-ink hover:border-ink/40"
            >
              <Download size={16} /> Download template CSV
            </button>
            {fileName ? <span className="text-sm text-muted">{fileName}</span> : null}
          </div>
          <p className="mt-2 text-xs text-muted">
            Template columns — compulsory: {compulsoryHeaders.map((header, index) => (
              <Fragment key={header}>{index > 0 ? ", " : null}<span className="font-mono font-semibold text-ink">{header}</span></Fragment>
            ))} · optional: {optionalHeaders.map((header, index) => (
              <Fragment key={header}>{index > 0 ? ", " : null}<span className="font-mono">{header}</span></Fragment>
            ))}. Ships with 2 example rows — replace them with your students. Files with other column names also work (you map the columns after choosing the file).
          </p>

          {parsed ? (
            <div className="mt-4 space-y-4">
              {parsed.errors.length ? (
                <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                  {parsed.errors.slice(0, 5).map((line) => <div key={line}>{line}</div>)}
                  {parsed.errors.length > 5 ? <div>…and {parsed.errors.length - 5} more.</div> : null}
                </div>
              ) : null}

              <div className="overflow-x-auto rounded-md border border-line">
                <table className="w-full text-left text-sm">
                  <thead className="bg-white/60 text-xs uppercase tracking-wide text-muted">
                    <tr>{parsed.columns.map((column) => <th key={column} className="px-3 py-2">{column}</th>)}</tr>
                  </thead>
                  <tbody>
                    {parsed.rows.slice(0, 5).map((row, index) => (
                      <tr key={index} className="border-t border-line">
                        {parsed.columns.map((column) => <td key={column} className="px-3 py-2">{row[column]}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted">Showing first {Math.min(5, parsed.rows.length)} of {parsed.rows.length} rows.</p>

              <div className="grid gap-3 md:grid-cols-3">
                <label className="block">
                  <span className="text-xs font-medium uppercase tracking-wide text-accent">Unique-ID column (required)</span>
                  <select
                    className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
                    value={uniqueIdColumn}
                    onChange={(event) => setUniqueIdColumn(event.target.value)}
                  >
                    {parsed.columns.map((column) => <option key={column} value={column}>{column}</option>)}
                  </select>
                </label>
                {mappingSelect("college", contest ? "College column (required)" : "College column")}
                {mappingSelect("name", "Name column")}
                {mappingSelect("email", "Email column")}
                {mappingSelect("roll_number", "Roll-number column")}
                {mappingSelect("hackerrank_username", "Candidate-ID column")}
                {mappingSelect("room", "Room column")}
              </div>

              {/* S-C: duplicate hard-reject panel — the exact rows the admin
                  has to fix in the file (1-based data rows; nothing saved). */}
              {duplicates?.length ? (
                <div className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm">
                  <div className="mb-2 font-semibold text-danger">Duplicate candidates — whole file rejected</div>
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs uppercase tracking-wide text-muted">
                      <tr><th className="py-1 pr-3">Row</th><th className="py-1 pr-3">College</th><th className="py-1 pr-3">Candidate ID</th><th className="py-1">Conflicts with row</th></tr>
                    </thead>
                    <tbody>
                      {duplicates.slice(0, 20).map((dup) => (
                        <tr key={`${dup.row}-${dup.unique_id}`} className="border-t border-danger/20">
                          <td className="py-1 pr-3 font-mono">{dup.row}</td>
                          <td className="py-1 pr-3">{dup.college}</td>
                          <td className="py-1 pr-3 font-mono">{dup.unique_id}</td>
                          <td className="py-1 font-mono">{dup.conflicts_with_row}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {duplicates.length > 20 ? <div className="mt-1 text-xs text-muted">…and {duplicates.length - 20} more.</div> : null}
                </div>
              ) : null}

              {/* S-C: college canonicalization gate (vision §2.2) — map each NEW
                  college name onto an existing college or confirm creating it.
                  This is the only enforceable moment to stop spelling drift. */}
              {collegeGate ? (
                <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
                  <div className="mb-2 font-semibold">
                    This upload creates {collegeGate.new_colleges.length} new college{collegeGate.new_colleges.length === 1 ? "" : "s"} — map or confirm each one
                  </div>
                  <div className="space-y-2">
                    {collegeGate.new_colleges.map((college) => (
                      <div key={college.college_norm} className="flex flex-wrap items-center gap-3">
                        <span className="font-mono font-semibold">{college.names.join(" / ")}</span>
                        <span className="text-xs text-muted">({college.rows} row{college.rows === 1 ? "" : "s"})</span>
                        <select
                          className="focus-ring h-9 rounded-md border border-line bg-white px-2 text-sm"
                          value={collegeDecisions[college.college_norm] ?? ""}
                          onChange={(event) => setCollegeDecisions({ ...collegeDecisions, [college.college_norm]: event.target.value })}
                        >
                          <option value="">Create new college “{college.name}”</option>
                          {collegeGate.known_colleges.map((known) => (
                            <option key={known.college_norm} value={known.college_norm}>Use existing “{known.name}”</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                  <button
                    className="focus-ring mt-3 inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                    onClick={confirmColleges}
                    disabled={busy}
                  >
                    <UploadCloud size={16} /> {busy ? "Uploading…" : "Confirm colleges and upload"}
                  </button>
                </div>
              ) : (
                <button
                  className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void upload()}
                  disabled={busy || !uniqueIdColumn}
                >
                  <UploadCloud size={16} /> {busy ? "Uploading…" : `Upload roster (${parsed.rows.length} students)`}
                </button>
              )}
            </div>
          ) : null}

          {status?.configured ? (
            <div className="mt-4">
              <button className="focus-ring inline-flex items-center gap-2 rounded-md border border-danger/40 px-4 py-2 text-sm font-medium text-danger disabled:opacity-50" onClick={() => void clear()} disabled={busy}>
                <X size={16} /> Clear roster (open login)
              </button>
            </div>
          ) : null}

          {message ? <div className="mt-4 rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm text-accent">{message}</div> : null}
          {/* F-D (KPR 2026-06-12): warn-only ID-shape warnings — loud, never blocking. */}
          {idWarnings.length > 0 ? (
            <div className="mt-4 space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
              <p className="font-semibold"><AlertTriangle size={16} className="mr-2 inline" />Check the unique-ID column before the exam:</p>
              {idWarnings.map((warning, index) => <p key={index}>{warning}</p>)}
            </div>
          ) : null}
          {error ? <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div> : null}
        </>
      )}
    </section>
  );
}

function summarizeSkipped(skipped: Array<{ row: number; reason: string }>) {
  const counts = new Map<string, number>();
  for (const item of skipped) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => `${count}× ${reason}`).join(", ");
}

// SETTINGS tab — per-type proctor alert configuration (enable/disable + severity)
// backed by GET/POST /api/admin/alert-settings. Each toggle/severity change saves
// the FULL config immediately so a partial payload can never be sent.
export function ProctorAlertTypesSection({ settings, loading, message, onReload, onSave }: { settings: AlertSettings | null; loading: boolean; message: string; onReload: () => void; onSave: (next: AlertSettings) => void }) {
  const types = settings ? Object.keys(settings.proctor) : [];
  const updateType = (type: string, patch: Partial<ProctorAlertTypeConfig>) => {
    if (!settings) return;
    const next: AlertSettings = {
      proctor: { ...settings.proctor, [type]: { ...settings.proctor[type], ...patch } }
    };
    onSave(next);
  };
  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Bell size={20} />
          <div>
            <h2 className="text-2xl font-semibold">Proctor alert types</h2>
            <p className="mt-1 text-sm text-muted">Enable or disable each proctor sure-shot and override its severity. Changes save immediately.</p>
          </div>
        </div>
        <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line px-4 text-sm font-medium disabled:opacity-50" onClick={onReload} disabled={loading}>
          <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> Reload
        </button>
      </div>

      {settings === null ? (
        <div className="rounded-lg border border-line bg-white p-4 text-sm text-muted">{loading ? "Loading alert settings…" : "No alert settings loaded yet."}</div>
      ) : (
        <div className="space-y-2">
          {types.map((type) => {
            const config = settings.proctor[type];
            return (
              <div key={type} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-white/60 p-3">
                <div className="flex items-center gap-3">
                  <label className="inline-flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={config.enabled}
                      disabled={loading}
                      onChange={(event) => updateType(type, { enabled: event.target.checked })}
                    />
                    <span className="font-mono">{type}</span>
                  </label>
                  {!config.enabled ? <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">disabled</span> : null}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {/* F9.3 (Wave6, product owner): whether this type appears on the
                      INVIGILATOR room dashboard's alert feed (filtered
                      server-side). DEFAULT ALL OFF — the admin opts each type in;
                      nothing is shared with invigilators until ticked here. */}
                  <label className="flex items-center gap-2 text-xs text-muted">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={config.show_to_invigilator}
                      disabled={loading}
                      onChange={(event) => updateType(type, { show_to_invigilator: event.target.checked })}
                    />
                    Share with invigilator
                  </label>
                  {/* tab_away alone exposes a configurable threshold: the minimum
                      continuous "HackerRank not visible" span (seconds) the
                      monitoring tab-away detector must observe before alerting.
                      Saved with the rest of alert-settings (source of truth for
                      the detector's --min-gap-seconds). */}
                  {type === "tab_away" ? (
                    <label className="flex items-center gap-2 text-xs text-muted">
                      Threshold
                      <input
                        type="number"
                        min={1}
                        step={1}
                        className="focus-ring h-9 w-20 rounded-md border border-line bg-white px-2 text-sm"
                        value={config.threshold_seconds ?? 12}
                        disabled={loading}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          updateType(type, { threshold_seconds: Number.isFinite(next) && next > 0 ? next : 12 });
                        }}
                      />
                      seconds
                    </label>
                  ) : null}
                  <label className="flex items-center gap-2 text-xs text-muted">
                    Severity
                    <select
                      className="focus-ring h-9 w-32 rounded-md border border-line bg-white px-2 text-sm"
                      value={config.severity}
                      disabled={loading}
                      onChange={(event) => updateType(type, { severity: event.target.value as AlertSeverity })}
                    >
                      <option value="critical">critical</option>
                      <option value="warning">warning</option>
                      <option value="info">info</option>
                    </select>
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {message ? <div className="mt-4 rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm text-accent">{message}</div> : null}
    </section>
  );
}

// SETTINGS tab — read-only reference for the contest-eval alert types, which are
// configured in monitoring/alert-config.json (NOT through this console).
export function ContestEvalAlertTypesSection() {
  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-4 flex items-center gap-3">
        <Search size={20} />
        <div>
          <h2 className="text-2xl font-semibold">Contest-eval alert types</h2>
          <p className="mt-1 text-sm text-muted">Read-only. These are configured in <span className="font-mono">monitoring/alert-config.json</span>, not here.</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {CONTEST_EVAL_ALERT_TYPES.map((type) => (
          <span key={type} className="rounded-full border border-line bg-white px-3 py-1.5 font-mono text-xs text-muted">{type}</span>
        ))}
      </div>
    </section>
  );
}

// SETTINGS tab — REVIEW ROSTER. The operator pastes the usernames to be reviewed
// (comma or newline separated; parsed/deduped client-side too), saves them, sees
// a coverage summary, and exports all collected verdicts as a CSV. Degrades to a
// clear "not deployed yet" note when the review endpoints 404.
export function ReviewRosterSection({
  text,
  onTextChange,
  summary,
  loading,
  exporting,
  downloadingDetails,
  message,
  unavailable,
  onSave,
  onReload,
  onExport,
  onDownloadDetails
}: {
  text: string;
  onTextChange: (value: string) => void;
  summary: ReviewRosterSummary | null;
  loading: boolean;
  exporting: boolean;
  downloadingDetails: boolean;
  message: string;
  unavailable: boolean;
  onSave: () => void;
  onReload: () => void;
  onExport: () => void;
  onDownloadDetails: () => void;
}) {
  // Live client-side count of what's currently in the textarea (after split/dedupe).
  const parsedCount = useMemo(() => parseRosterInput(text).length, [text]);
  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ListChecks size={20} />
          <div>
            <h2 className="text-2xl font-semibold">Review roster</h2>
            <p className="mt-1 text-sm text-muted">Paste the Candidate IDs to be reviewed (comma or newline separated). Reviewers open Recordings → Review mode and are served these students one-by-one.</p>
          </div>
        </div>
        <button
          className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line px-4 text-sm font-medium disabled:opacity-50"
          onClick={onReload}
          disabled={loading}
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> Reload
        </button>
      </div>

      {unavailable ? (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          <AlertTriangle size={16} className="mr-2 inline" />
          The review workflow endpoints are not deployed yet. Once the backend exposes the review-roster / reviews APIs, this section becomes active.
        </div>
      ) : (
        <>
          <textarea
            className="focus-ring min-h-[140px] w-full rounded-md border border-line bg-white p-3 font-mono text-sm"
            placeholder={"Asha_R, Karan_V, Neha_S\nVikram_T"}
            value={text}
            onChange={(event) => onTextChange(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50"
              onClick={onSave}
              disabled={loading || !parsedCount}
            >
              <ListChecks size={16} /> Save roster ({parsedCount})
            </button>
            <button
              className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line px-4 text-sm font-medium disabled:opacity-50"
              onClick={onExport}
              disabled={exporting}
            >
              <Download size={16} className={exporting ? "animate-pulse" : undefined} /> {exporting ? "Exporting…" : "Export reviews CSV"}
            </button>
            <button
              className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line px-4 text-sm font-medium disabled:opacity-50"
              onClick={onDownloadDetails}
              disabled={downloadingDetails || !parsedCount}
            >
              <Download size={16} className={downloadingDetails ? "animate-pulse" : undefined} /> {downloadingDetails ? "Downloading…" : "Download all details"}
            </button>
          </div>

          {/* SUMMARY LINE from GET review-roster. */}
          {summary ? (
            <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
              <span className="font-semibold text-ink">{summary.total}</span> total
              <span className="text-muted/50">·</span>
              <span className="font-semibold text-ink">{summary.with_0_reviews}</span> with 0 reviews
              <span className="text-muted/50">·</span>
              <span className="font-semibold text-ink">{summary.with_1_review}</span> with 1
              <span className="text-muted/50">·</span>
              <span className="font-semibold text-ink">{summary.with_2plus_reviews}</span> with 2+
              <span className="text-muted/50">·</span>
              <span className="font-semibold text-ink">{summary.active_claims}</span> active reviewer{summary.active_claims === 1 ? "" : "s"}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted">{loading ? "Loading roster…" : "No roster summary loaded yet."}</p>
          )}

          {message ? <div className="mt-4 rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm text-accent">{message}</div> : null}
        </>
      )}
    </section>
  );
}
