// D1 (Karthi decision, Wave6): warn-on-save confirm gate. The exact trigger was
// not recoverable from disk; the implemented interpretation is the clearest
// impactful one — saving an edit to a published problem that is referenced by an
// OPEN (running/active) contest, so the admin knows the edit changes what
// candidates currently sitting that contest see. Pure decision logic only; the
// UI binds window.confirm to it. See flags_for_karthi.
import { describe, expect, it } from "vitest";
import {
  contestsReferencingProblem,
  liveContestsReferencingProblem,
  liveEditConfirmMessage,
  liveEditGuardFromError,
  liveEditRetryBody,
  shouldConfirmLiveSave,
  liveSaveConfirmMessage
} from "./saveGuard";
import type { ContestSummary, ProblemDoc } from "../types";

function contest(overrides: Partial<ContestSummary>): ContestSummary {
  return {
    slug: "c",
    name: "C",
    status: "open",
    legacy: false,
    listed: true,
    identity_label: "Candidate ID",
    access_code: "ABC234",
    invigilator_key: "k".repeat(24),
    start_at: null,
    end_at: null,
    problems: [],
    rooms: [],
    room_gate_enabled: false,
    template_slug: null,
    created_at: "2026-06-10T00:00:00.000Z",
    updated_at: "2026-06-10T00:00:00.000Z",
    ...overrides
  };
}

function problemRef(problem_id: string, order = 0) {
  return { problem_id, points: null, order };
}

describe("contestsReferencingProblem", () => {
  it("matches a problem on a contest's S-I problems[] array", () => {
    const contests = [
      contest({ slug: "kec-r1", problems: [problemRef("two-sum"), problemRef("bfs")] }),
      contest({ slug: "kec-r2", problems: [problemRef("dijkstra")] })
    ];
    expect(contestsReferencingProblem("two-sum", contests).map((c) => c.slug)).toEqual(["kec-r1"]);
  });

  it("matches a problem on the LEGACY single-problem assignment (problem_id)", () => {
    const contests = [
      contest({ slug: "legacy", legacy: true, problems: undefined, problem_id: "two-sum" })
    ];
    expect(contestsReferencingProblem("two-sum", contests).map((c) => c.slug)).toEqual(["legacy"]);
  });

  it("returns [] when no contest references the problem", () => {
    const contests = [contest({ slug: "kec-r1", problems: [problemRef("bfs")] })];
    expect(contestsReferencingProblem("two-sum", contests)).toEqual([]);
  });

  it("returns [] for a blank problem id (a brand-new draft has no id yet)", () => {
    const contests = [contest({ slug: "kec-r1", problems: [problemRef("")] })];
    expect(contestsReferencingProblem("", contests)).toEqual([]);
  });
});

describe("liveContestsReferencingProblem (only OPEN contests are 'live')", () => {
  it("keeps OPEN contests, drops draft + archived ones", () => {
    const contests = [
      contest({ slug: "open-1", status: "open", problems: [problemRef("two-sum")] }),
      contest({ slug: "draft-1", status: "draft", problems: [problemRef("two-sum")] }),
      contest({ slug: "arch-1", status: "archived", problems: [problemRef("two-sum")] })
    ];
    expect(liveContestsReferencingProblem("two-sum", contests).map((c) => c.slug)).toEqual(["open-1"]);
  });
});

describe("shouldConfirmLiveSave", () => {
  it("is TRUE when at least one OPEN contest references the problem", () => {
    const contests = [contest({ slug: "open-1", status: "open", problems: [problemRef("two-sum")] })];
    expect(shouldConfirmLiveSave("two-sum", contests)).toBe(true);
  });

  it("is FALSE when only draft/archived contests reference the problem", () => {
    const contests = [
      contest({ slug: "draft-1", status: "draft", problems: [problemRef("two-sum")] }),
      contest({ slug: "arch-1", status: "archived", problems: [problemRef("two-sum")] })
    ];
    expect(shouldConfirmLiveSave("two-sum", contests)).toBe(false);
  });

  it("is FALSE when no contest references the problem (safe save, no prompt)", () => {
    const contests = [contest({ slug: "open-1", status: "open", problems: [problemRef("bfs")] })];
    expect(shouldConfirmLiveSave("two-sum", contests)).toBe(false);
  });
});

describe("liveSaveConfirmMessage", () => {
  it("names the count and the affected contest slugs (singular)", () => {
    const contests = [contest({ slug: "kec-r1", name: "KEC Round 1", status: "open", problems: [problemRef("two-sum")] })];
    const msg = liveSaveConfirmMessage("two-sum", liveContestsReferencingProblem("two-sum", contests));
    expect(msg).toContain("1 running/active contest");
    expect(msg).toContain("kec-r1");
    expect(msg).toContain("Continue?");
  });

  it("pluralizes when more than one contest is affected", () => {
    const contests = [
      contest({ slug: "kec-r1", status: "open", problems: [problemRef("two-sum")] }),
      contest({ slug: "kec-r2", status: "open", problems: [problemRef("two-sum")] })
    ];
    const msg = liveSaveConfirmMessage("two-sum", liveContestsReferencingProblem("two-sum", contests));
    expect(msg).toContain("2 running/active contests");
  });
});

