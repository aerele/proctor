import { describe, expect, it } from "vitest";
import {
  alertsForSession,
  approxRecordingSeconds,
  captureSourceLabel,
  describeRecordingContents,
  formatApproxDuration,
  viewEventsAffordance,
  viewRecordingAffordance
} from "./sessionDetail";

describe("approxRecordingSeconds", () => {
  it("is chunk_count × 30s (the fixed recorder chunk length)", () => {
    expect(approxRecordingSeconds(0)).toBe(0);
    expect(approxRecordingSeconds(1)).toBe(30);
    expect(approxRecordingSeconds(12)).toBe(360);
    expect(approxRecordingSeconds(220)).toBe(6600);
  });

  it("clamps negative / non-finite counts to 0", () => {
    expect(approxRecordingSeconds(-3)).toBe(0);
    expect(approxRecordingSeconds(Number.NaN)).toBe(0);
  });
});

describe("formatApproxDuration", () => {
  it("renders an em dash for zero (no recording)", () => {
    expect(formatApproxDuration(0)).toBe("—");
  });

  it("renders seconds below a minute", () => {
    expect(formatApproxDuration(30)).toBe("~30 sec");
  });

  it("renders whole minutes below an hour", () => {
    expect(formatApproxDuration(360)).toBe("~6 min");
    // Partial minutes round to the nearest minute (chunks are coarse anyway).
    expect(formatApproxDuration(90)).toBe("~2 min");
  });

  it("renders hours + minutes at or past an hour", () => {
    expect(formatApproxDuration(3600)).toBe("~1 h 0 min");
    expect(formatApproxDuration(6600)).toBe("~1 h 50 min");
  });
});

describe("alertsForSession", () => {
  const session = {
    session_id: "s-1",
    hackerrank_username: "Asha_R",
    status: "active",
    created_at: "2026-06-10T09:00:00.000Z"
  };

  it("counts alerts that reference the session's id directly", () => {
    const alerts = [
      { id: "a1", session_id: "s-1", hackerrank_username: "Asha_R" },
      { id: "a2", session_id: "s-other", hackerrank_username: "Asha_R" }
    ];
    expect(alertsForSession(alerts, session).map((a) => a.id)).toEqual(["a1"]);
  });

  it("includes session-less alerts for the same candidate (contest-eval signals)", () => {
    const alerts = [
      { id: "a1", hackerrank_username: "Asha_R" },
      { id: "a2", hackerrank_username: "Someone_Else" }
    ];
    expect(alertsForSession(alerts, session).map((a) => a.id)).toEqual(["a1"]);
  });

  it("matches the candidate by normalized username (username_norm vs raw)", () => {
    const alerts = [{ id: "a1", hackerrank_username: "ASHA_R", username_norm: "asha_r" }];
    expect(alertsForSession(alerts, session)).toHaveLength(1);
  });

  it("excludes another session's alerts even for the same candidate", () => {
    const alerts = [{ id: "a1", session_id: "s-2", hackerrank_username: "Asha_R" }];
    expect(alertsForSession(alerts, session)).toHaveLength(0);
  });
});

// F6.6 — per-source capture-state labels for the session detail card. The
// recorded webm is the DIRECT screen stream + mixed mic audio; the camera is
// live-monitor only and is NEVER part of the recorded video, so the labels
// must say that in plain language instead of implying a camera file exists.
describe("captureSourceLabel", () => {
  it("labels the screen states plainly", () => {
    expect(captureSourceLabel("screen", "recording")).toBe("recording");
    expect(captureSourceLabel("screen", "stopped")).toBe("stopped mid-exam");
    expect(captureSourceLabel("screen", "error")).toBe("capture error");
    expect(captureSourceLabel("screen", "inactive")).toBe("not started");
  });

  it("a recording camera is live-monitor only — never claims a camera recording exists", () => {
    expect(captureSourceLabel("camera", "recording")).toBe("on (live monitor only — not in the recorded video)");
  });

  // F10.1: when this session ACTUALLY uploaded camera chunks, the camera row
  // says so — the live-monitor wording only applies when nothing was recorded.
  it("a recording camera WITH camera chunks reads as a real recording", () => {
    expect(captureSourceLabel("camera", "recording", true)).toBe("recording (separate low-res camera video)");
    // The flag changes nothing for the other sources/states.
    expect(captureSourceLabel("camera", "permission_denied", true)).toBe("permission denied");
    expect(captureSourceLabel("screen", "recording", true)).toBe("recording");
  });

  it("labels denied/missing camera and microphone plainly", () => {
    expect(captureSourceLabel("camera", "permission_denied")).toBe("permission denied");
    expect(captureSourceLabel("camera", "unavailable")).toBe("no camera detected");
    expect(captureSourceLabel("microphone", "permission_denied")).toBe("permission denied");
    expect(captureSourceLabel("microphone", "unavailable")).toBe("no microphone detected");
  });

  it("a recording microphone says its audio lands inside the screen video", () => {
    expect(captureSourceLabel("microphone", "recording")).toBe("recording (audio mixed into the screen video)");
  });

  it("an unexpected state falls back to 'unknown'", () => {
    expect(captureSourceLabel("camera", "unknown")).toBe("unknown");
    expect(captureSourceLabel("microphone", "weird")).toBe("unknown");
  });
});

