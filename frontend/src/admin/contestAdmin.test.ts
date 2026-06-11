// S-D: pure logic for the Contests tab + global contest selector.
// Spec: docs/superpowers/specs/2026-06-10-f10-product-vision.md §2.7 (derived
// URLs), §5 rows A1-A3, §7 row S-D (per-tab URL scoping), §10.3 (access code).
import { describe, expect, it } from "vitest";
import {
  candidateUrlFor,
  contestStatusTone,
  contestWindowLabel,
  defaultContestSelection,
  invigilatorUrlFor,
  normalizeTestCodeInput,
  searchWithContestParam,
  sortContestsForList,
  testCodeIssue
} from "./contestAdmin";
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

describe("derived contest URLs (vision §2.7 — contest_url is dead)", () => {
  it("builds the candidate portal URL from origin + slug", () => {
    expect(candidateUrlFor("https://exam.aerele.in", "kec-r1")).toBe("https://exam.aerele.in/?contest=kec-r1");
  });

  it("builds the invigilator URL with slug + key, URL-encoded", () => {
    expect(invigilatorUrlFor("https://exam.aerele.in", "kec-r1", "k7Jq+x"))
      .toBe("https://exam.aerele.in/invigilator?contest=kec-r1&key=k7Jq%2Bx");
  });

  it("invigilator URL without a key (legacy contest) omits the key param", () => {
    expect(invigilatorUrlFor("https://exam.aerele.in", "legacy", null))
      .toBe("https://exam.aerele.in/invigilator?contest=legacy");
  });
});

describe("status chip + window label", () => {
  it("maps statuses to tones (open=live, draft=muted, archived=dim)", () => {
    expect(contestStatusTone("open")).toBe("open");
    expect(contestStatusTone("draft")).toBe("draft");
    expect(contestStatusTone("archived")).toBe("archived");
  });

  it("window label: both set, only one set, none set", () => {
    const label = contestWindowLabel("2026-06-12T03:00:00.000Z", "2026-06-12T06:00:00.000Z");
    expect(label).toContain("→");
    expect(contestWindowLabel(null, null)).toBe("no window set");
    expect(contestWindowLabel("2026-06-12T03:00:00.000Z", null)).toContain("no end");
  });
});

describe("defaultContestSelection (S-D: single open contest rule)", () => {
  it("keeps an explicit URL param when it names a known contest", () => {
    const contests = [contest({ slug: "a" }), contest({ slug: "b", status: "draft" })];
    expect(defaultContestSelection(contests, "b")).toBe("b");
  });

  it("falls back to the single OPEN contest when no param", () => {
    const contests = [contest({ slug: "a", status: "draft" }), contest({ slug: "b", status: "open" })];
    expect(defaultContestSelection(contests, "")).toBe("b");
  });

  it("two open contests -> explicit choice (empty selection)", () => {
    const contests = [contest({ slug: "a" }), contest({ slug: "b" })];
    expect(defaultContestSelection(contests, "")).toBe("");
  });

  it("an unknown URL param is preserved (old slug filters literally — empty lists, never an error)", () => {
    expect(defaultContestSelection([contest({ slug: "a" })], "ghost")).toBe("ghost");
  });

  it("the legacy contest counts as open for the single-open rule", () => {
    const contests = [contest({ slug: "legacy-exam", legacy: true, status: "open" })];
    expect(defaultContestSelection(contests, "")).toBe("legacy-exam");
  });
});

describe("searchWithContestParam (per-tab URL persistence)", () => {
  it("adds, replaces, and removes the contest param without touching other params", () => {
    expect(searchWithContestParam("", "kec-r1")).toBe("?contest=kec-r1");
    expect(searchWithContestParam("?contest=old&x=1", "new")).toBe("?contest=new&x=1");
    expect(searchWithContestParam("?contest=old&x=1", "")).toBe("?x=1");
    expect(searchWithContestParam("?x=1", "")).toBe("?x=1");
  });

  it("clearing the only param yields an empty string (clean URL)", () => {
    expect(searchWithContestParam("?contest=old", "")).toBe("");
  });
});

describe("sortContestsForList", () => {
  it("orders open before draft before archived, legacy last within its status, newest first within a group", () => {
    const contests = [
      contest({ slug: "arch", status: "archived", created_at: "2026-06-09T00:00:00.000Z" }),
      contest({ slug: "legacy-exam", legacy: true, status: "open", created_at: null }),
      contest({ slug: "draft-1", status: "draft", created_at: "2026-06-08T00:00:00.000Z" }),
      contest({ slug: "open-old", status: "open", created_at: "2026-06-01T00:00:00.000Z" }),
      contest({ slug: "open-new", status: "open", created_at: "2026-06-10T00:00:00.000Z" })
    ];
    expect(sortContestsForList(contests).map((c) => c.slug)).toEqual([
      "open-new", "open-old", "legacy-exam", "draft-1", "arch"
    ]);
  });
});

describe("custom test code helpers (W4)", () => {
  it("normalizeTestCodeInput uppercases, strips whitespace, caps at 6", () => {
    expect(normalizeTestCodeInput(" kec 2j6 ")).toBe("KEC2J6");
    expect(normalizeTestCodeInput("qqq222extra")).toBe("QQQ222");
    expect(normalizeTestCodeInput("")).toBe("");
  });

  it("testCodeIssue is null for empty (button stays disabled) and for a valid code", () => {
    expect(testCodeIssue("")).toBeNull();
    expect(testCodeIssue("KEC2J6")).toBeNull();
    expect(testCodeIssue("ABCDEF")).toBeNull();
  });

  it("testCodeIssue explains 0/1, bad characters, and wrong length", () => {
    expect(testCodeIssue("KEC101")).toMatch(/0 and 1/);
    expect(testCodeIssue("KEC-2J")).toMatch(/A-Z and digits 2-9/);
    expect(testCodeIssue("KEC2J")).toMatch(/exactly 6/);
  });
});
