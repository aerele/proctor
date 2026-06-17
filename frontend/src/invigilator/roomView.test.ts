// frontend/src/invigilator/roomView.test.ts — F9.2 clickable status filters +
// F9.4 plain-language alert explanations (pure logic for the invigilator portal).
import { describe, expect, it } from "vitest";
import {
  alertExplanation, duplicateRowKeys, emptyAlertsHint, examStageLabel,
  matchesStatusFilter, portalEntryBlurb, sessionStartedLabel, type StatusFilter
} from "./roomView";

type Row = Parameters<typeof matchesStatusFilter>[0];

const row = (overrides: Partial<Row> = {}): Row => ({
  status: "active",
  stale: false,
  exam_started_at: null,
  ...overrides
});

describe("matchesStatusFilter (F9.2)", () => {
  it("no filter matches every row", () => {
    const filters: StatusFilter[] = [null];
    for (const filter of filters) {
      expect(matchesStatusFilter(row(), filter)).toBe(true);
      expect(matchesStatusFilter(row({ status: "ended" }), filter)).toBe(true);
      expect(matchesStatusFilter(row({ status: "locked" }), filter)).toBe(true);
    }
  });

  it("recording matches ALL active rows (incl. stale — the tile count is stats.live)", () => {
    expect(matchesStatusFilter(row(), "recording")).toBe(true);
    expect(matchesStatusFilter(row({ stale: true }), "recording")).toBe(true);
    expect(matchesStatusFilter(row({ status: "ended" }), "recording")).toBe(false);
    expect(matchesStatusFilter(row({ status: "locked" }), "recording")).toBe(false);
  });

  it("disconnected matches only stale active rows", () => {
    expect(matchesStatusFilter(row({ stale: true }), "disconnected")).toBe(true);
    expect(matchesStatusFilter(row(), "disconnected")).toBe(false);
    expect(matchesStatusFilter(row({ status: "ended", stale: true }), "disconnected")).toBe(false);
  });

  it("locked / pending_approval / finished map to their statuses", () => {
    expect(matchesStatusFilter(row({ status: "locked" }), "locked")).toBe(true);
    expect(matchesStatusFilter(row(), "locked")).toBe(false);
    expect(matchesStatusFilter(row({ status: "pending_approval" }), "pending_approval")).toBe(true);
    expect(matchesStatusFilter(row(), "pending_approval")).toBe(false);
    expect(matchesStatusFilter(row({ status: "ended" }), "finished")).toBe(true);
    expect(matchesStatusFilter(row(), "finished")).toBe(false);
  });

  it("started matches rows whose exam has started, regardless of status", () => {
    expect(matchesStatusFilter(row({ exam_started_at: "2026-06-10T09:00:00Z" }), "started")).toBe(true);
    expect(matchesStatusFilter(row({ status: "ended", exam_started_at: "2026-06-10T09:00:00Z" }), "started")).toBe(true);
    expect(matchesStatusFilter(row(), "started")).toBe(false);
  });
});

describe("examStageLabel (F8 E2E live)", () => {
  it("a stamped exam start always reads Started, whatever the gate or status", () => {
    expect(examStageLabel(row({ exam_started_at: "2026-06-12T09:00:00Z" }), true)).toBe("Started");
    expect(examStageLabel(row({ exam_started_at: "2026-06-12T09:00:00Z" }), false)).toBe("Started");
    expect(examStageLabel(row({ status: "ended", exam_started_at: "2026-06-12T09:00:00Z" }), false)).toBe("Started");
  });
  it("a finished session is never Waiting", () => {
    expect(examStageLabel(row({ status: "ended" }), true)).toBe("Finished");
    expect(examStageLabel(row({ status: "ended" }), false)).toBe("Finished");
  });
  it("Waiting only while a start gate is actually holding candidates", () => {
    expect(examStageLabel(row(), true)).toBe("Waiting");
    expect(examStageLabel(row({ status: "locked" }), true)).toBe("Waiting");
  });
  it("with the gate disabled there is nothing to wait for — dash", () => {
    expect(examStageLabel(row(), false)).toBe("—");
    expect(examStageLabel(row({ status: "locked" }), false)).toBe("—");
    expect(examStageLabel(row({ status: "pending_approval" }), false)).toBe("—");
  });
});

