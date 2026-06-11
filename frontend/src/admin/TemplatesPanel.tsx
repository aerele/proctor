// frontend/src/admin/TemplatesPanel.tsx
// FIX-B2 (#58): the TEMPLATES tab — author / list / edit / delete named,
// reusable contest blueprints (F10.5 vision: "a TEMPLATE = named group of
// questions + settings + rules, stored in a list; instantiate into a CONTEST").
// A saved template then appears in the New-contest dropdown on the Contests tab,
// where the existing instantiate flow snapshot-copies it into a real contest.
// Self-contained section (own state, password prop) following the ProblemBank /
// Contests conventions; pure form logic lives in ./templateForm (unit-tested),
// storage + validation live on the backend (handler.mjs + src/templates.mjs).
import { ArrowDown, ArrowUp, Copy, LayoutTemplate, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  createTemplateApi,
  deleteTemplateApi,
  fetchProblems,
  fetchTemplateDetail,
  fetchTemplates,
  updateTemplateApi,
  type ContestTemplateSummary
} from "../api";
import {
  TEMPLATE_ENFORCEMENT_MODES,
  TEMPLATE_FORM_BOUNDS,
  TEMPLATE_LANGUAGES,
  draftFromTemplate,
  draftToSavePayload,
  emptyTemplateDraft,
  moveProblemRow,
  templateRowSummary,
  validateTemplateDraft,
  type TemplateDraft
} from "./templateForm";
import type { ProblemSummary } from "../types";

