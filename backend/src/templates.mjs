// backend/src/templates.mjs
// S-I §1.1: proctor TEMPLATES — reusable contest blueprints. A template is an
// ORDERED list of bank-problem references (+ per-entry points override) plus
// the contest defaults snapshot-copied onto a contest at instantiation
// (spec §1.4: the LIST is frozen at instantiate, the CONTENT stays live).
//
// Mirrors problems.mjs: pure validation that never spreads client input, a
// code-level SEED preset shadowed by a same-slug Firestore doc, and a store
// configured by handler.mjs with a Firestore GETTER so test fakes propagate.
//
// Spec: docs/superpowers/specs/2026-06-10-s-i-multiproblem-detail-spec.md §1.1/§2
import { isValidProblemId, SUPPORTED_LANGUAGES } from "./problems.mjs";

export const TEMPLATE_BOUNDS = {
  NAME_MAX: 120,
  DESCRIPTION_MAX: 2000,
  PROBLEMS_MAX: 20,
  POINTS_MAX: 1000,
  DURATION_MIN: 5,
  DURATION_MAX: 600,
  DURATION_DEFAULT: 120,
  IDENTITY_LABEL_MAX: 40,
  IDENTITY_LABEL_DEFAULT: "Roll Number",
  RETENTION_MIN: 1,
  RETENTION_MAX: 30,
  RETENTION_DEFAULT: 4
};

// Defaults-normalizer bounds. Deliberately IDENTICAL to the handler.mjs
// settings normalizers (F10.1 camera / F5.3 enforcement) so a template default
// can never persist a value the settings path would have rejected. Kept local
// because handler.mjs imports THIS module (exporting from handler would cycle).
const CAMERA_DEFAULTS = { enabled: true, fps: 10, width: 640 };
const CAMERA_FPS_MIN = 1;
const CAMERA_FPS_MAX = 15;
const CAMERA_WIDTH_MIN = 320;
const CAMERA_WIDTH_MAX = 1280;
// OMR P1 (2026-06-12 design §5.2): screen-marker fiducials are default OFF
// everywhere — only an explicit boolean true turns them on. v1 is boolean-only
// (size/contrast are frontend code constants, design Open Question 4).
const SCREEN_MARKERS_DEFAULTS = { enabled: false };
const ENFORCEMENT_MODES = ["block", "alert_first"];
const FULLSCREEN_REENTRY_DEFAULT_SECONDS = 20;
const FULLSCREEN_EXIT_LIMIT_DEFAULT = 2;

// The always-available day-before lab-check preset (vision S6/J1.5): every
// machine instantiates a tiny no-roster contest and runs sum-two end-to-end.
// Same shadow rule as SEED_PROBLEMS: a Firestore doc with this slug shadows
// the seed entirely; the list endpoint merges seeds + docs.
export const SEED_TEMPLATES = {
  "system-check": {
    slug: "system-check",
    name: "System check",
    description: "Day-before lab check: instantiate as an always-open no-roster contest and run one trivial problem end-to-end on every machine.",
    archived: false,
    problems: [{ problem_id: "sum-two", points: null, order: 0 }],
    defaults: {
      duration_minutes: 30,
      identity_label: "Roll Number",
      room_gate_enabled: false,
      camera_recording: { enabled: true, fps: 10, width: 320 },
      screen_markers: { enabled: false },
      enforcement: { mode: "block", fullscreen_reentry_seconds: 20, fullscreen_exit_limit: 2 },
      evidence_retention_days: 1,
      languages: ["python", "cpp", "java", "javascript"]
    },
    created_at: null,
    updated_at: null
  }
};

// Wired by handler.mjs at module load with a Firestore GETTER (not the
// instance) so the __setClientsForTest fakes propagate here too.
let store = null;
export function configureTemplateStore({ getFirestore, collection }) {
  store = { getFirestore, collection };
}

const TEMPLATES_QUERY_LIMIT = 500;

// Doc-or-seed read; `preset` marks seed-sourced rows (never stored). A doc
// SHADOWS the seed (same rule as the problem bank).
export async function getTemplate(slug) {
  const key = String(slug || "").trim();
  if (!key || /[\/]/.test(key)) return null;
  if (store) {
    const doc = await store.getFirestore().collection(store.collection).doc(key).get();
    if (doc.exists) return { ...doc.data(), preset: false };
  }
  const seed = Object.hasOwn(SEED_TEMPLATES, key) ? SEED_TEMPLATES[key] : null;
  return seed ? { ...structuredCloneTemplate(seed), preset: true } : null;
}

