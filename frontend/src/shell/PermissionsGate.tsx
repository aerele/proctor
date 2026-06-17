// frontend/src/shell/PermissionsGate.tsx
//
// F5.1 stage 1 — the permissions-first gate: a dark overlay (same chrome as
// the FullscreenGate it precedes) where ALL browser prompts fire — screen
// share, camera+mic, clipboard — BEFORE fullscreen, so a permission dialog can
// never kick the candidate out of fullscreen. One button drives the whole
// sequence (the click is the user gesture getDisplayMedia needs); a
// per-permission checklist with retry buttons takes over after the first run.
// No session exists yet, so fullscreen-exit/blur during the prompts is
// expected and never an anomaly (the reducer only fires while recording).

import { useEffect, useRef } from "react";
import {
  allPermissionsGranted, permissionRetryable, permissionsAttempted, permissionsReady,
  permissionStatusLine, PERMISSION_META, PERMISSION_ORDER,
  type PermissionChecklist, type PermissionKey
} from "./permissions";

export type PermissionsGateProps = {
  checklist: PermissionChecklist;
  // Which request is in flight ("all" = the full setup sequence). Buttons are
  // disabled while busy so a second gesture cannot overlap a live prompt.
  busy: PermissionKey | "all" | null;
  // Screen-share specific failure copy (invalid surface / cancelled / ...).
  screenMessage: string;
  onRun: () => void;
  onRetry: (key: PermissionKey) => void;
  onContinue: () => void;
};

function statusBadge(status: PermissionChecklist[PermissionKey]): { mark: string; className: string } {
  if (status === "granted") return { mark: "✓", className: "bg-emerald-500/20 text-emerald-300" };
  if (status === "denied") return { mark: "✕", className: "bg-red-500/20 text-red-300" };
  if (status === "unavailable") return { mark: "—", className: "bg-white/10 text-white/50" };
  if (status === "requesting") return { mark: "…", className: "bg-sky-500/20 text-sky-300" };
  return { mark: "○", className: "bg-white/10 text-white/50" }; // pending
}

export function PermissionsGate({ checklist, busy, screenMessage, onRun, onRetry, onContinue }: PermissionsGateProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const runButtonRef = useRef<HTMLButtonElement>(null);

  // Same browser floor as the recorder: no getDisplayMedia => dead-end copy.
  const supported = Boolean(navigator.mediaDevices?.getDisplayMedia);
  const attempted = permissionsAttempted(checklist);
  const ready = permissionsReady(checklist);
  const flawless = allPermissionsGranted(checklist);

  // M10 pattern (mirrors FullscreenGate): this is a real modal — focus moves
  // into it on mount so the candidate can't tab into the app behind it.
  useEffect(() => {
    (runButtonRef.current ?? dialogRef.current)?.focus();
  }, []);

  // M10 — focus trap: keep Tab / Shift+Tab cycling within the dialog.
  const onTrapKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const items = focusables ? Array.from(focusables) : [];
    if (items.length === 0) {
      e.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="permissions-gate-title"
      tabIndex={-1}
      onKeyDown={onTrapKeyDown}
      className="focus:outline-none fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-ink px-6 py-8 text-center text-white"
    >
      <div className="max-w-md">
        <img src="/aerele-logo.png" alt="Aerele" className="mx-auto h-12 w-12 rounded-md" />
        <h1 id="permissions-gate-title" className="mt-5 text-2xl font-semibold">This is a proctored exam</h1>
        {supported ? (
          <>
            <p className="mt-3 text-sm leading-6 text-white/70">
              First, set up screen sharing and permissions. Your browser will ask a few times —
              choose your <span className="font-semibold text-white">Entire Screen</span> and allow each request.
              You enter fullscreen after this step, so nothing interrupts you once the exam begins.
            </p>

            <ul className="mt-6 space-y-2 text-left">
              {PERMISSION_ORDER.map((key) => {
                const status = checklist[key];
                const badge = statusBadge(status);
                return (
                  <li key={key} className="flex items-center gap-3 rounded-md bg-white/5 px-4 py-3">
                    <span aria-hidden className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-bold ${badge.className}`}>
                      {badge.mark}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">
                        {PERMISSION_META[key].label}
                        {PERMISSION_META[key].required ? <span className="ml-2 rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-300">Required</span> : null}
                      </span>
                      <span className="block text-xs leading-5 text-white/60">
                        {attempted ? permissionStatusLine(key, status) : PERMISSION_META[key].blurb}
                      </span>
                    </span>
                    {attempted && permissionRetryable(status) ? (
                      <button
                        className="focus-ring shrink-0 rounded-md border border-white/30 px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={busy !== null}
                        onClick={() => onRetry(key)}
                      >
                        {key === "screen" ? "Share screen" : "Retry"}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {screenMessage ? <p className="mt-4 text-sm leading-6 text-red-300">{screenMessage}</p> : null}

            {!attempted || busy === "all" ? (
              <button
                ref={runButtonRef}
                className="focus-ring mt-6 rounded-md bg-white px-6 py-3 text-base font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy !== null}
                onClick={onRun}
              >
                {busy === "all" ? "Requesting permissions…" : "Set up permissions & share your screen"}
              </button>
            ) : null}

            {/* A flawless run auto-continues from App; the explicit button covers
                the screen-granted-but-something-denied case. */}
            {attempted && ready && !flawless && busy === null ? (
              <button
                className="focus-ring mt-6 rounded-md bg-white px-6 py-3 text-base font-semibold text-ink"
                onClick={onContinue}
              >
                Continue to fullscreen
              </button>
            ) : null}
          </>
        ) : (
          <p className="mt-3 text-sm leading-6 text-white/70">
            This browser cannot run the proctored exam. Open this page in the latest Chrome or Edge on a laptop or desktop.
          </p>
        )}
      </div>
    </div>
  );
}
