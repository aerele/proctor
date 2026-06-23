// frontend/src/admin/bankImportDisplay.test.ts — BANK-1 (F11) UI.
// The import preview/commit dialog renders each item's disposition from the pure
// mapping in bankImportDisplay.ts. This pins: (a) the badge for each resolver
// action (incl. the fork-slug-refined label), (b) the legal per-row override
// sets per situation, and (c) the Apply-gating on an unresolved dangling block.
import { describe, expect, it } from "vitest";
import {
  badgeForAction,
  legalProblemOverrides,
  legalTemplateOverrides,
  overrideLabel,
  planHasHardBlock,
  reasonText,
  summaryText
} from "./bankImportDisplay";
import type { BankImportProblemItem, BankImportTemplateItem } from "../types";

const problem = (over: Partial<BankImportProblemItem>): BankImportProblemItem => ({
  portable_id: "p-1", id: "two-sum", action: "create", target_slug: "two-sum", reason: "new", ...over
});
const template = (over: Partial<BankImportTemplateItem>): BankImportTemplateItem => ({
  portable_id: "t-1", slug: "weekly", name: "Weekly", action: "create", target_slug: "weekly", reason: "new", ...over
});

describe("badgeForAction — disposition → badge", () => {
  it("maps each action to a distinct tone", () => {
    expect(badgeForAction("create").tone).toBe("new");
    expect(badgeForAction("adopt").tone).toBe("new");
    expect(badgeForAction("skip").tone).toBe("skip");
    expect(badgeForAction("update").tone).toBe("update");
    expect(badgeForAction("fork").tone).toBe("fork");
    expect(badgeForAction("blocked").tone).toBe("blocked");
  });

  it("labels Unchanged for a skip (the dedup case) and Create for new", () => {
    expect(badgeForAction("skip").label).toBe("Unchanged");
    expect(badgeForAction("create").label).toBe("Create");
  });

  it("refines the fork label with the resolved target slug", () => {
    expect(badgeForAction("fork").label).toBe("Fork → -2");
    expect(badgeForAction("fork", "two-sum-2").label).toBe("Fork → two-sum-2");
  });

  it("falls back to the blocked badge for an unknown action", () => {
    // @ts-expect-error — exercising the runtime fallback for a future action.
    expect(badgeForAction("weird").tone).toBe("blocked");
  });
});

describe("legalProblemOverrides — per-situation override set", () => {
  it("a NEW problem can only be created or skipped", () => {
    expect(legalProblemOverrides(problem({ action: "create", reason: "new" }))).toEqual(["create", "skip"]);
  });

  it("an IDENTICAL (skip) row can be forced to update or fork", () => {
    expect(legalProblemOverrides(problem({ action: "skip", reason: "identical" }))).toEqual(["skip", "update", "fork"]);
  });

  it("an UPDATE row can be downgraded to skip or escalated to fork", () => {
    expect(legalProblemOverrides(problem({ action: "update", reason: "local_unchanged_since_export" }))).toEqual(["update", "skip", "fork"]);
  });

  it("a DIVERGENT fork offers update/skip — NOT adopt (that's legacy-only)", () => {
    const set = legalProblemOverrides(problem({ action: "fork", reason: "divergent" }));
    expect(set).toEqual(["fork", "update", "skip"]);
    expect(set).not.toContain("adopt");
  });

  it("a LEGACY un-keyed collision fork offers adopt (take it over)", () => {
    const set = legalProblemOverrides(problem({ action: "fork", reason: "legacy_collision" }));
    expect(set).toContain("adopt");
  });

  it("a BLOCKED row is not overridable", () => {
    expect(legalProblemOverrides(problem({ action: "blocked", reason: "fork_slug_exhausted", target_slug: null }))).toEqual([]);
  });
});

describe("legalTemplateOverrides — no adopt path for templates", () => {
  it("offers create/skip for a new template and nothing for a dangling block", () => {
    expect(legalTemplateOverrides(template({ action: "create" }))).toEqual(["create", "skip"]);
    expect(legalTemplateOverrides(template({ action: "blocked", reason: "dangling_problem_refs", target_slug: null }))).toEqual([]);
  });

  it("never offers adopt (templates mint slugs, they don't adopt)", () => {
    for (const action of ["create", "skip", "update", "fork"] as const) {
      expect(legalTemplateOverrides(template({ action }))).not.toContain("adopt");
    }
  });
});

describe("planHasHardBlock — Apply gating", () => {
  it("blocks Apply when a dangling template has no override", () => {
    const t = template({ action: "blocked", reason: "dangling_problem_refs", target_slug: null,
      dangling: [{ problem_portable_id: "x", hint: "missing-problem" }] });
    expect(planHasHardBlock([t], {})).toBe(true);
  });

  it("clears the block once an override is set for that template", () => {
    const t = template({ portable_id: "t-9", action: "blocked", reason: "dangling_problem_refs", target_slug: null });
    expect(planHasHardBlock([t], { "t-9": "skip" })).toBe(false);
  });

  it("does not block when every template resolves", () => {
    expect(planHasHardBlock([template({ action: "create" }), template({ action: "update" })], {})).toBe(false);
  });
});

describe("reasonText / summaryText / overrideLabel — readable prose", () => {
  it("turns reason codes into prose and falls back to the raw code", () => {
    expect(reasonText("identical")).toMatch(/deduped/i);
    expect(reasonText("divergent")).toMatch(/nothing overwritten/i);
    expect(reasonText("some_future_code")).toBe("some_future_code");
  });

  it("formats the footer summary line", () => {
    expect(summaryText({ created: 2, unchanged: 1, updated: 3, forked: 1, blocked: 0 }))
      .toBe("2 created · 1 unchanged · 3 updated · 1 forked · 0 blocked");
  });

  it("labels every override option", () => {
    expect(overrideLabel("fork")).toMatch(/fork/i);
    expect(overrideLabel("adopt")).toMatch(/adopt/i);
    expect(overrideLabel("update")).toMatch(/update/i);
  });
});
