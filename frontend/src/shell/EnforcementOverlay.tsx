// frontend/src/shell/EnforcementOverlay.tsx
//
// F5.3 — the fullscreen HARD-BLOCK takeover (replaces the soft "status bar
// hidden" treatment for fullscreen exits). Unmissable red, role=alertdialog,
// fixed over EVERYTHING. To resume, the candidate must BOTH:
//   (a) type the exact ack phrase, and
//   (b) re-enter fullscreen,
// within the countdown. Expiry (or exceeding the exit limit) reports the
// violation — in "block" mode the server locks the session (the locked screen
// then says to call the room proctor); in "alert_first" mode this overlay
// holds with a "proctor has been alerted" banner until the candidate complies
// or an invigilator acts.

import { AlertTriangle, Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FULLSCREEN_ACK_PHRASE, type EnforcementPhase } from "./enforcement";

export function EnforcementOverlay({ phase, remainingSeconds, exitCount, ackOk, fullscreen, onAckChange, onEnterFullscreen }: {
  phase: EnforcementPhase;
  remainingSeconds: number | null;
  exitCount: number;
  ackOk: boolean;
  fullscreen: boolean;
  /** Called on every keystroke — the hook matches against the exact phrase. */
  onAckChange: (text: string) => void;
  onEnterFullscreen: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [fsError, setFsError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // A11y (mirrors the M10 FullscreenGate fix): focus moves into the dialog so
  // keyboard/screen-reader users land on the required input immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A resolved episode unmounts this overlay, so a NEW episode always mounts
  // with an empty box (the phrase is per-episode by construction).
  const locking = phase === "locking";

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="enforcement-title"
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-red-950/95 p-6"
    >
      <div className="w-full max-w-2xl rounded-xl border-4 border-red-500 bg-red-900 p-8 text-white shadow-2xl">
        <div className="flex items-center gap-4">
          <AlertTriangle size={44} className="shrink-0 text-red-300" />
          <div>
            <h1 id="enforcement-title" className="text-3xl font-extrabold uppercase tracking-wide">
              {locking ? "Test disabled" : "You left fullscreen"}
            </h1>
            <p className="mt-1 text-base font-medium text-red-200">
              {locking
                ? "Your test is being locked. Raise your hand and call your room proctor."
                : `Fullscreen exit #${exitCount} was recorded. Complete BOTH steps below to continue your exam.`}
            </p>
          </div>
        </div>

        {!locking ? (
          <>
            {phase === "blocking" && remainingSeconds !== null ? (
              <p className="mt-6 text-center" aria-live="assertive">
                <span className="font-mono text-7xl font-extrabold tabular-nums text-red-100">{remainingSeconds}</span>
                <span className="ml-3 text-lg font-semibold text-red-200">seconds left</span>
              </p>
            ) : null}
            {phase === "alert_hold" ? (
              <p className="mt-6 rounded-lg border-2 border-red-400 bg-red-800 p-4 text-base font-semibold text-red-100" aria-live="assertive">
                Time expired — your proctor has been alerted. Complete both steps below to continue, or wait for the invigilator.
              </p>
            ) : null}

            <div className="mt-6 space-y-4">
              <div className={`rounded-lg border-2 p-4 ${ackOk ? "border-emerald-400 bg-emerald-900/40" : "border-red-400 bg-red-800/60"}`}>
                <p className="text-sm font-bold uppercase tracking-wide text-red-100">
                  Step 1 {ackOk ? "— done" : ""}: type this exact sentence
                </p>
                <p className="mt-2 select-none font-mono text-base font-semibold text-white">{FULLSCREEN_ACK_PHRASE}</p>
                <input
                  ref={inputRef}
                  className="focus-ring mt-3 h-11 w-full rounded-md border border-red-300 bg-white px-3 font-mono text-sm text-ink"
                  value={text}
                  placeholder="Type the sentence here"
                  autoComplete="off"
                  spellCheck={false}
                  onPaste={(event) => event.preventDefault()}
                  onDrop={(event) => event.preventDefault()}
                  onChange={(event) => {
                    setText(event.target.value);
                    onAckChange(event.target.value);
                  }}
                />
              </div>
              <div className={`rounded-lg border-2 p-4 ${fullscreen ? "border-emerald-400 bg-emerald-900/40" : "border-red-400 bg-red-800/60"}`}>
                <p className="text-sm font-bold uppercase tracking-wide text-red-100">
                  Step 2 {fullscreen ? "— done" : ""}: return to fullscreen
                </p>
                {!fullscreen ? (
                  <button
                    className="focus-ring mt-3 inline-flex h-11 items-center gap-2 rounded-md bg-white px-5 text-sm font-bold text-red-900"
                    onClick={() => {
                      setFsError("");
                      void onEnterFullscreen().catch(() => setFsError("Your browser blocked fullscreen. Click again to retry."));
                    }}
                  >
                    <Maximize2 size={16} /> Re-enter fullscreen now
                  </button>
                ) : (
                  <p className="mt-2 text-sm font-medium text-emerald-200">You are back in fullscreen.</p>
                )}
                {fsError ? <p className="mt-2 text-sm font-semibold text-red-200">{fsError}</p> : null}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
