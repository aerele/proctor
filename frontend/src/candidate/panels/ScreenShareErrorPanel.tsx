// frontend/src/candidate/panels/ScreenShareErrorPanel.tsx
// Candidate leaf panel (extracted verbatim from App.tsx, F2). Props-driven.
import { MailWarning, MonitorUp } from "lucide-react";
import type { RecorderStartErrorKind } from "../../useProctorRecorder";

// PROMINENT, recoverable screen-share / start failure. Always offers an inline
// Try-again that re-invokes the share prompt — never a page reload. The headline
// makes the NOT-RECORDING state unmistakable.
export function ScreenShareErrorPanel({ startError, stopped, busy, onRetry, onDismiss }: { startError: { kind: RecorderStartErrorKind; message: string }; stopped: boolean; busy: boolean; onRetry: () => void; onDismiss: () => void }) {
  const isInvalidSurface = startError.kind === "invalid_surface";
  // UX-H3: once the session is live (`stopped`), "has NOT started" reads as a
  // glitch to a candidate whose share dropped mid-exam — name the stopped
  // state and the fix instead. Pre-start keeps the truthful never-started title.
  const heading = isInvalidSurface
    ? "Recording has NOT started — share your entire screen"
    : startError.kind === "unsupported"
      ? "Recording has NOT started — unsupported browser"
      : stopped
        ? "Recording stopped — restart your screen share"
        : "Recording has NOT started";
  return (
    <div className="mt-5 rounded-lg border-2 border-danger/50 bg-danger/5 p-5 shadow-subtle">
      <div className="flex items-start gap-3">
        <MailWarning size={22} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0">
          <p className="text-base font-semibold text-danger">{heading}</p>
          <p className="mt-1.5 text-sm leading-6 text-ink">{startError.message}</p>
          {isInvalidSurface ? (
            <p className="mt-2 text-xs leading-5 text-muted">
              Tip: in the share dialog, open the <span className="font-medium">Entire Screen</span> tab (not Window or Chrome Tab), pick your screen, then choose Share.
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onRetry}
          disabled={busy}
        >
          <MonitorUp size={16} /> {busy ? "Opening share…" : "Try again — share entire screen"}
        </button>
        <button
          className="focus-ring rounded-md border border-line px-4 py-2 text-sm font-medium text-muted hover:border-ink/40"
          onClick={onDismiss}
          disabled={busy}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
