// frontend/src/candidate/panels/FullscreenBlockNotice.tsx
//
// B2 / MI-1 (v1.1 candidate-flow state machine) — the calm page body for the
// FS_BLOCK_NO_COUNTDOWN render-gate branch. The LT-1 render-gate keeps the exam
// workspace (W1) from rendering whenever the candidate is out of fullscreen
// while recording+running; this is what they see instead. It is reached AFTER an
// exception we already handled (post-unlock the gate flips locked→running while
// out of fullscreen; post re-share) — NOT a violation, so it is deliberately
// calm: no countdown, no typed-ack, no "test will be locked".
//
// The authoritative no-countdown overlay is the enforcement `fs_block` branch
// (EnforcementOverlay), which rides the same injection on this branch and paints
// ABOVE this notice. This component is the defensive, never-blank page body so
// the candidate always has a "Return to fullscreen" affordance even on the first
// render before the require_fullscreen dispatch has engaged the overlay phase.
import { Maximize2 } from "lucide-react";

export function FullscreenBlockNotice({ onEnterFullscreen }: { onEnterFullscreen: () => void }) {
  return (
    <section className="mx-auto max-w-xl rounded-lg border border-line bg-panel p-6 text-center shadow-subtle">
      <div className="mx-auto flex items-center justify-center text-accent">
        <Maximize2 size={22} />
      </div>
      <h1 className="mt-3 text-2xl font-semibold text-ink">Return to fullscreen to continue</h1>
      <p className="mt-3 text-sm leading-6 text-muted">
        Your exam runs in fullscreen from start to finish. Return to fullscreen to continue your exam — your recording is still running.
      </p>
      <button
        className="focus-ring mt-5 inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white"
        onClick={onEnterFullscreen}
      >
        <Maximize2 size={16} /> Return to fullscreen
      </button>
    </section>
  );
}
