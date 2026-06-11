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
  shouldConfirmLiveSave,
  liveSaveConfirmMessage
} from "./saveGuard";
import type { ContestSummary } from "../types";

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
