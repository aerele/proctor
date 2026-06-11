// frontend/src/admin/adminNav.test.ts — W3 admin nav grouping invariants.
import { describe, expect, it } from "vitest";
import { ADMIN_NAV_GROUPS, groupOfView, type AdminView } from "./adminNav";

const ALL_VIEWS: AdminView[] = [
  "stats", "contests", "templates", "alerts", "sessions", "attendance",
  "results", "people", "review", "recordings", "problems", "settings", "ips"
];

describe("admin nav groups", () => {
  it("every admin view appears in exactly one group (nothing unreachable, nothing doubled)", () => {
    const seen = ADMIN_NAV_GROUPS.flatMap((group) => group.views.map((entry) => entry.view));
    expect([...seen].sort()).toEqual([...ALL_VIEWS].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("groupOfView returns the containing group for every view", () => {
    for (const view of ALL_VIEWS) {
      const group = groupOfView(view);
      expect(group.views.map((entry) => entry.view)).toContain(view);
    }
  });

  it("the first group is Live with Live stats first (the during-exam default)", () => {
    expect(ADMIN_NAV_GROUPS[0].key).toBe("live");
    expect(ADMIN_NAV_GROUPS[0].views[0].view).toBe("stats");
  });

  it("group keys and labels are unique", () => {
    const keys = ADMIN_NAV_GROUPS.map((group) => group.key);
    const labels = ADMIN_NAV_GROUPS.map((group) => group.label);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
