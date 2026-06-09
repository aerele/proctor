// frontend/src/shell/FullscreenGate.tsx
//
// S1 §5.1 — the fullscreen-first gate: a near-blank dark overlay that is the
// candidate's FIRST screen, and that re-covers the app whenever fullscreen is
// lost BEFORE recording (whatever was active stays mounted underneath — form
// state is preserved). Renders below the fixed ExamTopBar (z-40 < z-50) so the
// red stage-1 bar stays readable over it. While an anomaly episode is active
// the AnomalyPanel owns re-entry instead (ExamShellChrome suppresses this gate).

import { useState } from "react";

export function FullscreenGate({ onEnter }: { onEnter: () => Promise<void> }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Same browser floor as the recorder (getDisplayMedia): latest Chrome/Edge on
  // a laptop/desktop. No Fullscreen API => dead-end copy, no button (spec §3.10).
  const supported = typeof document.documentElement.requestFullscreen === "function";

  const enter = async () => {
    setBusy(true);
    setError("");
    try {
      await onEnter();
    } catch {
      // Browser policy/permission rejection — inline retry, never an auto-loop.
      setError("Your browser blocked fullscreen. Click the button again to retry — if it keeps failing, call an invigilator.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink px-6 text-center text-white">
      <div className="max-w-md">
        <img src="/aerele-logo.png" alt="Aerele" className="mx-auto h-12 w-12 rounded-md" />
        <h1 className="mt-5 text-2xl font-semibold">This is a proctored exam</h1>
        {supported ? (
          <>
            <p className="mt-3 text-sm leading-6 text-white/70">
              The exam runs in fullscreen from start to finish. Enter fullscreen to begin.
            </p>
            <button
              className="focus-ring mt-6 rounded-md bg-white px-6 py-3 text-base font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy}
              onClick={() => void enter()}
            >
              Enter fullscreen to begin
            </button>
            {error ? <p className="mt-4 text-sm text-red-300">{error}</p> : null}
          </>
        ) : (
          <p className="mt-3 text-sm leading-6 text-white/70">
            This browser cannot run the fullscreen exam. Open this page in the latest Chrome or Edge on a laptop or desktop.
          </p>
        )}
      </div>
    </div>
  );
}