export function TemplatesPanel({ password }: { password: string }) {
  const [templates, setTemplates] = useState<ContestTemplateSummary[] | null>(null);
  const [bank, setBank] = useState<ProblemSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState<TemplateDraft | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [list, problems] = await Promise.all([
        fetchTemplates(password),
        fetchProblems(password).catch(() => [] as ProblemSummary[])
      ]);
      setTemplates(list.sort((a, b) => a.name.localeCompare(b.name)));
      setBank(problems);
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

  const openNew = () => {
    setMessage("");
    setError("");
    setDraft(emptyTemplateDraft());
  };

  const openEdit = async (slug: string) => {
    setMessage("");
    setError("");
    try {
      setDraft(draftFromTemplate(await fetchTemplateDetail(password, slug)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const save = async () => {
    if (!draft) return;
    const invalid = validateTemplateDraft(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = draftToSavePayload(draft);
      const saved = draft.slug
        ? await updateTemplateApi(password, { ...payload, slug: draft.slug })
        : await createTemplateApi(password, payload);
      setMessage(`Template "${saved.name}" saved as ${saved.slug}. Instantiate it into a contest from the Contests tab.`);
      setDraft(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (template: ContestTemplateSummary) => {
    if (template.preset) {
      setError("The built-in System check preset cannot be deleted. Duplicate it if you want an editable copy.");
      return;
    }
    if (!window.confirm(`Delete template "${template.name}"? Existing contests already made from it are unaffected. This cannot be undone.`)) return;
    setError("");
    try {
      await deleteTemplateApi(password, template.slug);
      setMessage(`Deleted template "${template.name}".`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // Duplicate = hydrate a NEW draft from the source's fields (slug cleared, name
  // suffixed). Reuses the create path — no separate clone endpoint needed here,
  // and it lets the preset be customized (clone-then-edit, the spec path).
  const duplicate = async (slug: string, name: string) => {
    setMessage("");
    setError("");
    try {
      const detail = await fetchTemplateDetail(password, slug);
      const next = draftFromTemplate(detail);
      setDraft({ ...next, slug: "", preset: false, name: `Copy of ${name}` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <LayoutTemplate size={20} />
          <div>
            <h1 className="text-2xl font-semibold">Templates</h1>
            <p className="mt-1 text-sm text-muted">
              A template is a named, reusable blueprint — an ordered set of bank problems plus default settings and rules. Save one here, then instantiate it into a contest from the Contests tab.
            </p>
          </div>
        </div>
        {!draft ? (
          <div className="flex gap-2">
            <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-line px-4 text-sm font-medium" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={16} /> Reload
            </button>
            <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white" onClick={openNew}>
              <Plus size={16} /> New template
            </button>
          </div>
        ) : null}
      </div>

      {error ? <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div> : null}
      {message ? <div className="mb-4 rounded-lg border border-accent/30 bg-accent/10 p-3 text-sm text-accent">{message}</div> : null}

      {draft ? (
        <TemplateEditor
          draft={draft}
          bank={bank}
          saving={saving}
          onChange={setDraft}
          onSave={() => void save()}
          onCancel={() => { setDraft(null); setError(""); }}
        />
      ) : (
        <div className="space-y-2">
          {loading ? <p className="text-sm text-muted">Loading…</p> : null}
          {!loading && templates && !templates.length ? (
            <p className="text-sm text-muted">No templates yet. Create one to reuse a problem set and settings across contests.</p>
          ) : null}
          {(templates ?? []).map((template) => (
            <div key={template.slug} className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-white p-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">{template.name}</span>
                  <span className="font-mono text-xs text-muted">{template.slug}</span>
                  {template.preset ? <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-700">preset</span> : null}
                  {template.archived ? <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-semibold text-muted">archived</span> : null}
                </div>
                <div className="mt-1 text-xs text-muted">
                  {templateRowSummary(template.problem_count, template.total_points)}
                  {template.updated_at ? ` · updated ${new Date(template.updated_at).toLocaleString()}` : ""}
                </div>
              </div>
              <div className="flex gap-2">
                <button className="focus-ring inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-xs font-medium" onClick={() => void duplicate(template.slug, template.name)} title="Duplicate into a new editable template">
                  <Copy size={12} /> Duplicate
                </button>
                <button className="focus-ring rounded-md border border-line px-3 py-1.5 text-xs font-medium" onClick={() => void openEdit(template.slug)}>
                  {template.preset ? "View" : "Edit"}
                </button>
                <button
                  className="focus-ring inline-flex items-center gap-1 rounded-md border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => void remove(template)}
                  disabled={template.preset}
                  title={template.preset ? "The built-in preset cannot be deleted" : "Delete this template"}
                >
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

function TemplateEditor({ draft, bank, saving, onChange, onSave, onCancel }: {
  draft: TemplateDraft;
  bank: ProblemSummary[];
  saving: boolean;
  onChange: (draft: TemplateDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [addProblemId, setAddProblemId] = useState("");
  const set = (patch: Partial<TemplateDraft>) => onChange({ ...draft, ...patch });
  const readOnly = draft.preset; // a bare seed preset is view-only (duplicate to edit)

  const bankChoices = bank.filter((problem) => !draft.problems.some((row) => row.problem_id === problem.id));
  const titleOf = (id: string) => bank.find((problem) => problem.id === id)?.title ?? "";

  return (
    <div className="space-y-4">
      {readOnly ? (
        <p className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-800">
          This is the built-in <b>System check</b> preset — it is read-only. Use <b>Duplicate</b> on the list to make an editable copy.
        </p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3">
        <label className="block md:col-span-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Template name</span>
          <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm disabled:bg-neutral-100" value={draft.name} disabled={readOnly} placeholder="Aptitude — Round 1" maxLength={TEMPLATE_FORM_BOUNDS.NAME_MAX} onChange={(event) => set({ name: event.target.value })} />
          {draft.slug ? <span className="mt-1 block font-mono text-xs text-muted">{draft.slug}</span> : null}
        </label>
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Window duration (min)</span>
          <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm disabled:bg-neutral-100" type="number" disabled={readOnly} min={TEMPLATE_FORM_BOUNDS.DURATION_MIN} max={TEMPLATE_FORM_BOUNDS.DURATION_MAX} value={draft.durationMinutes} onChange={(event) => set({ durationMinutes: event.target.value })} />
          <span className="mt-1 block text-xs text-muted">prefills the contest end time at instantiate</span>
        </label>
      </div>

      <label className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Description (optional)</span>
        <textarea className="focus-ring mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-sm disabled:bg-neutral-100" rows={2} disabled={readOnly} maxLength={TEMPLATE_FORM_BOUNDS.DESCRIPTION_MAX} value={draft.description} onChange={(event) => set({ description: event.target.value })} />
      </label>

      {/* Ordered problems from the bank (reorder / remove / per-problem points) */}
      <div className="rounded-md border border-line bg-white/60 p-4">
        <h3 className="text-sm font-semibold text-ink">Problems (ordered)</h3>
        <ul className="mt-2 space-y-2">
          {draft.problems.map((row, index) => (
            <li key={row.problem_id} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-white px-3 py-2">
              <span className="w-6 text-xs text-muted">#{index + 1}</span>
              <code className="flex-1 text-sm">{row.problem_id}{titleOf(row.problem_id) ? <span className="ml-2 font-sans text-xs text-muted">{titleOf(row.problem_id)}</span> : null}</code>
              <label className="flex items-center gap-1 text-xs text-muted">
                points
                <input className="focus-ring h-8 w-20 rounded-md border border-line bg-white px-2 text-sm disabled:bg-neutral-100" type="number" placeholder="bank" disabled={readOnly} value={row.points} onChange={(event) => set({ problems: draft.problems.map((r, i) => (i === index ? { ...r, points: event.target.value } : r)) })} />
              </label>
              <button className="focus-ring rounded-md border border-line bg-white p-1.5 disabled:opacity-40" title="Move up" disabled={readOnly || index === 0} onClick={() => set({ problems: moveProblemRow(draft.problems, index, -1) })}><ArrowUp size={13} /></button>
              <button className="focus-ring rounded-md border border-line bg-white p-1.5 disabled:opacity-40" title="Move down" disabled={readOnly || index === draft.problems.length - 1} onClick={() => set({ problems: moveProblemRow(draft.problems, index, 1) })}><ArrowDown size={13} /></button>
              <button className="focus-ring rounded-md border border-danger/40 bg-white p-1.5 text-danger disabled:opacity-40" title="Remove" disabled={readOnly} onClick={() => set({ problems: draft.problems.filter((_, i) => i !== index) })}><Trash2 size={13} /></button>
            </li>
          ))}
          {!draft.problems.length ? <li className="text-sm text-muted">No problems yet — a template needs at least one.</li> : null}
        </ul>
        {!readOnly ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select className="focus-ring h-9 rounded-md border border-line bg-white px-3 text-sm" value={addProblemId} onChange={(event) => setAddProblemId(event.target.value)}>
              <option value="">Add a problem from the bank…</option>
              {bankChoices.map((problem) => (
                <option key={problem.id} value={problem.id}>{problem.id} — {problem.title}{problem.status !== "published" ? " (draft)" : ""}</option>
              ))}
            </select>
            <button className="focus-ring inline-flex h-9 items-center gap-1 rounded-md border border-line bg-white px-3 text-sm font-medium disabled:opacity-50" disabled={!addProblemId} onClick={() => { set({ problems: [...draft.problems, { problem_id: addProblemId, points: "" }] }); setAddProblemId(""); }}>
              <Plus size={14} /> Add
            </button>
          </div>
        ) : null}
      </div>

      {/* Default settings + rules (snapshot-copied onto the contest at instantiate) */}
      <div className="rounded-md border border-line bg-white/60 p-4">
        <h3 className="text-sm font-semibold text-ink">Default settings &amp; rules</h3>
        <p className="mt-1 text-xs text-muted">These prefill the contest when the template is instantiated; the admin can still override any of them before opening the contest.</p>

        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Identity label</span>
            <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm disabled:bg-neutral-100" disabled={readOnly} maxLength={TEMPLATE_FORM_BOUNDS.IDENTITY_LABEL_MAX} value={draft.identityLabel} onChange={(event) => set({ identityLabel: event.target.value })} />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Evidence retention (days)</span>
            <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm disabled:bg-neutral-100" type="number" disabled={readOnly} min={TEMPLATE_FORM_BOUNDS.RETENTION_MIN} max={TEMPLATE_FORM_BOUNDS.RETENTION_MAX} value={draft.evidenceRetentionDays} onChange={(event) => set({ evidenceRetentionDays: event.target.value })} />
          </label>
          <label className="flex items-end gap-2 pb-2 text-sm text-muted">
            <input className="h-4 w-4 accent-accent disabled:opacity-50" type="checkbox" disabled={readOnly} checked={draft.roomGateEnabled} onChange={(event) => set({ roomGateEnabled: event.target.checked })} />
            <span>Room start gate (invigilator code)</span>
          </label>
        </div>

        <div className="mt-3 grid gap-4 md:grid-cols-2">
          {/* Languages */}
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Languages</span>
            <div className="mt-1 flex flex-wrap gap-3">
              {TEMPLATE_LANGUAGES.map((lang) => (
                <label key={lang} className="inline-flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={draft.languages.includes(lang)}
                    onChange={(event) => set({ languages: event.target.checked ? [...draft.languages, lang] : draft.languages.filter((l) => l !== lang) })}
                  />
                  {lang}
                </label>
              ))}
            </div>
          </div>

          {/* Camera recording */}
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Camera recording</span>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" disabled={readOnly} checked={draft.cameraEnabled} onChange={(event) => set({ cameraEnabled: event.target.checked })} /> enabled
              </label>
              <label className="inline-flex items-center gap-1 text-muted">
                fps
                <input className="focus-ring h-8 w-16 rounded-md border border-line bg-white px-2 text-sm disabled:bg-neutral-100" type="number" disabled={readOnly || !draft.cameraEnabled} value={draft.cameraFps} onChange={(event) => set({ cameraFps: event.target.value })} />
              </label>
              <label className="inline-flex items-center gap-1 text-muted">
                width
                <input className="focus-ring h-8 w-20 rounded-md border border-line bg-white px-2 text-sm disabled:bg-neutral-100" type="number" disabled={readOnly || !draft.cameraEnabled} value={draft.cameraWidth} onChange={(event) => set({ cameraWidth: event.target.value })} />
              </label>
            </div>
          </div>

          {/* OMR P1: screen-marker fiducials flag (default OFF) — snapshot-
              copied onto contests at instantiation like camera recording. */}
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Screen markers (overlay detection)</span>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" disabled={readOnly} checked={draft.screenMarkersEnabled} onChange={(event) => set({ screenMarkersEnabled: event.target.checked })} /> enabled
              </label>
            </div>
          </div>
        </div>

        {/* Enforcement */}
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Enforcement mode</span>
            <select className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-2 text-sm disabled:bg-neutral-100" disabled={readOnly} value={draft.enforcementMode} onChange={(event) => set({ enforcementMode: event.target.value as TemplateDraft["enforcementMode"] })}>
              {TEMPLATE_ENFORCEMENT_MODES.map((mode) => (
                <option key={mode} value={mode}>{mode === "block" ? "Block (hard)" : "Alert first"}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Fullscreen re-entry (s)</span>
            <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm disabled:bg-neutral-100" type="number" disabled={readOnly} value={draft.fullscreenReentrySeconds} onChange={(event) => set({ fullscreenReentrySeconds: event.target.value })} />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Fullscreen exit limit</span>
            <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm disabled:bg-neutral-100" type="number" disabled={readOnly} value={draft.fullscreenExitLimit} onChange={(event) => set({ fullscreenExitLimit: event.target.value })} />
          </label>
        </div>
      </div>

      <div className="flex gap-3">
        {!readOnly ? (
          <button className="focus-ring inline-flex h-10 items-center justify-center rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={onSave} disabled={saving}>
            {saving ? "Saving…" : draft.slug ? "Save changes" : "Create template"}
          </button>
        ) : null}
        <button className="focus-ring inline-flex h-10 items-center justify-center rounded-md border border-line px-4 text-sm font-medium" onClick={onCancel} disabled={saving}>
          {readOnly ? "Close" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
