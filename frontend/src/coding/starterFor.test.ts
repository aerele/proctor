// frontend/src/coding/starterFor.test.ts
// F12.2: the per-problem per-language starter resolver + the untouched-swap
// transition. ONE resolver feeds both the initial-code pick and the
// language-change swap, so this is the single source of truth's test.
import { describe, expect, it } from "vitest";
import { STARTERS, starterFor, nextCodeOnLanguageSwitch } from "./CodingWorkspace";

describe("starterFor", () => {
  it("returns the problem's per-language stub when present", () => {
    const problem = { stubs: { python: "def solve():\n    pass\n", cpp: "int main(){}\n" } };
    expect(starterFor(problem, "python")).toBe("def solve():\n    pass\n");
    expect(starterFor(problem, "cpp")).toBe("int main(){}\n");
  });

  it("falls back to the generic STARTERS scaffold when the language has no stub", () => {
    const problem = { stubs: { python: "PY STUB\n" } };
    // python is stubbed; java/javascript/cpp are not -> generic floor.
    expect(starterFor(problem, "python")).toBe("PY STUB\n");
    expect(starterFor(problem, "java")).toBe(STARTERS.java);
    expect(starterFor(problem, "javascript")).toBe(STARTERS.javascript);
    expect(starterFor(problem, "cpp")).toBe(STARTERS.cpp);
  });

  it("falls back to STARTERS for a problem with no stubs at all (back-compat)", () => {
    expect(starterFor({}, "python")).toBe(STARTERS.python);
    expect(starterFor(null, "cpp")).toBe(STARTERS.cpp);
    expect(starterFor(undefined, "java")).toBe(STARTERS.java);
  });

  it("treats a non-string stub value as absent (defensive against bad payloads)", () => {
    // Simulate a malformed payload that slipped a non-string through.
    const problem = { stubs: { python: 42 as unknown as string } };
    expect(starterFor(problem, "python")).toBe(STARTERS.python);
  });

  it("honors an explicit empty-string stub (an author CAN choose a blank stub)", () => {
    const problem = { stubs: { python: "" } };
    expect(starterFor(problem, "python")).toBe("");
  });

  // SQL (language 82): sql has a generic starter floor like every language,
  // and per-problem sql stubs (schema-comment headers) win over it.
  it("resolves sql like any other language: stub wins, STARTERS.sql is the floor", () => {
    expect(STARTERS.sql).toBe("-- Write your SQL query below.\n");
    expect(starterFor({}, "sql")).toBe(STARTERS.sql);
    const problem = { stubs: { sql: "-- T(A INTEGER, B TEXT)\n-- Write your SQL query below.\n" } };
    expect(starterFor(problem, "sql")).toBe("-- T(A INTEGER, B TEXT)\n-- Write your SQL query below.\n");
  });
});

describe("nextCodeOnLanguageSwitch (untouched-swap)", () => {
  it("swaps to the next language's STARTER when code is the prev untouched STARTER (no stubs)", () => {
    const code = STARTERS.python; // untouched generic python starter
    expect(nextCodeOnLanguageSwitch({}, code, "python", "cpp")).toBe(STARTERS.cpp);
  });

  it("swaps to the next language's STUB when code is the prev untouched STUB", () => {
    const problem = { stubs: { python: "PY STUB\n", cpp: "CPP STUB\n" } };
    expect(nextCodeOnLanguageSwitch(problem, "PY STUB\n", "python", "cpp")).toBe("CPP STUB\n");
  });

  it("preserves code (returns null) when the candidate has edited away from the starter", () => {
    const problem = { stubs: { python: "PY STUB\n", cpp: "CPP STUB\n" } };
    expect(nextCodeOnLanguageSwitch(problem, "my real solution", "python", "cpp")).toBeNull();
  });

  it("recognizes the prev STUB as untouched even when the generic STARTER differs", () => {
    // Regression guard for the drift the centralized resolver prevents: before
    // F12.2 the untouched check used STARTERS[prev], which would NOT equal the
    // stub, so an untouched stub would be wrongly preserved on switch.
    const problem = { stubs: { python: "PY STUB\n" } }; // cpp has no stub
    // Candidate sat on the untouched python STUB, switches to cpp (generic).
    expect(nextCodeOnLanguageSwitch(problem, "PY STUB\n", "python", "cpp")).toBe(STARTERS.cpp);
  });

  it("mixed: stubbed prev -> stubbed next swaps to the next stub", () => {
    const problem = { stubs: { java: "JAVA STUB\n", javascript: "JS STUB\n" } };
    expect(nextCodeOnLanguageSwitch(problem, "JAVA STUB\n", "java", "javascript")).toBe("JS STUB\n");
  });
});