// F6.6 — the recordings-review header line: what does the loaded recording
// actually contain, derived from the same per-source capture state.
describe("describeRecordingContents", () => {
  it("screen + mic audio when the microphone was recording", () => {
    expect(describeRecordingContents({ screen: "recording", camera: "recording", microphone: "recording" }))
      .toBe("screen video + microphone audio; camera live-monitored only (not recorded)");
  });

  it("screen only when the microphone permission was denied", () => {
    expect(describeRecordingContents({ screen: "recording", camera: "permission_denied", microphone: "permission_denied" }))
      .toBe("screen video only — microphone permission denied; camera permission denied");
  });

  it("screen only when no microphone was detected", () => {
    expect(describeRecordingContents({ screen: "recording", camera: "unavailable", microphone: "unavailable" }))
      .toBe("screen video only — no microphone detected; no camera detected");
  });

  it("notes a microphone that stopped mid-exam", () => {
    expect(describeRecordingContents({ screen: "recording", camera: "recording", microphone: "stopped" }))
      .toBe("screen video — microphone stopped mid-exam; camera live-monitored only (not recorded)");
  });

  it("degrades to a no-detail line when the state was never reported (legacy sessions)", () => {
    expect(describeRecordingContents(null)).toBe("screen video — capture detail not reported for this session");
    expect(describeRecordingContents(undefined)).toBe("screen video — capture detail not reported for this session");
  });

  // F10.1: a session that uploaded camera chunks describes the separate
  // low-res camera video instead of the live-monitor-only fragment.
  it("describes the separate camera video when camera chunks exist", () => {
    expect(describeRecordingContents({ screen: "recording", camera: "recording", microphone: "recording" }, 12))
      .toBe("screen video + microphone audio; camera recorded separately (low-res)");
    expect(describeRecordingContents({ screen: "recording", camera: "stopped", microphone: "recording" }, 4))
      .toBe("screen video + microphone audio; camera recorded separately (low-res; stopped mid-exam)");
  });

  it("zero camera chunks keeps the live-monitor wording (count is authoritative)", () => {
    expect(describeRecordingContents({ screen: "recording", camera: "recording", microphone: "recording" }, 0))
      .toBe("screen video + microphone audio; camera live-monitored only (not recorded)");
  });
});

// F6 review — the session card's deep-link affordances. "View recording" needs
// playable chunks AND loadable recording data (demo mode only seeds a few
// candidates); "View events" needs only loadable data — the Recordings tab's
// activity log works without a single recorded chunk.
describe("viewRecordingAffordance", () => {
  it("is enabled with a playback tooltip when chunks exist and data is loadable", () => {
    const a = viewRecordingAffordance(12, true);
    expect(a.disabled).toBe(false);
    expect(a.tip).toContain("Recordings tab");
  });

  it("is disabled with a nothing-to-play tooltip for zero-chunk sessions", () => {
    const a = viewRecordingAffordance(0, true);
    expect(a.disabled).toBe(true);
    expect(a.tip).toContain("No recorded chunks");
  });

  it("is disabled with a demo-data tooltip when the candidate has no loadable recording data", () => {
    const a = viewRecordingAffordance(12, false);
    expect(a.disabled).toBe(true);
    expect(a.tip).toContain("Demo mode");
  });
});

describe("viewEventsAffordance", () => {
  it("is enabled even for zero-chunk sessions when data is loadable (events need no chunks)", () => {
    const a = viewEventsAffordance(true);
    expect(a.disabled).toBe(false);
    expect(a.tip).toContain("activity log");
  });

  it("is disabled with the demo-data tooltip when the candidate is not loadable", () => {
    const a = viewEventsAffordance(false);
    expect(a.disabled).toBe(true);
    expect(a.tip).toContain("Demo mode");
  });
});
