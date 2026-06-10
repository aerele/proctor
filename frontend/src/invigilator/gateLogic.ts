// frontend/src/invigilator/gateLogic.ts — pure helpers for the S3 room gate.
// No React, no fetch — unit-tested with vitest.
import type { RoomGate } from "../types";

// Mirror of the backend's sanitizeRoom + gateRoomKey: the portal must send the
// SAME key the backend derives from a candidate's room label, and the
// "(no room set)" picker entry maps to the reserved "_" key.
export function roomKeyForLabel(label: string): string {
  const cleaned = String(label).trim().replace(/[^a-zA-Z0-9 ._-]/g, "").slice(0, 80);
  return cleaned || "_";
}

// Candidate OTP input: digits only, capped at 6 (the input is forgiving about
// spaces/dashes people type when copying from a board).
export function normalizeOtpInput(raw: string): string {
  return String(raw).replace(/\D/g, "").slice(0, 6);
}

export function isCompleteOtp(value: string): boolean {
  return /^\d{6}$/.test(value);
}

export type GateBadge = { label: string; tone: "idle" | "armed" | "open" };

export function gateStatusLabel(gate: RoomGate | null): GateBadge {
  if (!gate) return { label: "No code released yet", tone: "idle" };
  if (gate.mode === "open") return { label: "Room OPEN — everyone admitted", tone: "open" };
  return { label: "Code active", tone: "armed" };
}
