// F6 item 2 / TG msg 1581 — alert GROUPING for the alerts console: group the
// visible alerts by candidate or by type into collapsible sections (header:
// label + count + worst severity + group-select). Pure grouping only; the
// console renders the same AlertRow inside each section and the selection
// model (alertSelection.ts) keeps working on the per-group id lists.
import { describe, expect, it } from "vitest";
import { groupAlerts, worstSeverity, type GroupableAlert } from "./alertGrouping";

function alert(overrides: Partial<GroupableAlert>): GroupableAlert {
  return {
    id: "a-default",
    type: "tab_away",
    severity: "warning",
    hackerrank_username: "User_Default",
    ...overrides
  };
}

describe("worstSeverity", () => {
  it("ranks critical > warning > info", () => {
    expect(worstSeverity(["info", "critical", "warning"])).toBe("critical");
    expect(worstSeverity(["info", "warning"])).toBe("warning");
    expect(worstSeverity(["info"])).toBe("info");
  });
});

describe("groupAlerts", () => {
  it("groups by candidate on the normalized username, collapsing raw spellings", () => {
    const groups = groupAlerts(
      [
        alert({ id: "a1", hackerrank_username: "Arav_M" }),
        alert({ id: "b1", hackerrank_username: "Divya_P", username_norm: "divya_p" }),
        // Same candidate as a1, different raw casing — must join a1's group.
        alert({ id: "a2", hackerrank_username: "arav_m" }),
        alert({ id: "b2", hackerrank_username: "DIVYA_P" })
      ],
      "candidate"
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe("arav_m");
    // The label is the first-seen RAW username (what the admin recognizes).
    expect(groups[0].label).toBe("Arav_M");
    expect(groups[0].ids).toEqual(["a1", "a2"]);
    expect(groups[1].ids).toEqual(["b1", "b2"]);
  });

  it("groups by type and keeps first-appearance order (newest-first input)", () => {
    const groups = groupAlerts(
      [
        alert({ id: "t1", type: "ip_changed" }),
        alert({ id: "t2", type: "tab_away" }),
        alert({ id: "t3", type: "ip_changed" })
      ],
      "type"
    );
    expect(groups.map((group) => group.key)).toEqual(["ip_changed", "tab_away"]);
    expect(groups[0].label).toBe("ip_changed");
    expect(groups[0].ids).toEqual(["t1", "t3"]);
  });

  it("computes each group's worst severity for the header chip", () => {
    const groups = groupAlerts(
      [
        alert({ id: "w1", type: "tab_away", severity: "info" }),
        alert({ id: "w2", type: "tab_away", severity: "critical" }),
        alert({ id: "x1", type: "ip_changed", severity: "warning" })
      ],
      "type"
    );
    expect(groups[0].worstSeverity).toBe("critical");
    expect(groups[1].worstSeverity).toBe("warning");
  });

  it("returns [] for no alerts", () => {
    expect(groupAlerts([], "candidate")).toEqual([]);
  });
});
