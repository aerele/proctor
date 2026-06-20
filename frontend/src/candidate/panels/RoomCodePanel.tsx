// frontend/src/candidate/panels/RoomCodePanel.tsx
// Candidate leaf panel (extracted verbatim from App.tsx, F2). Props-driven.
import { KeyRound } from "lucide-react";
import { isCompleteOtp } from "../../invigilator/gateLogic";

// S3: the waiting room between "recording started" and "exam released". Shows a
// big 6-digit entry (the invigilator writes the room code on the board) and
// auto-advances when the invigilator opens the whole room.
export function RoomCodePanel(props: {
  room: string;
  code: string;
  error: string;
  busy: boolean;
  onCodeChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const { room, code, error, busy, onCodeChange, onSubmit } = props;
  return (
    <section className="rounded-lg border border-accent/40 bg-accent/5 p-6 text-center shadow-subtle">
      <KeyRound size={26} className="mx-auto text-accent" />
      <h2 className="mt-3 text-xl font-semibold text-ink">Waiting for your room code</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted">
        Recording has started. Your invigilator will announce a 6-digit start code for room {room ? <strong>{room}</strong> : "(not set)"} just before the test begins. Enter it below — or simply wait: if your invigilator starts the whole room, this screen advances automatically.
      </p>
      <div className="mx-auto mt-4 flex max-w-xs items-center gap-3">
        <input
          className="focus-ring h-12 w-full rounded-md border border-line bg-white px-4 text-center text-2xl font-semibold tracking-[0.4em] text-ink"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          value={code}
          onChange={(event) => onCodeChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && isCompleteOtp(code) && !busy) onSubmit();
          }}
        />
        <button
          className="focus-ring inline-flex h-12 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!isCompleteOtp(code) || busy}
          onClick={onSubmit}
        >
          {busy ? "Checking…" : "Start"}
        </button>
      </div>
      {error ? <p className="mt-3 text-sm font-medium text-danger">{error}</p> : null}
      <p className="mt-3 text-xs text-muted">Stay in this tab. Your screen is being recorded while you wait.</p>
    </section>
  );
}
