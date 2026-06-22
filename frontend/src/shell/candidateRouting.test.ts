// frontend/src/shell/candidateRouting.test.ts — S-D candidate routing (vision
// C1 + §10.3): pure decisions for the ?contest= pin, the access-code landing
// page, and the legacy fallback. The charter: a PRESENT-but-bad contest param
// lands on the access-code page, an ABSENT param keeps today's legacy flow
// while the legacy settings doc exists (bit-for-bit), and a transient fetch
// failure on a pinned link must NEVER dump candidates onto the landing page.
import { describe, expect, it } from "vitest";
import {
  accessCodeReady,
  candidateFormMode,
  candidateFormReady,
  contestParamOf,
  contestUrlFor,
  isCandidateEmailValid,
  landingErrorMessage,
  rosterLookupErrorMessage,
  normalizeAccessCodeInput,
  routeForPinnedOutcome,
  sessionStorageKeyFor
} from "./candidateRouting";

describe("contestParamOf", () => {
  it("reads ?contest= from a search string, trimmed", () => {
    expect(contestParamOf("?contest=kec-r1")).toBe("kec-r1");
    expect(contestParamOf("?foo=1&contest=%20kec-r1%20")).toBe("kec-r1");
  });

  it("absent / blank -> empty string", () => {
    expect(contestParamOf("")).toBe("");
    expect(contestParamOf("?foo=1")).toBe("");
    expect(contestParamOf("?contest=")).toBe("");
    expect(contestParamOf("?contest=%20%20")).toBe("");
  });
});

describe("routeForPinnedOutcome (?contest= present)", () => {
  it("config loaded -> pinned contest route", () => {
    expect(routeForPinnedOutcome("kec-r1", { ok: true })).toEqual({ kind: "contest", slug: "kec-r1" });
  });

  it("unknown_contest / contest_not_open -> landing page with a notice", () => {
    const unknown = routeForPinnedOutcome("ghost", { ok: false, status: 400, code: "unknown_contest" });
    expect(unknown.kind).toBe("landing");
    const closed = routeForPinnedOutcome("kec-r1", { ok: false, status: 403, code: "contest_not_open" });
    expect(closed.kind).toBe("landing");
    // The notice tells the candidate WHY they are looking at a code box.
    expect(closed.kind === "landing" && closed.notice.length > 0).toBe(true);
  });

  it("transient failure (network / 500) -> retryable error, NEVER the landing page", () => {
    const network = routeForPinnedOutcome("kec-r1", { ok: false });
    expect(network).toEqual({ kind: "config_error", slug: "kec-r1" });
    const server = routeForPinnedOutcome("kec-r1", { ok: false, status: 500 });
    expect(server.kind).toBe("config_error");
  });
});

describe("access-code input", () => {
  it("normalize uppercases and strips whitespace", () => {
    expect(normalizeAccessCodeInput(" dem o42 ")).toBe("DEMO42");
    expect(normalizeAccessCodeInput("kx7q2m")).toBe("KX7Q2M");
  });

  it("normalize caps the value at 6 chars (typing past the box length)", () => {
    expect(normalizeAccessCodeInput("ABCDEFG")).toBe("ABCDEF");
  });

  it("ready only for exactly 6 chars from the mint alphabet (A-Z, 2-9)", () => {
    expect(accessCodeReady("DEMO42")).toBe(true);
    expect(accessCodeReady("KX7Q2M")).toBe(true);
    expect(accessCodeReady("DEMO4")).toBe(false);
    expect(accessCodeReady("DEM-42")).toBe(false);
    // 0 and 1 are not in the mint alphabet (I/O/0/1 ambiguity).
    expect(accessCodeReady("DEMO01")).toBe(false);
    expect(accessCodeReady("")).toBe(false);
  });
});

describe("landingErrorMessage", () => {
  it("code_not_found -> not-recognized copy", () => {
    expect(landingErrorMessage(404, "code_not_found")).toMatch(/not recognized/i);
  });

  it("rate limited -> wait copy", () => {
    expect(landingErrorMessage(429, "rate_limited")).toMatch(/wait/i);
  });

  it("invalid_code and anything else -> generic check-the-code copy", () => {
    expect(landingErrorMessage(400, "invalid_code")).toMatch(/6.character/i);
    expect(landingErrorMessage(undefined, undefined)).toMatch(/could not/i);
  });
});

