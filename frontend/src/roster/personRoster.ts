// frontend/src/roster/personRoster.ts — S-C demo parity for the per-contest
// (person-layer) roster upload. Pure logic, no IO: api.ts wraps this with the
// localStorage demo stores so VITE_DEMO_MODE exercises the SAME validation
// order, payload shapes, and enrollment semantics as backend/src/identity.mjs:
//   1. college column missing / blank cells → 400, whole file rejected
//   2. college canonicalization gate (map-or-create resolutions)
//   3. duplicate (college_norm, unique_id_norm) on FINAL norm → 400 with rows
//   4. same id under different colleges → allowed with warning
//   5. blank-id rows → skip-with-report
// Row numbers are 1-BASED data rows, matching the backend payloads.
import type {
  CollegeResolution,
  KnownCollege,
  NewCollegePreview,
  RosterDuplicate,
  RosterUploadRequest,
  RosterUploadResponse
} from "../types";

export type PersonRosterState = {
  /** college_norm → display name (mirrors proctor_colleges) */
  colleges: Record<string, string>;
  /** person key ("{college_norm}--{unique_id_norm}") → enrollment status */
  enrollments: Record<string, "active" | "removed">;
  /** person keys ever seen (drives created/updated person counts) */
  persons: Record<string, true>;
};

export function emptyPersonRosterState(): PersonRosterState {
  return { colleges: {}, enrollments: {}, persons: {} };
}

export type PersonRosterUploadResult =
  | { kind: "error"; status: number; code: string; payload?: Record<string, unknown> }
  | { kind: "confirm"; new_colleges: NewCollegePreview[]; known_colleges: KnownCollege[] }
  | { kind: "ok"; response: RosterUploadResponse; state: PersonRosterState };

// Mirrors backend identityNorm = sanitizeSegment(normalizeUniqueId(v)):
// trim + lower + strip ALL whitespace, then doc-id-safe charset + 120 cap,
// never empty/all-dots.
export function identityNorm(value: string): string {
  const norm = String(value).trim().toLowerCase().replace(/\s+/g, "");
  const cleaned = norm.replace(/[^a-z0-9._-]/g, "_").slice(0, 120);
  if (cleaned === "" || /^\.+$/.test(cleaned)) return "_";
  return cleaned;
}

// UI decisions → the wire college_resolutions payload: "" = create the new
// college, anything else = map onto that existing college_norm.
export function buildCollegeResolutions(decisions: Record<string, string>): Record<string, CollegeResolution> {
  const resolutions: Record<string, CollegeResolution> = {};
  for (const [collegeNorm, target] of Object.entries(decisions)) {
    resolutions[collegeNorm] = target ? { action: "map", college_norm: target } : { action: "create" };
  }
  return resolutions;
}

