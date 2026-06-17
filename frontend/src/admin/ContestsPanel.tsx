// frontend/src/admin/ContestsPanel.tsx
// S-D: the Contests tab (vision §5 A2) + contest detail (A3 skeleton) —
// list/create/detail with window editing (per-contest exam-time), ordered
// problems editing (S-I §1.4.5 guard-aware), rooms + room-gate, status
// actions, access code + invigilator key display/copy/regenerate, and the
// per-contest roster section (passed in from App.tsx so S-C's panel is REUSED,
// not duplicated). Self-contained section, ProblemBank conventions.
import { Archive, ArrowDown, ArrowUp, Copy, Download, KeyRound, Plus, RefreshCw, ShieldAlert, Trash2, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  adjustContestExamTime,
  adoptContestIntoPersonModel,
  createContestApi,
  exportContest,
  fetchContests,
  fetchProblems,
  fetchTemplates,
  purgeContest,
  regenerateContestSecretApi,
  runRetentionSweep,
  setContestAccessCodeApi,
  setContestStatusApi,
  updateContestApi,
  type ApiError,
  type ContestTemplateSummary
} from "../api";
import { parseRoster, suggestMapping } from "../roster/parseRoster";
import { buildCollegeResolutions } from "../roster/personRoster";
import {
  candidateUrlFor,
  contestProblemsCount,
  contestStatusTone,
  contestWindowLabel,
  invigilatorUrlFor,
  normalizeTestCodeInput,
  sortContestsForList,
  testCodeIssue
} from "./contestAdmin";
import { DateTimeField } from "./DateTimeField";
import { lifecyclePhase, purgeGateState, retentionStatus } from "./dataLifecycle";
import type { ContestExportResponse, ContestStatus, ContestSummary, ProblemSummary } from "../types";

const STATUS_CHIP_CLASSES: Record<ReturnType<typeof contestStatusTone>, string> = {
  open: "bg-accent/15 text-accent border-accent/30",
  draft: "bg-neutral-100 text-muted border-line",
  archived: "bg-neutral-200 text-muted border-line opacity-70"
};

function StatusChip({ status }: { status: ContestStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CHIP_CLASSES[contestStatusTone(status)]}`}>
      {status}
    </span>
  );
}

function LegacyBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
      legacy
    </span>
  );
}

// Derived lifecycle-phase badge (vision §7 ladder). The purged phase reads as a
// tombstone (heavy data deleted; Results/People still read via final_snapshot).
const PHASE_CLASSES: Record<string, string> = {
  draft: "bg-neutral-100 text-muted border-line",
  scheduled: "bg-sky-50 text-sky-700 border-sky-200",
  live: "bg-accent/15 text-accent border-accent/30",
  ended: "bg-neutral-100 text-ink border-line",
  selection_done: "bg-emerald-50 text-emerald-700 border-emerald-200",
  evidence_purged: "bg-amber-50 text-amber-700 border-amber-300",
  purged: "bg-rose-50 text-rose-700 border-rose-300",
  archived: "bg-neutral-200 text-muted border-line opacity-80"
};

function LifecycleBadge({ contest }: { contest: ContestSummary }) {
  const phase = lifecyclePhase(contest, new Date().toISOString());
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${PHASE_CLASSES[phase.key] ?? PHASE_CLASSES.draft}`} title={phase.tombstone ? "Heavy data deleted; scores and selection are retained" : undefined}>
      {phase.tombstone ? <Archive size={11} /> : null}
      {phase.label}
    </span>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="focus-ring inline-flex h-7 items-center gap-1 rounded-md border border-line bg-white px-2 text-xs font-medium text-ink hover:border-ink/40"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      title={`Copy ${label}`}
    >
      <Copy size={12} /> {copied ? "Copied" : "Copy"}
    </button>
  );
}

