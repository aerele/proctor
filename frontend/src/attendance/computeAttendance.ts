// S6 attendance — pure attendance math + CSV builder, shared by the api.ts demo
// branch and unit tests. Mirrors the backend adminAttendance semantics EXACTLY
// (spec: docs/superpowers/specs/2026-06-09-s6-attendance-stats-design.md):
// taken = >=1 matching session (any status); in_progress = any non-ended;
// completed = all ended; blank/off-roster session ids -> unmatched_sessions.

export type AttendanceAbsentee = {
  unique_id: string;
  name: string;
  roll_number: string;
  room: string;
};

export type AttendanceSessionLike = {
  roster_unique_id: string;
  status: string;
};

export type AttendanceCore = {
  roster_total: number;
  taken: { total: number; in_progress: number; completed: number };
  not_taken: number;
  absentees: AttendanceAbsentee[];
  unmatched_sessions: number;
};

// GET /api/admin/attendance response. `configured:false` carries nothing else.
export type AttendanceReport =
  | { configured: false }
  | ({ configured: true; contest_slug: string | null; generated_at: string } & AttendanceCore);

// Mirrors the backend normalizeUniqueId: trim + lowercase + strip ALL whitespace
// (colleges format roll numbers inconsistently: "21 CS 001" ≡ "21CS001").
function normalizeUniqueId(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

export function computeAttendance(
  roster: AttendanceAbsentee[],
  sessions: AttendanceSessionLike[]
): AttendanceCore {
  const knownNorms = new Set(roster.map((row) => normalizeUniqueId(row.unique_id)));
  const liveByNorm = new Map<string, boolean>();
  let unmatched = 0;
  for (const session of sessions) {
    const idNorm = normalizeUniqueId(session.roster_unique_id || "");
    if (!idNorm || !knownNorms.has(idNorm)) {
      unmatched += 1;
      continue;
    }
    const live = session.status !== "ended";
    liveByNorm.set(idNorm, Boolean(liveByNorm.get(idNorm)) || live);
  }
  const taken = { total: 0, in_progress: 0, completed: 0 };
  const absentees: AttendanceAbsentee[] = [];
  for (const row of roster) {
    const idNorm = normalizeUniqueId(row.unique_id);
    if (liveByNorm.has(idNorm)) {
      taken.total += 1;
      if (liveByNorm.get(idNorm)) taken.in_progress += 1;
      else taken.completed += 1;
    } else {
      absentees.push(row);
    }
  }
  absentees.sort((a, b) => a.unique_id.localeCompare(b.unique_id));
  return {
    roster_total: roster.length,
    taken,
    not_taken: absentees.length,
    absentees,
    unmatched_sessions: unmatched
  };
}

// RFC-4180-ish escaping, same rules as App.tsx's csvField (kept local so this
// module stays pure + importable by both api.ts and App.tsx). Cells starting
// with a formula trigger are prefixed with ' so spreadsheets treat them as
// text — roster fields are candidate-supplied (M8, same guard as App.tsx).
function csvField(value: string): string {
  let v = value;
  if (v && /^[=+\-@\t\r]/.test(v)) v = "'" + v;
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

// Absentees CSV for the exam-day report: fixed header + one row per absentee.
export function buildAbsenteesCsv(absentees: AttendanceAbsentee[]): string {
  const header = "unique_id,name,roll_number,room";
  const rows = absentees.map((a) =>
    [csvField(a.unique_id), csvField(a.name), csvField(a.roll_number), csvField(a.room)].join(",")
  );
  return [header, ...rows].join("\n");
}