// Seeds merged with docs, docs shadow seeds. FULL docs — the handler list
// endpoint projects summaries (problem_count/total_points) on top.
export async function listTemplates() {
  const bySlug = new Map();
  for (const [slug, seed] of Object.entries(SEED_TEMPLATES)) {
    bySlug.set(slug, { ...structuredCloneTemplate(seed), preset: true });
  }
  if (store) {
    const snapshot = await store.getFirestore().collection(store.collection).limit(TEMPLATES_QUERY_LIMIT).get();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      bySlug.set(data.slug, { ...data, preset: false });
    }
  }
  return [...bySlug.values()].sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
}

// Deep copy of the template-owned nested structures (problems entries +
// defaults) so seeds/clones can never share mutable references.
export function structuredCloneTemplate(template) {
  return {
    ...template,
    problems: (template.problems || []).map((entry) => ({ ...entry })),
    defaults: {
      ...template.defaults,
      camera_recording: { ...template.defaults?.camera_recording },
      screen_markers: normalizeTemplateScreenMarkers(template.defaults?.screen_markers),
      enforcement: { ...template.defaults?.enforcement },
      languages: [...(template.defaults?.languages || [])]
    }
  };
}

function invalid(error) {
  return { ok: false, error };
}

// ---- ordered problem entries (shared with contest problems[], §1.3) ---------
// Allow-listed {problem_id, points, order}: dedupe ids (first occurrence wins),
// sort by the provided order (stable), renumber 0..n-1. points: null = "use
// the bank problem's points at serve time", else int 0..1000 override.
export function normalizeProblemEntries(list) {
  if (!Array.isArray(list) || list.length < 1) return invalid("problems must be a non-empty array");
  if (list.length > TEMPLATE_BOUNDS.PROBLEMS_MAX) {
    return invalid(`problems: max ${TEMPLATE_BOUNDS.PROBLEMS_MAX} entries`);
  }
  const seen = new Set();
  const entries = [];
  for (const [index, item] of list.entries()) {
    if (!item || typeof item !== "object") return invalid(`problems[${index}] must be an object`);
    const problemId = String(item.problem_id || "");
    if (!isValidProblemId(problemId)) return invalid(`problems[${index}].problem_id is invalid`);
    if (seen.has(problemId)) continue; // dedupe: first occurrence wins
    seen.add(problemId);
    let points = null;
    if (item.points !== undefined && item.points !== null) {
      points = Number(item.points);
      if (!Number.isInteger(points) || points < 0 || points > TEMPLATE_BOUNDS.POINTS_MAX) {
        return invalid(`problems[${index}].points must be null or an integer 0-${TEMPLATE_BOUNDS.POINTS_MAX}`);
      }
    }
    const orderRaw = Number(item.order);
    const order = Number.isFinite(orderRaw) ? orderRaw : index;
    entries.push({ problem_id: problemId, points, order });
  }
  entries.sort((a, b) => a.order - b.order);
  return { ok: true, entries: entries.map((entry, index) => ({ ...entry, order: index })) };
}

