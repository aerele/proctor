// frontend/src/admin/templateForm.ts
// FIX-B2 (#58): pure form/list logic for the Templates tab. A TEMPLATE is a
// named, reusable contest blueprint — an ordered list of bank-problem refs plus
// default settings — that an admin instantiates into a real contest from the
// Contests tab. The backend (src/templates.mjs + handler CRUD) owns validation
// and storage; this module is the UI-side draft <-> wire-payload mapping kept
// pure so it can be unit-tested without React. Mirrors problemDraft.ts.
import type { ProblemLanguage } from "../types";
import type { ContestTemplateDetail } from "../api";

export const TEMPLATE_LANGUAGES: ProblemLanguage[] = ["python", "cpp", "java", "javascript"];
export const TEMPLATE_ENFORCEMENT_MODES = ["block", "alert_first"] as const;

// Bounds mirror backend/src/templates.mjs TEMPLATE_BOUNDS so the UI rejects the
// same values the server would (no surprise 400s after a long form).
export const TEMPLATE_FORM_BOUNDS = {
  NAME_MAX: 120,
  DESCRIPTION_MAX: 2000,
  PROBLEMS_MAX: 20,
  POINTS_MAX: 1000,
  DURATION_MIN: 5,
  DURATION_MAX: 600,
  IDENTITY_LABEL_MAX: 40,
  RETENTION_MIN: 1,
  RETENTION_MAX: 30
};

// One ordered problem row: a points string ("" = use the bank problem's points
// at serve time, mirroring the contest editor's empty-points convention).
export type TemplateProblemRow = { problem_id: string; points: string };

// The editable form shape. Numbers are strings so partial typing never throws.
export type TemplateDraft = {
  slug: string;            // "" for a brand-new template (create); set = update
  name: string;
  description: string;
  problems: TemplateProblemRow[];
  durationMinutes: string;
  identityLabel: string;
  roomGateEnabled: boolean;
  cameraEnabled: boolean;
  cameraFps: string;
  cameraWidth: string;
  enforcementMode: (typeof TEMPLATE_ENFORCEMENT_MODES)[number];
  fullscreenReentrySeconds: string;
  fullscreenExitLimit: string;
  evidenceRetentionDays: string;
  languages: ProblemLanguage[];
  preset: boolean;         // a bare seed preset: form is read-only / clone-only
};

// A blank draft with the spec defaults (same numbers as the system-check-free
// defaults in templates.mjs normalizeDefaults).
export function emptyTemplateDraft(): TemplateDraft {
  return {
    slug: "",
    name: "",
    description: "",
    problems: [],
    durationMinutes: "120",
    identityLabel: "Roll Number",
    roomGateEnabled: true,
    cameraEnabled: true,
    cameraFps: "10",
    cameraWidth: "640",
    enforcementMode: "block",
    fullscreenReentrySeconds: "20",
    fullscreenExitLimit: "2",
    evidenceRetentionDays: "4",
    languages: [...TEMPLATE_LANGUAGES],
    preset: false
  };
}

const numToStr = (value: number | null | undefined, fallback: string): string =>
  value === null || value === undefined ? fallback : String(value);

// Hydrate an editable draft from a fetched template detail doc (edit path).
export function draftFromTemplate(template: ContestTemplateDetail): TemplateDraft {
  const d = template.defaults ?? {};
  const camera = d.camera_recording ?? {};
  const enforcement = d.enforcement ?? {};
  const languages = (d.languages ?? []).filter((lang): lang is ProblemLanguage =>
    (TEMPLATE_LANGUAGES as string[]).includes(lang));
  return {
    slug: template.slug,
    name: template.name ?? "",
    description: template.description ?? "",
    problems: (template.problems ?? []).map((entry) => ({
      problem_id: entry.problem_id,
      points: entry.points === null || entry.points === undefined ? "" : String(entry.points)
    })),
    durationMinutes: numToStr(d.duration_minutes, "120"),
    identityLabel: d.identity_label ?? "Roll Number",
    roomGateEnabled: d.room_gate_enabled !== false,
    cameraEnabled: camera.enabled !== false,
    cameraFps: numToStr(camera.fps, "10"),
    cameraWidth: numToStr(camera.width, "640"),
    enforcementMode: enforcement.mode === "alert_first" ? "alert_first" : "block",
    fullscreenReentrySeconds: numToStr(enforcement.fullscreen_reentry_seconds, "20"),
    fullscreenExitLimit: numToStr(enforcement.fullscreen_exit_limit, "2"),
    evidenceRetentionDays: numToStr(d.evidence_retention_days, "4"),
    languages: languages.length ? languages : [...TEMPLATE_LANGUAGES],
    preset: Boolean(template.preset)
  };
}

