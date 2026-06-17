// frontend/src/admin/dateTimeText.test.ts — M0 typed-datetime parsing.
import { describe, expect, it } from "vitest";
import { formatDateTimeText, normalizeDateTimeText, parseDateTimeText } from "./dateTimeText";

describe("parseDateTimeText", () => {
  it("parses the canonical display form (YYYY-MM-DD HH:mm) and the T form", () => {
    expect(parseDateTimeText("2026-06-12 09:30")).toBe("2026-06-12T09:30");
    expect(parseDateTimeText("2026-06-12T09:30")).toBe("2026-06-12T09:30");
    expect(parseDateTimeText("2026-6-2 7:05")).toBe("2026-06-02T07:05");
    expect(parseDateTimeText("  2026-06-12   09:30  ")).toBe("2026-06-12T09:30");
  });

  it("accepts a pasted ISO-ish string with seconds (seconds dropped)", () => {
    expect(parseDateTimeText("2026-06-12T09:30:45")).toBe("2026-06-12T09:30");
    expect(parseDateTimeText("2026-06-12 09:30:00")).toBe("2026-06-12T09:30");
  });

  it("parses day-first dates (4-digit year LAST) with /, - or . separators", () => {
    expect(parseDateTimeText("12/06/2026 09:30")).toBe("2026-06-12T09:30");
    expect(parseDateTimeText("12-06-2026 9:30")).toBe("2026-06-12T09:30");
    expect(parseDateTimeText("12.06.2026, 21:30")).toBe("2026-06-12T21:30");
  });

  it("handles am/pm in either form", () => {
    expect(parseDateTimeText("12/06/2026 9:30 am")).toBe("2026-06-12T09:30");
    expect(parseDateTimeText("12/06/2026 9:30 pm")).toBe("2026-06-12T21:30");
    expect(parseDateTimeText("12/06/2026 12:00 am")).toBe("2026-06-12T00:00");
    expect(parseDateTimeText("12/06/2026 12:00 pm")).toBe("2026-06-12T12:00");
    expect(parseDateTimeText("2026-06-12 9:30PM")).toBe("2026-06-12T21:30");
    // am/pm hours must be 1-12
    expect(parseDateTimeText("12/06/2026 13:00 pm")).toBeNull();
    expect(parseDateTimeText("12/06/2026 0:30 am")).toBeNull();
  });

  it("rejects incomplete or out-of-range input (partial typing stays pending)", () => {
    expect(parseDateTimeText("")).toBeNull();
    expect(parseDateTimeText("2026-06-12")).toBeNull(); // a time is required
    expect(parseDateTimeText("2026-06-12 25:00")).toBeNull();
    expect(parseDateTimeText("2026-06-12 09:60")).toBeNull();
    expect(parseDateTimeText("2026-13-01 09:30")).toBeNull();
    expect(parseDateTimeText("31/02/2026 09:30")).toBeNull(); // Feb 31 does not exist
    expect(parseDateTimeText("tomorrow 9am")).toBeNull();
    expect(parseDateTimeText("06/12/26 09:30")).toBeNull(); // 2-digit year is ambiguous
  });

  it("round-trips with formatDateTimeText", () => {
    const canonical = "2026-06-12T09:30";
    expect(parseDateTimeText(formatDateTimeText(canonical))).toBe(canonical);
    expect(formatDateTimeText("")).toBe("");
    // A stored value with seconds still displays minute precision.
    expect(formatDateTimeText("2026-06-12T09:30:00")).toBe("2026-06-12 09:30");
  });
});

describe("normalizeDateTimeText (F10 E2E live — canonical echo on blur/save)", () => {
  it("snaps any parseable text to the canonical display form", () => {
    expect(normalizeDateTimeText("12/06/2026 9:30 pm")).toBe("2026-06-12 21:30");
    expect(normalizeDateTimeText("12-06-2026 9:30")).toBe("2026-06-12 09:30");
    expect(normalizeDateTimeText("2026-6-2 7:05")).toBe("2026-06-02 07:05");
    expect(normalizeDateTimeText("  2026-06-12   09:30  ")).toBe("2026-06-12 09:30");
  });

  it("is idempotent on already-canonical text", () => {
    expect(normalizeDateTimeText("2026-06-12 21:30")).toBe("2026-06-12 21:30");
  });

  it("leaves blank / incomplete / invalid drafts untouched for correction", () => {
    expect(normalizeDateTimeText("")).toBe("");
    expect(normalizeDateTimeText("2026-06-12")).toBe("2026-06-12");
    expect(normalizeDateTimeText("tomorrow 9am")).toBe("tomorrow 9am");
    expect(normalizeDateTimeText("31/02/2026 09:30")).toBe("31/02/2026 09:30");
  });
});
