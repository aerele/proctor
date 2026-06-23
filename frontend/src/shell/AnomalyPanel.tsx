// frontend/src/shell/AnomalyPanel.tsx
//
// W2 flip — the BIG problem-state banner. While an anomaly episode is active
// it REPLACES the slim strip as a fixed, full-width red bar that stays pinned
// to the viewport top until the episode is resolved (it used to be an in-flow
// panel that could sit scrolled out of view while the candidate worked deep in
// the workspace — "the alert doesn't show up"). Same episode semantics as
// before: lists the episode's friendly reason(s) with timestamps; exactly ONE
// primary action ("I have fixed this") that stays disabled until every restore
// precondition holds. Re-enter fullscreen gets its own button (a fresh click
// is always a valid gesture). Share-restart is NEVER offered here — that stays
// with ScreenShareErrorPanel (no duplicate CTA).

import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import type { AnomalyReason, RestorePreconditions } from "./examShell";

export function AnomalyPanel({ reasons, preconditions, onRestore, onEnterFullscreen, onReportDispute }: {
  reasons: AnomalyReason[];
  preconditions: RestorePreconditions;
  onRestore: () => void;
  onEnterFullscreen: () => Promise<void>;
  /** ALERT-1: the candidate flagged this proctoring alert as a software
   *  mistake/unfair. Raises a dispute_raised alert for the proctor; it NEVER
   *  clears the banner or bypasses the restore preconditions. Absent ⇒ the
   *  dispute affordance is not rendered. The disputed type is the episode's
   *  first reason (the surfaced anomaly). */
  onReportDispute?: (disputedType: string, note: string) => void | Promise<void>;
}) {
  const [fsError, setFsError] = useState("");
  // ALERT-1: dispute disclosure state (local only — disputing changes nothing
  // about the restore requirement).
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeSent, setDisputeSent] = useState(false);
  const ready = preconditions.fullscreen && preconditions.visible && preconditions.recording;
  const disputedType = reasons[0]?.type ?? "";

  const pending: string[] = [];
  if (!preconditions.fullscreen) pending.push("re-enter fullscreen");
  if (!preconditions.visible) pending.push("keep this exam tab visible");
  if (!preconditions.recording) pending.push("press 'Try again — share entire screen' below");

  return (
    <div role="alert" aria-live="assertive" className="fixed inset-x-0 top-0 z-50 border-b-4 border-red-900 bg-red-700 px-4 py-3 text-white shadow-subtle md:px-8">
      <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center gap-x-5 gap-y-2">
        <span className="flex shrink-0 items-center gap-2 text-base font-bold uppercase tracking-wide">
          <AlertTriangle size={20} className="shrink-0" /> Proctoring alert
        </span>
        <div className="min-w-0 flex-1 basis-64">
          <ul className="max-h-14 space-y-0.5 overflow-y-auto text-sm font-semibold leading-5">
            {reasons.map((reason) => (
              <li key={reason.type}>
                {reason.message}{" "}
                <span className="font-mono text-xs font-normal text-red-200">{new Date(reason.at).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs leading-5 text-red-100">
            {ready
              ? "All clear — press “I have fixed this” to continue."
              : `To continue: ${pending.join(" · ")}.`}
          </p>
          {fsError ? <p className="text-xs font-semibold text-red-100">{fsError}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!preconditions.fullscreen ? (
            <button
              className="focus-ring rounded-md bg-white px-3.5 py-2 text-sm font-bold text-red-800"
              onClick={() => {
                setFsError("");
                void onEnterFullscreen().catch(() => setFsError("Your browser blocked fullscreen. Click again to retry."));
              }}
            >
              Re-enter fullscreen
            </button>
          ) : null}
          <button
            className="focus-ring rounded-md border-2 border-white/80 px-3.5 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!ready}
            onClick={onRestore}
          >
            I have fixed this
          </button>
          {/* ALERT-1: the quieter dispute option. "I have fixed this" above is
              the acknowledge path; this raises a flag for a GENUINE software
              fault. It never clears the banner. */}
          {onReportDispute && !disputeSent ? (
            <button
              className="focus-ring rounded-md px-2 py-2 text-xs font-semibold text-red-100 underline underline-offset-2 hover:text-white"
              onClick={() => setDisputeOpen((value) => !value)}
              aria-expanded={disputeOpen}
            >
              Report a problem with this alert
            </button>
          ) : null}
        </div>
      </div>
      {onReportDispute && disputeSent ? (
        <p className="mx-auto mt-2 max-w-screen-2xl text-xs font-semibold text-red-100" aria-live="polite">
          Reported. Your proctor will review this. Normal exam rules still apply — please complete the steps above to continue.
        </p>
      ) : null}
      {onReportDispute && disputeOpen && !disputeSent ? (
        <div role="dialog" aria-label="Report a problem with this alert" className="mx-auto mt-2 max-w-screen-2xl rounded-md border border-white/40 bg-red-800/60 p-3 text-xs leading-5 text-red-50">
          <p className="font-bold">Only report a genuine technical problem.</p>
          <p className="mt-1">
            Use this only if you believe this alert is a <span className="font-semibold">software mistake</span> — the app flagged you while you did nothing wrong, a button didn&rsquo;t work, or the screen behaved incorrectly. This is <span className="font-semibold">not</span> a way to dismiss a warning you caused; your proctor sees this alongside the recording, and normal exam rules still apply.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              className="focus-ring rounded-md bg-white px-3 py-1.5 text-xs font-bold text-red-900"
              onClick={() => { void Promise.resolve(onReportDispute(disputedType, "")); setDisputeSent(true); setDisputeOpen(false); }}
            >
              Send report
            </button>
            <button
              className="focus-ring rounded-md border border-white/60 px-3 py-1.5 text-xs font-semibold text-red-50"
              onClick={() => setDisputeOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
