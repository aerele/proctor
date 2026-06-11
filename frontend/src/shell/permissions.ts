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


// Map a classified screen-share failure onto the checklist: an unsupported
// browser is a dead end; everything else is retryable.
export function screenStatusFromErrorKind(kind: RecorderStartErrorKind): PermissionStatus {
  return kind === "unsupported" ? "unavailable" : "denied";
}

// Gate copy for a failed screen share — setup-stage wording (no session, no
// recording yet), unlike App.tsx's handleStartFailure copy.
export function screenShareFailureMessage(kind: RecorderStartErrorKind): string {
  if (kind === "invalid_surface") {
    return "You shared a tab or window. Share your ENTIRE screen — press the button again and pick the whole screen.";
  }
  if (kind === "share_cancelled") {
    return "Screen share was cancelled or blocked. Press the button again, choose your Entire Screen, and Allow.";
  }
  if (kind === "unsupported") {
    return "This browser cannot share your screen. Open this page in the latest Chrome or Edge on a laptop or desktop.";
  }
  return "Screen share failed. Try again — if it keeps failing, call an invigilator.";
}
