// frontend/src/invigilator/roomView.test.ts — F9.2 clickable status filters +
// F9.4 plain-language alert explanations (pure logic for the invigilator portal).
import { describe, expect, it } from "vitest";
import { alertExplanation, matchesStatusFilter, type StatusFilter } from "./roomView";

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
