// frontend/src/candidate/panels/ComeBackLaterPanel.tsx
// #135 take-home (D6 / C-6 / A5 / §5b(2)): the ">15 min early" screen. It
// REPLACES the registration form full-screen (A5) — a candidate who opens the
// link well before the start must NOT acquire screen share / start a recording
// for a long dead wait (D6). The take-home pre-session re-fetch (A4) re-evaluates
// the boundary every ~30s, so once the clock crosses inside the 15-min window
// this screen AUTO-ADVANCES into the WaitingRoom (no candidate action needed).
import { CalendarClock } from "lucide-react";
import { ProctorHelpLine } from "./ProctorHelpLine";

export function ComeBackLaterPanel({ contestName, startAtLabel, startDateLabel, proctorPhone }: {
  contestName: string | null;
  /** Local-time label of T0, e.g. "10:00 AM". null when the schedule is unknown. */
  startAtLabel: string | null;
  /** Local-date label of T0, e.g. "Mon, Jun 23". null when unknown. */
  startDateLabel: string | null;
  proctorPhone: string;
}) {
  return (
    <section className="mx-auto max-w-xl rounded-lg border border-line bg-panel p-6 shadow-subtle">
      <div className="text-center">
        <CalendarClock size={28} className="mx-auto text-accent" />
        <h1 className="mt-3 text-2xl font-semibold text-ink">You&rsquo;re early — come back closer to start time.</h1>
        {contestName ? <p className="mt-1 text-sm font-medium text-accent">{contestName}</p> : null}
      </div>

      <p className="mt-4 text-sm leading-6 text-muted">
        {startAtLabel
          ? <>Your test starts at <strong className="text-ink">{startAtLabel}</strong>{startDateLabel ? <> on <strong className="text-ink">{startDateLabel}</strong></> : null}. It&rsquo;s not open yet, so there&rsquo;s nothing to do right now.</>
          : <>Your test hasn&rsquo;t opened yet, so there&rsquo;s nothing to do right now.</>}
      </p>
      <p className="mt-2 text-sm leading-6 text-muted">
        Close this tab and come back about 10 minutes before{startAtLabel ? <> <strong className="text-ink">{startAtLabel}</strong></> : " the start time"}.
        When you return and open this link, you&rsquo;ll go straight into the waiting screen and the test will begin on its own.
      </p>

      <ul className="mt-4 space-y-2 text-sm leading-6 text-muted">
        <li>Use a laptop or desktop with Chrome or Edge — not a phone or tablet.</li>
        <li>Find a quiet, well-lit room where you&rsquo;ll be alone for the whole test.</li>
        <li>Make sure your camera works and your laptop is charged.</li>
      </ul>

      <div className="mt-4 border-t border-line pt-4">
        {proctorPhone ? (
          <p className="text-sm leading-6 text-muted">
            Questions before you start? Call your proctor at{" "}
            <a className="font-medium text-accent underline" href={`tel:${proctorPhone}`}>{proctorPhone}</a>.
          </p>
        ) : (
          <ProctorHelpLine proctorPhone={proctorPhone} />
        )}
      </div>
    </section>
  );
}
