// frontend/src/invigilator/gateLogic.test.ts
import { describe, expect, it } from "vitest";
import { gateStatusLabel, isCompleteOtp, normalizeOtpInput, roomKeyForLabel } from "./gateLogic";
import type { RoomGate } from "../types";

const baseGate: RoomGate = {
  room: "Lab A-1", room_key: "Lab A-1", mode: "otp", otp: "123456",
  released_at: "2026-06-09T10:00:00.000Z", released_by: "Priya",
  opened_at: null, opened_by: "", updated_at: "2026-06-09T10:00:00.000Z"
};

describe("normalizeOtpInput", () => {
  it("strips non-digits and caps at 6", () => {
    expect(normalizeOtpInput(" 12a3-4 5678")).toBe("123456");
    expect(normalizeOtpInput("12")).toBe("12");
    expect(normalizeOtpInput("abc")).toBe("");
  });
});

describe("isCompleteOtp", () => {
  it("accepts exactly six digits", () => {
    expect(isCompleteOtp("123456")).toBe(true);
    expect(isCompleteOtp("12345")).toBe(false);
    expect(isCompleteOtp("1234567")).toBe(false);
    expect(isCompleteOtp("12345a")).toBe(false);
  });
});

describe("roomKeyForLabel", () => {
  it("mirrors the backend sanitizer (keep letters/digits/space/._-, max 80) and falls back to '_'", () => {
    expect(roomKeyForLabel("Lab A-1")).toBe("Lab A-1");
    expect(roomKeyForLabel("Lab @#A!")).toBe("Lab A");
    expect(roomKeyForLabel("   ")).toBe("_");
    expect(roomKeyForLabel("")).toBe("_");
    expect(roomKeyForLabel("x".repeat(100))).toBe("x".repeat(80));
  });
});

describe("gateStatusLabel", () => {
  it("classifies missing / armed / open gates", () => {
    expect(gateStatusLabel(null).tone).toBe("idle");
    expect(gateStatusLabel(baseGate).tone).toBe("armed");
    expect(gateStatusLabel({ ...baseGate, mode: "open" }).tone).toBe("open");
  });
});
