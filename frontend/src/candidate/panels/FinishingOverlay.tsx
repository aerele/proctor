// frontend/src/candidate/panels/FinishingOverlay.tsx
// Candidate leaf panel (extracted verbatim from App.tsx, F2). Props-driven.
import { RefreshCw, UploadCloud } from "lucide-react";

// Blocking "finishing up" takeover shown while status === "ending" — the window
// between End being pressed and the recorder fully stopping + chunks flushing +
// screen-share/camera released (the whole stop() body). role=alertdialog, fixed
// over EVERYTHING (same treatment as the enforcement takeover). It holds the
// candidate on the page so they do NOT exit fullscreen / switch away / close the
// tab during teardown — which (a) is the UX the product owner asked for and (b) closes the
// last window where a teardown-induced visibility change could be misread.
// (The beacon away-signal is already gated off once status leaves "recording",
// so this overlay is belt-and-braces on top of that root-cause fix.)
// Tier-1: when `draining` is set (status === "ending_draining"), the SAME
// blocking takeover shows the live remaining-segments/MB drain progress + the
// "tell your invigilator" line, and stays up for the FULL drain wait (the
// buffer survived a force-close, so this gate re-enters on reopen). When absent
// it is the original transient "finishing up" overlay (status === "ending").
export function FinishingOverlay({ draining }: { draining?: { pendingCount: number; pendingBytes: number } }) {
  const mb = draining ? Math.max(0, draining.pendingBytes) / (1024 * 1024) : 0;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="finishing-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/80 p-6 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-lg border border-accent/30 bg-panel p-6 text-center shadow-subtle">
        <UploadCloud size={28} className="mx-auto text-accent" />
        <h2 id="finishing-title" className="mt-3 text-xl font-semibold text-ink">
          {draining ? "Waiting for upload to finish — do not close this tab" : "Finishing and uploading your recording…"}
        </h2>
        {draining ? (
          <>
            <p className="mt-2 text-sm leading-6 text-muted">
              Uploading your remaining recording: <strong className="text-ink">{draining.pendingCount}</strong>{" "}
              {draining.pendingCount === 1 ? "segment" : "segments"} (<strong className="text-ink">{mb.toFixed(1)} MB</strong>) left.
              Your recording is saved on this computer and is uploading automatically. Closing now would lose part of it.
            </p>
            <p className="mt-2 text-xs leading-5 text-muted">
              If this stays stuck, tell your invigilator — they can help. Do not exit fullscreen or close this tab.
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm leading-6 text-muted">
            Please do not close this tab or switch away yet. We are stopping the recording, uploading the
            final segments, and releasing your screen share and camera. This only takes a moment.
          </p>
        )}
        <div className="mt-4 flex items-center justify-center gap-2 text-xs font-medium text-muted">
          <RefreshCw size={14} className="animate-spin text-accent" /> Do not exit fullscreen until this finishes.
        </div>
      </div>
    </div>
  );
}
