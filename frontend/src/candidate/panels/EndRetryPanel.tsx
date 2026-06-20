// frontend/src/candidate/panels/EndRetryPanel.tsx
// Candidate leaf panel (extracted verbatim from App.tsx, F2). Props-driven.
import { MailWarning, RefreshCw } from "lucide-react";

// Recording already stopped but the final end/manifest submit failed. Recoverable
// inline — re-send the end without reloading (a reload could orphan the session).
export function EndRetryPanel({ error, busy, onRetry }: { error: string; busy: boolean; onRetry: () => void }) {
  return (
    <div className="mt-5 rounded-lg border-2 border-danger/50 bg-danger/5 p-5 shadow-subtle">
      <div className="flex items-start gap-3">
        <MailWarning size={22} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0">
          <p className="text-base font-semibold text-danger">Couldn't submit the end of your test</p>
          <p className="mt-1.5 text-sm leading-6 text-ink">
            Your recording has stopped and the segments are uploaded, but confirming the end of the session failed. Do not close this tab — press Retry to finish submitting.
          </p>
          {error ? <p className="mt-2 break-words text-xs leading-5 text-muted">{error}</p> : null}
        </div>
      </div>
      <div className="mt-4">
        <button
          className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onRetry}
          disabled={busy}
        >
          <RefreshCw size={16} className={busy ? "animate-spin" : undefined} /> {busy ? "Submitting…" : "Retry submitting"}
        </button>
      </div>
    </div>
  );
}
