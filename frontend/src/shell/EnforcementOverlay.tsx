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
import { FULLSCREEN_ACK_PHRASE, alertHoldMessage, enforcementHeadline, enforcementSubline, type EnforcementPhase, type ViolationPhase } from "./enforcement";

export function EnforcementOverlay({ phase, violation, remainingSeconds, exitCount, ackOk, fullscreen, simplifiedRecovery = false, takeHome = false, proctorPhone = "", onAckChange, onEnterFullscreen, onReportDispute }: {
  phase: EnforcementPhase;
  /** The violation that tripped the hold — words the alert_hold banner (wave-3). */
  violation: ViolationPhase | null;
  remainingSeconds: number | null;
  exitCount: number;
  ackOk: boolean;
  fullscreen: boolean;
  /** #71: admin per-contest toggle — when true the typed-ack step (Step 1) is
   *  hidden; re-entering fullscreen is the only action. Lands live via the
   *  heartbeat-delivered enforcement config. */
  simplifiedRecovery?: boolean;
  /** #135 take-home: remote mode — routes the locking/alert_hold copy to the
   *  proctor phone instead of "raise your hand / wait for the invigilator". */
  takeHome?: boolean;
  /** #135 take-home: proctor contact number — shown on the calm pre-T0 soft
   *  nudge tail and threaded into the locking/alert copy. Empty ⇒ tail omitted. */
  proctorPhone?: string;
  /** Called on every keystroke — the hook matches against the exact phrase. */
  onAckChange: (text: string) => void;
  onEnterFullscreen: () => Promise<void>;
  /** ALERT-1: the candidate flagged this alert as a software mistake/unfair via
   *  "Report a problem with this alert". Raises a dispute_raised alert for the
   *  proctor; it NEVER unlocks/bypasses recovery. Absent ⇒ the dispute button is
   *  not rendered (back-compat / surfaces without a dispute channel). */
  onReportDispute?: (disputedType: string, note: string) => void | Promise<void>;
}) {
  // #135: the remote copy options threaded into the pure copy fns (C-8). Absent
  // takeHome ⇒ byte-identical in-venue copy (D3).
  const copyOpts = takeHome ? { takeHome: true, phone: proctorPhone } : undefined;
  const [text, setText] = useState("");
  const [fsError, setFsError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reenterButtonRef = useRef<HTMLButtonElement | null>(null);
  // ALERT-1: the "Report a problem with this alert" disclosure. `disputeOpen`
  // gates the inline confirm panel; `disputeNote` is the optional one-line note;
  // `disputeSent` flips to the calm "Reported" confirmation. Local state only —
  // disputing changes NOTHING about the recovery requirement.
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeNote, setDisputeNote] = useState("");
  const [disputeSent, setDisputeSent] = useState(false);
  const disputeNoteRef = useRef<HTMLInputElement | null>(null);

  // A11y (mirrors the M10 FullscreenGate fix): focus moves into the dialog so
  // keyboard/screen-reader users land on the required control immediately.
  // FIX 3 (exam-eve 2026-06-18): in simplified-recovery mode the typed-ack input
  // (inputRef) is NOT rendered, so focusing it was a no-op and keyboard/SR users
  // never landed in the dialog. Focus the "Re-enter fullscreen" button instead —
  // it is the only action in that mode. The typed-ack path is unchanged.
  // FLOW-1 (v1.1): on an accidental EXIT (candidate is OUT of fullscreen), the
  // first recovery action is re-entering fullscreen — the "Enter full screen"
  // button is rendered (only while !fullscreen) and is auto-focused so a keyboard
  // user lands directly on it. Once back in fullscreen the button unmounts and
  // focus falls to the typed-ack input (the remaining step) as before.
  useEffect(() => {
    if (simplifiedRecovery || !fullscreen) reenterButtonRef.current?.focus();
    else inputRef.current?.focus();
  }, [simplifiedRecovery, fullscreen]);

  // ALERT-1 a11y: when the dispute confirm opens, move focus into the note field
  // (mirrors the modal-focus discipline above). The confirm is a nested dialog.
  useEffect(() => {
    if (disputeOpen) disputeNoteRef.current?.focus();
  }, [disputeOpen]);

  // A resolved episode unmounts this overlay, so a NEW episode always mounts
  // with an empty box (the phrase is per-episode by construction).
  const locking = phase === "locking";

  // W5 FIX (stuck-state bug): the reducer resets ackOk on every violate()
  // transition (blocking → locking/alert_hold), but the typed text lived only
  // in this component's local state. After the transition the box still showed
  // the full phrase while Step 1 read "not done" — and since onAckChange only
  // fires on EDITS, a candidate who then re-entered fullscreen could never
  // resolve the hold without realizing they had to retype. Keep the box in
  // lockstep with the reducer: any phase change while this overlay stays
  // mounted clears the box (and tells the hook, keeping ackOk honest).
  const prevPhaseRef = useRef(phase);
  useEffect(() => {
    if (prevPhaseRef.current === phase) return;
    prevPhaseRef.current = phase;
    setText("");
    onAckChange("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // #135 take-home pre-T0 SOFT nudge: a calm (non-red) banner with a SINGLE
  // "Back to fullscreen" button — no countdown, no typed-ack step, no "test will
  // be locked" copy. The exam hasn't started, so nothing is held against the
  // candidate; this is a gentle prompt to be ready when the test opens.
  if (phase === "soft") {
    return (
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="enforcement-soft-title"
        className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-ink/80 p-6"
      >
        <div className="w-full max-w-lg rounded-xl border border-line bg-white p-8 text-ink shadow-2xl">
          <div className="flex items-start gap-4">
            <Maximize2 size={32} className="mt-1 shrink-0 text-accent" />
            <div>
              <h1 id="enforcement-soft-title" className="text-2xl font-bold">
                {enforcementHeadline(phase, fullscreen, simplifiedRecovery)}
              </h1>
              <p className="mt-2 text-base text-muted">
                {enforcementSubline(phase, fullscreen, exitCount, simplifiedRecovery)}
              </p>
            </div>
          </div>
          <div className="mt-6">
            <button
              className="focus-ring inline-flex h-11 items-center gap-2 rounded-md bg-ink px-5 text-sm font-bold text-white"
              onClick={() => {
                setFsError("");
                void onEnterFullscreen().catch(() => setFsError("Your browser blocked fullscreen. Click again to retry."));
              }}
            >
              <Maximize2 size={16} /> Back to fullscreen
            </button>
            {fsError ? <p className="mt-2 text-sm font-semibold text-red-600">{fsError}</p> : null}
          </div>
          {proctorPhone ? (
            <p className="mt-4 text-sm text-muted">
              Trouble with fullscreen? Call your proctor at <a className="font-medium text-accent underline" href={`tel:${proctorPhone}`}>{proctorPhone}</a>.
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  // LT-5 (v1.1): the NO-COUNTDOWN re-entry block (fs_block). Shown after an
  // exception we already handled (post-unlock, post re-share) where the candidate
  // must return to fullscreen but is NOT in a violation episode. A DEDICATED
  // early-return branch placed ABOVE the red alertdialog body (modelled on the
  // calm "soft" branch above) so it is CALM, no-fault: an Enter-fullscreen button,
  // NO countdown, NO typed-ack, NO "test will be locked", NO dispute block. The
  // shared red body below — and its ALERT-1 dispute Escape-cancel + REC-3 floor —
  // is left byte-identical (Invariant 9).
  if (phase === "fs_block") {
    return (
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="enforcement-fsblock-title"
        className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-ink/80 p-6"
      >
        <div className="w-full max-w-lg rounded-xl border border-line bg-white p-8 text-ink shadow-2xl">
          <div className="flex items-start gap-4">
            <Maximize2 size={32} className="mt-1 shrink-0 text-accent" />
            <div>
              <h1 id="enforcement-fsblock-title" className="text-2xl font-bold">
                {enforcementHeadline(phase, fullscreen, simplifiedRecovery)}
              </h1>
              <p className="mt-2 text-base text-muted">
                {enforcementSubline(phase, fullscreen, exitCount, simplifiedRecovery)}
              </p>
            </div>
          </div>
          <div className="mt-6">
            <button
              ref={reenterButtonRef}
              className="focus-ring inline-flex h-11 items-center gap-2 rounded-md bg-ink px-5 text-sm font-bold text-white"
              onClick={() => {
                setFsError("");
                void onEnterFullscreen().catch(() => setFsError("Your browser blocked fullscreen. Click again to retry."));
              }}
            >
              <Maximize2 size={16} /> Enter full screen
            </button>
            {fsError ? <p className="mt-2 text-sm font-semibold text-red-600">{fsError}</p> : null}
          </div>
          {proctorPhone ? (
            <p className="mt-4 text-sm text-muted">
              Trouble with fullscreen? Call your proctor at <a className="font-medium text-accent underline" href={`tel:${proctorPhone}`}>{proctorPhone}</a>.
            </p>
          ) : null}
        </div>
      </div>
    );
  }

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
            {/* W5: headline + sub-line reflect the LIVE state — once the
                candidate is back in fullscreen the overlay points at the
                remaining step instead of repeating "You left fullscreen". */}
            <h1 id="enforcement-title" className="text-3xl font-extrabold uppercase tracking-wide">
              {enforcementHeadline(phase, fullscreen, simplifiedRecovery)}
            </h1>
            <p className="mt-1 text-base font-medium text-red-200">
              {enforcementSubline(phase, fullscreen, exitCount, simplifiedRecovery, copyOpts)}
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
                {alertHoldMessage(violation, simplifiedRecovery, copyOpts)}
              </p>
            ) : null}

            <div className="mt-6 space-y-4">
              {/* #71: the typed-ack step (Step 1) is rendered ONLY when typing is
                  required. In simplified-recovery mode it is omitted entirely and
                  a plain warning replaces it — re-entering fullscreen is the only
                  action. */}
              {!simplifiedRecovery ? (
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
              ) : (
                <p className="rounded-lg border-2 border-red-400 bg-red-800/60 p-4 text-base font-semibold text-red-100">
                  Leaving fullscreen during the exam is not allowed and has been recorded. Return to fullscreen now to continue your exam.
                </p>
              )}
              <div className={`rounded-lg border-2 p-4 ${fullscreen ? "border-emerald-400 bg-emerald-900/40" : "border-red-400 bg-red-800/60"}`}>
                <p className="text-sm font-bold uppercase tracking-wide text-red-100">
                  {simplifiedRecovery
                    ? `Return to fullscreen ${fullscreen ? "— done" : ""}`
                    : `Step 2 ${fullscreen ? "— done" : ""}: return to fullscreen`}
                </p>
                {!fullscreen ? (
                  <button
                    ref={reenterButtonRef}
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

              {/* ALERT-1: candidate feedback. Completing the recovery steps above
                  IS the "I understand — I won't repeat" (acknowledge) path. The
                  second, deliberately quieter option lets a candidate hitting a
                  GENUINE software fault flag it — worded so an honest candidate who
                  simply doesn't want the flag will NOT press it. */}
              {onReportDispute ? (
                <div className="rounded-lg border border-red-400/60 bg-red-950/40 p-4">
                  {disputeSent ? (
                    <p className="text-sm font-semibold text-red-100" aria-live="polite">
                      Reported. Your proctor will review this. Normal exam rules still apply — please complete the steps above to continue.
                    </p>
                  ) : !disputeOpen ? (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm text-red-200">
                        Acknowledge by completing the steps above. Believe this alert is a software mistake?
                      </p>
                      <button
                        type="button"
                        className="focus-ring inline-flex h-9 items-center rounded-md border border-red-300/70 px-3 text-sm font-semibold text-red-100 hover:bg-red-800/50"
                        onClick={() => { setDisputeOpen(true); setFsError(""); }}
                      >
                        Report a problem with this alert
                      </button>
                    </div>
                  ) : (
                    <div role="dialog" aria-modal="false" aria-labelledby="dispute-confirm-title">
                      <h2 id="dispute-confirm-title" className="text-base font-bold text-red-100">
                        Only report a genuine technical problem
                      </h2>
                      <p className="mt-2 text-sm leading-6 text-red-200">
                        Use this only if you believe this alert is a <span className="font-semibold">software mistake</span> — for
                        example the app flagged you while you did nothing wrong, a button didn&rsquo;t work, or the screen behaved
                        incorrectly.
                      </p>
                      <p className="mt-2 text-sm leading-6 text-red-200">
                        This is <span className="font-semibold">not</span> a way to dismiss a warning you caused. Your proctor will
                        see this report alongside the recording of what actually happened, and normal exam rules still apply. Misuse
                        may itself be flagged.
                      </p>
                      <input
                        ref={disputeNoteRef}
                        className="focus-ring mt-3 h-10 w-full rounded-md border border-red-300 bg-white px-3 text-sm text-ink"
                        value={disputeNote}
                        maxLength={500}
                        placeholder="Optional: what went wrong? (one line)"
                        autoComplete="off"
                        onChange={(event) => setDisputeNote(event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Escape") { setDisputeOpen(false); setDisputeNote(""); } }}
                      />
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="focus-ring inline-flex h-9 items-center rounded-md bg-white px-4 text-sm font-bold text-red-900"
                          onClick={() => {
                            void Promise.resolve(onReportDispute("fullscreen_enforcement", disputeNote.trim()));
                            setDisputeSent(true);
                            setDisputeOpen(false);
                          }}
                        >
                          Send report
                        </button>
                        <button
                          type="button"
                          className="focus-ring inline-flex h-9 items-center rounded-md border border-red-300/70 px-4 text-sm font-semibold text-red-100 hover:bg-red-800/50"
                          onClick={() => { setDisputeOpen(false); setDisputeNote(""); }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