// Client-side validation. Returns a human message on the FIRST problem, else "".
// Intentionally lighter than the server (which re-validates + normalizes); this
// only catches the obvious mistakes so the admin gets instant feedback.
export function validateTemplateDraft(draft: TemplateDraft): string {
  const name = draft.name.trim();
  if (!name) return "Give the template a name.";
  if (name.length > TEMPLATE_FORM_BOUNDS.NAME_MAX) return `Name is too long (max ${TEMPLATE_FORM_BOUNDS.NAME_MAX}).`;
  if (draft.description.length > TEMPLATE_FORM_BOUNDS.DESCRIPTION_MAX) {
    return `Description is too long (max ${TEMPLATE_FORM_BOUNDS.DESCRIPTION_MAX}).`;
  }
  if (!draft.problems.length) return "Add at least one problem from the bank.";
  if (draft.problems.length > TEMPLATE_FORM_BOUNDS.PROBLEMS_MAX) {
    return `Too many problems (max ${TEMPLATE_FORM_BOUNDS.PROBLEMS_MAX}).`;
  }
  const seen = new Set<string>();
  for (const row of draft.problems) {
    if (!row.problem_id) return "A problem row is empty — remove it or pick a problem.";
    if (seen.has(row.problem_id)) return `Problem "${row.problem_id}" is listed twice.`;
    seen.add(row.problem_id);
    if (row.points.trim() !== "") {
      const points = Number(row.points);
      if (!Number.isInteger(points) || points < 0 || points > TEMPLATE_FORM_BOUNDS.POINTS_MAX) {
        return `Points for "${row.problem_id}" must be a whole number 0–${TEMPLATE_FORM_BOUNDS.POINTS_MAX} (or blank for the bank default).`;
      }
    }
  }
  if (!draft.languages.length) return "Pick at least one language.";
  return "";
}

// The wire payload for create (POST /templates) or update (POST /template-update).
// Numbers parse from the string fields; blank points -> null (use bank points);
// out-of-range numbers are LEFT to the server normalizer (it clamps/defaults),
// so we only forward what the admin typed. order is positional (the UI list IS
// the order). On update we include the slug.
export type TemplateSavePayload = {
  slug?: string;
  name: string;
  description: string;
  problems: Array<{ problem_id: string; points: number | null; order: number }>;
  defaults: {
    duration_minutes: number;
    identity_label: string;
    room_gate_enabled: boolean;
    camera_recording: { enabled: boolean; fps: number; width: number };
    enforcement: { mode: string; fullscreen_reentry_seconds: number; fullscreen_exit_limit: number };
    evidence_retention_days: number;
    languages: ProblemLanguage[];
  };
};

export function draftToSavePayload(draft: TemplateDraft): TemplateSavePayload {
  const payload: TemplateSavePayload = {
    name: draft.name.trim(),
    description: draft.description,
    problems: draft.problems.map((row, order) => ({
      problem_id: row.problem_id,
      points: row.points.trim() === "" ? null : Number(row.points),
      order
    })),
    defaults: {
      duration_minutes: Number(draft.durationMinutes),
      identity_label: draft.identityLabel.trim(),
      room_gate_enabled: draft.roomGateEnabled,
      camera_recording: {
        enabled: draft.cameraEnabled,
        fps: Number(draft.cameraFps),
        width: Number(draft.cameraWidth)
      },
      enforcement: {
        mode: draft.enforcementMode,
        fullscreen_reentry_seconds: Number(draft.fullscreenReentrySeconds),
        fullscreen_exit_limit: Number(draft.fullscreenExitLimit)
      },
      evidence_retention_days: Number(draft.evidenceRetentionDays),
      languages: draft.languages
    }
  };
  if (draft.slug) payload.slug = draft.slug;
  return payload;
}

// Move a problem row up/down by delta, clamped (returns the same array identity
// when the move would fall off either end so callers can skip a no-op setState).
export function moveProblemRow(rows: TemplateProblemRow[], index: number, delta: number): TemplateProblemRow[] {
  const target = index + delta;
  if (target < 0 || target >= rows.length) return rows;
  const next = [...rows];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

// Summary-row label for the list: "3 problems · 240 pts".
export function templateRowSummary(problemCount: number, totalPoints: number): string {
  const problems = `${problemCount} problem${problemCount === 1 ? "" : "s"}`;
  return `${problems} · ${totalPoints} pts`;
}
