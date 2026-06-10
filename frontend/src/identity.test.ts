// frontend/src/identity.test.ts — S-A identity helpers (F9 spec §5 stage S-A).
//
// candidateIdOf: the accept-both display adapter — DTOs may deliver the new
// candidate_id, the frozen legacy hackerrank_username, or both.
// sessionStartPayload: the dual-field wire body — candidate_id AND
// hackerrank_username carry the SAME value so the current backend (which only
// reads hackerrank_username) keeps working unchanged until S-E.

import { describe, expect, it } from "vitest";
import type { StudentForm } from "./types";
import { candidateIdOf, sessionStartPayload } from "./identity";

const form: StudentForm = {
  candidate_id: "21 CS 001",
  name: "Asha R",
  roll_number: "21CS001",
  email: "asha@example.com",
  room: "Lab A-1",
  consent_accepted: true,
  roster_unique_id: ""
};

describe("candidateIdOf (accept-both display adapter)", () => {
  it("prefers candidate_id when both fields are present", () => {
    expect(candidateIdOf({ candidate_id: "21 CS 001", hackerrank_username: "asha_r" })).toBe("21 CS 001");
  });

  it("falls back to the legacy hackerrank_username", () => {
    expect(candidateIdOf({ hackerrank_username: "asha_r" })).toBe("asha_r");
  });

  it("treats blank/whitespace candidate_id as absent", () => {
    expect(candidateIdOf({ candidate_id: "   ", hackerrank_username: "asha_r" })).toBe("asha_r");
  });

  it("returns '' for null/undefined rows and non-string junk", () => {
    expect(candidateIdOf(null)).toBe("");
    expect(candidateIdOf(undefined)).toBe("");
    expect(candidateIdOf({})).toBe("");
    expect(candidateIdOf({ candidate_id: 42, hackerrank_username: { nope: true } })).toBe("");
  });

  it("trims the returned value", () => {
    expect(candidateIdOf({ hackerrank_username: "  asha_r  " })).toBe("asha_r");
  });
});

describe("sessionStartPayload (dual-field send until S-E)", () => {
  it("sends candidate_id AND hackerrank_username with the same value", () => {
    const body = sessionStartPayload(form);
    expect(body.candidate_id).toBe("21 CS 001");
    expect(body.hackerrank_username).toBe("21 CS 001");
  });

  it("carries the rest of the form fields unchanged", () => {
    const body = sessionStartPayload(form);
    expect(body.name).toBe("Asha R");
    expect(body.roll_number).toBe("21CS001");
    expect(body.email).toBe("asha@example.com");
    expect(body.room).toBe("Lab A-1");
    expect(body.consent_accepted).toBe(true);
  });

  it("omits roster_unique_id and session_id when absent (backend parity)", () => {
    const body = sessionStartPayload(form);
    expect("roster_unique_id" in body).toBe(false);
    expect("session_id" in body).toBe(false);
  });

  it("includes roster_unique_id and session_id when present", () => {
    const body = sessionStartPayload({ ...form, roster_unique_id: "21CS001" }, "session-123");
    expect(body.roster_unique_id).toBe("21CS001");
    expect(body.session_id).toBe("session-123");
  });
});