function isoToLocalInput(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function localInputToIso(value: string) {
  if (!value) return "";
  return new Date(value).toISOString();
}

type ProblemRow = { problem_id: string; points: string };

function problemRowsOf(contest: ContestSummary): ProblemRow[] {
  return (contest.problems ?? []).map((entry) => ({
    problem_id: entry.problem_id,
    points: entry.points === null || entry.points === undefined ? "" : String(entry.points)
  }));
}

export function ContestsPanel({ password, renderRoster, onContestsChanged }: {
  password: string;
  /** App.tsx supplies the EXISTING S-C roster section for the given slug. */
  renderRoster: (contestSlug: string) => ReactNode;
  /** Fired after any mutation so the global selector list stays fresh. */
  onContestsChanged?: (contests: ContestSummary[]) => void;
}) {
  const [contests, setContests] = useState<ContestSummary[] | null>(null);
  const [templates, setTemplates] = useState<ContestTemplateSummary[]>([]);
  const [bank, setBank] = useState<ProblemSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [detailSlug, setDetailSlug] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  // Create-form state.
  const [newName, setNewName] = useState("");
  const [newTemplate, setNewTemplate] = useState("");
  const [newStartAt, setNewStartAt] = useState("");
  const [newEndAt, setNewEndAt] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [list, templateList, problems] = await Promise.all([
        fetchContests(password, true),
        fetchTemplates(password).catch(() => [] as ContestTemplateSummary[]),
        fetchProblems(password).catch(() => [] as ProblemSummary[])
      ]);
      setContests(list);
      setTemplates(templateList.filter((template) => !template.archived));
      setBank(problems);
      onContestsChanged?.(list);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sorted = useMemo(() => sortContestsForList(contests ?? []), [contests]);
  const detail = sorted.find((contest) => contest.slug === detailSlug) ?? null;
  const origin = window.location.origin;

  const runMutation = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const createNow = () => runMutation(async () => {
    const created = await createContestApi(password, {
      name: newName,
      ...(newTemplate ? { template_slug: newTemplate } : {}),
      ...(newStartAt ? { start_at: localInputToIso(newStartAt) } : {}),
      ...(newEndAt ? { end_at: localInputToIso(newEndAt) } : {})
    });
    setMessage(`Contest "${created.name}" created as ${created.slug} (draft). Open it when it is ready for candidates.`);
    setCreating(false);
    setNewName("");
    setNewTemplate("");
    setNewStartAt("");
    setNewEndAt("");
    setDetailSlug(created.slug);
  });

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Contests</h1>
            <p className="mt-1 text-sm text-muted">Each contest is one administered round: its own window, roster, rooms and links. Create from a template or blank.</p>
          </div>
          <div className="flex gap-2">
            <button className="focus-ring inline-flex h-9 items-center gap-2 rounded-md border border-line px-3 text-sm font-medium" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={14} /> Refresh
            </button>
            <button className="focus-ring inline-flex h-9 items-center gap-2 rounded-md bg-ink px-3 text-sm font-medium text-white" onClick={() => setCreating((value) => !value)}>
              <Plus size={14} /> New contest
            </button>
          </div>
        </div>

        {creating ? (
          <div className="mb-4 rounded-md border border-accent/30 bg-accent/5 p-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">Contest name</span>
                <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm" value={newName} placeholder="KEC June 2026 — Round 1" onChange={(event) => setNewName(event.target.value)} />
                {newName.trim() ? <span className="mt-1 block text-xs text-muted">slug preview: <code>{newName.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "")}</code></span> : null}
              </label>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">Template</span>
                <select className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm" value={newTemplate} onChange={(event) => setNewTemplate(event.target.value)}>
                  <option value="">Blank contest (no problems yet)</option>
                  {templates.map((template) => (
                    <option key={template.slug} value={template.slug}>
                      {template.name} ({template.problem_count} problem{template.problem_count === 1 ? "" : "s"}{template.preset ? ", preset" : ""})
                    </option>
                  ))}
                </select>
              </label>
              <DateTimeField label="Start time (optional now, required to open)" value={newStartAt} onChange={setNewStartAt} />
              <DateTimeField label="End time (template duration prefills when blank)" value={newEndAt} onChange={setNewEndAt} />
            </div>
            <div className="mt-3 flex gap-2">
              <button className="focus-ring inline-flex h-9 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={createNow} disabled={busy || !newName.trim()}>
                Create draft
              </button>
              <button className="focus-ring inline-flex h-9 items-center rounded-md border border-line px-4 text-sm font-medium" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {error ? <div className="mb-3 rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div> : null}
        {message ? <div className="mb-3 rounded-md border border-accent/30 bg-accent/10 p-3 text-sm text-accent">{message}</div> : null}

        {contests === null ? (
          <p className="text-sm text-muted">{loading ? "Loading contests…" : "No contests loaded."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <th className="py-2 pr-3">Contest</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Window</th>
                  <th className="py-2 pr-3">Problems</th>
                  <th className="py-2 pr-3">Candidate link</th>
                  <th className="py-2 pr-3">Access code</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((contest) => (
                  <tr key={contest.slug} className="border-b border-line/60 align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium text-ink">{contest.name}</div>
                      <div className="font-mono text-xs text-muted">{contest.slug}</div>
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusChip status={contest.status} />
                        {contest.legacy ? <LegacyBadge /> : <LifecycleBadge contest={contest} />}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted">{contestWindowLabel(contest.start_at, contest.end_at)}</td>
                    <td className="py-2 pr-3">{contestProblemsCount(contest)}</td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-1.5">
                        <code className="max-w-[16rem] truncate text-xs">{candidateUrlFor(origin, contest.slug)}</code>
                        <CopyButton value={candidateUrlFor(origin, contest.slug)} label="candidate link" />
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      {contest.access_code ? (
                        <div className="flex items-center gap-1.5">
                          <code className="text-sm font-semibold tracking-widest">{contest.access_code}</code>
                          <CopyButton value={contest.access_code} label="access code" />
                        </div>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <button className="focus-ring inline-flex h-8 items-center rounded-md border border-line bg-white px-3 text-xs font-medium text-ink hover:border-ink/40" onClick={() => setDetailSlug(contest.slug === detailSlug ? "" : contest.slug)}>
                        {contest.slug === detailSlug ? "Close" : "Detail"}
                      </button>
                    </td>
                  </tr>
                ))}
                {!sorted.length ? (
                  <tr><td colSpan={7} className="py-4 text-sm text-muted">No contests yet — create the first one above.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {detail ? (
        <ContestDetail
          key={detail.slug}
          password={password}
          contest={detail}
          bank={bank}
          busy={busy}
          runMutation={runMutation}
          renderRoster={renderRoster}
        />
      ) : null}
    </div>
  );
}

function ContestDetail({ password, contest, bank, busy, runMutation, renderRoster }: {
  password: string;
  contest: ContestSummary;
  bank: ProblemSummary[];
  busy: boolean;
  runMutation: (fn: () => Promise<void>) => Promise<void>;
  renderRoster: (contestSlug: string) => ReactNode;
}) {
  const origin = window.location.origin;
  const [startInput, setStartInput] = useState(() => isoToLocalInput(contest.start_at));
  const [endInput, setEndInput] = useState(() => isoToLocalInput(contest.end_at));
  const [roomsText, setRoomsText] = useState(() => (contest.rooms ?? []).join(", "));
  const [gateEnabled, setGateEnabled] = useState(contest.room_gate_enabled);
  const [problemRows, setProblemRows] = useState<ProblemRow[]>(() => problemRowsOf(contest));
  const [addProblemId, setAddProblemId] = useState("");
  const [endNowArmed, setEndNowArmed] = useState(false);
  // W4: custom test code — error surfaces INLINE in the Candidate access box
  // (the server's 400/409 messages are written for the admin verbatim).
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState("");

  const saveCustomCode = () => void runMutation(async () => {
    try {
      await setContestAccessCodeApi(password, contest.slug, codeInput);
      setCodeInput("");
      setCodeError("");
    } catch (cause) {
      // Swallow after capturing: the panel-level error stays clean and the
      // list still reloads (runMutation's finally path).
      setCodeError(cause instanceof Error ? cause.message : String(cause));
    }
  });

  const candidateUrl = candidateUrlFor(origin, contest.slug);
  const invigilatorUrl = invigilatorUrlFor(origin, contest.slug, contest.invigilator_key);
  const isLegacy = contest.legacy;

  // S-I §1.4.5 guard-aware problems save: open-contest ADDs need confirm:true,
  // points edits need the typed contest slug; removal of a problem with stored
  // submissions stays a hard 409 the admin sees verbatim.
  const saveProblems = () => runMutation(async () => {
    const problems = problemRows.map((row) => ({
      problem_id: row.problem_id,
      points: row.points.trim() === "" ? null : Number(row.points)
    }));
    const attempt = async (extra: { confirm?: boolean; confirm_points_edit?: string }) =>
      updateContestApi(password, { slug: contest.slug, problems, ...extra });
    try {
      await attempt({});
    } catch (cause) {
      const apiError = cause as ApiError;
      if (apiError.code === "problem_add_requires_confirm") {
        if (!window.confirm("This contest is OPEN. Add the new problem(s) for every candidate now?")) throw cause;
        await attempt({ confirm: true });
        return;
      }
      if (apiError.code === "points_edit_confirmation_required") {
        const typed = window.prompt(`Points edits apply retroactively (best scores are computed live). Type the contest slug "${contest.slug}" to confirm:`);
        if (typed !== contest.slug) throw cause;
        await attempt({ confirm: true, confirm_points_edit: typed });
        return;
      }
      throw cause;
    }
  });

  const moveRow = (index: number, delta: number) => {
    setProblemRows((rows) => {
      const next = [...rows];
      const target = index + delta;
      if (target < 0 || target >= next.length) return rows;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const bankChoices = bank.filter((problem) => !problemRows.some((row) => row.problem_id === problem.id));

  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-ink">
            {contest.name}
            <StatusChip status={contest.status} />
            {isLegacy ? <LegacyBadge /> : <LifecycleBadge contest={contest} />}
          </h2>
          <p className="mt-1 font-mono text-xs text-muted">{contest.slug}{contest.template_slug ? ` · from template ${contest.template_slug}` : ""}</p>
        </div>
        {!isLegacy ? (
          <div className="flex gap-2">
            {contest.status === "draft" ? (
              <button className="focus-ring inline-flex h-9 items-center rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" disabled={busy} onClick={() => void runMutation(async () => { await setContestStatusApi(password, contest.slug, "open"); })}>
                Open contest
              </button>
            ) : null}
            {contest.status === "open" ? (
              <button className="focus-ring inline-flex h-9 items-center rounded-md border border-danger/40 px-4 text-sm font-medium text-danger disabled:opacity-50" disabled={busy} onClick={() => { if (window.confirm("Archive this contest? Candidates can no longer start or resume.")) void runMutation(async () => { await setContestStatusApi(password, contest.slug, "archived"); }); }}>
                Archive
              </button>
            ) : null}
            {contest.status === "archived" ? (
              <button className="focus-ring inline-flex h-9 items-center rounded-md border border-line px-4 text-sm font-medium disabled:opacity-50" disabled={busy} onClick={() => void runMutation(async () => { await setContestStatusApi(password, contest.slug, "open"); })}>
                Reopen
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {isLegacy ? (
        <p className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          This is the legacy exam synthesized from the global Settings — it has no contest document, so links/codes/edits are not available here. It keeps running exactly as configured on the Settings tab.
        </p>
      ) : (
        <>
          {/* Links + codes (vision §2.7: URLs are derived). */}
          <div className="mb-4 grid gap-3 lg:grid-cols-2">
            <div className="rounded-md border border-line bg-white/60 p-4">
              <h3 className="text-sm font-semibold text-ink">Candidate access</h3>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <code className="max-w-full truncate text-xs">{candidateUrl}</code>
                <CopyButton value={candidateUrl} label="candidate link" />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs uppercase tracking-wide text-muted">Test code</span>
                <code className="text-lg font-semibold tracking-[0.3em]">{contest.access_code}</code>
                {contest.access_code ? <CopyButton value={contest.access_code} label="access code" /> : null}
                <button className="focus-ring inline-flex h-7 items-center gap-1 rounded-md border border-line bg-white px-2 text-xs font-medium" disabled={busy} onClick={() => { if (window.confirm("Regenerate the test code? The old code stops working immediately.")) void runMutation(async () => { await regenerateContestSecretApi(password, contest.slug, "access_code"); }); }}>
                  <RefreshCw size={12} /> Regenerate
                </button>
                {/* W4: set a CUSTOM code (unique among open contests — server-enforced). */}
                <input
                  className="focus-ring h-7 w-28 rounded-md border border-line bg-white px-2 font-mono text-sm tracking-widest"
                  value={codeInput}
                  placeholder="KEC226"
                  maxLength={6}
                  aria-label="Custom test code"
                  onChange={(event) => { setCodeInput(normalizeTestCodeInput(event.target.value)); setCodeError(""); }}
                  onKeyDown={(event) => { if (event.key === "Enter" && !busy && codeInput.length === 6 && !testCodeIssue(codeInput)) saveCustomCode(); }}
                />
                <button
                  className="focus-ring inline-flex h-7 items-center gap-1 rounded-md border border-line bg-white px-2 text-xs font-medium disabled:opacity-50"
                  disabled={busy || codeInput.length !== 6 || testCodeIssue(codeInput) !== null}
                  onClick={saveCustomCode}
                >
                  Set custom code
                </button>
              </div>
              {testCodeIssue(codeInput) ? <p className="mt-1 text-xs text-warning">{testCodeIssue(codeInput)}</p> : null}
              {codeError ? <p className="mt-1 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-xs text-danger">{codeError}</p> : null}
              <p className="mt-2 text-xs text-muted">Candidates open the link directly, or type the code on the landing page at {origin}/. Codes are 6 characters (A-Z, 2-9) and must be unique across open contests.</p>
            </div>
            <div className="rounded-md border border-line bg-white/60 p-4">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink"><KeyRound size={14} /> Invigilator access</h3>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <code className="max-w-full truncate text-xs">{invigilatorUrl}</code>
                <CopyButton value={invigilatorUrl} label="invigilator link" />
                <button className="focus-ring inline-flex h-7 items-center gap-1 rounded-md border border-line bg-white px-2 text-xs font-medium" disabled={busy} onClick={() => { if (window.confirm("Regenerate the invigilator key? Every distributed invigilator link stops working immediately.")) void runMutation(async () => { await regenerateContestSecretApi(password, contest.slug, "invigilator_key"); }); }}>
                  <RefreshCw size={12} /> Regenerate key
                </button>
              </div>
              <p className="mt-2 text-xs text-muted">The link authenticates room invigilators for THIS contest only. Share it with hall staff; regenerate if it leaks.</p>
            </div>
          </div>

          {/* Window editing (per-contest exam-time semantics, S5 moved per-contest). */}
          <div className="mb-4 rounded-md border border-line bg-white/60 p-4">
            <h3 className="text-sm font-semibold text-ink">Exam window</h3>
            <div className="mt-2 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
              <DateTimeField label="Start" value={startInput} onChange={setStartInput} />
              <DateTimeField label="End" value={endInput} onChange={setEndInput} />
              <button className="focus-ring inline-flex h-10 items-center self-end rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" disabled={busy} onClick={() => void runMutation(async () => { await updateContestApi(password, { slug: contest.slug, start_at: startInput ? localInputToIso(startInput) : null, end_at: endInput ? localInputToIso(endInput) : null }); })}>
                Save window
              </button>
            </div>
            {contest.start_at && contest.end_at ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">Live controls:</span>
                {[15, 30].map((minutes) => (
                  <button key={minutes} className="focus-ring inline-flex h-8 items-center rounded-md border border-line bg-white px-3 text-xs font-medium disabled:opacity-50" disabled={busy} onClick={() => void runMutation(async () => { await adjustContestExamTime(password, contest.slug, { extend_minutes: minutes }); })}>
                    +{minutes} min
                  </button>
                ))}
                {endNowArmed ? (
                  <>
                    <button className="focus-ring inline-flex h-8 items-center rounded-md bg-danger px-3 text-xs font-medium text-white disabled:opacity-50" disabled={busy} onClick={() => { setEndNowArmed(false); void runMutation(async () => { await adjustContestExamTime(password, contest.slug, { end_now: true }); }); }}>
                      Confirm end now
                    </button>
                    <button className="focus-ring inline-flex h-8 items-center rounded-md border border-line px-3 text-xs font-medium" onClick={() => setEndNowArmed(false)}>Cancel</button>
                  </>
                ) : (
                  <button className="focus-ring inline-flex h-8 items-center rounded-md border border-danger/40 px-3 text-xs font-medium text-danger disabled:opacity-50" disabled={busy} onClick={() => setEndNowArmed(true)}>
                    End now…
                  </button>
                )}
                {contest.end_at_updated_at ? <span className="text-xs text-muted">end time last adjusted {new Date(contest.end_at_updated_at).toLocaleString()}</span> : null}
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted">Set both start and end to unlock the live extend / end-now controls (and to open the contest).</p>
            )}
          </div>

          {/* Ordered problems snapshot (S-I): reorder/remove/add + points. */}
          <div className="mb-4 rounded-md border border-line bg-white/60 p-4">
            <h3 className="text-sm font-semibold text-ink">Problems (ordered)</h3>
            {contest.status === "open" ? (
              <p className="mt-1 text-xs text-amber-700">This contest is OPEN: adding asks for confirmation, removing is blocked once a problem has submissions, and points edits need a typed confirmation.</p>
            ) : null}
            <ul className="mt-2 space-y-2">
              {problemRows.map((row, index) => (
                <li key={row.problem_id} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-white px-3 py-2">
                  <span className="w-6 text-xs text-muted">#{index + 1}</span>
                  <code className="flex-1 text-sm">{row.problem_id}</code>
                  <label className="flex items-center gap-1 text-xs text-muted">
                    points
                    <input className="focus-ring h-8 w-20 rounded-md border border-line bg-white px-2 text-sm" type="number" placeholder="bank" value={row.points} onChange={(event) => setProblemRows((rows) => rows.map((r, i) => (i === index ? { ...r, points: event.target.value } : r)))} />
                  </label>
                  <button className="focus-ring rounded-md border border-line bg-white p-1.5 disabled:opacity-40" title="Move up" disabled={index === 0} onClick={() => moveRow(index, -1)}><ArrowUp size={13} /></button>
                  <button className="focus-ring rounded-md border border-line bg-white p-1.5 disabled:opacity-40" title="Move down" disabled={index === problemRows.length - 1} onClick={() => moveRow(index, 1)}><ArrowDown size={13} /></button>
                  <button className="focus-ring rounded-md border border-danger/40 bg-white p-1.5 text-danger" title="Remove" onClick={() => setProblemRows((rows) => rows.filter((_, i) => i !== index))}><Trash2 size={13} /></button>
                </li>
              ))}
              {!problemRows.length ? <li className="text-sm text-muted">No problems yet — a contest needs at least one to open.</li> : null}
            </ul>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select className="focus-ring h-9 rounded-md border border-line bg-white px-3 text-sm" value={addProblemId} onChange={(event) => setAddProblemId(event.target.value)}>
                <option value="">Add a problem from the bank…</option>
                {bankChoices.map((problem) => (
                  <option key={problem.id} value={problem.id}>{problem.id} — {problem.title}{problem.status !== "published" ? " (draft — publish first)" : ""}</option>
                ))}
              </select>
              <button className="focus-ring inline-flex h-9 items-center gap-1 rounded-md border border-line bg-white px-3 text-sm font-medium disabled:opacity-50" disabled={!addProblemId} onClick={() => { setProblemRows((rows) => [...rows, { problem_id: addProblemId, points: "" }]); setAddProblemId(""); }}>
                <Plus size={14} /> Add
              </button>
              <button className="focus-ring inline-flex h-9 items-center rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" disabled={busy} onClick={saveProblems}>
                Save problems
              </button>
            </div>
          </div>

          {/* Rooms + room gate (per-contest, vision §2.12). */}
          <div className="mb-4 rounded-md border border-line bg-white/60 p-4">
            <h3 className="text-sm font-semibold text-ink">Rooms & start gate</h3>
            <div className="mt-2 grid gap-3 md:grid-cols-[1fr_auto]">
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">Rooms (comma-separated)</span>
                <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm" value={roomsText} placeholder="Lab 1, Lab 2" onChange={(event) => setRoomsText(event.target.value)} />
              </label>
              <button className="focus-ring inline-flex h-10 items-center self-end rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" disabled={busy} onClick={() => void runMutation(async () => { await updateContestApi(password, { slug: contest.slug, rooms: roomsText.split(",").map((room) => room.trim()).filter(Boolean), room_gate_enabled: gateEnabled }); })}>
                Save rooms & gate
              </button>
            </div>
            <label className="mt-3 flex items-start gap-3 text-sm leading-6 text-muted">
              <input className="mt-1 h-4 w-4 accent-accent" type="checkbox" checked={gateEnabled} onChange={(event) => setGateEnabled(event.target.checked)} />
              <span><span className="font-medium text-ink">Room start codes (invigilator gate)</span> — candidates wait after recording starts until their room invigilator releases a 6-digit code (or presses Start now) from the per-contest invigilator link above.</span>
            </label>
          </div>

          {/* Roster — REUSE of the S-C section, scoped to this contest. */}
          {renderRoster(contest.slug)}

          {/* Data lifecycle (S-G/S-H, vision §2.16): export → triple-gated purge
              → tombstone + the evidence-retention countdown. */}
          <DataLifecycleSection password={password} contest={contest} busy={busy} runMutation={runMutation} />

          {/* Legacy "Adopt into person model" (vision §2.15) — backfill a
              contest that ran before the person layer into person_ids so it
              shows up on cross-round scorecards. */}
          <AdoptIntoPersonSection password={password} contest={contest} />
        </>
      )}
    </section>
  );
}

// S-G/S-H Data lifecycle (vision §2.16): EXPORT → triple-gated PURGE → tombstone,
// + the evidence-RETENTION countdown and an on-demand sweep. The gate-enable and
// countdown logic are pure (./dataLifecycle, unit-tested); this component only
// renders + dispatches. The server re-enforces every gate — the UI mirrors it so
// a request the server would reject can never be fired.
function DataLifecycleSection({ password, contest, busy, runMutation }: {
  password: string;
  contest: ContestSummary;
  busy: boolean;
  runMutation: (fn: () => Promise<void>) => Promise<void>;
}) {
  const now = new Date().toISOString();
  const phase = lifecyclePhase(contest, now);
  const retention = retentionStatus({ contest, now });
  const [confirmed, setConfirmed] = useState(false);
  const [typedSlug, setTypedSlug] = useState("");
  const [includeEvidence, setIncludeEvidence] = useState(false);
  const [exportResult, setExportResult] = useState<ContestExportResponse | null>(null);

  const gate = purgeGateState({ contest, confirmed, typedSlug });
  const purged = gate.alreadyPurged;
  const lastExportAt = contest.last_export_at ?? null;

  // runMutation owns error surfacing (panel-level) + the post-mutation reload.
  const doExport = () => runMutation(async () => {
    const result = await exportContest(password, contest.slug);
    setExportResult(result);
  });

  const doPurge = () => runMutation(async () => {
    await purgeContest(password, { contest: contest.slug, confirm: confirmed, slug: typedSlug.trim(), include_evidence: includeEvidence });
    // Reset the gate inputs so the purged state can't be re-fired by stale UI.
    setConfirmed(false);
    setTypedSlug("");
  });

  const doSweep = () => runMutation(async () => {
    await runRetentionSweep(password);
  });

  // TOMBSTONE display: a purged contest reads clearly as purged; its heavy data
  // is gone but scores + selection are retained (Results/People read the snapshot).
  if (purged) {
    return (
      <div className="mt-4 rounded-md border border-rose-300 bg-rose-50/60 p-4">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-rose-800"><Archive size={15} /> Data lifecycle — purged</h3>
        <p className="mt-2 text-sm text-rose-800">
          This contest was <b>purged</b>{contest.purged_at ? ` on ${new Date(contest.purged_at).toLocaleString()}` : ""}. Heavy data (sessions, submissions, recordings) was permanently deleted; <b>scores and selection are retained</b> — its Results and People scorecards still read from the frozen snapshot.
        </p>
        {contest.purge_counts ? (
          <p className="mt-2 text-xs text-rose-700">
            Deleted: {Object.entries(contest.purge_counts).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(", ") || "no heavy data"}.
          </p>
        ) : null}
        <p className="mt-2 text-xs text-rose-700">
          {contest.evidence_purged_at
            ? `Evidence recordings deleted on ${new Date(contest.evidence_purged_at).toLocaleString()}.`
            : "Recordings are scheduled for deletion by the next retention sweep."}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-md border border-line bg-white/60 p-4">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink"><ShieldAlert size={15} /> Data lifecycle</h3>
      <p className="mt-1 text-xs text-muted">Export the contest to a downloadable archive, then permanently purge its heavy data once you no longer need it. Scores and selection always survive a purge.</p>

      {/* EXPORT */}
      <div className="mt-3 rounded-md border border-line bg-white p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium text-ink">Export</p>
            <p className="text-xs text-muted">
              {lastExportAt ? `Last exported ${new Date(lastExportAt).toLocaleString()}.` : "Not exported yet."}
              {" "}Export zips auto-delete after 10 days.
            </p>
          </div>
          <button className="focus-ring inline-flex h-9 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" disabled={busy} onClick={doExport}>
            <Download size={14} /> {lastExportAt ? "Re-export" : "Export"}
          </button>
        </div>
        {exportResult?.signed_url ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <a className="focus-ring inline-flex h-8 items-center gap-1 rounded-md border border-accent/40 bg-accent/5 px-3 font-medium text-accent" href={exportResult.signed_url} target="_blank" rel="noreferrer">
              <Download size={12} /> Download archive
            </a>
            <span className="text-muted">{Object.entries(exportResult.counts ?? {}).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(" · ")}</span>
          </div>
        ) : null}
      </div>

      {/* RETENTION status */}
      <div className="mt-3 rounded-md border border-line bg-white p-3">
        <p className="text-sm font-medium text-ink">Evidence retention</p>
        {contest.selection_done_at ? (
          <p className="text-xs text-muted">Selection marked done {new Date(contest.selection_done_at).toLocaleString()} · {retention.retentionDays}-day window.</p>
        ) : null}
        <p className={`mt-1 text-sm ${retention.purged ? "text-emerald-700" : retention.due ? "text-amber-700" : "text-ink"}`}>
          {retention.purged ? <Archive size={13} className="mr-1 inline" /> : null}
          {retention.label}
        </p>
        {retention.started && !retention.purged && retention.deleteAt ? (
          <p className="mt-1 text-xs text-muted">Recordings become eligible for deletion on {new Date(retention.deleteAt).toLocaleString()}.</p>
        ) : null}
        <button className="focus-ring mt-2 inline-flex h-8 items-center gap-1 rounded-md border border-line bg-white px-3 text-xs font-medium disabled:opacity-50" disabled={busy} onClick={doSweep} title="Runs the same daily Cloud Scheduler sweep on demand">
          <RefreshCw size={12} /> Run retention sweep now
        </button>
      </div>

      {/* PURGE — triple gate */}
      <div className="mt-3 rounded-md border border-rose-200 bg-rose-50/40 p-3">
        <p className="text-sm font-semibold text-rose-800">Purge heavy data</p>
        <p className="mt-1 text-xs text-rose-700">Permanently deletes sessions, submissions and recordings. Scores and selection are kept. This cannot be undone.</p>

        {/* Gate 1 */}
        {!gate.exportDone ? (
          <p className="mt-2 rounded-md border border-rose-200 bg-white px-3 py-2 text-xs text-rose-700">Export the contest first — purge is disabled until a successful export exists.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {/* Gate 2 */}
            <label className="flex items-start gap-2 text-xs leading-5 text-rose-800">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-rose-600" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
              <span>I understand this <b>permanently deletes</b> sessions, submissions and recordings; <b>scores and selection are kept</b>.</span>
            </label>
            {/* Gate 3 */}
            <label className="block text-xs text-rose-800">
              Type the contest slug <code className="font-semibold">{contest.slug}</code> to confirm:
              <input
                className="focus-ring mt-1 h-9 w-full max-w-xs rounded-md border border-rose-300 bg-white px-3 font-mono text-sm"
                value={typedSlug}
                placeholder={contest.slug}
                onChange={(event) => setTypedSlug(event.target.value)}
                aria-label="Type the contest slug to confirm purge"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-rose-800">
              <input type="checkbox" className="h-4 w-4 accent-rose-600" checked={includeEvidence} onChange={(event) => setIncludeEvidence(event.target.checked)} />
              Also delete recordings now (otherwise the retention sweep handles them on schedule).
            </label>
            <button
              className="focus-ring inline-flex h-9 items-center gap-2 rounded-md bg-rose-600 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              disabled={busy || !gate.canPurge}
              onClick={doPurge}
            >
              <Trash2 size={14} /> Purge this contest
            </button>
            {!gate.canPurge ? (
              <p className="text-xs text-rose-600">
                {gate.nextStep === "confirm" ? "Tick the confirmation to continue." : gate.nextStep === "slug" ? "The typed slug must match exactly." : ""}
              </p>
            ) : null}
          </div>
        )}
      </div>

      <p className="mt-2 text-[11px] text-muted">Lifecycle phase: <b>{phase.label}</b></p>
    </div>
  );
}

// S-J §2.15 — the one-time legacy adoption action. Re-upload the contest's
// roster WITH the college column; the backend mints persons/colleges/enrollments
// and stamps person_id onto the existing sessions/submissions (username_norm
// stays FROZEN). After adoption the contest appears on person scorecards and can
// seed a carry-over Round 2. Reuses the S-C parseRoster + college map-or-confirm
// gate, but POSTs to /api/admin/contest-adopt.
function AdoptIntoPersonSection({ password, contest }: { password: string; contest: ContestSummary }) {
  const [open, setOpen] = useState(false);
  const [parsed, setParsed] = useState<ReturnType<typeof parseRoster> | null>(null);
  const [fileName, setFileName] = useState("");
  const [uniqueIdColumn, setUniqueIdColumn] = useState("");
  const [mapping, setMapping] = useState<ReturnType<typeof suggestMapping>["mapping"]>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [collegeGate, setCollegeGate] = useState<{ new_colleges: { college_norm: string; name: string; rows: number }[] } | null>(null);
  const [collegeDecisions, setCollegeDecisions] = useState<Record<string, string>>({});

  const adoptedAt = (contest as ContestSummary & { adopted_into_person_model_at?: string }).adopted_into_person_model_at;

  const onFile = async (file: File | null) => {
    setMessage(""); setError(""); setCollegeGate(null);
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

  const adopt = async (decisions?: Record<string, string>) => {
    if (!parsed || !uniqueIdColumn) return;
    setBusy(true); setMessage(""); setError("");
    try {
      const response = await adoptContestIntoPersonModel(password, {
        contest: contest.slug,
        unique_id_column: uniqueIdColumn,
        columns: parsed.columns,
        column_mapping: mapping,
        rows: parsed.rows,
        ...(decisions ? { college_resolutions: buildCollegeResolutions(decisions) } : {})
      }) as Record<string, unknown>;
      if (response.needs_college_confirmation) {
        const newColleges = (response.new_colleges as { college_norm: string; name: string; rows: number }[]) ?? [];
        setCollegeGate({ new_colleges: newColleges });
        setCollegeDecisions(Object.fromEntries(newColleges.map((c) => [c.college_norm, ""])));
        return;
      }
      setCollegeGate(null);
      setMessage(
        `Adopted into the person model: ${response.sessions_stamped ?? 0} session(s) and ${response.submissions_stamped ?? 0} submission(s) stamped, ` +
        `${(response.persons as { created?: number })?.created ?? 0} person(s) created. This contest now appears on cross-round scorecards.`
      );
      setParsed(null); setFileName("");
    } catch (cause) {
      const apiError = cause as ApiError;
      if (apiError?.code === "duplicate_unique_ids") { setError("Duplicate candidates in the file — fix the rows and re-upload. Nothing was changed."); return; }
      if (apiError?.code === "college_required") { setError("A college cell is blank — every row needs a college. Nothing was changed."); return; }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-md border border-line bg-white/60 p-4">
      <button className="focus-ring flex w-full items-center justify-between text-left" onClick={() => setOpen((value) => !value)}>
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-ink"><UserPlus size={15} /> Adopt into person model</span>
        <span className="text-xs text-muted">{adoptedAt ? "Adopted" : open ? "Hide" : "Backfill legacy data"}</span>
      </button>
      {open ? (
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-xs text-muted">
            For a contest that ran before the person model: re-upload its roster <b>with a college column</b>. The candidates' existing sessions and scores get linked to durable persons (keys stay frozen), so this contest shows up on cross-round scorecards and can seed a Round 2.
          </p>
          {adoptedAt ? (
            <p className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent">Already adopted on {new Date(adoptedAt).toLocaleString()}. Re-uploading refreshes the link (safe, idempotent).</p>
          ) : null}
          <input className="block w-full text-xs" type="file" accept=".csv,text/csv" onChange={(event) => void onFile(event.target.files?.[0] ?? null)} />
          {parsed ? (
            <div className="space-y-2">
              <p className="text-xs text-muted">Loaded <b>{fileName}</b>: {parsed.rows.length} row(s). ID column: <span className="font-mono">{uniqueIdColumn}</span>.</p>
              {!collegeGate ? (
                <button className="focus-ring inline-flex h-9 items-center gap-2 rounded-md bg-ink px-4 text-xs font-medium text-white disabled:opacity-50" disabled={busy} onClick={() => void adopt()}>
                  <UserPlus size={14} /> {busy ? "Adopting…" : "Adopt this roster"}
                </button>
              ) : null}
            </div>
          ) : null}
          {collegeGate ? (
            <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
              <p className="text-xs font-medium text-warning">This upload introduces new college name(s). Map each to an existing college or create it, then adopt.</p>
              {collegeGate.new_colleges.map((c) => (
                <div key={c.college_norm} className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-mono">{c.name} ({c.rows} row{c.rows === 1 ? "" : "s"})</span>
                  <span className="text-muted">create as "{c.name}"</span>
                </div>
              ))}
              <button className="focus-ring inline-flex h-9 items-center gap-2 rounded-md bg-ink px-4 text-xs font-medium text-white disabled:opacity-50" disabled={busy} onClick={() => void adopt(collegeDecisions)}>
                {busy ? "Adopting…" : "Confirm & adopt"}
              </button>
            </div>
          ) : null}
          {message ? <p className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent">{message}</p> : null}
          {error ? <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
