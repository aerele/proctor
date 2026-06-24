// frontend/src/admin/bulkSelect.test.ts
// LT-9: unit tests for the shared bulk-export "select all" header logic used by
// ProblemBank + TemplatesPanel. Pure functions (no DOM) so they run in this
// jsdom-less harness: tri-state derivation + toggle-all/clear-all semantics.
import { describe, expect, it } from "vitest";
import { headerCheckboxFlags, headerSelectState, toggleAllVisible } from "./bulkSelect";

describe("headerSelectState", () => {
  it("is 'none' when nothing is selected", () => {
    expect(headerSelectState(["a", "b", "c"], new Set())).toBe("none");
  });

  it("is 'all' when every visible key is selected", () => {
    expect(headerSelectState(["a", "b", "c"], new Set(["a", "b", "c"]))).toBe("all");
  });

  it("is 'indeterminate' when only some visible keys are selected", () => {
    expect(headerSelectState(["a", "b", "c"], new Set(["a"]))).toBe("indeterminate");
    expect(headerSelectState(["a", "b", "c"], new Set(["a", "b"]))).toBe("indeterminate");
  });

  it("is 'none' for an empty visible list (even if other keys are selected)", () => {
    expect(headerSelectState([], new Set(["x"]))).toBe("none");
  });

  it("counts only VISIBLE keys — selected-but-hidden keys don't make it 'all'", () => {
    // "a","b" visible and both selected → "all", regardless of extra hidden "z".
    expect(headerSelectState(["a", "b"], new Set(["a", "b", "z"]))).toBe("all");
  });
});

describe("headerCheckboxFlags", () => {
  it("checked only when all visible are selected", () => {
    expect(headerCheckboxFlags(["a", "b"], new Set(["a", "b"]))).toEqual({ checked: true, indeterminate: false });
  });

  it("indeterminate (not checked) on a partial selection", () => {
    expect(headerCheckboxFlags(["a", "b"], new Set(["a"]))).toEqual({ checked: false, indeterminate: true });
  });

  it("neither checked nor indeterminate when none selected", () => {
    expect(headerCheckboxFlags(["a", "b"], new Set())).toEqual({ checked: false, indeterminate: false });
  });
});

describe("toggleAllVisible", () => {
  it("select-all: adds every visible key when none are selected", () => {
    const next = toggleAllVisible(["a", "b", "c"], new Set());
    expect([...next].sort()).toEqual(["a", "b", "c"]);
  });

  it("select-all: completes the set from a partial selection", () => {
    const next = toggleAllVisible(["a", "b", "c"], new Set(["a"]));
    expect([...next].sort()).toEqual(["a", "b", "c"]);
  });

  it("deselect-all: clears every visible key when all are selected", () => {
    const next = toggleAllVisible(["a", "b", "c"], new Set(["a", "b", "c"]));
    expect([...next]).toEqual([]);
  });

  it("preserves selections for keys outside the visible set", () => {
    // "z" isn't visible; select-all over a/b must keep "z" intact.
    const next = toggleAllVisible(["a", "b"], new Set(["z"]));
    expect([...next].sort()).toEqual(["a", "b", "z"]);
    // and deselect-all over a/b (when all visible selected) keeps "z".
    const cleared = toggleAllVisible(["a", "b"], new Set(["a", "b", "z"]));
    expect([...cleared]).toEqual(["z"]);
  });

  it("does not mutate the input set", () => {
    const input = new Set(["a"]);
    toggleAllVisible(["a", "b"], input);
    expect([...input]).toEqual(["a"]);
  });
});
