// frontend/src/devtools/TakeHomeGallery.tsx
//
// #135 take-home — DEV/DEMO-ONLY screenshot gallery (test + doc infra, NOT a
// product surface). It mounts the pure presentational take-home panels in
// isolation, inside the real <Shell> with the real Tailwind theme, so each NEW
// remote screen can be (a) screenshotted clean for human UX sign-off and (b)
// captured as a Playwright visual baseline — without driving the full StudentApp
// into a hard-to-reproduce pre-T0 recording state.
//
// Gating: this is only reachable when VITE_DEMO_MODE === "true" (see the guard in
// App.tsx). In a production build the route falls through to the candidate app,
// so this file is INERT in prod (no feature-logic change — pure demo infra).
//
// Each screen renders under a stable ?screen=<id> selector so a Playwright spec
// can isolate one component per shot. Props are realistic + deterministic (no
// live clock: countdown ms are passed as fixed props), so shots are byte-stable.
import { Lock } from "lucide-react";
import { Shell } from "../ui/Shell";
import { WaitingRoomPanel } from "../candidate/panels/WaitingRoomPanel";
import { ComeBackLaterPanel } from "../candidate/panels/ComeBackLaterPanel";
import { ProctorHelpLine } from "../candidate/panels/ProctorHelpLine";
import { BlockedScreen } from "../candidate/panels/BlockedScreen";
import { EnforcementOverlay } from "../shell/EnforcementOverlay";

// One realistic contest identity reused across every screen.
const CONTEST_NAME = "Aerele Backend Hiring — Take-Home Round";
const PROCTOR_PHONE = "+91 98765 43210";

// A representative pre-T0 state: ~8 min 30 s remaining, T0 = 10:00 AM IST.
const EIGHT_THIRTY_MS = 8 * 60 * 1000 + 30 * 1000; // 510000

export function TakeHomeGallery() {
  const screen = new URLSearchParams(window.location.search).get("screen") ?? "index";

  switch (screen) {
    case "waiting-room":
      return (
        <Shell padTop={false}>
          <WaitingRoomPanel
            contestName={CONTEST_NAME}
            startsInMs={EIGHT_THIRTY_MS}
            startAtLabel="10:00 AM"
            proctorPhone={PROCTOR_PHONE}
          />
        </Shell>
      );

    case "come-back-later":
      return (
        <Shell padTop={false}>
          <ComeBackLaterPanel
            contestName={CONTEST_NAME}
            startAtLabel="10:00 AM"
            startDateLabel="Mon, Jun 23"
            proctorPhone={PROCTOR_PHONE}
          />
        </Shell>
      );

    case "proctor-help-line":
      // The persistent in-exam chrome help element, on its own card so the
      // element itself is the subject of the shot.
      return (
        <Shell padTop={false}>
          <section className="mx-auto max-w-xl rounded-lg border border-line bg-panel p-6 shadow-subtle">
            <p className="mb-3 text-sm font-medium text-ink">In-exam proctoring panel</p>
            <ProctorHelpLine proctorPhone={PROCTOR_PHONE} />
          </section>
        </Shell>
      );

    case "soft-nudge":
      // The SOFT pre-T0 fullscreen-exit nudge (calm / non-red, no countdown, no
      // typed-ack). It is a fixed-inset overlay, so it paints over a faint
      // waiting-room backdrop exactly as it would in the live wait.
      return (
        <Shell padTop={false}>
          <WaitingRoomPanel
            contestName={CONTEST_NAME}
            startsInMs={EIGHT_THIRTY_MS}
            startAtLabel="10:00 AM"
            proctorPhone={PROCTOR_PHONE}
          />
          <EnforcementOverlay
            phase="soft"
            violation={null}
            remainingSeconds={null}
            exitCount={0}
            ackOk={false}
            fullscreen={false}
            takeHome
            proctorPhone={PROCTOR_PHONE}
            onAckChange={() => undefined}
            onEnterFullscreen={async () => undefined}
          />
        </Shell>
      );

    case "locked-with-phone":
      // The enforcement-LOCKED screen, take-home variant: the {phone} CTA in the
      // body lines + the UnlockCodePanel below. We render a static stand-in for
      // the unlock panel (the real one calls the unlock API on submit) so the
      // shot needs no session — the copy + layout are identical.
      return (
        <Shell padTop={false}>
          <BlockedScreen
            tone="danger"
            icon={<Lock size={22} />}
            title="Your test is locked — fullscreen rule"
            lines={[
              "You did not return to fullscreen in time (or exited fullscreen too many times), so this session locked itself.",
              `Call your proctor at ${PROCTOR_PHONE}. They can read you a 6-digit unlock code to enter below, or unlock you from their console.`
            ]}
            onRefresh={() => undefined}
            error=""
          />
          <LockedUnlockStandIn />
        </Shell>
      );

    default:
      return (
        <Shell padTop={false}>
          <section className="mx-auto max-w-2xl rounded-lg border border-line bg-panel p-6 shadow-subtle">
            <h1 className="text-2xl font-semibold text-ink">Take-home screen gallery (demo only)</h1>
            <p className="mt-2 text-sm text-muted">
              Append <code className="font-mono">?screen=&lt;id&gt;</code>: <code>waiting-room</code>,{" "}
              <code>come-back-later</code>, <code>proctor-help-line</code>, <code>soft-nudge</code>,{" "}
              <code>locked-with-phone</code>.
            </p>
          </section>
        </Shell>
      );
  }
}

// A faithful, session-free stand-in for the UnlockCodePanel's chrome + copy (the
// real panel wires its input/button to the unlock API). Markup mirrors
// UnlockCodePanel.tsx so the locked-screen shot reads true.
function LockedUnlockStandIn() {
  return (
    <section className="mx-auto mt-5 max-w-xl rounded-lg border border-line bg-panel p-5 text-center shadow-subtle">
      <p className="text-sm font-semibold text-ink">Have the unlock code?</p>
      <p className="mt-1 text-sm leading-6 text-muted">
        Your proctor can read you a 6-digit unlock code (from their console) to unlock this session. Call them at{" "}
        <a className="font-medium text-accent underline" href={`tel:${PROCTOR_PHONE}`}>{PROCTOR_PHONE}</a>.
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
        <input
          className="focus-ring h-11 w-44 rounded-md border border-line bg-white px-3 text-center font-mono text-lg tracking-[0.3em]"
          inputMode="numeric"
          maxLength={6}
          placeholder="000000"
          readOnly
          value=""
        />
        <button className="focus-ring inline-flex h-11 items-center gap-2 rounded-md bg-ink px-5 text-sm font-medium text-white opacity-50" disabled>
          Unlock
        </button>
      </div>
    </section>
  );
}