// ---- W7: backend hidden-test live-edit guard (409) ---------------------------

// An ApiError as `request()` builds it from the backend 409: message/code from
// the body's `error`, plus the FULL flat body (handler api() catch merges the
// httpErrorWith extra — here the open-contest slugs — next to error/detail).
function liveEdit409(overrides: { status?: number; code?: string; body?: Record<string, unknown> } = {}): Error {
  const e = new Error("live_edit_confirmation_required") as Error & {
    status?: number;
    code?: string;
    body?: Record<string, unknown>;
  };
  e.status = overrides.status ?? 409;
  e.code = overrides.code ?? "live_edit_confirmation_required";
  e.body = overrides.body ?? {
    error: "live_edit_confirmation_required",
    detail: "live_edit_confirmation_required",
    contests: ["kec-r1"]
  };
  return e;
}

function doc(overrides: Partial<ProblemDoc> = {}): ProblemDoc {
  return {
    id: "two-sum",
    title: "Two Sum",
    statement: "Add two numbers.",
    languages: ["python"],
    cpuTimeLimit: 5,
    memoryLimit: 128000,
    points: 100,
    scoring: "per_test",
    status: "published",
    sampleTests: [{ input: "1 2", expected: "3" }],
    hiddenTests: [{ input: "3 4", expected: "7" }],
    ...overrides
  };
}

describe("liveEditGuardFromError", () => {
  it("classifies the backend 409 and extracts the open-contest slugs", () => {
    expect(liveEditGuardFromError(liveEdit409())).toEqual({ contests: ["kec-r1"] });
  });

  it("extracts EVERY named contest", () => {
    const e = liveEdit409({ body: { error: "live_edit_confirmation_required", contests: ["kec-r1", "kec-r2"] } });
    expect(liveEditGuardFromError(e)).toEqual({ contests: ["kec-r1", "kec-r2"] });
  });

  it("returns null for a different 409 code (problem_referenced stays a normal error)", () => {
    expect(liveEditGuardFromError(liveEdit409({ code: "problem_referenced" }))).toBeNull();
  });

  it("returns null for a non-409 status even with the matching code", () => {
    expect(liveEditGuardFromError(liveEdit409({ status: 400 }))).toBeNull();
  });

  it("returns null for plain errors and non-object causes", () => {
    expect(liveEditGuardFromError(new Error("Failed to fetch"))).toBeNull();
    expect(liveEditGuardFromError("boom")).toBeNull();
    expect(liveEditGuardFromError(null)).toBeNull();
    expect(liveEditGuardFromError(undefined)).toBeNull();
  });

  it("still fires on a malformed body (guard wins; the dialog just can't name contests)", () => {
    const e = liveEdit409({ body: { error: "live_edit_confirmation_required" } });
    expect(liveEditGuardFromError(e)).toEqual({ contests: [] });
  });
});

describe("liveEditConfirmMessage", () => {
  it("names the problem, the count, and the contest slug (singular)", () => {
    const msg = liveEditConfirmMessage("two-sum", { contests: ["kec-r1"] });
    expect(msg).toContain("Hidden tests are changing");
    expect(msg).toContain('"two-sum"');
    expect(msg).toContain("1 OPEN contest (kec-r1)");
    expect(msg).toContain("next submission");
    expect(msg).toContain("Continue?");
  });

  it("pluralizes and names every contest", () => {
    const msg = liveEditConfirmMessage("two-sum", { contests: ["kec-r1", "kec-r2"] });
    expect(msg).toContain("2 OPEN contests (kec-r1, kec-r2)");
    expect(msg).toContain("sitting them");
  });

  it("falls back gracefully when the body named no contests", () => {
    const msg = liveEditConfirmMessage("two-sum", { contests: [] });
    expect(msg).toContain("an OPEN contest");
    expect(msg).toContain("Continue?");
  });
});

describe("liveEditRetryBody", () => {
  it("is the SAME save payload plus confirm_live_edit === the problem id", () => {
    const payload = doc();
    expect(liveEditRetryBody(payload)).toEqual({ ...payload, confirm_live_edit: "two-sum" });
  });

  it("does not mutate the original payload (cancel must lose nothing)", () => {
    const payload = doc();
    const snapshot = JSON.parse(JSON.stringify(payload)) as ProblemDoc;
    void liveEditRetryBody(payload);
    expect(payload).toEqual(snapshot);
    expect("confirm_live_edit" in payload).toBe(false);
  });
});
