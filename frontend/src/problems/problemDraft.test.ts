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

  // F12.2: a doc WITHOUT stubs round-trips with NO stubs key (byte-compat).
  it("a stub-less doc gains no stubs field on round-trip", () => {
    const out = draftToDoc(draftFromDoc(DOC));
    expect("stubs" in out).toBe(false);
  });

  // F12.2: per-language stubs survive the round-trip; blank languages drop.
  it("preserves authored stubs and drops blank-language stubs", () => {
    const doc: ProblemDoc = { ...DOC, stubs: { python: "def solve():\n    pass\n", cpp: "int main(){}\n" } };
    const draft = draftFromDoc(doc);
    // The draft lifts to a FULL keyed map (java/javascript become blank).
    expect(draft.stubs).toEqual({ python: "def solve():\n    pass\n", cpp: "int main(){}\n", java: "", javascript: "" });
    // Serializing drops the blanks -> the original sparse map.
    expect(draftToDoc(draft)).toEqual(doc);
  });

  it("an all-blank stub draft serializes to NO stubs field", () => {
    const draft = { ...emptyProblemDraft(), id: "x", title: "T", statement: "S",
      sampleTests: DOC.sampleTests, hiddenTests: DOC.hiddenTests };
    expect("stubs" in draftToDoc(draft)).toBe(false);
  });

  // W6: statement_format normalization — absent/plain stores no field; only
  // "markdown" rides the doc (mirrors the backend's absent == plain rule).
  it("a doc without statement_format edits as plain and round-trips with NO field", () => {
    const draft = draftFromDoc(DOC);
    expect(draft.statementFormat).toBe("plain");
    expect("statement_format" in draftToDoc(draft)).toBe(false);
  });

  it("a markdown doc round-trips with statement_format intact", () => {
    const doc: ProblemDoc = { ...DOC, statement: "# Reverse\n\nReverse **it**.", statement_format: "markdown" };
    const draft = draftFromDoc(doc);
    expect(draft.statementFormat).toBe("markdown");
    expect(draftToDoc(draft)).toEqual(doc);
  });

  it("switching a markdown draft back to plain drops the field on serialize", () => {
    const doc: ProblemDoc = { ...DOC, statement_format: "markdown" };
    const out = draftToDoc({ ...draftFromDoc(doc), statementFormat: "plain" });
    expect("statement_format" in out).toBe(false);
  });

  it("a new (empty) draft defaults to plain", () => {
    expect(emptyProblemDraft().statementFormat).toBe("plain");
  });
});
