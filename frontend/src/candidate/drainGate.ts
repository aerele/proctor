// frontend/src/candidate/drainGate.ts
// Tier-1 end-of-test drain gate — pure decision logic extracted from StudentApp
// so the "never claim safe-to-exit while footage is pending" invariant is unit-
// tested in isolation rather than only through the component tree.
//
// THE INVARIANT (release-blocker, confirmed against a live incident): the
// completion UI may say "safe to exit / fully uploaded" ONLY when the recording
// buffer is provably empty — pendingCount === 0 — or the recorder degraded to
// fallback mode (no durable buffer, today's pre-Tier-1 behavior). Any
// pending-and-unflushed state reached by ANY path (self-end, retry, server
// status flip, refresh button, reload) must be a loud, truthful "NOT saved"
// state that preserves the durable buffer — never a green checkmark.
import type { BufferMode, BufferStatus } from "../useProctorRecorder";

// The result of a drain wait. `drained` is the ONLY signal callers may trust to
// proceed to endSession + clearBuffer + the "ended" completion. It is true ONLY
// when the buffer genuinely reached empty (pendingCount <= 0) or degraded to
// fallback mode (the floor — fallback has no durable buffer to lose). If the
// wait aborts for ANY other reason (status flipped away from "ending_draining"
// while chunks are still pending — e.g. a candidate "try again"/resume click or
// a server status flip), `drained` is false and `pending` carries the real,
// still-unsent chunk count so the caller can surface "N chunks not saved".
export type DrainResult = { drained: boolean; pending: number };

// Minimal recorder surface the drain loop needs — a structural subset of the
// real recorder handle so tests can pass a hand-rolled fake (matching the
// existing recorder-mocking test style) without a full recorder.
export type DrainRecorder = {
  getBufferMode: () => BufferMode;
  getBufferStatus: () => Promise<BufferStatus>;
  kickDrain: () => void;
};

export type DrainBufferDeps = {
  // The live session status, read fresh on every poll (StudentApp passes a
  // closure over statusRef.current). The loop runs only while this stays
  // "ending_draining"; any other value means the UI moved on (admin end/lock,
  // or a candidate resume click) so the wait aborts.
  getStatus: () => string;
  // Injectable sleep so tests run instantly; StudentApp passes a 1s setTimeout.
  sleep: (ms: number) => Promise<void>;
  // Hard cap on polls (defence against an endless loop). StudentApp keeps the
  // long real-world wait; tests pass a tiny cap.
  maxPolls?: number;
  pollIntervalMs?: number;
};

// Drain the durable buffer until empty, or abort truthfully. PURE w.r.t. UI:
// it touches no React state, emits no events — it only kicks the recorder's
// drainer and polls. The caller owns event emission + state transitions, gating
// them on `drained`.
//
// Returns:
//   { drained: true,  pending: 0 } — buffer reached empty, OR was already empty.
//   { drained: true,  pending: N } — recorder is in fallback mode (no durable
//                                    buffer — the floor; releasing is correct).
//   { drained: false, pending: N } — status flipped away from "ending_draining"
//                                    while N > 0 chunks were still pending. The
//                                    caller must NOT clear the buffer or claim
//                                    "saved".
export async function drainBuffer(
  recorder: DrainRecorder,
  deps: DrainBufferDeps
): Promise<DrainResult> {
  // Fallback mode never has a durable buffer to drain — releasing is the floor,
  // identical to the pre-Tier-1 behavior. drained:true is correct here.
  if (recorder.getBufferMode() !== "buffering") return { drained: true, pending: 0 };

  const initial = await recorder.getBufferStatus();
  // Already empty (or flipped to fallback) at entry → drained, nothing to wait on.
  if (initial.mode !== "buffering" || initial.pendingCount <= 0) {
    return { drained: true, pending: Math.max(0, initial.pendingCount) };
  }

  const maxPolls = deps.maxPolls ?? 100_000;
  const pollIntervalMs = deps.pollIntervalMs ?? 1000;
  let pending = initial.pendingCount;

  for (let guard = 0; guard < maxPolls; guard += 1) {
    // The UI moved on (admin end/lock self-stopped the recorder + flipped status
    // away, OR the candidate clicked "try again"/resume → resumeRecording, OR a
    // server status flip). With chunks STILL pending this is an ABORT, not a
    // drain — return drained:false so the caller never claims "saved".
    if (deps.getStatus() !== "ending_draining") {
      return { drained: false, pending };
    }
    // Belt-and-braces wake; the recorder's own drainer (online + timer + post-
    // success kicks) owns the actual uploads.
    recorder.kickDrain();
    const current = await recorder.getBufferStatus();
    pending = current.pendingCount;
    if (current.mode !== "buffering" || current.pendingCount <= 0) {
      // Empty, or degraded to fallback mid-wait — the floor releases the gate.
      return { drained: true, pending: Math.max(0, current.pendingCount) };
    }
    await deps.sleep(pollIntervalMs);
  }
  // Exhausted the poll cap with chunks still pending — treat as NOT drained so
  // the caller never falsely claims "saved" (this path is effectively
  // unreachable with the real 100k cap, but it must fail safe, not open).
  return { drained: false, pending };
}

// The post-drain end-sequence decision (pure). Given a DrainResult, decide what
// the end path (stop()/retryEnd()) may do. This is the gate that makes "only
// proceed to endSession + clearBuffer + the ended completion when drained ===
// true" a unit-tested invariant rather than an inline `if` buried in two async
// component methods. When NOT drained: submitEnd / clearBuffer / showEnded are
// all false (the durable buffer is preserved and the candidate sees the loud
// "NOT saved" state); enterNotSaved is true and carries the residual pending.
export type EndPlan = {
  submitEnd: boolean; // call endSession?
  clearBuffer: boolean; // drop the durable buffer (clearBuffer/clearChunkBuffer)?
  showEnded: boolean; // flip to the "ended / safe to exit" completion?
  enterNotSaved: boolean; // drop into the loud "NOT saved" state instead?
  pending: number; // residual pending count (0 when drained)
};

export function endPlanForDrain(result: DrainResult): EndPlan {
  if (result.drained) {
    return { submitEnd: true, clearBuffer: true, showEnded: true, enterNotSaved: false, pending: 0 };
  }
  // NOT drained: chunks still pending. Preserve the buffer, do not submit the
  // end, do not claim "safe to exit". The end path enters the "NOT saved" state.
  return { submitEnd: false, clearBuffer: false, showEnded: false, enterNotSaved: true, pending: result.pending };
}

// The single safe-exit predicate. The completion UI ("Done — safe to exit /
// fully uploaded") may render ONLY when this is true. True iff the recorder is
// NOT in buffering mode (fallback has no durable buffer — today's behavior) OR
// the live pending-chunk count is exactly zero. Pure: derived from the recorder
// buffer mode + the host's live bufferStatus snapshot.
export function canShowSafeExit(args: {
  bufferMode: BufferMode | undefined;
  pendingCount: number;
}): boolean {
  return args.bufferMode !== "buffering" || args.pendingCount === 0;
}
