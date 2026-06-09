// frontend/src/shell/AnomalyPanel.tsx
//
// S1 §7.3 — the red panel shown while the top bar is vanished. Lists the
// episode's friendly reason(s) with timestamps; exactly ONE primary action
// ("I have fixed this — restore my status bar") that stays disabled until
// every restore precondition holds. Re-enter fullscreen gets its own button
// (a fresh click is always a valid gesture). Share-restart is NEVER offered
// here — that stays with the existing ScreenShareErrorPanel (no duplicate CTA).

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
  if (!preconditions.fullscreen) pending.push("Re-enter fullscreen.");
  if (!preconditions.visible) pending.push("Keep this exam tab visible.");
  if (!preconditions.recording) pending.push("Recording must be running — use the Try again / Resume button on this page to restart your screen share.");

  return (
    <div className="mb-5 rounded-lg border-2 border-danger bg-danger/10 p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle size={24} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold uppercase tracking-wide text-danger">Status bar hidden — anomaly detected</p>
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {reasons.map((reason) => (
              <li key={reason.type}>
                <span className="font-medium">{reason.message}</span>{" "}
                <span className="font-mono text-xs text-muted">{new Date(reason.at).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
          {!ready ? (
            <ul className="mt-3 list-inside list-disc text-sm text-danger">
              {pending.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-3">
            {!preconditions.fullscreen ? (
              <button
                className="focus-ring rounded-md bg-ink px-4 py-2 text-sm font-medium text-white"
                onClick={() => {
                  setFsError("");
                  void onEnterFullscreen().catch(() => setFsError("Your browser blocked fullscreen. Click again to retry."));
                }}
              >
                Re-enter fullscreen
              </button>
            ) : null}
            <button
              className="focus-ring rounded-md bg-danger px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!ready}
              onClick={onRestore}
            >
              I have fixed this — restore my status bar
            </button>
          </div>
          {fsError ? <p className="mt-2 text-sm text-danger">{fsError}</p> : null}
        </div>
      </div>
    </div>
  );
}