describe("rosterLookupErrorMessage", () => {
  it("429 / rate_limited -> wait copy with the server's retry_after_seconds", () => {
    const msg = rosterLookupErrorMessage(429, "rate_limited", 17);
    expect(msg).toMatch(/wait 17 seconds/i);
    expect(msg).toMatch(/invigilator/i);
    // It must NOT surface the raw machine code.
    expect(msg).not.toMatch(/rate_limited/);
  });

  it("429 with a singular second is grammatical", () => {
    expect(rosterLookupErrorMessage(429, "rate_limited", 1)).toMatch(/wait 1 second\b/i);
  });

  it("429 with no/zero retry hint falls back to a minute", () => {
    expect(rosterLookupErrorMessage(429, "rate_limited")).toMatch(/wait a minute/i);
    expect(rosterLookupErrorMessage(undefined, "rate_limited", 0)).toMatch(/wait a minute/i);
  });

  it("404 / not_on_roster -> check-the-id copy", () => {
    expect(rosterLookupErrorMessage(404, "not_on_roster")).toMatch(/could not find that ID/i);
    expect(rosterLookupErrorMessage(404, "roster_not_configured")).toMatch(/could not find that ID/i);
  });

  it("anything else -> generic try-again copy", () => {
    expect(rosterLookupErrorMessage(500, undefined)).toMatch(/could not check/i);
  });

  // #135 take-home (§5a): with the take-home opts, the invigilator tail is
  // replaced by the proctor-phone tail; without them the copy is byte-identical.
  it("take-home opts route the 429/404 tail to the proctor phone (not invigilator)", () => {
    const opts = { takeHome: true, phone: "+91 98765 43210" };
    const rl = rosterLookupErrorMessage(429, "rate_limited", 17, opts);
    expect(rl).toMatch(/call your proctor at \+91 98765 43210/i);
    expect(rl).not.toMatch(/invigilator/i);
    const nf = rosterLookupErrorMessage(404, "not_on_roster", undefined, opts);
    expect(nf).toMatch(/call your proctor at \+91 98765 43210/i);
    expect(nf).not.toMatch(/invigilator/i);
  });

  it("take-home with no phone falls back to 'the number provided'", () => {
    expect(rosterLookupErrorMessage(404, "not_on_roster", undefined, { takeHome: true }))
      .toMatch(/call your proctor at the number provided/i);
  });

  it("absent opts is byte-identical to the in-venue copy (D3)", () => {
    expect(rosterLookupErrorMessage(429, "rate_limited", 17))
      .toBe(rosterLookupErrorMessage(429, "rate_limited", 17, undefined));
    expect(rosterLookupErrorMessage(404, "not_on_roster"))
      .toBe(rosterLookupErrorMessage(404, "not_on_roster", undefined, { takeHome: false }));
  });
});

describe("contestUrlFor", () => {
  it("builds the pinned candidate URL for a resolved slug", () => {
    expect(contestUrlFor("kec-r1")).toBe("/?contest=kec-r1");
    expect(contestUrlFor("a b")).toBe("/?contest=a%20b");
  });
});

describe("candidateFormMode", () => {
  it("pinned person contest: roster -> server-resolved id entry; no roster -> open details form", () => {
    expect(candidateFormMode(true)).toBe("person_roster");
    expect(candidateFormMode(false)).toBe("person_open");
  });
});

describe("candidateFormReady", () => {
  const full = {
    candidate_id: "21CS001",
    name: "Asha",
    roll_number: "42",
    email: "a@x.com",
    room: "Lab 1",
    consent_accepted: true,
    roster_unique_id: "21 CS 001"
  };

  it("person_roster: typed id + room + consent — the roster supplies the rest server-side", () => {
    const minimal = { ...full, candidate_id: "", name: "", roll_number: "", email: "" };
    expect(candidateFormReady("person_roster", minimal)).toBe(true);
    expect(candidateFormReady("person_roster", { ...minimal, roster_unique_id: " " })).toBe(false);
    expect(candidateFormReady("person_roster", { ...minimal, room: "" })).toBe(false);
    expect(candidateFormReady("person_roster", { ...minimal, consent_accepted: false })).toBe(false);
  });

  it("person_open: id + name + email + room + consent (roll optional, F9 §1.4)", () => {
    const noRoll = { ...full, roll_number: "", roster_unique_id: "" };
    expect(candidateFormReady("person_open", noRoll)).toBe(true);
    expect(candidateFormReady("person_open", { ...noRoll, email: "" })).toBe(false);
    expect(candidateFormReady("person_open", { ...noRoll, email: "asha@example" })).toBe(false);
    expect(candidateFormReady("person_open", { ...noRoll, name: "" })).toBe(false);
    expect(candidateFormReady("person_open", { ...noRoll, candidate_id: "" })).toBe(false);
  });

  it("person_roster: email is roster-supplied, so its format never gates the button", () => {
    // person_roster never types an email — a blank/garbage email must NOT block.
    const minimal = { ...full, candidate_id: "", name: "", roll_number: "", email: "" };
    expect(candidateFormReady("person_roster", minimal)).toBe(true);
    expect(candidateFormReady("person_roster", { ...minimal, email: "not-an-email" })).toBe(true);
  });
});

describe("isCandidateEmailValid", () => {
  it("accepts a permissive non-space@non-space.non-space shape", () => {
    expect(isCandidateEmailValid("a@b.co")).toBe(true);
    expect(isCandidateEmailValid("asha.k+tag@mail.example.com")).toBe(true);
    expect(isCandidateEmailValid("  trim@me.io  ")).toBe(true);
  });

  it("rejects obvious typos (no @, no domain dot, spaces)", () => {
    expect(isCandidateEmailValid("")).toBe(false);
    expect(isCandidateEmailValid("plainstring")).toBe(false);
    expect(isCandidateEmailValid("missing-at.example.com")).toBe(false);
    expect(isCandidateEmailValid("nodot@example")).toBe(false);
    expect(isCandidateEmailValid("has space@example.com")).toBe(false);
    expect(isCandidateEmailValid("@example.com")).toBe(false);
  });
});

describe("sessionStorageKeyFor", () => {
  it("legacy (no pin) keeps the historical key so deployed sessions resume", () => {
    expect(sessionStorageKeyFor("")).toBe("aerele-proctor-session-id");
  });

  it("pinned contests get their OWN key — two tabs can run two contests", () => {
    expect(sessionStorageKeyFor("kec-r1")).toBe("aerele-proctor-session-id::kec-r1");
    expect(sessionStorageKeyFor("kec-r2")).not.toBe(sessionStorageKeyFor("kec-r1"));
  });
});
