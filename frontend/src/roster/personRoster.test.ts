// frontend/src/roster/personRoster.test.ts — S-C demo parity for the
// per-contest (person-layer) roster upload. Pure logic, vitest.
// Mirrors backend/src/identity.mjs semantics: LOCKED validation order
// (college column → blank college → canonicalization gate → dup hard-reject →
// ambiguity warn → blank-id skip), 1-based row numbers, enrollment
// mint/remove/reactivate.
import { describe, expect, it } from "vitest";
import {
  buildCollegeResolutions,
  emptyPersonRosterState,
  evaluatePersonRosterUpload,
  identityNorm
} from "./personRoster";
import type { RosterUploadRequest } from "../types";

const COLUMNS = ["college", "unique_id", "name", "email"];
function payload(rows: Array<Record<string, string>>, extra: Partial<RosterUploadRequest> = {}): RosterUploadRequest {
  return {
    contest: "kec-r1",
    unique_id_column: "unique_id",
    columns: COLUMNS,
    column_mapping: { name: "name", email: "email" },
    rows,
    ...extra
  };
}
const ASHA = { college: "KEC", unique_id: "21 CS 001", name: "Asha", email: "a@x.com" };
const BALA = { college: "KEC", unique_id: "21CS002", name: "Bala", email: "b@x.com" };

describe("identityNorm (mirrors backend sanitizeSegment ∘ normalizeUniqueId)", () => {
  it("matches the backend golden table", () => {
    expect(identityNorm("21 CS 001")).toBe("21cs001");
    expect(identityNorm("a#1")).toBe("a_1");
    expect(identityNorm("a@b.c")).toBe("a_b.c");
    expect(identityNorm("..")).toBe("_");
    expect(identityNorm("X".repeat(300))).toBe("x".repeat(120));
  });
});

describe("buildCollegeResolutions", () => {
  it("maps empty decisions to create and non-empty to map", () => {
    expect(buildCollegeResolutions({ "kec": "", "k.e.c.": "kec" })).toEqual({
      "kec": { action: "create" },
      "k.e.c.": { action: "map", college_norm: "kec" }
    });
  });
});

describe("evaluatePersonRosterUpload", () => {
  it("rejects when no college column can be resolved", () => {
    const result = evaluatePersonRosterUpload(
      { ...payload([{ unique_id: "1", name: "x" }]), columns: ["unique_id", "name"] },
      emptyPersonRosterState()
    );
    expect(result).toMatchObject({ kind: "error", status: 400, code: "college_column_required" });
  });

  it("rejects blank college cells with 1-based row numbers (whole file)", () => {
    const result = evaluatePersonRosterUpload(
      payload([ASHA, { ...BALA, college: "" }]),
      emptyPersonRosterState()
    );
    expect(result).toMatchObject({ kind: "error", code: "college_required", payload: { rows: [2] } });
  });

  it("blocks unknown colleges with a confirmation preview (nothing written)", () => {
    const result = evaluatePersonRosterUpload(payload([ASHA, BALA]), emptyPersonRosterState());
    expect(result).toMatchObject({
      kind: "confirm",
      new_colleges: [{ college_norm: "kec", name: "KEC", names: ["KEC"], rows: 2 }],
      known_colleges: []
    });
  });

  it("create resolution links rows, mints enrollments, and persists the college", () => {
    const result = evaluatePersonRosterUpload(
      payload([ASHA, BALA], { college_resolutions: { kec: { action: "create" } } }),
      emptyPersonRosterState()
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.response.count).toBe(2);
    expect(result.response.colleges_created).toEqual(["kec"]);
    expect(result.response.persons).toEqual({ created: 2, updated: 0 });
    expect(result.response.enrollments).toEqual({ created: 2, reactivated: 0, removed: 0 });
    expect(result.state.colleges).toEqual({ kec: "KEC" });
    expect(result.state.enrollments["kec--21cs001"]).toBe("active");
  });

  it("hard-rejects duplicate (college, unique_id) on the FINAL norm with row numbers", () => {
    const result = evaluatePersonRosterUpload(
      payload([ASHA, { ...ASHA, unique_id: "21cs001" }], { college_resolutions: { kec: { action: "create" } } }),
      emptyPersonRosterState()
    );
    expect(result).toMatchObject({
      kind: "error",
      code: "duplicate_unique_ids",
      payload: { duplicates: [{ row: 2, college: "KEC", unique_id: "21cs001", conflicts_with_row: 1 }] }
    });
  });

  it("same id under two colleges: allowed with an ambiguity warning, two persons", () => {
    const result = evaluatePersonRosterUpload(
      payload(
        [ASHA, { college: "PSG Tech", unique_id: "21CS001", name: "Priya", email: "p@y.com" }],
        { college_resolutions: { kec: { action: "create" }, psgtech: { action: "create" } } }
      ),
      emptyPersonRosterState()
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.response.ambiguous_ids).toEqual([{ unique_id_norm: "21cs001", colleges: ["kec", "psgtech"] }]);
    expect(result.response.count).toBe(2);
  });

  it("re-upload removal + reactivation across evaluations (state threads through)", () => {
    const first = evaluatePersonRosterUpload(
      payload([ASHA, BALA], { college_resolutions: { kec: { action: "create" } } }),
      emptyPersonRosterState()
    );
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;

    const dropBala = evaluatePersonRosterUpload(payload([ASHA]), first.state);
    expect(dropBala.kind).toBe("ok");
    if (dropBala.kind !== "ok") return;
    expect(dropBala.response.enrollments).toEqual({ created: 0, reactivated: 0, removed: 1 });
    expect(dropBala.state.enrollments["kec--21cs002"]).toBe("removed");
    expect(dropBala.response.persons).toEqual({ created: 0, updated: 1 });

    const readd = evaluatePersonRosterUpload(payload([ASHA, BALA]), dropBala.state);
    expect(readd.kind).toBe("ok");
    if (readd.kind !== "ok") return;
    expect(readd.response.enrollments).toEqual({ created: 0, reactivated: 1, removed: 0 });
  });

  it("skips blank-id rows with a 1-based report", () => {
    const result = evaluatePersonRosterUpload(
      payload([ASHA, { college: "KEC", unique_id: "", name: "NoId", email: "" }], {
        college_resolutions: { kec: { action: "create" } }
      }),
      emptyPersonRosterState()
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.response.skipped).toEqual([{ row: 2, reason: "empty_unique_id" }]);
  });
});
