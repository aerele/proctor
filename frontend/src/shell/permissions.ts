// frontend/src/shell/permissions.ts
//
// F5.1 — permissions-first onboarding: PURE checklist state for the stage-1
// PermissionsGate. All browser prompts (screen share, camera+mic, clipboard)
// fire BEFORE fullscreen so a permission dialog can never kick the candidate
// out of fullscreen mid-onboarding. Only the screen share is a hard gate —
// camera/mic/clipboard keep their existing optional semantics (denials are
// recorded for the proctor, never blocking). The DOM/getUserMedia glue lives
// in App.tsx + useProctorRecorder.ts; everything here is vitest-tested.

import type { RecorderStartErrorKind } from "../useProctorRecorder";

export type PermissionKey = "screen" | "camera" | "microphone" | "clipboard";

export type PermissionStatus = "pending" | "requesting" | "granted" | "denied" | "unavailable";

export type PermissionChecklist = Record<PermissionKey, PermissionStatus>;

// Screen first: it is the only REQUIRED item and the anchor of the single
// setup gesture (getDisplayMedia must run on the click itself).
export const PERMISSION_ORDER: PermissionKey[] = ["screen", "camera", "microphone", "clipboard"];

export const PERMISSION_META: Record<PermissionKey, { label: string; required: boolean; blurb: string }> = {
  screen: { label: "Screen sharing", required: true, blurb: "Your ENTIRE screen is recorded from start to finish." },
  camera: { label: "Camera", required: false, blurb: "Live camera monitoring while you take the test." },
  microphone: { label: "Microphone", required: false, blurb: "Room audio is recorded alongside your screen." },
  clipboard: { label: "Clipboard", required: false, blurb: "Copy, cut, and paste during the test are logged for review." }
};

export const initialPermissionChecklist: PermissionChecklist = {
  screen: "pending",
  camera: "pending",
  microphone: "pending",
  clipboard: "pending"
};

// The hard gate: stage 2 (fullscreen) unlocks once the screen share is live.
// Camera/mic/clipboard stay optional — same trust model as the recorder.
export function permissionsReady(checklist: PermissionChecklist): boolean {
  return checklist.screen === "granted";
}

// Drives the auto-continue: a flawless run needs no extra click.
export function allPermissionsGranted(checklist: PermissionChecklist): boolean {
  return PERMISSION_ORDER.every((key) => checklist[key] === "granted");
}

// Before the first run the gate shows ONE setup button; after any attempt the
// per-item statuses (and retry buttons) take over.
export function permissionsAttempted(checklist: PermissionChecklist): boolean {
  return PERMISSION_ORDER.some((key) => checklist[key] !== "pending");
}

// B1/LT-2 (v1.1): the acquire-once checklist patch. The browser-check stage now
// performs the REAL surface-guarded acquire and carries the live streams up, so
// when those streams arrive we mark the matching items granted WITHOUT another
// prompt. Screen is the hard gate: a live screen track => "granted". Camera and
// microphone are derived from the live track kinds on the cameraMic stream (a
// mic-only grant marks microphone granted, camera pending — re-promptable, never
// blocking). Clipboard is NOT acquired by the browser check (it has no stream),
// so it is left untouched here and primed later in the permissions setup. Pure
// so the acquire-once skip logic is vitest-tested without a real picker.
export function checklistFromAcquiredMedia(
  current: PermissionChecklist,
  media: { hasLiveScreen: boolean; hasLiveCamera: boolean; hasLiveMicrophone: boolean }
): PermissionChecklist {
  return {
    ...current,
    screen: media.hasLiveScreen ? "granted" : current.screen,
    camera: media.hasLiveCamera ? "granted" : current.camera,
    microphone: media.hasLiveMicrophone ? "granted" : current.microphone
  };
}

// Live-track helpers for checklistFromAcquiredMedia (kept here so the caller in
// App.tsx passes a plain boolean shape and the derivation stays unit-testable).
export function hasLiveTrackOfKind(stream: MediaStream | null | undefined, kind: "video" | "audio"): boolean {
  if (!stream) return false;
  const tracks = kind === "video" ? stream.getVideoTracks() : stream.getAudioTracks();
  return tracks.some((t) => t.readyState === "live");
}

// denied => candidate can re-trigger the prompt; pending stays retryable so a
// screen share killed between setup and start drops back to a retry button.
// unavailable is a dead end (no API/device) — retrying cannot help.
export function permissionRetryable(status: PermissionStatus): boolean {
  return status === "denied" || status === "pending";
}

