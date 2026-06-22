// frontend/src/shell/browserPreflight.ts
//
// G2 (v1.1 anti-cheat) — browser / codec PREFLIGHT + anti-spoof HARD block.
//
// Audit #10 / decision (TAKEHOME-V1.1-DECISIONS §"#10"): "if we can't establish
// the recording set / can't capture screen + keystrokes + cursor, DO NOT let
// them proceed. Build a browser matrix. Browsers can be SPOOFED → add capability
// DETECTION that actually TRIES the capture; if not possible → block with 'use
// the latest Chrome / recommended browser'."
//
// DESIGN: the UA string is NEVER the gate (it is trivially spoofed). The gate is
// the RESULT of actually attempting each capability: a present-but-non-functional
// API (e.g. getDisplayMedia exists but the share is impossible, or MediaRecorder
// exists but supports no webm codec) FAILS the probe. This module is the PURE
// decision layer over those probe results — unit-tested; the live attempts are
// the thin async runner in browserPreflightProbe.ts.
//
// HONEST about the model: a determined attacker who shims getDisplayMedia/
// getUserMedia/MediaRecorder in the page can fake a "pass". We can't beat a fully
// instrumented browser from inside it. The bar this clears is the COMMON case —
// wrong/old browser, no codec, no screen-capture support, headless/locked-down
// environments — plus a spoofed UA pretending to be a supported browser while
// the real captures fail. That is the realistic threat, and it is blocked hard.

// The capability set we MUST be able to establish to run an honest proctored
// session. Each is probed by actually attempting it (browserPreflightProbe.ts).
export type PreflightCapability =
  | "secure_context"   // https / localhost — getUserMedia/getDisplayMedia need it
  | "screen_capture"   // getDisplayMedia returns a live screen track
  | "camera_mic"       // getUserMedia returns a track (camera and/or mic)
  | "media_recorder"   // MediaRecorder + a supported webm codec (we can ENCODE)
  | "fullscreen"       // Element.requestFullscreen exists (the exam runs fullscreen)
  | "keystroke"        // KeyboardEvent capture works (editor keystroke logging)
  | "cursor";          // PointerEvent / cursor tracking works

// A single probe outcome. `required` capabilities BLOCK on failure; optional
// ones (camera_mic today — a desktop with no webcam is allowed, screen is the
// hard floor, matching permissions.ts) only WARN.
export type ProbeResult = {
  capability: PreflightCapability;
  ok: boolean;
  required: boolean;
  /** Short human reason shown in the matrix when ok=false. */
  detail?: string;
};

// The browser-capability MATRIX: which capabilities are REQUIRED (hard block on
// failure) vs optional (recorded, non-blocking). screen_capture + media_recorder
// + fullscreen + secure_context are the floor — without them there is no honest
// recording. keystroke/cursor are required because the integrity model leans on
// them (decision: "can't capture … keystrokes + cursor → don't let them
// proceed"). camera_mic stays OPTIONAL (no webcam ≠ disqualified; matches the
// existing recorder trust model where screen is the only hard gate).
export const PREFLIGHT_MATRIX: Record<PreflightCapability, { required: boolean; label: string }> = {
  secure_context: { required: true, label: "Secure connection (HTTPS)" },
  screen_capture: { required: true, label: "Screen sharing" },
  media_recorder: { required: true, label: "Screen recording (video codec)" },
  fullscreen: { required: true, label: "Full-screen mode" },
  keystroke: { required: true, label: "Keystroke capture" },
  cursor: { required: true, label: "Cursor / pointer capture" },
  camera_mic: { required: false, label: "Camera & microphone" }
};

export const PREFLIGHT_ORDER: PreflightCapability[] = [
  "secure_context",
  "screen_capture",
  "media_recorder",
  "fullscreen",
  "keystroke",
  "cursor",
  "camera_mic"
];

export type PreflightVerdict = {
  /** true ⇒ proceed; false ⇒ HARD block. */
  passed: boolean;
  /** the REQUIRED capabilities that failed (drives the block message). */
  blockingFailures: PreflightCapability[];
  /** OPTIONAL capabilities that failed (warned, non-blocking). */
  warnings: PreflightCapability[];
  /** the candidate-facing headline message. */
  message: string;
};

// The standard "use the latest Chrome / recommended browser" block message.
// Names the failing capabilities so the candidate (or the proctor on the phone)
// can act. Deliberately points at Chrome/Edge desktop — the supported matrix.
export const RECOMMENDED_BROWSER_LINE =
  "Please open this test in the latest Google Chrome (or Microsoft Edge) on a laptop or desktop computer. Phones, tablets, in-app browsers, and older or privacy-hardened browsers cannot run the proctored recording.";

/**
 * PURE: decide the preflight verdict from the probe results. A single REQUIRED
 * failure blocks. The message lists what failed + the recommended-browser line.
 */
export function evaluatePreflight(results: ProbeResult[]): PreflightVerdict {
  const blockingFailures = results.filter((r) => r.required && !r.ok).map((r) => r.capability);
  const warnings = results.filter((r) => !r.required && !r.ok).map((r) => r.capability);

  if (blockingFailures.length === 0) {
    return {
      passed: true,
      blockingFailures: [],
      warnings,
      message: "Your browser supports everything this proctored test needs."
    };
  }

  const failedLabels = blockingFailures.map((cap) => PREFLIGHT_MATRIX[cap].label);
  const failList = failedLabels.length === 1
    ? failedLabels[0]
    : `${failedLabels.slice(0, -1).join(", ")} and ${failedLabels[failedLabels.length - 1]}`;

  return {
    passed: false,
    blockingFailures,
    warnings,
    message: `This browser cannot ${blockingFailures.length === 1 ? "do" : "do all of"}: ${failList}. ${RECOMMENDED_BROWSER_LINE}`
  };
}

// ---- secondary UA advisory (NEVER the gate) ----------------------------------
//
// The UA is used ONLY to add a helpful hint, never to pass or block — a real
// capture probe already decided that. We DO surface a soft note when the UA
// looks like a known-unsupported surface (iOS Safari can't getDisplayMedia,
// in-app webviews are flaky) so the candidate gets a clearer pointer even if
// some shimmed probe slipped through. PURE.
export type UaAdvisory = "ok" | "ios" | "in_app_webview" | "firefox" | "unknown";

export function classifyUserAgent(ua: string): UaAdvisory {
  const s = (ua || "").toLowerCase();
  if (!s) return "unknown";
  // In-app webviews (Instagram, FB, Line, etc.) — screen capture is unreliable.
  if (/\b(fban|fbav|instagram|line\/|micromessenger|gsa\/)\b/.test(s)) return "in_app_webview";
  // iOS (incl. iPadOS Safari masquerading): no getDisplayMedia at all.
  if (/iphone|ipad|ipod/.test(s) || (/macintosh/.test(s) && /mobile/.test(s))) return "ios";
  if (/firefox\//.test(s)) return "firefox";
  return "ok";
}

export function uaAdvisoryLine(advisory: UaAdvisory): string {
  switch (advisory) {
    case "ios":
      return "iPhones and iPads cannot share their screen for proctoring. Switch to a laptop or desktop running Google Chrome.";
    case "in_app_webview":
      return "You appear to be inside another app's built-in browser (for example opened from a chat or social app). Open this link in the real Chrome app on a laptop or desktop instead.";
    case "firefox":
      return "Some Firefox configurations cannot record the screen reliably. If the checks below fail, switch to the latest Google Chrome.";
    default:
      return "";
  }
}
