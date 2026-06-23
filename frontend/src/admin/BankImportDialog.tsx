// frontend/src/admin/BankImportDialog.tsx
// BANK-1 (F11) UI — the upload → PREVIEW → commit dialog (spec §5.3). The admin
// picks a .json bundle; we parse it client-side, POST it to bank-import-preview
// (read-only, no writes), render the per-item plan as a table with a badge +
// reason + a per-row override <select>, then on Apply POST bank-import-commit
// with the chosen overrides + the preview_token. The two-phase preview→commit,
// dedup, and fork-to-`-2` decisions are ALL server-side; this dialog only shows
// the plan and lets the admin tweak a row before committing.
//
// Modal a11y mirrors SessionDetailCard / FullscreenGate: role=dialog, aria-modal,
// click-outside + Escape close, focus moved into the dialog on open.
import { UploadCloud, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { bankImportCommit, bankImportPreview, type ApiError } from "../api";
import type {
  BankBundle,
  BankImportCommitResult,
  BankImportOverrides,
  BankImportPlan,
  BankImportProblemItem,
  BankImportTemplateItem
} from "../types";
import {
  type BankBadge,
  type BankOverrideAction,
  badgeForAction,
  legalProblemOverrides,
  legalTemplateOverrides,
  overrideLabel,
  planHasHardBlock,
  reasonText,
  summaryText
} from "./bankImportDisplay";

const TONE_CLASS: Record<BankBadge["tone"], string> = {
  new: "bg-accent/10 text-accent",
  skip: "bg-ink/10 text-ink",
  update: "bg-sky-100 text-sky-700",
  fork: "bg-amber-100 text-amber-800",
  blocked: "bg-danger/10 text-danger"
};

function Badge({ badge }: { badge: BankBadge }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[badge.tone]}`}>
      {badge.label}
    </span>
  );
}

export function BankImportDialog({ password, onClose, onApplied }: {
  password: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [bundle, setBundle] = useState<BankBundle | null>(null);
  const [fileName, setFileName] = useState("");
  const [plan, setPlan] = useState<BankImportPlan | null>(null);
  const [overrides, setOverrides] = useState<BankImportOverrides>({});
  const [result, setResult] = useState<BankImportCommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButtonRef.current?.focus(); }, []);

  const onDialogKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
    if (e.key !== "Tab") return;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const items = focusables ? Array.from(focusables) : [];
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
      e.preventDefault(); first.focus();
    }
  };

  const onFile = async (file: File | null) => {
    if (!file) return;
    setError("");
    setPlan(null);
    setResult(null);
    setOverrides({});
    setBusy(true);
    try {
      const text = await file.text();
      let parsed: BankBundle;
      try {
        parsed = JSON.parse(text) as BankBundle;
      } catch {
        throw new Error("That file isn't valid JSON — pick a bundle exported from a problem bank.");
      }
      if (!parsed || parsed.kind !== "proctor.bank-bundle") {
        throw new Error("That file isn't a Proctor bank bundle (missing kind \"proctor.bank-bundle\").");
      }
      setBundle(parsed);
      setFileName(file.name);
      const previewed = await bankImportPreview(password, parsed);
      setPlan(previewed);
    } catch (cause) {
      setError(messageOf(cause));
      setBundle(null);
      setFileName("");
    } finally {
      setBusy(false);
    }
  };

  const setOverride = (portableId: string, value: string) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (!value) delete next[portableId];
      else next[portableId] = value;
      return next;
    });
  };

  // M4 (correctness review): a synchronous in-flight guard. `busy` is React state
  // (its update is async), so two Apply clicks in the same tick both pass the
  // `busy` check and fire two commits; the server's idempotency usually absorbs
  // it, but a re-resolved fork/create on the second pass can mint a duplicate.
  // The ref flips synchronously, so the second click is dropped before any await.
  const inFlightRef = useRef(false);
  const apply = async () => {
    if (!bundle || !plan || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError("");
    try {
      const committed = await bankImportCommit(password, {
        bundle,
        overrides,
        preview_token: plan.preview_token
      });
      setResult(committed);
      onApplied();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
      inFlightRef.current = false;
    }
  };

  const applyDisabled =
    busy || !plan || planHasHardBlock(plan.templates, overrides);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Import problem/template bundle"
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:p-10"
      onClick={onClose}
      onKeyDown={onDialogKeyDown}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="focus:outline-none w-full max-w-4xl rounded-lg border border-line bg-panel p-5 shadow-subtle"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Import bundle</h2>
            <p className="mt-1 text-sm text-muted">
              Pick a bundle exported from a problem bank. You'll see exactly what each item will do —
              new, skipped (already here), updated, or forked to a new slug — before anything is written.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            className="focus-ring rounded-md border border-line p-1.5"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {error ? <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div> : null}

        {!result ? (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <label className="focus-ring inline-flex cursor-pointer items-center gap-2 rounded-md border border-line px-4 py-2 text-sm font-medium">
                <UploadCloud size={16} /> Choose bundle file (.json)
                <input
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(event) => void onFile(event.target.files?.[0] ?? null)}
                />
              </label>
              {fileName ? <span className="font-mono text-xs text-muted">{fileName}</span> : null}
              {busy && !plan ? <span className="text-sm text-muted">Reading…</span> : null}
            </div>

            {plan ? (
              <>
                <PlanTable
                  problems={plan.problems}
                  templates={plan.templates}
                  overrides={overrides}
                  onOverride={setOverride}
                />
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                  <span className="text-sm text-muted">{summaryText(plan.summary)}</span>
                  <div className="flex items-center gap-2">
                    {planHasHardBlock(plan.templates, overrides) ? (
                      <span className="text-xs text-danger">
                        Resolve the blocked template(s) first — they reference a problem that isn't in this bundle or on this instance.
                      </span>
                    ) : null}
                    <button
                      className="focus-ring inline-flex h-10 items-center justify-center rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50"
                      onClick={() => void apply()}
                      disabled={applyDisabled}
                    >
                      {busy ? "Applying…" : "Apply import"}
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </>
        ) : (
          <CommitResultView result={result} onClose={onClose} />
        )}
      </section>
    </div>
  );
}

function PlanTable({ problems, templates, overrides, onOverride }: {
  problems: BankImportProblemItem[];
  templates: BankImportTemplateItem[];
  overrides: BankImportOverrides;
  onOverride: (portableId: string, value: string) => void;
}) {
  return (
    <div className="space-y-4">
      {problems.length ? (
        <Section title={`Problems (${problems.length})`}>
          {problems.map((item) => {
            const legal = legalProblemOverrides(item);
            return (
              <Row
                key={item.portable_id}
                name={item.id ?? item.portable_id}
                hint={item.status ? `status: ${item.status}` : ""}
                badge={badgeForAction(item.action, item.target_slug)}
                reason={reasonText(item.reason)}
                legal={legal}
                override={overrides[item.portable_id] ?? ""}
                defaultAction={item.action}
                onOverride={(value) => onOverride(item.portable_id, value)}
              />
            );
          })}
        </Section>
      ) : null}

      {templates.length ? (
        <Section title={`Templates (${templates.length})`}>
          {templates.map((item) => {
            const legal = legalTemplateOverrides(item);
            const dangling = item.dangling?.length
              ? ` (missing: ${item.dangling.map((d) => d.hint || d.problem_portable_id || "?").join(", ")})`
              : "";
            return (
              <Row
                key={item.portable_id}
                name={item.name ?? item.slug ?? item.portable_id}
                hint={item.slug ? `slug: ${item.slug}` : ""}
                badge={badgeForAction(item.action, item.target_slug)}
                reason={`${reasonText(item.reason)}${dangling}`}
                legal={legal}
                override={overrides[item.portable_id] ?? ""}
                defaultAction={item.action}
                onOverride={(value) => onOverride(item.portable_id, value)}
              />
            );
          })}
        </Section>
      ) : null}

      {!problems.length && !templates.length ? (
        <p className="text-sm text-muted">This bundle is empty.</p>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({ name, hint, badge, reason, legal, override, defaultAction, onOverride }: {
  name: string;
  hint: string;
  badge: BankBadge;
  reason: string;
  legal: BankOverrideAction[];
  override: string;
  defaultAction: string;
  onOverride: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-white p-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono font-semibold">{name}</span>
          <Badge badge={badge} />
          {hint ? <span className="text-xs text-muted">{hint}</span> : null}
        </div>
        <div className="mt-1 text-xs text-muted">{reason}</div>
      </div>
      {legal.length ? (
        <label className="flex items-center gap-1 text-xs text-muted">
          override
          <select
            className="focus-ring h-8 rounded-md border border-line bg-white px-2 text-xs"
            value={override}
            onChange={(event) => onOverride(event.target.value)}
          >
            <option value="">auto ({defaultAction})</option>
            {legal.map((action) => (
              <option key={action} value={action}>{overrideLabel(action)}</option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

function CommitResultView({ result, onClose }: { result: BankImportCommitResult; onClose: () => void }) {
  const a = result.applied;
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-accent/30 bg-accent/10 p-3 text-sm text-accent">
        Import applied — {a.created} created · {a.updated} updated · {a.forked} forked · {a.skipped} skipped
        {a.blocked ? ` · ${a.blocked} blocked` : ""}.
      </div>
      <div className="space-y-2">
        {[...result.problems, ...result.templates].map((item) => (
          <div key={`${item.portable_id}-${item.target_slug}`} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-white p-2 text-sm">
            <span className="font-mono">{item.target_slug ?? item.portable_id}</span>
            <Badge badge={badgeForAction(item.action, item.target_slug)} />
            <span className="text-xs text-muted">{reasonText(item.reason)}</span>
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <button
          className="focus-ring inline-flex h-10 items-center justify-center rounded-md bg-ink px-4 text-sm font-medium text-white"
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </div>
  );
}

function messageOf(cause: unknown): string {
  const apiError = cause as ApiError;
  // Map the backend envelope codes to readable prose; fall back to the message.
  switch (apiError?.code) {
    case "unsupported_bundle": return "This file isn't a recognized bank bundle.";
    case "unsupported_bundle_version": return "This bundle was made by a newer version of Proctor — update before importing.";
    case "bundle_too_many_problems": return "This bundle has too many problems to import at once.";
    case "bundle_too_many_templates": return "This bundle has too many templates to import at once.";
    case "bundle_changed": return "The bundle changed since the preview — re-pick the file and try again.";
    default: return cause instanceof Error ? cause.message : String(cause);
  }
}