export function permissionStatusLine(key: PermissionKey, status: PermissionStatus): string {
  if (status === "requesting") {
    return key === "screen"
      ? "Pick your Entire Screen in the browser dialog…"
      : "Waiting for you to press Allow…";
  }
  if (status === "granted") {
    if (key === "screen") return "Entire screen is being shared.";
    if (key === "clipboard") return "Clipboard access granted.";
    return `${PERMISSION_META[key].label} access granted.`;
  }
  if (status === "denied") {
    if (key === "screen") return "Screen share was cancelled or blocked.";
    return `${PERMISSION_META[key].label} was blocked. This is noted for the proctor — you can still continue.`;
  }
  if (status === "unavailable") {
    return `${PERMISSION_META[key].label} is not available on this browser or device.`;
  }
  // pending
  return key === "screen" ? "Not shared yet." : "Not requested yet.";
}


// FIX-B3 #1: the clipboard primer (navigator.clipboard.readText()) is OPTIONAL
// and must NEVER wedge onboarding. Some browsers/extensions leave the clipboard
// grant prompt hanging indefinitely, which would freeze the "Requesting
// permissions…" state forever. So we RACE the read against a short timeout and
// treat a timeout exactly like a denial: recorded as not-granted, non-blocking.
// The grant (if it ever resolves later) is moot — we never keep the clipboard
// TEXT here anyway (M6), only the boolean grant. ~3.5 s is long enough for a
// real prompt-accept yet short enough not to strand a candidate.
export const CLIPBOARD_PRIMER_TIMEOUT_MS = 3500;

export type ClipboardPrimerOutcome = "granted" | "denied" | "timeout";

// Generic, dependency-free promise/timeout race. Resolves with the promise's
// fulfilled value if it wins, rejects with its reason if it rejects first, and
// resolves with `timeoutValue` once `timeoutMs` elapses with neither. Whichever
// arm settles SECOND is ignored (a late settle can't flip an already-decided
// race), so a slow clipboard read that resolves after the timeout is harmless.
export function raceWithTimeout<T, Handle = ReturnType<typeof setTimeout>>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutValue: T,
  setTimeoutFn: (cb: () => void, ms: number) => Handle = setTimeout as unknown as (cb: () => void, ms: number) => Handle,
  clearTimeoutFn: (handle: Handle) => void = clearTimeout as unknown as (handle: Handle) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeoutFn(() => {
      if (settled) return;
      settled = true;
      resolve(timeoutValue);
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        resolve(value);
      },
      (reason) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        reject(reason);
      }
    );
  });
}

// Run the clipboard primer with the timeout race. Returns the outcome the App
// records on the checklist: "granted" if the read succeeds in time, "denied" if
// it rejects (blocked), "timeout" if it neither resolves nor rejects in time.
// The App maps BOTH "denied" and "timeout" to the non-blocking "denied" status,
// so onboarding always proceeds. The read result TEXT is never inspected (M6).
export async function primeClipboardWithTimeout<Handle = ReturnType<typeof setTimeout>>(
  readText: () => Promise<unknown>,
  timeoutMs: number = CLIPBOARD_PRIMER_TIMEOUT_MS,
  setTimeoutFn?: (cb: () => void, ms: number) => Handle,
  clearTimeoutFn?: (handle: Handle) => void
): Promise<ClipboardPrimerOutcome> {
  const TIMED_OUT = "__clipboard_primer_timeout__";
  try {
    const result = await raceWithTimeout<string, Handle>(
      readText().then(() => "granted"),
      timeoutMs,
      TIMED_OUT,
      setTimeoutFn,
      clearTimeoutFn
    );
    return result === TIMED_OUT ? "timeout" : "granted";
  } catch {
    return "denied";
  }
}

// Map a classified screen-share failure onto the checklist: an unsupported
// browser is a dead end; everything else is retryable.
export function screenStatusFromErrorKind(kind: RecorderStartErrorKind): PermissionStatus {
  return kind === "unsupported" ? "unavailable" : "denied";
}

// Gate copy for a failed screen share — setup-stage wording (no session, no
// recording yet), unlike App.tsx's handleStartFailure copy.
// #135 take-home (A10): the generic-failure tail routes to the proctor phone
// instead of "call an invigilator" for remote contests (no invigilator in the
// room). Absent opts ⇒ byte-identical in-venue copy (D3).
export function screenShareFailureMessage(
  kind: RecorderStartErrorKind,
  opts?: { takeHome?: boolean; phone?: string }
): string {
  if (kind === "invalid_surface") {
    return "You shared a tab or window. Share your ENTIRE screen — press the button again and pick the whole screen.";
  }
  if (kind === "share_cancelled") {
    return "Screen share was cancelled or blocked. Press the button again, choose your Entire Screen, and Allow.";
  }
  if (kind === "unsupported") {
    return "This browser cannot share your screen. Open this page in the latest Chrome or Edge on a laptop or desktop.";
  }
  const callForHelp = opts?.takeHome
    ? `call your proctor at ${opts.phone || "the number provided"}`
    : "call an invigilator";
  return `Screen share failed. Try again — if it keeps failing, ${callForHelp}.`;
}
