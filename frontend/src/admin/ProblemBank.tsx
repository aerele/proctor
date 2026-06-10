// frontend/src/admin/ProblemBank.tsx
// S4: admin question bank — list/author/publish problems and assign the active
// contest problem. Self-contained section (own state, password prop) so the
// App.tsx touchpoints stay minimal: import + tab + render branch.
import { ClipboardList, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { deleteProblem, fetchProblemDetail, fetchProblems, fetchProctorSettings, saveProblem, saveProctorSettings } from "../api";
import { draftFromDoc, draftToDoc, emptyProblemDraft, PROBLEM_LANGUAGES, validateProblemDraft, type ProblemDraft } from "../problems/problemDraft";
import type { ProblemSummary, ProblemTest } from "../types";

export function ProblemBankSection({ password }: { password: string }) {
  const [problems, setProblems] = useState<ProblemSummary[]>([]);
  const [activeProblemId, setActiveProblemId] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<ProblemDraft | null>(null);
  const [editingExisting, setEditingExisting] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [list, settings] = await Promise.all([
        fetchProblems(password),
        fetchProctorSettings(password).catch(() => null)
      ]);
      setProblems(list);
      setActiveProblemId(settings?.problem_id || "");
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

  const openEdit = async (id: string) => {
    setError("");
    setMessage("");
    try {
      setDraft(draftFromDoc(await fetchProblemDetail(password, id)));
      setEditingExisting(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const save = async () => {
    if (!draft) return;
    const invalid = validateProblemDraft(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await saveProblem(password, draftToDoc(draft));
      setMessage(`Saved "${draft.id}".`);
      setDraft(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(`Delete problem "${id}"? This cannot be undone.`)) return;
    setError("");
    try {
      await deleteProblem(password, id);
      setMessage(`Deleted "${id}".`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // Assign/clear the active contest problem by patching the EXISTING settings
  // doc (problem_id rides next to contest_url). Requires the schedule gate to
  // be configured first — surfaced as a plain error message if it is not.
  const setActive = async (id: string) => {
    setError("");
    try {
      const settings = await fetchProctorSettings(password);
      if (!settings.start_at || !settings.end_at) {
        setError("Configure the proctoring schedule (Settings tab) before assigning a problem.");
        return;
      }
      await saveProctorSettings(password, { ...settings, problem_id: id });
      setActiveProblemId(id);
      setMessage(id ? `"${id}" is now the active contest problem.` : "Active problem cleared — candidates fall back to the contest link.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ClipboardList size={20} />
          <div>
            <h1 className="text-2xl font-semibold">Problem bank</h1>
            <p className="mt-1 text-sm text-muted">
              Author problems with sample + hidden tests, limits, and scoring. Publish, then set one as the active contest problem — candidates get it inside the proctored workspace.
            </p>
          </div>
        </div>
        {!draft ? (
          <div className="flex gap-2">
            <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-line px-4 text-sm font-medium" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={16} /> Reload
            </button>
            <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white" onClick={() => { setDraft(emptyProblemDraft()); setEditingExisting(false); setMessage(""); }}>
              <Plus size={16} /> New problem
            </button>
          </div>
        ) : null}
      </div>

      {error ? <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div> : null}
      {message ? <div className="mb-4 rounded-lg border border-accent/30 bg-accent/10 p-3 text-sm text-accent">{message}</div> : null}

      {draft ? (
        <ProblemEditor
          draft={draft}
          editingExisting={editingExisting}
          saving={saving}
          onChange={setDraft}
          onSave={() => void save()}
          onCancel={() => setDraft(null)}
        />
      ) : (
        <div className="space-y-2">
          {loading ? <p className="text-sm text-muted">Loading…</p> : null}
          {!loading && !problems.length ? (
            <p className="text-sm text-muted">No problems yet. The built-in seed "sum-two" remains available until you author one (assign it by setting the active problem ID to sum-two in Settings).</p>
          ) : null}
          {problems.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-white p-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">{p.id}</span>
                  <span className="text-muted">{p.title}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${p.status === "published" ? "bg-accent/10 text-accent" : "bg-ink/10 text-ink"}`}>{p.status}</span>
                  {p.id === activeProblemId ? <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">Active</span> : null}
                </div>
                <div className="mt-1 text-xs text-muted">
                  {p.points} pts · {p.scoring} · {p.languages.join(", ")} · {p.sample_count} sample / {p.hidden_count} hidden
                  {p.updated_at ? ` · updated ${new Date(p.updated_at).toLocaleString()}` : ""}
                </div>
              </div>
              <div className="flex gap-2">
                {p.id === activeProblemId ? (
                  <button className="focus-ring rounded-md border border-line px-3 py-1.5 text-xs font-medium" onClick={() => void setActive("")}>Clear active</button>
                ) : p.status === "published" ? (
                  <button className="focus-ring rounded-md border border-line px-3 py-1.5 text-xs font-medium" onClick={() => void setActive(p.id)}>Set active</button>
                ) : null}
                <button className="focus-ring rounded-md border border-line px-3 py-1.5 text-xs font-medium" onClick={() => void openEdit(p.id)}>Edit</button>
                <button className="focus-ring inline-flex items-center gap-1 rounded-md border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger" onClick={() => void remove(p.id)}>
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ProblemEditor({ draft, editingExisting, saving, onChange, onSave, onCancel }: {
  draft: ProblemDraft;
  editingExisting: boolean;
  saving: boolean;
  onChange: (d: ProblemDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<ProblemDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">ID (slug — locked after create)</span>
          <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 font-mono text-sm disabled:bg-neutral-100" value={draft.id} disabled={editingExisting} onChange={(e) => set({ id: e.target.value })} />
        </label>
        <label className="block md:col-span-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Title</span>
          <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm" value={draft.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
      </div>
      <label className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Statement (plain text, shown pre-wrapped)</span>
        <textarea className="focus-ring mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-sm" rows={8} value={draft.statement} onChange={(e) => set({ statement: e.target.value })} />
      </label>
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Languages</span>
          <div className="mt-1 flex gap-3">
            {PROBLEM_LANGUAGES.map((lang) => (
              <label key={lang} className="inline-flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={draft.languages.includes(lang)}
                  onChange={(e) => set({ languages: e.target.checked ? [...draft.languages, lang] : draft.languages.filter((l) => l !== lang) })}
                />
                {lang}
              </label>
            ))}
          </div>
        </div>
        <label className="block w-32">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">CPU limit (s)</span>
          <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm" value={draft.cpuTimeLimit} onChange={(e) => set({ cpuTimeLimit: e.target.value })} />
        </label>
        <label className="block w-36">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Memory (KB)</span>
          <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm" value={draft.memoryLimit} onChange={(e) => set({ memoryLimit: e.target.value })} />
        </label>
        <label className="block w-28">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Points</span>
          <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm" value={draft.points} onChange={(e) => set({ points: e.target.value })} />
        </label>
        <label className="block w-44">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Scoring</span>
          <select className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-2 text-sm" value={draft.scoring} onChange={(e) => set({ scoring: e.target.value as ProblemDraft["scoring"] })}>
            <option value="per_test">Per test (proportional)</option>
            <option value="all_or_nothing">All or nothing</option>
          </select>
        </label>
        <label className="block w-36">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Status</span>
          <select className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-2 text-sm" value={draft.status} onChange={(e) => set({ status: e.target.value as ProblemDraft["status"] })}>
            <option value="draft">Draft (hidden from candidates)</option>
            <option value="published">Published</option>
          </select>
        </label>
      </div>
      <TestsEditor label="Sample tests (shown to candidates, echoed by Run)" tests={draft.sampleTests} max={10} onChange={(tests) => set({ sampleTests: tests })} />
      <TestsEditor label="Hidden tests (graded on Submit — never shown)" tests={draft.hiddenTests} max={50} onChange={(tests) => set({ hiddenTests: tests })} />
      <div className="flex gap-3">
        <button className="focus-ring inline-flex h-10 items-center justify-center rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save problem"}
        </button>
        <button className="focus-ring inline-flex h-10 items-center justify-center rounded-md border border-line px-4 text-sm font-medium" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function TestsEditor({ label, tests, max, onChange }: {
  label: string;
  tests: ProblemTest[];
  max: number;
  onChange: (tests: ProblemTest[]) => void;
}) {
  const setTest = (index: number, patch: Partial<ProblemTest>) =>
    onChange(tests.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
        <button
          className="focus-ring rounded-md border border-line px-3 py-1 text-xs font-medium disabled:opacity-50"
          onClick={() => onChange([...tests, { input: "", expected: "" }])}
          disabled={tests.length >= max}
        >
          + Add test
        </button>
      </div>
      <div className="space-y-2">
        {tests.map((t, index) => (
          <div key={index} className="flex items-start gap-2">
            <span className="mt-2 w-6 text-right font-mono text-xs text-muted">{index + 1}.</span>
            <textarea className="focus-ring w-full rounded-md border border-line bg-white px-2 py-1 font-mono text-xs" rows={2} placeholder="stdin" value={t.input} onChange={(e) => setTest(index, { input: e.target.value })} />
            <textarea className="focus-ring w-full rounded-md border border-line bg-white px-2 py-1 font-mono text-xs" rows={2} placeholder="expected stdout" value={t.expected} onChange={(e) => setTest(index, { expected: e.target.value })} />
            <button className="focus-ring mt-1 rounded-md border border-danger/40 px-2 py-1 text-xs text-danger" onClick={() => onChange(tests.filter((_, i) => i !== index))} title="Remove test">
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