export function evaluatePersonRosterUpload(
  payload: RosterUploadRequest,
  state: PersonRosterState
): PersonRosterUploadResult {
  const columns = payload.columns ?? [];
  const mapping = payload.column_mapping ?? {};

  // (1) resolve the COMPULSORY college column.
  const collegeColumn =
    (payload.college_column && columns.includes(payload.college_column) && payload.college_column) ||
    (mapping.college && columns.includes(mapping.college) && mapping.college) ||
    columns.find((column) => column.toLowerCase() === "college") ||
    "";
  if (!collegeColumn) return { kind: "error", status: 400, code: "college_column_required" };

  const projected = payload.rows.map((row, index) => ({
    row: index + 1,
    college: (row[collegeColumn] ?? "").trim(),
    uniqueId: (row[payload.unique_id_column] ?? "").trim(),
    fields: row
  }));

  const blankCollegeRows = projected.filter((r) => !r.college).map((r) => r.row);
  if (blankCollegeRows.length) {
    return { kind: "error", status: 400, code: "college_required", payload: { rows: blankCollegeRows } };
  }

  // (2) canonicalization gate — distinct college strings grouped by final norm.
  const groups = new Map<string, NewCollegePreview>();
  for (const r of projected) {
    const norm = identityNorm(r.college);
    if (!groups.has(norm)) groups.set(norm, { college_norm: norm, name: r.college, names: [], rows: 0 });
    const group = groups.get(norm)!;
    if (!group.names.includes(r.college)) group.names.push(r.college);
    group.rows += 1;
  }
  const resolutions = payload.college_resolutions ?? {};
  const colleges = { ...state.colleges };
  const resolvedNorms = new Map<string, string>();
  const collegesCreated: string[] = [];
  const unresolved: NewCollegePreview[] = [];
  for (const group of groups.values()) {
    if (colleges[group.college_norm] !== undefined) {
      resolvedNorms.set(group.college_norm, group.college_norm);
      continue;
    }
    const resolution = resolutions[group.college_norm];
    if (resolution?.action === "map" && colleges[identityNorm(resolution.college_norm)] !== undefined) {
      resolvedNorms.set(group.college_norm, identityNorm(resolution.college_norm));
    } else if (resolution?.action === "create") {
      resolvedNorms.set(group.college_norm, group.college_norm);
      colleges[group.college_norm] = ("name" in resolution && resolution.name) || group.name;
      collegesCreated.push(group.college_norm);
    } else {
      unresolved.push(group);
    }
  }
  if (unresolved.length) {
    return {
      kind: "confirm",
      new_colleges: unresolved.sort((a, b) => a.college_norm.localeCompare(b.college_norm)),
      known_colleges: Object.entries(state.colleges)
        .map(([college_norm, name]) => ({ college_norm, name }))
        .sort((a, b) => a.college_norm.localeCompare(b.college_norm))
    };
  }

  // (5) blank-id skip first so (3) keys on real candidates only.
  const skipped: Array<{ row: number; reason: string }> = [];
  const candidates: Array<{ row: number; college: string; uniqueId: string; collegeNorm: string; idNorm: string; personKey: string }> = [];
  for (const r of projected) {
    if (!r.uniqueId) {
      skipped.push({ row: r.row, reason: "empty_unique_id" });
      continue;
    }
    const collegeNorm = resolvedNorms.get(identityNorm(r.college))!;
    const idNorm = identityNorm(r.uniqueId);
    candidates.push({ row: r.row, college: r.college, uniqueId: r.uniqueId, collegeNorm, idNorm, personKey: `${collegeNorm}--${idNorm}` });
  }
  if (!candidates.length) {
    return { kind: "error", status: 400, code: "no valid roster rows (every row was skipped)" };
  }

  // (3) duplicate (college_norm, unique_id_norm) on the FINAL norm → hard reject.
  const firstByPerson = new Map<string, number>();
  const duplicates: RosterDuplicate[] = [];
  for (const c of candidates) {
    const first = firstByPerson.get(c.personKey);
    if (first !== undefined) duplicates.push({ row: c.row, college: c.college, unique_id: c.uniqueId, conflicts_with_row: first });
    else firstByPerson.set(c.personKey, c.row);
  }
  if (duplicates.length) {
    return { kind: "error", status: 400, code: "duplicate_unique_ids", payload: { duplicates } };
  }

  // (4) ambiguity warning.
  const collegesById = new Map<string, Set<string>>();
  for (const c of candidates) {
    if (!collegesById.has(c.idNorm)) collegesById.set(c.idNorm, new Set());
    collegesById.get(c.idNorm)!.add(c.collegeNorm);
  }
  const ambiguousIds = [...collegesById.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([idNorm, set]) => ({ unique_id_norm: idNorm, colleges: [...set].sort() }))
    .sort((a, b) => a.unique_id_norm.localeCompare(b.unique_id_norm));

  // Persons + enrollments reconcile (mint / reactivate / remove).
  const unique = [...new Map(candidates.map((c) => [c.personKey, c])).values()];
  const persons = { ...state.persons };
  const personStats = { created: 0, updated: 0 };
  for (const c of unique) {
    if (persons[c.personKey]) personStats.updated += 1;
    else {
      persons[c.personKey] = true;
      personStats.created += 1;
    }
  }
  const enrollments: Record<string, "active" | "removed"> = { ...state.enrollments };
  const enrollmentStats = { created: 0, reactivated: 0, removed: 0 };
  const uploadedKeys = new Set(unique.map((c) => c.personKey));
  for (const c of unique) {
    const current = enrollments[c.personKey];
    if (current === undefined) {
      enrollments[c.personKey] = "active";
      enrollmentStats.created += 1;
    } else if (current === "removed") {
      enrollments[c.personKey] = "active";
      enrollmentStats.reactivated += 1;
    }
  }
  for (const [personKey, status] of Object.entries(state.enrollments)) {
    if (!uploadedKeys.has(personKey) && status === "active") {
      enrollments[personKey] = "removed";
      enrollmentStats.removed += 1;
    }
  }

  return {
    kind: "ok",
    response: {
      ok: true,
      configured: true,
      contest: payload.contest,
      count: unique.length,
      skipped,
      ambiguous_ids: ambiguousIds,
      colleges_created: collegesCreated.sort(),
      persons: personStats,
      enrollments: enrollmentStats
    },
    state: { colleges, enrollments, persons }
  };
}
