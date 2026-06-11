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

export function AnomalyPanel({ reasons, preconditions, onRestore, onEnterFullscreen }: {
  reasons: AnomalyReason[];
  preconditions: RestorePreconditions;
  onRestore: () => void;
  onEnterFullscreen: () => Promise<void>;
}) {
  const [fsError, setFsError] = useState("");
  const ready = preconditions.fullscreen && preconditions.visible && preconditions.recording;

  const pending: string[] = [];
  if (!preconditions.fullscreen) pending.push("re-enter fullscreen");
  if (!preconditions.visible) pending.push("keep this exam tab visible");
  if (!preconditions.recording) pending.push("restart recording with the Resume / Try again button on this page");

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
        </div>
      </div>
    </div>
  );
}
