// frontend/src/recordingReviewLookup.test.ts — FIX-B1: the recording-review
// player must resolve a session by its STORED key (username_norm), not by the
// display candidate_id.
//
// THE BUG: the picker passed candidateIdOf(row) (e.g. "TEC001") to loadUser →
// fetchAdminSessions(username="TEC001") → GET ?username=TEC001. The backend
// re-normalizes that to "tec001", which can NEVER equal a person-mode session's
// stored key person_id = "{college_norm}~{uid_norm}" (e.g.
// "testengineeringcollege~tec001") → empty result → dead player for roster
// (person-mode) contests.
//
// THE FIX: picker rows + the Sessions deep link carry the row's exact stored
// `username_norm`, and fetchAdminSessions sends it as `?username_norm=` (no
// re-normalization). The legacy `?username=` path is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fetchAdminSessions reads import.meta.env at module load, so configure a base
// URL (and a non-demo build) BEFORE importing it.
vi.stubEnv("VITE_API_BASE_URL", "https://api.test");
vi.stubEnv("VITE_DEMO_MODE", "false");
vi.stubEnv("VITE_ADMIN_PASSWORD", "");

const { fetchAdminSessions } = await import("./api");

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify(body); },
    async json() { return body; }
  } as unknown as Response;
}

describe("fetchAdminSessions lookup key (FIX-B1)", () => {
  let calls: string[];
  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      return okJson({ sessions: [] });
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the EXACT username_norm (person_id) — NOT a re-normalized candidate_id — when given", async () => {
    // This is the picker→loadUser path for a person-mode row: the display label
    // is "TEC001" but the lookup key is the stored person_id.
    await fetchAdminSessions("TEC001", "pw", undefined, "testengineeringcollege~tec001");
    const url = new URL(calls[0]);
    expect(url.pathname).toBe("/api/admin/sessions");
    // The query MUST carry the exact stored key, un-normalized…
    expect(url.searchParams.get("username_norm")).toBe("testengineeringcollege~tec001");
    // …and MUST NOT fall back to the candidate-id `username` param (the bug).
    expect(url.searchParams.has("username")).toBe(false);
  });

  it("keeps the legacy ?username path when no username_norm is supplied (back-compat)", async () => {
    // Manual candidate-id entry / review-mode: no stored key known → the server
    // re-normalizes the typed candidate id, exactly as before.
    await fetchAdminSessions("LEG001", "pw");
    const url = new URL(calls[0]);
    expect(url.searchParams.get("username")).toBe("LEG001");
    expect(url.searchParams.has("username_norm")).toBe(false);
  });

  it("threads the contest scope alongside the exact key", async () => {
    await fetchAdminSessions("TEC001", "pw", "tec-2026", "testengineeringcollege~tec001");
    const url = new URL(calls[0]);
    expect(url.searchParams.get("username_norm")).toBe("testengineeringcollege~tec001");
    expect(url.searchParams.get("contest_slug")).toBe("tec-2026");
  });
});
