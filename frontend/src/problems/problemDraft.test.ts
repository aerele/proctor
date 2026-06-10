// frontend/src/problems/problemDraft.test.ts
import { describe, expect, it } from "vitest";
import { draftFromDoc, draftToDoc, emptyProblemDraft, validateProblemDraft } from "./problemDraft";
import type { ProblemDoc } from "../types";

const DOC: ProblemDoc = {
  id: "rev-str", title: "Reverse", statement: "Reverse it.",
  languages: ["python"], cpuTimeLimit: 2, memoryLimit: 64000,
  points: 80, scoring: "per_test", status: "published",
  sampleTests: [{ input: "ab\n", expected: "ba" }],
  hiddenTests: [{ input: "xyz\n", expected: "zyx" }]
};

const validDraft = () => draftFromDoc(DOC);

describe("emptyProblemDraft", () => {
  it("starts with sane defaults and one empty test row each", () => {
    const d = emptyProblemDraft();
    expect(d.cpuTimeLimit).toBe("5");
    expect(d.memoryLimit).toBe("128000");
    expect(d.points).toBe("100");
    expect(d.status).toBe("draft");
    expect(d.sampleTests).toHaveLength(1);
    expect(d.hiddenTests).toHaveLength(1);
    expect(validateProblemDraft(d)).not.toBeNull(); // empty id/title/statement
  });
});

describe("validateProblemDraft (mirrors backend bounds)", () => {
  it("accepts a valid draft", () => expect(validateProblemDraft(validDraft())).toBeNull());
  it("rejects a bad id", () => expect(validateProblemDraft({ ...validDraft(), id: "Bad_ID" })).toMatch(/ID/));
  it("rejects a missing title", () => expect(validateProblemDraft({ ...validDraft(), title: " " })).toMatch(/Title/));
  it("rejects a missing statement", () => expect(validateProblemDraft({ ...validDraft(), statement: "" })).toMatch(/Statement/));
  it("rejects no languages", () => expect(validateProblemDraft({ ...validDraft(), languages: [] })).toMatch(/language/));
  it("rejects out-of-range cpu", () => expect(validateProblemDraft({ ...validDraft(), cpuTimeLimit: "30" })).toMatch(/CPU/));
  it("rejects non-integer memory", () => expect(validateProblemDraft({ ...validDraft(), memoryLimit: "64000.5" })).toMatch(/Memory/));
  it("rejects out-of-range points", () => expect(validateProblemDraft({ ...validDraft(), points: "5000" })).toMatch(/Points/));
  it("rejects empty hidden tests", () => expect(validateProblemDraft({ ...validDraft(), hiddenTests: [] })).toMatch(/Hidden/));
});

describe("draft <-> doc round trip", () => {
  it("doc -> draft -> doc preserves every field", () => {
    expect(draftToDoc(draftFromDoc(DOC))).toEqual(DOC);
  });
});
