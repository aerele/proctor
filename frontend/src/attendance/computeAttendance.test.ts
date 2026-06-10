import { describe, expect, it } from "vitest";
import { buildAbsenteesCsv, computeAttendance } from "./computeAttendance";

const roster = [
  { unique_id: "21CS001", name: "Asha", roll_number: "R1", room: "Lab A" },
  { unique_id: "21CS002", name: "Vikram", roll_number: "R2", room: "Lab B" },
  { unique_id: "21CS010", name: "Meera", roll_number: "R3", room: "Lab A" }
];

describe("computeAttendance", () => {
  it("marks everyone absent when there are no sessions", () => {
    const core = computeAttendance(roster, []);
    expect(core.roster_total).toBe(3);
    expect(core.taken).toEqual({ total: 0, in_progress: 0, completed: 0 });
    expect(core.not_taken).toBe(3);
    expect(core.absentees.map((a) => a.unique_id)).toEqual(["21CS001", "21CS002", "21CS010"]);
    expect(core.unmatched_sessions).toBe(0);
  });

  it("splits taken into in-progress (any non-ended) and completed (all ended)", () => {
    const core = computeAttendance(roster, [
      { roster_unique_id: "21CS001", status: "ended" },
      { roster_unique_id: "21CS002", status: "active" }
    ]);
    expect(core.taken).toEqual({ total: 2, in_progress: 1, completed: 1 });
    expect(core.not_taken).toBe(1);
    expect(core.absentees.map((a) => a.unique_id)).toEqual(["21CS010"]);
  });

  it("matches unique ids case- and whitespace-insensitively", () => {
    const core = computeAttendance(roster, [{ roster_unique_id: "21 cs 001", status: "active" }]);
    expect(core.taken.total).toBe(1);
    expect(core.unmatched_sessions).toBe(0);
  });

  it("counts a student once across multiple sessions; any live session wins", () => {
    const core = computeAttendance(roster, [
      { roster_unique_id: "21CS001", status: "ended" },
      { roster_unique_id: "21CS001", status: "active" }
    ]);
    expect(core.taken).toEqual({ total: 1, in_progress: 1, completed: 0 });
  });

  it("counts pending_approval and locked as taken / in progress", () => {
    const core = computeAttendance(roster, [
      { roster_unique_id: "21CS001", status: "pending_approval" },
      { roster_unique_id: "21CS002", status: "locked" }
    ]);
    expect(core.taken).toEqual({ total: 2, in_progress: 2, completed: 0 });
  });

  it("routes blank and off-roster ids into unmatched_sessions", () => {
    const core = computeAttendance(roster, [
      { roster_unique_id: "", status: "active" },
      { roster_unique_id: "99XX999", status: "active" }
    ]);
    expect(core.taken.total).toBe(0);
    expect(core.not_taken).toBe(3);
    expect(core.unmatched_sessions).toBe(2);
  });

  it("sorts absentees by unique_id regardless of roster order", () => {
    const shuffled = [roster[2], roster[0], roster[1]];
    const core = computeAttendance(shuffled, []);
    expect(core.absentees.map((a) => a.unique_id)).toEqual(["21CS001", "21CS002", "21CS010"]);
  });
});

describe("buildAbsenteesCsv", () => {
  it("emits a header plus one escaped row per absentee", () => {
    const csv = buildAbsenteesCsv([
      { unique_id: "21CS001", name: 'Asha "AJ", Jr', roll_number: "R1", room: "Lab A" }
    ]);
    expect(csv).toBe('unique_id,name,roll_number,room\n21CS001,"Asha ""AJ"", Jr",R1,Lab A');
  });

  it("returns only the header for an empty list", () => {
    expect(buildAbsenteesCsv([])).toBe("unique_id,name,roll_number,room");
  });

  it("neutralizes formula-injection triggers in candidate-supplied fields", () => {
    const csv = buildAbsenteesCsv([
      { unique_id: "=cmd()", name: "+SUM(1)", roll_number: "-2+3", room: "@import" }
    ]);
    expect(csv.split("\n")[1]).toBe("'=cmd(),'+SUM(1),'-2+3,'@import");
  });
});
