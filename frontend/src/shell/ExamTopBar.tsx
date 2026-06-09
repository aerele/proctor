// frontend/src/shell/ExamTopBar.tsx
//
// S1 — the unique dark top bar (spec §7): fixed, full-width, ~64px, the ONLY
// dark chrome in the otherwise light app — instantly recognizable across a
// room. Left: §4 stage color block (the at-a-distance element). Center:
// name + roll + room (random ID-card spot checks). Right: liveness — a ticking
// wall clock on EVERY stage (screenshots can't tick); elapsed exam timer +
// pulsing REC dot while recording; permanent red ⚑ chip when flagCount > 0.
// Its ABSENCE is the alarm — ExamShellChrome unmounts it entirely on anomaly.

import { useEffect, useState } from "react";
import { formatExamElapsed, formatWallClock, STAGE_META, type Stage } from "./examShell";

export function ExamTopBar({ stage, identity, elapsedSeconds, recording, flagCount }: {
  stage: Stage;
  identity: { name: string; username: string; room: string } | null;
  elapsedSeconds: number;
  recording: boolean;
  flagCount: number;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const meta = STAGE_META[stage];
  return (
    <div className="fixed inset-x-0 top-0 z-50 flex h-16 items-stretch bg-ink text-white shadow-subtle">
      {/* Stage block — number + label readable from the back of the room. */}
      <div className={`flex h-full shrink-0 items-center gap-3 px-5 ${meta.blockClass}`}>
        <span className="text-3xl font-bold leading-none">{stage}</span>
        <span className="text-sm font-semibold uppercase tracking-widest">{meta.label}</span>
      </div>
      {/* Identity — enables walk-by ID checks without interrupting. */}
      <div className="flex min-w-0 flex-1 items-center gap-3 px-5">
        {identity ? (
          <>
            <span className="truncate text-lg font-semibold">{identity.name}</span>
            <span className="truncate font-mono text-sm text-white/70">{identity.username}</span>
            <span className="shrink-0 text-sm text-white/70">Room {identity.room || "—"}</span>
          </>
        ) : (
          <span className="text-sm text-white/60">Not signed in</span>
        )}
      </div>
      {/* Liveness — flag chip, REC dot, ticking clock(s). */}
      <div className="flex shrink-0 items-center gap-4 px-5">
        {flagCount > 0 ? (
          <span className="rounded-full bg-red-600 px-2.5 py-1 text-xs font-bold">⚑ {flagCount}</span>
        ) : null}
        {recording ? (
          <span className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-red-600" />
            </span>
            <span className="text-xs font-bold text-red-400">REC</span>
          </span>
        ) : null}
        {recording ? (
          <span className="text-right">
            {/* S5 seam: this slot later shows remaining time instead of elapsed. */}
            <span className="block font-mono text-xl font-semibold leading-none">{formatExamElapsed(elapsedSeconds)}</span>
            <span className="block font-mono text-[11px] text-white/60">{formatWallClock(now)}</span>
          </span>
        ) : (
          <span className="font-mono text-xl font-semibold">{formatWallClock(now)}</span>
        )}
      </div>
    </div>
  );
}
