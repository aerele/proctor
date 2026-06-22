// frontend/src/candidate/panels/UnlockCodePanel.tsx
// Candidate leaf panel (extracted verbatim from App.tsx, F2). Props-driven.
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { unlockEnforcementGate } from "../../api";
import type { ApiError } from "../../api";
import { isCompleteOtp, normalizeOtpInput } from "../../invigilator/gateLogic";

// F5.6 L2 candidate-side release: an ENFORCEMENT-locked session unlocks with
// the room's dedicated UNLOCK code (minted on the invigilator portal — wave-2
// fix: never the start code, which the candidate typed themselves to begin).
// Admin locks never render this panel (locked_reason gate in the caller).
//
// #135 take-home (§5a rows 13-15): with `takeHome`, the "ask your room proctor"
// copy routes to the remote proctor phone instead. Absent ⇒ in-venue copy (D3).
export function UnlockCodePanel({ sessionId, takeHome = false, proctorPhone = "", onUnlocked }: { sessionId: string; takeHome?: boolean; proctorPhone?: string; onUnlocked: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const submit = async () => {
    setBusy(true);
    setMessage("");
    try {
      await unlockEnforcementGate(sessionId, code.trim());
      setCode("");
      onUnlocked();
    } catch (cause) {
      const apiCode = (cause as ApiError)?.code;
      setMessage(
        apiCode === "invalid_code"
          ? takeHome
            ? `That code is not valid. Call your proctor at ${proctorPhone || "the number provided"} and ask them to read it again — the unlock code is NOT the code you started with.`
            : "That code is not valid. Ask your room proctor to read it again — the unlock code is NOT the code you started with."
          : apiCode === "too_many_attempts" ? "Too many attempts — this session can now only be unlocked by a proctor."
            : apiCode === "no_unlock_code"
              ? takeHome
                ? `An unlock code hasn't been issued yet. Call your proctor at ${proctorPhone || "the number provided"} and ask them to generate one on their console, or to unlock you from there.`
                : "Your room proctor hasn't issued an unlock code yet. Ask them to generate one on their console, or to unlock you from there."
              : apiCode === "not_enforcement_locked" ? "This lock can only be released by a proctor."
                : cause instanceof Error ? cause.message : String(cause)
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto mt-5 max-w-xl rounded-lg border border-line bg-panel p-5 text-center shadow-subtle">
      <p className="text-sm font-semibold text-ink">Have the unlock code?</p>
      <p className="mt-1 text-sm leading-6 text-muted">
        {takeHome
          ? <>Your proctor can read you a 6-digit unlock code (from their console) to unlock this session. Call them at{" "}
              <a className="font-medium text-accent underline" href={`tel:${proctorPhone}`}>{proctorPhone || "the number provided"}</a>.</>
          : "Your room proctor can read you a 6-digit unlock code (from their proctor console) to unlock this session."}
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
        <input
          className="focus-ring h-11 w-44 rounded-md border border-line bg-white px-3 text-center font-mono text-lg tracking-[0.3em]"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          value={code}
          onChange={(event) => setCode(normalizeOtpInput(event.target.value))}
          onKeyDown={(event) => {
            if (event.key === "Enter" && isCompleteOtp(code) && !busy) void submit();
          }}
        />
        <button
          className="focus-ring inline-flex h-11 items-center gap-2 rounded-md bg-ink px-5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!isCompleteOtp(code) || busy}
          onClick={() => void submit()}
        >
          <KeyRound size={16} /> Unlock
        </button>
      </div>
      {message ? <p className="mt-3 text-sm font-medium text-danger">{message}</p> : null}
    </section>
  );
}