describe("alertExplanation (F9.4)", () => {
  it("explains every catalog type in plain language (no jargon-only echo of the type)", () => {
    const types = [
      "recording_stopped", "screen_share_stopped", "recording_error",
      "fullscreen_enforcement", "ip_changed", "tab_hidden", "tab_away", "disconnected"
    ];
    for (const type of types) {
      const text = alertExplanation(type);
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toContain("_");
    }
  });

  it("falls back to a generic explanation for unknown types", () => {
    const text = alertExplanation("some_future_type");
    expect(text.length).toBeGreaterThan(20);
    expect(text).not.toContain("some_future_type");
  });
});

describe("portalEntryBlurb (FIX-B3 #4)", () => {
  it("mentions the start code / starting the room when the gate is ON", () => {
    const text = portalEntryBlurb(true);
    expect(text).toContain("start code");
    expect(text).toContain("start the room");
  });
  it("drops the start-code / start-the-room promise when the gate is OFF", () => {
    const text = portalEntryBlurb(false);
    expect(text).not.toContain("start code");
    expect(text).not.toContain("start the room");
    // still describes the monitoring view
    expect(text).toContain("recording");
    expect(text).toContain("alerts");
  });
});

describe("sessionStartedLabel (FIX-B3 #5)", () => {
  it("formats an ISO timestamp as HH:MM:SS local time", () => {
    // Build via a Date so the assertion is timezone-agnostic.
    const d = new Date(2026, 5, 10, 9, 5, 3);
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(sessionStartedLabel(d.toISOString())).toBe(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
  });
  it("returns empty string for missing / blank / unparseable input", () => {
    expect(sessionStartedLabel(null)).toBe("");
    expect(sessionStartedLabel(undefined)).toBe("");
    expect(sessionStartedLabel("")).toBe("");
    expect(sessionStartedLabel("   ")).toBe("");
    expect(sessionStartedLabel("not-a-date")).toBe("");
  });
});

describe("duplicateRowKeys (FIX-B3 #5)", () => {
  const keyOf = (r: { candidate_id?: string; name?: string }) => r.candidate_id || r.name || "";
  it("flags only candidate keys that appear more than once", () => {
    const rows = [
      { candidate_id: "A1", name: "Asha" },
      { candidate_id: "A1", name: "Asha" }, // stale + rejoin → duplicate
      { candidate_id: "B2", name: "Bala" }
    ];
    const dupes = duplicateRowKeys(rows, keyOf);
    expect(dupes.has("A1")).toBe(true);
    expect(dupes.has("B2")).toBe(false);
  });
  it("falls back to name when there is no candidate id", () => {
    const rows = [{ name: "Cara" }, { name: "Cara" }, { name: "Deepa" }];
    const dupes = duplicateRowKeys(rows, keyOf);
    expect(dupes.has("Cara")).toBe(true);
    expect(dupes.has("Deepa")).toBe(false);
  });
  it("ignores rows with no usable key", () => {
    const rows = [{}, {}];
    expect(duplicateRowKeys(rows, keyOf).size).toBe(0);
  });
});

describe("emptyAlertsHint (FIX-B3 #6)", () => {
  it("says nothing-fired when alert types ARE shared", () => {
    expect(emptyAlertsHint(true)).toBe("No open alerts for this room.");
  });
  it("explains intentional emptiness when NO alert types are shared", () => {
    const text = emptyAlertsHint(false);
    expect(text).toContain("No alert types are shared");
    expect(text).not.toBe("No open alerts for this room.");
  });
});
