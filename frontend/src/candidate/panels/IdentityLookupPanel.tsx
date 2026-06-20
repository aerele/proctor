// frontend/src/candidate/panels/IdentityLookupPanel.tsx
// Candidate leaf panel (extracted verbatim from App.tsx, F2). Props-driven.
import { Search, UserCheck } from "lucide-react";
import type { RosterLookupResult } from "../../types";
import { candidateIdOf } from "../../identity";
import { Field } from "../../ui/Field";

// S2 — roster identity gate (form stage, before the details form). Three
// states: enter-ID, confirm-match, confirmed. The server re-verifies the ID at
// /api/session/start, so this panel is UX only — never a security boundary.
export function IdentityLookupPanel({ label, value, onChange, busy, cooldown, error, match, confirmed, confirmedId, onLookup, onConfirm, onReject, onReset }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  /** True during the post-429 rate-limit cooldown — the button stays disabled. */
  cooldown: boolean;
  error: string;
  match: RosterLookupResult | null;
  confirmed: boolean;
  confirmedId: string;
  onLookup: () => void;
  onConfirm: () => void;
  onReject: () => void;
  onReset: () => void;
}) {
  const idLabel = label || "Unique ID";
  if (confirmed) {
    return (
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 p-4">
        <div className="flex items-center gap-2 text-sm">
          <UserCheck size={18} className="text-accent" />
          <span className="font-medium">Identity confirmed:</span>
          <span className="font-mono">{confirmedId}</span>
        </div>
        <button className="focus-ring inline-flex items-center gap-2 rounded-md border border-line px-3 py-2 text-xs font-medium" onClick={onReset}>
          Not you? Re-enter ID
        </button>
      </div>
    );
  }
  return (
    <div className="mb-5 rounded-lg border border-line bg-white/60 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-accent">Step 1 — confirm your identity</p>
      <p className="mt-1 text-sm text-muted">
        This exam uses a pre-registered student list. Enter your {idLabel} exactly as registered, then confirm the matched record.
      </p>
      {!match ? (
        <>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto]">
            <Field label={idLabel} value={value} onChange={onChange} />
            <button
              className="focus-ring mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onLookup}
              disabled={busy || cooldown || !value.trim()}
            >
              <Search size={16} /> {busy ? "Checking…" : cooldown ? "Please wait…" : "Find me"}
            </button>
          </div>
          {error ? <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div> : null}
        </>
      ) : (
        <div className="mt-3 rounded-lg border border-accent/30 bg-accent/5 p-4">
          <p className="text-sm font-semibold text-ink">Is this you?</p>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm md:grid-cols-2">
            <div><dt className="inline text-muted">{idLabel}: </dt><dd className="inline font-medium">{match.unique_id}</dd></div>
            {match.name ? <div><dt className="inline text-muted">Name: </dt><dd className="inline font-medium">{match.name}</dd></div> : null}
            {match.roll_number && match.roll_number !== match.unique_id ? (
              <div><dt className="inline text-muted">Roll number: </dt><dd className="inline font-medium">{match.roll_number}</dd></div>
            ) : null}
            {match.email_masked ? <div><dt className="inline text-muted">Email: </dt><dd className="inline font-medium">{match.email_masked}</dd></div> : null}
            {candidateIdOf(match) ? <div><dt className="inline text-muted">Candidate ID: </dt><dd className="inline font-medium">{candidateIdOf(match)}</dd></div> : null}
            {match.room ? <div><dt className="inline text-muted">Room: </dt><dd className="inline font-medium">{match.room}</dd></div> : null}
          </dl>
          <div className="mt-4 flex flex-wrap gap-3">
            <button className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white" onClick={onConfirm}>
              <UserCheck size={16} /> Yes, this is me
            </button>
            <button className="focus-ring inline-flex items-center gap-2 rounded-md border border-line px-4 py-2 text-sm font-medium" onClick={onReject}>
              No — search again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
