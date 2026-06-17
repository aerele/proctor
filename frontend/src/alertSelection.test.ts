import { describe, expect, it } from "vitest";
import { addAllToSelection, isAllSelected, removeFromSelection, toggleId, usernamesForSelection } from "./alertSelection";

describe("toggleId", () => {
  it("adds an id that is not selected yet", () => {
    const next = toggleId(new Set(["a"]), "b");
    expect([...next].sort()).toEqual(["a", "b"]);
  });

  it("removes an id that is already selected", () => {
    const next = toggleId(new Set(["a", "b"]), "b");
    expect([...next]).toEqual(["a"]);
  });

  it("does not mutate the input set", () => {
    const input = new Set(["a"]);
    toggleId(input, "b");
    expect([...input]).toEqual(["a"]);
  });
});

describe("addAllToSelection", () => {
  it("unions the visible ids into the selection", () => {
    const next = addAllToSelection(new Set(["a"]), ["b", "c"]);
    expect([...next].sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps already-selected off-screen ids (selection survives filter changes)", () => {
    const next = addAllToSelection(new Set(["offscreen"]), ["a"]);
    expect(next.has("offscreen")).toBe(true);
    expect(next.has("a")).toBe(true);
  });

  it("does not mutate the input set", () => {
    const input = new Set<string>();
    addAllToSelection(input, ["a"]);
    expect(input.size).toBe(0);
  });
});

describe("removeFromSelection", () => {
  it("drops the given ids and keeps the rest", () => {
    const next = removeFromSelection(new Set(["a", "b", "c"]), ["b", "missing"]);
    expect([...next].sort()).toEqual(["a", "c"]);
  });

  // F6 review: un-checking "Select all" passes the CURRENTLY FILTERED ids here —
  // only those leave the selection; off-screen ids picked under another filter
  // survive (mirror image of addAllToSelection's select-all semantics).
  it("unchecking select-all removes only the visible ids — off-screen ids survive", () => {
    const next = removeFromSelection(new Set(["vis-1", "vis-2", "offscreen"]), ["vis-1", "vis-2"]);
    expect([...next]).toEqual(["offscreen"]);
  });

  it("does not mutate the input set", () => {
    const input = new Set(["a"]);
    removeFromSelection(input, ["a"]);
    expect([...input]).toEqual(["a"]);
  });
});

describe("isAllSelected", () => {
  it("is false for an empty visible list (nothing to select-all)", () => {
    expect(isAllSelected(new Set(["a"]), [])).toBe(false);
  });

  it("is true when every visible id is selected, even with extra off-screen ids", () => {
    expect(isAllSelected(new Set(["a", "b", "offscreen"]), ["a", "b"])).toBe(true);
  });

  it("is false when any visible id is missing from the selection", () => {
    expect(isAllSelected(new Set(["a"]), ["a", "b"])).toBe(false);
  });
});

describe("usernamesForSelection", () => {
  const alerts = [
    { id: "1", hackerrank_username: "alice" },
    { id: "2", hackerrank_username: "bob" },
    { id: "3", hackerrank_username: "alice" }
  ];

  it("maps selected alert ids to unique usernames in list order", () => {
    expect(usernamesForSelection(alerts, new Set(["1", "2", "3"]))).toEqual(["alice", "bob"]);
  });

  it("ignores selected ids that are not in the current alert list", () => {
    expect(usernamesForSelection(alerts, new Set(["2", "stale"]))).toEqual(["bob"]);
  });

  it("returns an empty array when nothing is selected", () => {
    expect(usernamesForSelection(alerts, new Set())).toEqual([]);
  });
});
