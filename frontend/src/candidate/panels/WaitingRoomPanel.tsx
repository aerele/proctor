// frontend/src/candidate/panels/WaitingRoomPanel.tsx
// #135 take-home: the pre-T0 WAITING ROOM (D1/D9). Recording is already live and
// fullscreen is held; the candidate holds here until the official start (T0),
// then the exam opens on this same page with no re-permission/re-fullscreen
// prompt (the seamless T0 hand-off — purely derived in StudentApp, this panel
// just renders the countdown). Pure props, no effects.
//
// A9 (a11y): the 1 Hz mm:ss number is aria-hidden so a screen reader does not
// hear it tick every second; a SEPARATE aria-live="polite" region announces
// only coarse milestones (10 / 5 / 1 minute, "exam started") via the pure
// waitingRoomMilestone() helper — it only re-announces when the bucket changes.
import { Clock } from "lucide-react";
import { formatRemaining, waitingRoomMilestone } from "../../examTime";
import { ProctorHelpLine } from "./ProctorHelpLine";

export function WaitingRoomPanel({ contestName, startsInMs, startAtLabel, proctorPhone }: {
  contestName: string | null;
  /** Skew-corrected ms until T0 (>0 here by construction — the waiting room only
   *  renders inside the 15-min pre-T0 window). null only if the schedule vanished. */
  startsInMs: number | null;
  /** Local-time label of T0, e.g. "10:00 AM". null when no schedule is known. */
  startAtLabel: string | null;
  /** Proctor contact number for the help line (D4a). Empty ⇒ the line is omitted. */
  proctorPhone: string;
}) {
  const countdown = startsInMs !== null ? formatRemaining(startsInMs) : null;
  const minutesLeft = startsInMs !== null ? Math.ceil(startsInMs / 60_000) : null;
  const underAMinute = startsInMs !== null && startsInMs <= 60_000;
  const milestone = waitingRoomMilestone(startsInMs);

  return (
    <section className="mx-auto max-w-2xl rounded-lg border border-accent/40 bg-accent/5 p-6 shadow-subtle">
      <div className="text-center">
        <Clock size={28} className="mx-auto text-accent" />
        <h1 className="mt-3 text-2xl font-semibold text-ink">
          You&rsquo;re in. Your test starts soon.
        </h1>
        {contestName ? <p className="mt-1 text-sm font-medium text-accent">{contestName}</p> : null}
        <p className="mt-3 text-sm leading-6 text-muted">
          {startAtLabel
            ? <>Your test starts at <strong className="text-ink">{startAtLabel}</strong> — that&rsquo;s in </>
            : <>Your test starts in </>}
          {countdown ? (
            <strong className="font-mono text-ink tabular-nums" aria-hidden="true">{countdown}</strong>
          ) : null}
          {startAtLabel ? "." : "."}
        </p>
        {/* A9: the only announced surface — coarse milestones, never the 1 Hz tick. */}
        <p className="sr-only" role="status" aria-live="polite">{milestone ?? ""}</p>
      </div>

      <p className="mt-4 rounded-md border border-line bg-white/60 p-4 text-sm leading-6 text-ink">
        You don&rsquo;t need to do anything yet. Stay on this page in fullscreen — the test will open here
        automatically the moment it starts. No need to refresh.
      </p>

      <ul className="mt-4 space-y-2 text-sm leading-6 text-muted">
        <li>Stay in fullscreen and keep this tab open the whole time. Leaving fullscreen is recorded and can lock your test once the exam starts.</li>
        <li>Don&rsquo;t open other tabs, apps, or windows, and don&rsquo;t switch screens.</li>
        <li>Your screen and camera are being recorded for review. That&rsquo;s normal — just sit tight.</li>
        <li>Keep your laptop plugged in and your internet on.</li>
      </ul>

      <p className="mt-4 text-sm leading-6 text-muted">
        {underAMinute
          ? "Almost there — under a minute to go. Stay on this page."
          : `Nothing to do for the next ${minutesLeft ?? 0} minute${minutesLeft === 1 ? "" : "s"}. Don't change anything, don't open anything else — just wait here. When the timer hits zero, your questions appear on this page automatically.`}
      </p>

      <ProctorHelpLine proctorPhone={proctorPhone} className="mt-4" />
    </section>
  );
}
