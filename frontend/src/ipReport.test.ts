import { describe, expect, it } from "vitest";
import { groupIpEntries, summarizeIpEntries, IP_REPORT_CANDIDATES_LIMIT, type IpRow } from "./ipReport";

function row(overrides: Partial<IpRow>): IpRow {
  return {
    session_id: "s-default",
    hackerrank_username: "User_Default",
    name: "User Default",
    room: "Lab A-1",
    status: "active",
    created_at: "2026-06-09T10:00:00.000Z",
    ip: "203.0.113.10",
    ...overrides
  };
}

describe("groupIpEntries", () => {
  it("groups by ip, dedupes users case-insensitively, counts statuses", () => {
    const entries = groupIpEntries([
      row({ session_id: "a1", hackerrank_username: "Alice", ip: "10.0.0.1", status: "active" }),
      row({ session_id: "a2", hackerrank_username: "alice", ip: "10.0.0.1", status: "ended" }),
      row({ session_id: "b1", hackerrank_username: "Bob", ip: "10.0.0.1", status: "locked" }),
      row({ session_id: "c1", hackerrank_username: "Carol", ip: "10.0.0.2", status: "pending_approval", room: "Lab B-2" })
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0].ip).toBe("10.0.0.1"); // 2 users sorts before 1
    expect(entries[0].sessions).toBe(3);
    expect(entries[0].users).toBe(2);
    expect(entries[0].active).toBe(1);
    expect(entries[0].ended).toBe(1);
    expect(entries[0].locked).toBe(1);
    expect(entries[1].pending_approval).toBe(1);
    expect(entries[1].rooms).toEqual(["Lab B-2"]);
  });

  it("buckets blank ips under 'unknown' and sorts rooms", () => {
    const entries = groupIpEntries([
      row({ session_id: "l1", hackerrank_username: "L1", ip: " ", room: "Lab B-2" }),
      row({ session_id: "l2", hackerrank_username: "L2", ip: "", room: "Lab A-1" })
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].ip).toBe("unknown");
    expect(entries[0].rooms).toEqual(["Lab A-1", "Lab B-2"]);
  });

  it("sorts users desc, then sessions desc, then ip asc", () => {
    const entries = groupIpEntries([
      row({ session_id: "a1", hackerrank_username: "U1", ip: "10.0.0.9" }),
      row({ session_id: "a2", hackerrank_username: "U1", ip: "10.0.0.9" }),
      row({ session_id: "b1", hackerrank_username: "U2", ip: "10.0.0.5" }),
      row({ session_id: "b2", hackerrank_username: "U3", ip: "10.0.0.5" }),
      row({ session_id: "c1", hackerrank_username: "U4", ip: "10.0.0.7" }),
      row({ session_id: "d1", hackerrank_username: "U5", ip: "10.0.0.3" })
    ]);
    expect(entries.map((entry) => entry.ip)).toEqual(["10.0.0.5", "10.0.0.9", "10.0.0.3", "10.0.0.7"]);
  });

  it("caps candidates per ip, newest first, with the truncation flag", () => {
    const rows: IpRow[] = [];
    for (let i = 0; i < IP_REPORT_CANDIDATES_LIMIT + 3; i += 1) {
      rows.push(row({
        session_id: `s${i}`,
        hackerrank_username: `User${i}`,
        ip: "10.0.0.1",
        created_at: `2026-06-09T10:${String(i).padStart(2, "0")}:00.000Z`
      }));
    }
    const [entry] = groupIpEntries(rows);
    expect(entry.candidates).toHaveLength(IP_REPORT_CANDIDATES_LIMIT);
    expect(entry.candidates_truncated).toBe(true);
    expect(entry.candidates[0].session_id).toBe(`s${IP_REPORT_CANDIDATES_LIMIT + 2}`);
  });
});

describe("summarizeIpEntries", () => {
  it("computes totals, multi-user ips, and ip-change counts", () => {
    const rows = [
      row({ session_id: "a1", hackerrank_username: "Alice", ip: "10.0.0.1", ip_change_count: 1 }),
      row({ session_id: "b1", hackerrank_username: "Bob", ip: "10.0.0.1" }),
      row({ session_id: "c1", hackerrank_username: "Carol", ip: "10.0.0.2" })
    ];
    const summary = summarizeIpEntries(groupIpEntries(rows), rows);
    expect(summary.total_sessions).toBe(3);
    expect(summary.distinct_ips).toBe(2);
    expect(summary.multi_user_ips).toBe(1);
    expect(summary.ip_changed_sessions).toBe(1);
  });
});