// ---- defaults normalization ---------------------------------------------------
// Same "garbage falls back to the default" convention as the settings
// normalizers — EXCEPT languages, where an explicitly-sent bad list is a hard
// error (mirrors validateProblemInput's languages rule).
function normalizeDefaults(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};

  let languages = [...SUPPORTED_LANGUAGES];
  if (source.languages !== undefined) {
    if (!Array.isArray(source.languages)) return invalid("defaults.languages must be an array");
    languages = [...new Set(source.languages.map(String))];
    if (!languages.length) return invalid("defaults.languages must be non-empty");
    for (const lang of languages) {
      if (!SUPPORTED_LANGUAGES.includes(lang)) return invalid(`defaults.languages: unsupported language ${lang}`);
    }
  }

  let identityLabel = TEMPLATE_BOUNDS.IDENTITY_LABEL_DEFAULT;
  if (source.identity_label !== undefined) {
    const label = String(source.identity_label).trim();
    if (!label || label.length > TEMPLATE_BOUNDS.IDENTITY_LABEL_MAX) {
      return invalid(`defaults.identity_label must be 1-${TEMPLATE_BOUNDS.IDENTITY_LABEL_MAX} chars`);
    }
    identityLabel = label;
  }

  return {
    ok: true,
    defaults: {
      duration_minutes: boundedIntOr(source.duration_minutes, TEMPLATE_BOUNDS.DURATION_DEFAULT,
        TEMPLATE_BOUNDS.DURATION_MIN, TEMPLATE_BOUNDS.DURATION_MAX),
      identity_label: identityLabel,
      room_gate_enabled: typeof source.room_gate_enabled === "boolean" ? source.room_gate_enabled : true,
      camera_recording: normalizeTemplateCameraRecording(source.camera_recording),
      screen_markers: normalizeTemplateScreenMarkers(source.screen_markers),
      enforcement: normalizeTemplateEnforcement(source.enforcement),
      evidence_retention_days: clampIntOr(source.evidence_retention_days, TEMPLATE_BOUNDS.RETENTION_DEFAULT,
        TEMPLATE_BOUNDS.RETENTION_MIN, TEMPLATE_BOUNDS.RETENTION_MAX),
      languages
    }
  };
}

export function normalizeTemplateCameraRecording(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : CAMERA_DEFAULTS.enabled,
    fps: boundedIntOr(source.fps, CAMERA_DEFAULTS.fps, CAMERA_FPS_MIN, CAMERA_FPS_MAX),
    width: boundedIntOr(source.width, CAMERA_DEFAULTS.width, CAMERA_WIDTH_MIN, CAMERA_WIDTH_MAX)
  };
}

// OMR P1: same "garbage → default" rule as the camera normalizer, but the
// default is DISABLED — a deployment that never touches the flag must behave
// byte-identically to today (design §5.2/§11).
export function normalizeTemplateScreenMarkers(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : SCREEN_MARKERS_DEFAULTS.enabled
  };
}

export function normalizeTemplateEnforcement(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    mode: ENFORCEMENT_MODES.includes(source.mode) ? source.mode : "block",
    fullscreen_reentry_seconds: intAtLeastOr(source.fullscreen_reentry_seconds, FULLSCREEN_REENTRY_DEFAULT_SECONDS, 1),
    fullscreen_exit_limit: intAtLeastOr(source.fullscreen_exit_limit, FULLSCREEN_EXIT_LIMIT_DEFAULT, 0)
  };
}

// ---- whole-body validation ------------------------------------------------------
// Validate + NORMALIZE an authoring payload into a brand-new allow-listed
// template object (no slug — create derives it, update keeps it). Client
// input is never spread into storage (validateProblemInput's hardening rule).
export function validateTemplateInput(body) {
  const name = String(body?.name || "").trim();
  if (!name) return invalid("name is required");
  if (name.length > TEMPLATE_BOUNDS.NAME_MAX) return invalid(`name: max ${TEMPLATE_BOUNDS.NAME_MAX} chars`);

  const description = String(body?.description ?? "");
  if (description.length > TEMPLATE_BOUNDS.DESCRIPTION_MAX) {
    return invalid(`description: max ${TEMPLATE_BOUNDS.DESCRIPTION_MAX} chars`);
  }

  const problems = normalizeProblemEntries(body?.problems);
  if (!problems.ok) return problems;

  const defaults = normalizeDefaults(body?.defaults);
  if (!defaults.ok) return defaults;

  return {
    ok: true,
    template: { name, description, problems: problems.entries, defaults: defaults.defaults }
  };
}

// ---- small numeric helpers (same semantics as handler.mjs boundedIntOr) ----------

function boundedIntOr(raw, fallback, minimum, maximum) {
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < minimum || num > maximum) return fallback;
  return num;
}

function intAtLeastOr(raw, fallback, minimum) {
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < minimum) return fallback;
  return num;
}

// Retention keeps the contests.mjs clamp convention (1..30) — a number out of
// range CLAMPS (the admin asked for "more"/"less", honor the nearest bound);
// non-numeric garbage falls back to the default.
function clampIntOr(raw, fallback, minimum, maximum) {
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num)) return fallback;
  return Math.min(maximum, Math.max(minimum, num));
}
