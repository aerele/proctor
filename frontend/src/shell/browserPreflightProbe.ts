// frontend/src/shell/browserPreflightProbe.ts
//
// G2 (v1.1 anti-cheat) — the LIVE anti-spoof probe runner. This is the half that
// browserPreflight.ts deliberately is NOT: it actually CALLS the capture APIs
// and inspects the result, instead of trusting feature-detection (which a
// spoofed UA / shimmed `navigator` could pass). The PURE verdict logic lives in
// browserPreflight.ts (evaluatePreflight) and is unit-tested; this module is the
// thin browser glue, kept out of the unit suite (it needs real getUserMedia).
//
// Two probe TIERS so we don't pop a permission dialog just to load the page:
//   • Passive probes (secure_context, media_recorder codec, fullscreen API,
//     keystroke/cursor event support) run on mount — no prompts.
//   • Active probes (screen_capture, camera_mic) require a user gesture (the
//     "Check my browser" button) because getDisplayMedia/getUserMedia must run
//     on a click. They genuinely OPEN the picker and verify a LIVE track comes
//     back, then immediately stop it (we are only testing capability here; the
//     real capture happens later in PermissionsGate).
//
// HONEST: a page-level shim of these APIs can still fake a pass. We can't win
// against a fully instrumented browser from inside it. This blocks the realistic
// cases (wrong/old/locked-down browser, no codec, headless, spoofed UA whose
// real captures fail) — see browserPreflight.ts header.

import type { PreflightCapability, ProbeResult } from "./browserPreflight";
import { PREFLIGHT_MATRIX } from "./browserPreflight";

function result(capability: PreflightCapability, ok: boolean, detail?: string): ProbeResult {
  return { capability, ok, required: PREFLIGHT_MATRIX[capability].required, detail };
}

// Stop every track on a stream — we only needed to prove we could acquire it.
function stopStream(stream: MediaStream | null | undefined) {
  try {
    stream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* best-effort cleanup */
  }
}

// ---- passive probes (no prompts) ---------------------------------------------

export function probeSecureContext(): ProbeResult {
  // getUserMedia/getDisplayMedia require a secure context. window.isSecureContext
  // is the authoritative signal (true on https + localhost).
  const ok = typeof window !== "undefined" && window.isSecureContext === true;
  return result("secure_context", ok, ok ? undefined : "This page must be served over HTTPS.");
}

export function probeMediaRecorder(): ProbeResult {
  // ANTI-SPOOF: MediaRecorder may exist but support NO webm codec (then we can't
  // encode the recording). Require an actually-supported webm mime — the same
  // candidates the recorder uses (useProctorRecorder getSupportedMimeType).
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return result("media_recorder", false, "MediaRecorder is not available.");
  }
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  const ok = candidates.some((c) => {
    try {
      return MediaRecorder.isTypeSupported(c);
    } catch {
      return false;
    }
  });
  return result("media_recorder", ok, ok ? undefined : "No supported screen-recording video codec.");
}

export function probeFullscreen(): ProbeResult {
  // The exam runs fullscreen; requestFullscreen must exist (vendor-prefixed
  // included for older WebKit).
  const el = typeof document !== "undefined" ? (document.documentElement as unknown as Record<string, unknown>) : null;
  const ok = Boolean(
    el && (typeof el.requestFullscreen === "function" || typeof el.webkitRequestFullscreen === "function")
  );
  return result("fullscreen", ok, ok ? undefined : "Full-screen mode is not supported.");
}

export function probeKeystroke(): ProbeResult {
  // Keystroke capture relies on the KeyboardEvent constructor + addEventListener.
  // We can't force a real keypress here, but a browser missing these can't log
  // editor keystrokes at all. (Real keystroke flow is exercised in the editor.)
  const ok = typeof window !== "undefined"
    && typeof window.addEventListener === "function"
    && typeof KeyboardEvent !== "undefined";
  return result("keystroke", ok, ok ? undefined : "Keyboard event capture is not supported.");
}

export function probeCursor(): ProbeResult {
  // Cursor/pointer tracking relies on PointerEvent (or at minimum MouseEvent).
  const ok = typeof window !== "undefined"
    && (typeof PointerEvent !== "undefined" || typeof MouseEvent !== "undefined");
  return result("cursor", ok, ok ? undefined : "Pointer / cursor capture is not supported.");
}

export function runPassiveProbes(): ProbeResult[] {
  return [probeSecureContext(), probeMediaRecorder(), probeFullscreen(), probeKeystroke(), probeCursor()];
}

// ---- active probes (need a user gesture) -------------------------------------

// ANTI-SPOOF: actually OPEN the screen picker and require a LIVE video track. A
// browser that lacks getDisplayMedia, or one where the user cancels, or a
// headless environment that returns no track, FAILS. We stop the track at once —
// this is only a capability test. A cancellation reads as "can't establish the
// capture set" → block (the candidate can re-run the check).
export async function probeScreenCapture(): Promise<ProbeResult> {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!md || typeof md.getDisplayMedia !== "function") {
    return result("screen_capture", false, "Screen sharing is not supported by this browser.");
  }
  let stream: MediaStream | null = null;
  try {
    stream = await md.getDisplayMedia({ video: true, audio: false });
    const hasVideo = stream.getVideoTracks().length > 0 && stream.getVideoTracks()[0].readyState !== "ended";
    return result("screen_capture", hasVideo, hasVideo ? undefined : "Screen share returned no live video.");
  } catch {
    return result("screen_capture", false, "Screen share was blocked or cancelled.");
  } finally {
    stopStream(stream);
  }
}

// camera_mic is OPTIONAL (no webcam ≠ blocked). We still TRY — a present camera
// that errors is recorded as a warning, and a granted track confirms capability.
// A missing device or denied permission is a non-blocking warning.
export async function probeCameraMic(): Promise<ProbeResult> {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!md || typeof md.getUserMedia !== "function") {
    return result("camera_mic", false, "Camera / microphone access is not supported.");
  }
  let stream: MediaStream | null = null;
  try {
    stream = await md.getUserMedia({ video: true, audio: true });
    const ok = stream.getTracks().length > 0;
    return result("camera_mic", ok, ok ? undefined : "No camera or microphone track.");
  } catch {
    // Try audio-only before giving up — a desktop with a mic but no webcam still
    // contributes audio. Still non-blocking either way.
    try {
      stream = await md.getUserMedia({ audio: true });
      return result("camera_mic", stream.getAudioTracks().length > 0, "Microphone only (no camera).");
    } catch {
      return result("camera_mic", false, "Camera and microphone unavailable.");
    }
  } finally {
    stopStream(stream);
  }
}

// The synthetic demo build (VITE_DEMO_MODE) has NO real capture — the whole demo
// API layer is synthetic and never records. Headless/demo Chromium also can't
// auto-pick a desktop-capture source for getDisplayMedia. So in demo mode the
// active probes report a synthetic PASS (the gate UI still renders and is
// clickable). Real builds always run the live anti-spoof probes.
const demoMode = import.meta.env.VITE_DEMO_MODE === "true";

// Run the active (gesture-required) probes. Called from the "Check my browser"
// button handler so getDisplayMedia/getUserMedia run on the user gesture.
export async function runActiveProbes(): Promise<ProbeResult[]> {
  if (demoMode) {
    return [result("screen_capture", true, "Demo build — capture not exercised."), result("camera_mic", true)];
  }
  // Screen first (the hard gate) so a cancel there short-circuits the camera
  // prompt — no point asking for the webcam if the screen can't be shared.
  const screen = await probeScreenCapture();
  const camera = await probeCameraMic();
  return [screen, camera];
}
