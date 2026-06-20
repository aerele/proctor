// frontend/src/admin/views/ExamTimeCard.tsx
// Live exam-time control card + its scope type, extracted verbatim from App.tsx (F3).
import { useEffect, useState } from "react";
import { formatRemaining, remainingMs } from "../../examTime";
import { localInputToIso } from "../../timeInput";
import type { ExamTimeRequest } from "../../types";
import { DateTimeField } from "../DateTimeField";

//   unscoped — no contest scoped; the card shows the global settings schedule
//              read-only (editing is disabled — there is nothing to write to).
//   contest  — a real contest is scoped; the card shows ITS window and writes
//              via contest-exam-time (the Contest → Detail panel's API).
//   unknown  — a scoped slug not in the contests list (deep link / still
//              loading); the editor is disabled so nothing wrong gets written.
export type ExamTimeCardScope =
  | { kind: "unscoped" }
  | { kind: "contest"; slug: string }
  | { kind: "unknown"; slug: string };

// S5: live exam-time control on the Live stats view. Remaining time is computed
// against the SERVER clock (skew captured when the stats/exam-time response
// arrived) so the admin display agrees with the students'. The 1 s ticker only
// re-renders this card. "End exam now" is a deliberate two-click confirm.
// F3 (E2E live): the card is scope-aware — an explicit chip says WHICH
// schedule it shows/edits, so a scoped contest can never be confused with the
// global settings schedule on exam day.
export function ExamTimeCard({ endAt, skewMs, busy, endNowArmed, onArmEndNow, absoluteInput, onAbsoluteInputChange, onAdjust, scope }: {
  endAt: string;
  skewMs: number;
  busy: boolean;
  endNowArmed: boolean;
  onArmEndNow: (armed: boolean) => void;
  absoluteInput: string;
  onAbsoluteInputChange: (value: string) => void;
  onAdjust: (body: ExamTimeRequest) => void;
  scope: ExamTimeCardScope;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = remainingMs(endAt, Date.now(), skewMs);
  const over = left !== null && left <= 0;
  // Exam-time is per-contest: only a scoped real contest is editable. An
  // unscoped/unknown scope disables every write.
  const editable = scope.kind === "contest";
  const buttonClass = "focus-ring inline-flex h-10 items-center justify-center rounded-md border border-line px-3 text-sm font-medium disabled:opacity-50";
  return (
    <section className="mb-5 rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">Exam time</h2>
            {scope.kind === "contest" ? (
              <span className="inline-flex rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-xs font-semibold text-accent" title="This card shows and edits the scoped contest's exam window — the same window as Contests → Detail.">
                Contest: {scope.slug}
              </span>
            ) : scope.kind === "unscoped" ? (
              <span className="inline-flex rounded-full border border-line bg-white/60 px-2.5 py-0.5 text-xs font-semibold text-muted" title="Scope to a contest (top-right) to view and control its exam window.">
                No contest scoped
              </span>
            ) : (
              <span className="inline-flex rounded-full border border-warning/40 bg-warning/10 px-2.5 py-0.5 text-xs font-semibold text-warning" title="The scoped slug is not in the contests list — controls are disabled so the wrong schedule can never be edited.">
                Unknown contest: {scope.slug} — controls disabled
              </span>
            )}
          </div>
          {endAt ? (
            <p className="mt-1 text-sm text-muted">
              Ends {new Date(endAt).toLocaleString()} ·{" "}
              <span className={`font-mono font-semibold ${over ? "text-danger" : "text-ink"}`}>
                {over ? "time is up" : `${formatRemaining(left ?? 0)} left`}
              </span>
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted">
              {scope.kind === "contest"
                ? "No exam window configured for this contest yet — set it in Contests → Detail."
                : scope.kind === "unknown"
                  ? "No schedule to show for this scope."
                  : "Scope to a contest to view its exam window."}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <button className={buttonClass} disabled={busy || !endAt || !editable} onClick={() => onAdjust({ extend_minutes: 15 })}>+15 min</button>
          <button className={buttonClass} disabled={busy || !endAt || !editable} onClick={() => onAdjust({ extend_minutes: 5 })}>+5 min</button>
          <button className={buttonClass} disabled={busy || !endAt || !editable} onClick={() => onAdjust({ extend_minutes: -5 })}>−5 min</button>
          <DateTimeField label="New end time" value={absoluteInput} onChange={onAbsoluteInputChange} className="w-64" disabled={!editable} />
          <button className={buttonClass} disabled={busy || !absoluteInput || !editable} onClick={() => onAdjust({ end_at: localInputToIso(absoluteInput) })}>Set</button>
          {endNowArmed ? (
            <>
              <button className="focus-ring inline-flex h-10 items-center justify-center rounded-md bg-danger px-3 text-sm font-medium text-white disabled:opacity-50" disabled={busy || !editable} onClick={() => onAdjust({ end_now: true })}>Confirm: end for everyone</button>
              <button className={buttonClass} disabled={busy} onClick={() => onArmEndNow(false)}>Cancel</button>
            </>
          ) : (
            <button className="focus-ring inline-flex h-10 items-center justify-center rounded-md border border-danger/40 px-3 text-sm font-medium text-danger disabled:opacity-50" disabled={busy || !endAt || !editable} onClick={() => onArmEndNow(true)}>End exam now…</button>
          )}
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">
        {scope.kind === "contest"
          ? `Changes reach students within ~15 seconds via their heartbeat — no reload needed. "End exam now" force-ends every live session in ${scope.slug} only.`
          : "Changes reach students within ~15 seconds via their heartbeat — no reload needed. \"End exam now\" also force-ends every live session in the contest."}
      </p>
    </section>
  );
}
