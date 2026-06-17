// frontend/src/shell/ExamTopBar.tsx
//
// W2 flip — the SLIM persistent proctoring strip (~40px), the steady-state
// cue. Subtle by design but still the ONLY dark chrome in the light app, with
// the colored stage block and the pulsing REC dot, so an invigilator glancing
// from afar still reads "proctoring active" instantly. The PROMINENT treatment
// now belongs to the problem state only (AnomalyPanel banner / Enforcement
// overlay) — big-and-loud means something is wrong.
// Left: stage color block + contest. Center: name + roll + room (walk-by ID
// spot checks). Right: ⚑ flag chip, REC dot, time left, ticking elapsed/wall
// clock (a screenshot cannot tick), and the caller's action slot (W1: the
// proctoring-panel toggle + End test live here during the exam).

import { useEffect, useState, type ReactNode } from "react";
import { formatExamElapsed, formatRoomLabel, formatWallClock, STAGE_META, type Stage } from "./examShell";

export function ExamTopBar({ stage, identity, contestName, elapsedSeconds, recording, flagCount, remainingLabel, timeUp, actions }: {
  stage: Stage;
  identity: { name: string; candidate_id: string; room: string } | null;
  /** Contest label next to the stage block (hidden on narrow screens). */
  contestName?: string | null;
  elapsedSeconds: number;
  recording: boolean;
  flagCount: number;
  // S5: skew-corrected "Time left" countdown; turns red with a TIME UP label
  // once the exam end passes. null hides the slot (no schedule configured).
  remainingLabel: string | null;
  timeUp: boolean;
  /** W1: caller-provided controls (proctoring-panel toggle, End test). */
  actions?: ReactNode;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const meta = STAGE_META[stage];
  return (
    <div className="fixed inset-x-0 top-0 z-50 flex h-10 items-stretch bg-ink text-white shadow-subtle">
      {/* Stage block — the uniquely-colored at-a-distance element. */}
      <div className={`flex h-full shrink-0 items-center gap-2 px-3 ${meta.blockClass}`}>
        <span className="text-sm font-bold leading-none">{stage}</span>
        <span className="text-[10px] font-semibold uppercase tracking-widest">{meta.label}</span>
      </div>
      {recording ? (
        <span className="flex shrink-0 items-center gap-1.5 pl-3" title="Proctoring active — recording is running">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-600" />
          </span>
          <span className="text-[10px] font-bold tracking-widest text-red-400">REC</span>
        </span>
      ) : null}
      {/* Identity — enables walk-by ID checks without interrupting. */}
      <div className="flex min-w-0 flex-1 items-center gap-2.5 px-3">
        {contestName ? <span className="hidden max-w-48 truncate text-xs font-medium text-white/55 lg:block">{contestName}</span> : null}
        {identity ? (
          <>
            <span className="truncate text-sm font-semibold">{identity.name}</span>
            <span className="hidden truncate font-mono text-xs text-white/60 sm:block">{identity.candidate_id}</span>
            <span className="hidden shrink-0 text-xs text-white/60 md:block">{formatRoomLabel(identity.room)}</span>
          </>
        ) : (
          <span className="text-xs text-white/50">Not signed in</span>
        )}
      </div>
      {/* Liveness — flag chip, countdown, one ticking element per state. */}
      <div className="flex shrink-0 items-center gap-3 px-3">
        {flagCount > 0 ? (
          <span title="Proctoring events recorded for review — keep going; your invigilator will ask only if needed" className="rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-bold">⚑ {flagCount}</span>
        ) : null}
        {recording && remainingLabel !== null ? (
          <span className={`flex items-baseline gap-1.5 ${timeUp ? "text-red-400" : ""}`}>
            <span className={`text-[9px] font-semibold uppercase tracking-widest ${timeUp ? "text-red-400" : "text-white/50"}`}>{timeUp ? "Time up" : "Left"}</span>
            <span className="font-mono text-sm font-semibold leading-none">{remainingLabel}</span>
          </span>
        ) : null}
        {recording ? (
          <span className="flex items-baseline gap-1.5 text-white/80">
            <span className="text-[9px] font-semibold uppercase tracking-widest text-white/50">Elapsed</span>
            <span className="font-mono text-sm leading-none">{formatExamElapsed(elapsedSeconds)}</span>
          </span>
        ) : (
          // UX-M4: labeled like LEFT/ELAPSED — an unlabeled ticking clock reads
          // as a countdown; LOCAL says it is just the wall clock.
          <span className="flex items-baseline gap-1.5">
            <span className="text-[9px] font-semibold uppercase tracking-widest text-white/50">Local</span>
            <span className="font-mono text-sm font-semibold leading-none">{formatWallClock(now)}</span>
          </span>
        )}
        {actions}
      </div>
    </div>
  );
}
