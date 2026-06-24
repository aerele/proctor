import { describe, expect, it } from "vitest";
import {
  alertEpochMs,
  alertSeekOffsetSec,
  buildAlertRecordingLink,
  type SeekableAlert
} from "./alertSeek";

// A session whose test-start anchor (created_at) is 12:00:00Z.
const TEST_START_MS = Date.parse("2026-06-23T12:00:00Z");

describe("alertEpochMs", () => {
  it("parses a valid ISO timestamp to epoch ms", () => {
    expect(alertEpochMs("2026-06-23T12:05:00Z")).toBe(Date.parse("2026-06-23T12:05:00Z"));
  });

  it("returns null for missing / empty / unparseable input", () => {
    expect(alertEpochMs(undefined)).toBeNull();
    expect(alertEpochMs(null)).toBeNull();
    expect(alertEpochMs("")).toBeNull();
    expect(alertEpochMs("not-a-date")).toBeNull();
  });
});

describe("alertSeekOffsetSec (LT-12 — alert wall-clock → test-relative seek)", () => {
  it("maps an alert 5 minutes after test start to +300s", () => {
    expect(alertSeekOffsetSec("2026-06-23T12:05:00Z", TEST_START_MS)).toBe(300);
  });

  it("is 0 at exactly the test-start moment", () => {
    expect(alertSeekOffsetSec("2026-06-23T12:00:00Z", TEST_START_MS)).toBe(0);
  });

  it("allows a NEGATIVE offset for an alert before test start (caller/player clamps)", () => {
    expect(alertSeekOffsetSec("2026-06-23T11:59:30Z", TEST_START_MS)).toBe(-30);
  });

  it("returns null when the alert timestamp is missing/unparseable", () => {
    expect(alertSeekOffsetSec(undefined, TEST_START_MS)).toBeNull();
    expect(alertSeekOffsetSec("garbage", TEST_START_MS)).toBeNull();
  });

  it("returns null when the test-start anchor is missing/non-finite", () => {
    expect(alertSeekOffsetSec("2026-06-23T12:05:00Z", null)).toBeNull();
    expect(alertSeekOffsetSec("2026-06-23T12:05:00Z", undefined)).toBeNull();
    expect(alertSeekOffsetSec("2026-06-23T12:05:00Z", NaN)).toBeNull();
  });
});

describe("buildAlertRecordingLink (LT-12 — deep-link from an alert row)", () => {
  const alert: SeekableAlert = {
    timestamp: "2026-06-23T12:05:00Z",
    session_id: "sess-own",
    username_norm: "asha_r"
  };

  it("targets the JOINED live session over the alert's own session_id", () => {
    const link = buildAlertRecordingLink(
      alert,
      { sessionId: "sess-live", usernameNorm: "asha_r" },
      "Asha_R"
    );
    expect(link).toEqual({
      username: "Asha_R",
      usernameNorm: "asha_r",
      sessionId: "sess-live",
      seekToMs: Date.parse("2026-06-23T12:05:00Z")
    });
  });

  it("falls back to the alert's own session_id when there is no join target", () => {
    const link = buildAlertRecordingLink(alert, null, "Asha_R");
    expect(link?.sessionId).toBe("sess-own");
    expect(link?.seekToMs).toBe(Date.parse("2026-06-23T12:05:00Z"));
  });

  it("carries the alert's username_norm when the join target has none", () => {
    const link = buildAlertRecordingLink(alert, { sessionId: "sess-x" }, "Asha_R");
    expect(link?.usernameNorm).toBe("asha_r");
    expect(link?.sessionId).toBe("sess-x");
  });

  it("returns null for a session-less alert (nothing to open)", () => {
    const sessionless: SeekableAlert = { timestamp: "2026-06-23T12:05:00Z", username_norm: "x" };
    expect(buildAlertRecordingLink(sessionless, null, "X")).toBeNull();
  });

  it("omits seekToMs (no seek) when the alert timestamp is unparseable", () => {
    const bad: SeekableAlert = { timestamp: "garbage", session_id: "s" };
    const link = buildAlertRecordingLink(bad, null, "X");
    expect(link?.sessionId).toBe("s");
    expect(link?.seekToMs).toBeUndefined();
  });
});
