// backend/src/contests.mjs
// S-B (SHIPS DARK): the proctor_contests collection + the two scoping
// chokepoints every FUTURE contest-scoped read goes through.
//
// Specs:
//   docs/superpowers/specs/2026-06-10-f10-product-vision.md  §2.7 (doc shape),
//     §7 row S-B (identity_mode enum), §10.3 (typed access code)
//   docs/superpowers/specs/2026-06-10-f9-identity-data-lifecycle-design.md
//     §2.1 (F9 contest doc, frozen), §2.3 (no-bleed mechanisms), §3 (lifecycle
//     placeholders), §6 (legacy-contest synthesis)
//
// NOTHING in the production candidate/session flow reads any of this yet —
// handler.mjs only wires the new ADMIN endpoints onto these functions. The
// legacy exam keeps running off the SETTINGS_ID="active" doc bit-for-bit; it
// surfaces here only as a READ-ONLY synthesized contest (legacy:true) so the
// future Contests tab shows today's exam without migration.
import { randomInt } from "node:crypto";

export const CONTEST_STATUSES = ["draft", "open", "archived"];
// F10 §7 row S-B: "unique_id" is deleted from the design before any code
// exists. New contests are ALWAYS "person"; "legacy_username" exists only on
// the synthesized legacy contest and can never be created or assigned.
export const IDENTITY_MODES = ["person", "legacy_username"];

const NAME_MAX = 200;
const IDENTITY_LABEL_MAX = 80;
const IDENTITY_LABEL_DEFAULT = "Candidate ID"; // S-A interim label (F9 §5 S-A)
const RETENTION_DAYS_DEFAULT = 4;              // F9 Q2 default, clamp 1..30
const RETENTION_DAYS_MIN = 1;
const RETENTION_DAYS_MAX = 30;
const CONTESTS_QUERY_LIMIT = 500;
const SLUG_COLLISION_LIMIT = 50;

// Typed contest access code (vision §10.3): 6 chars, A-Z plus 2-9 (no 0/1 —
// O/I lookalikes), minted ONCE at create with a bounded collision-retry loop.
export const ACCESS_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789";
const ACCESS_CODE_LENGTH = 6;
const ACCESS_CODE_MINT_ATTEMPTS = 20;

// Cross-contest reads must OPT IN with this sentinel — scopedQuery never
// defaults to unscoped (F9 §2.3.2). A Symbol so no JSON payload can forge it.
export const ALL_CONTESTS = Symbol("ALL_CONTESTS");

// Wired by handler.mjs at module load with a Firestore GETTER (not the
// instance) so the __setClientsForTest fakes propagate here too — the exact
// configureProblemStore pattern.
let store = null;
export function configureContestStore({ getFirestore, collection, settingsCollection, settingsId }) {
  store = { getFirestore, collection, settingsCollection, settingsId };
}

// Injectable RNG seam for deterministic access-code collision tests (mirrors
// __setExecClockForTest). fn(max) → int in [0, max). Pass null to restore.
let _randomInt = (max) => randomInt(max);
export function __setRandomForTest(fn) {
  _randomInt = fn || ((max) => randomInt(max));
}

function db() {
  if (!store) throw httpError(500, "contest store is not configured");
  return store.getFirestore();
}

function contestsCol() {
  return db().collection(store.collection);
}

function contestRef(slug) {
  return contestsCol().doc(slug);
}

async function getActiveSettings() {
  const doc = await db().collection(store.settingsCollection).doc(store.settingsId).get();
  return doc.exists ? doc.data() : null;
}

// ---- slugify (F8 decision 1 / F9 §2.1) --------------------------------------
// lowercase, trim, whitespace→"-", strip non [a-z0-9-]; runs of dashes collapse
// and edge dashes drop so "KEC June 2026 — Round 1" → "kec-june-2026-round-1"
// (the em-dash strips clean instead of leaving "---"). Empty result = invalid
// name; collisions get the -2/-3… suffix at create time.
export function slugify(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---- create -----------------------------------------------------------------

export async function createContest(body) {
  const name = String(body?.name ?? "").trim();
  if (!name) throw httpError(400, "name is required");
  if (name.length > NAME_MAX) throw httpError(400, `name: max ${NAME_MAX} chars`);
  const baseSlug = slugify(name);
  if (!baseSlug) throw httpError(400, "name must contain letters or digits");
  if (body?.identity_mode !== undefined && body.identity_mode !== "person") {
    // "legacy_username" is synth-only; "unique_id" never ships (F10 §7 S-B).
    throw httpError(400, "identity_mode must be \"person\"");
  }

  const identityLabel = normalizeIdentityLabel(body?.identity_label);
  const listed = body?.listed === undefined ? true : requireBoolean(body.listed, "listed");
  const window = normalizeWindow(body?.start_at, body?.end_at);
  const retentionDays = normalizeRetentionDays(body?.evidence_retention_days);
  const accessCode = await mintAccessCode();
  const legacy = await synthesizeLegacyContest();
  const now = new Date().toISOString();

  // Atomic .create() decides slug ownership — two concurrent creates of the
  // same name can never overwrite each other; the loser walks to the next
  // suffix. The synthesized legacy slug is skipped outright so a new contest
  // can never shadow today's legacy exam data.
  for (let n = 1; n <= SLUG_COLLISION_LIMIT; n++) {
    const slug = n === 1 ? baseSlug : `${baseSlug}-${n}`;
    if (legacy && legacy.slug === slug) continue;
    const item = {
      slug,
      name,
      status: "draft",
      listed,
      identity_mode: "person",
      identity_label: identityLabel,
      access_code: accessCode,
      start_at: window.start_at,
      end_at: window.end_at,
      end_at_updated_at: null, // S5 semantics move per-contest at S-C/S-D
      room_gate_enabled: false,
      rooms: [],
      created_at: now,
      updated_at: now,
      // Lifecycle block placeholders (F9 §3) — S-G/S-H fill these in.
      selection_done_at: null,
      evidence_retention_days: retentionDays,
      evidence_purged_at: null,
      db_purged_at: null,
      evidence_prefixes: null,
      last_export: null
    };
    try {
      await contestRef(slug).create(item);
      return item;
    } catch (err) {
      if (isAlreadyExists(err)) continue;
      throw err;
    }
  }
  throw httpError(409, "slug_collision_limit");
}

// ---- update / status ----------------------------------------------------------

// Display/settings edits only. THE rule: a rename NEVER changes the slug — the
// slug is embedded in doc ids, GCS paths and links the moment a session exists.
// identity_mode, access_code and status are not updatable here (status has its
// own endpoint; the other two are mint-once).
export async function updateContest(slugRaw, body) {
  const existing = await getRealContest(slugRaw);
  if (body?.identity_mode !== undefined) throw httpError(400, "identity_mode is immutable");
  if (body?.access_code !== undefined) throw httpError(400, "access_code cannot be edited");
  if (body?.status !== undefined) throw httpError(400, "use /api/admin/contest-status to change status");

  const patch = {};
  if (body?.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw httpError(400, "name is required");
    if (name.length > NAME_MAX) throw httpError(400, `name: max ${NAME_MAX} chars`);
    patch.name = name;
  }
  if (body?.identity_label !== undefined) patch.identity_label = normalizeIdentityLabel(body.identity_label);
  if (body?.listed !== undefined) patch.listed = requireBoolean(body.listed, "listed");
  if (body?.evidence_retention_days !== undefined) {
    patch.evidence_retention_days = normalizeRetentionDays(body.evidence_retention_days);
  }
  // Window edits validate against the MERGED window so a partial edit can never
  // leave start >= end behind.
  const window = normalizeWindow(
    body?.start_at !== undefined ? body.start_at : existing.start_at,
    body?.end_at !== undefined ? body.end_at : existing.end_at
  );
  if (body?.start_at !== undefined) patch.start_at = window.start_at;
  if (body?.end_at !== undefined) patch.end_at = window.end_at;

  const item = { ...existing, ...patch, updated_at: new Date().toISOString() };
  await contestRef(item.slug).set(item);
  return item;
}

export async function setContestStatus(slugRaw, statusRaw) {
  const status = String(statusRaw ?? "");
  if (!CONTEST_STATUSES.includes(status)) {
    throw httpError(400, `status must be one of ${CONTEST_STATUSES.join(", ")}`);
  }
  const existing = await getRealContest(slugRaw);
  const item = { ...existing, status, updated_at: new Date().toISOString() };
  await contestRef(item.slug).set(item);
  return item;
}

// A REAL contest doc or 404. The synthesized legacy contest deliberately falls
// through to 404 here: it has no doc, so every write path refuses it (F9 §6 —
// nothing legacy is ever rewritten).
async function getRealContest(slugRaw) {
  const slug = String(slugRaw ?? "").trim();
  if (!slug) throw httpError(404, "contest_not_found");
  const doc = await contestRef(slug).get();
  if (!doc.exists) throw httpError(404, "contest_not_found");
  return doc.data();
}

// ---- list ----------------------------------------------------------------------

export async function listContests({ includeArchived = false } = {}) {
  const snapshot = await contestsCol().limit(CONTESTS_QUERY_LIMIT).get();
  const realDocs = snapshot.docs.map((doc) => doc.data());
  const contests = realDocs
    .filter((contest) => includeArchived || contest.status !== "archived")
    .map((contest) => ({ ...contest, legacy: false }))
    .sort(
      (a, b) =>
        String(b.created_at || "").localeCompare(String(a.created_at || "")) ||
        String(a.slug || "").localeCompare(String(b.slug || ""))
    );
  // Legacy synthesis rides the LIST read (F9 §6, read-only): today's exam shows
  // up without migration — unless a real doc (future import/adoption) already
  // owns that slug.
  const legacy = await synthesizeLegacyContest();
  if (legacy && !realDocs.some((contest) => contest.slug === legacy.slug)) {
    contests.push(legacy);
  }
  return contests;
}

// ---- legacy-contest synthesis (F9 §6) --------------------------------------------
// Derived ON READ from the SETTINGS_ID="active" doc; never written anywhere.
// slug = settings.contest_slug || slug(contest_url) || "legacy". When neither
// source yields a slug, this deployment's legacy sessions were stamped
// contest_slug:"" — legacy_empty_slug:true makes scopedQuery translate to the
// `== ""` filter.
export async function synthesizeLegacyContest() {
  const settings = await getActiveSettings();
  if (!settings) return null;
  const storedSlug = String(settings.contest_slug || "") || legacySlugFromUrl(settings.contest_url);
  const slug = storedSlug || "legacy";
  return {
    slug,
    name: slug,
    legacy: true,
    legacy_empty_slug: !storedSlug,
    status: "open",
    listed: true,
    identity_mode: "legacy_username",
    identity_label: IDENTITY_LABEL_DEFAULT,
    access_code: null,
    start_at: settings.start_at || null,
    end_at: settings.end_at || null,
    end_at_updated_at: settings.end_at_updated_at || null,
    room_gate_enabled: Boolean(settings.room_gate_enabled),
    rooms: Array.isArray(settings.rooms) ? settings.rooms : [],
    created_at: null,
    updated_at: settings.updated_at || null,
    selection_done_at: null,
    evidence_retention_days: RETENTION_DAYS_DEFAULT,
    evidence_purged_at: null,
    db_purged_at: null,
    evidence_prefixes: null,
    last_export: null
  };
}

// ---- resolveContest (F9 §2.3.1) ----------------------------------------------------
// THE mandatory resolver for future candidate/contest-scoped paths: slug (or a
// req carrying ?contest= / {contest}) → contest doc, or 400 unknown_contest /
// 403 contest_not_open. The synthesized legacy contest resolves read-only.

export async function resolveContest(reqOrSlug, { requireOpen = true } = {}) {
  const slug = contestParamOf(reqOrSlug);
  if (!slug) throw httpError(400, "unknown_contest");
  let contest = null;
  const doc = await contestRef(slug).get();
  if (doc.exists) {
    contest = { ...doc.data(), legacy: false };
  } else {
    const legacy = await synthesizeLegacyContest();
    if (legacy && legacy.slug === slug) contest = legacy;
  }
  if (!contest) throw httpError(400, "unknown_contest");
  if (requireOpen && contest.status !== "open") throw httpError(403, "contest_not_open");
  return contest;
}

function contestParamOf(reqOrSlug) {
  if (typeof reqOrSlug === "string") return reqOrSlug.trim();
  const fromQuery = reqOrSlug?.query?.contest;
  if (fromQuery !== undefined && fromQuery !== null && String(fromQuery).trim() !== "") {
    return String(fromQuery).trim();
  }
  let body = reqOrSlug?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const fromBody = body?.contest;
  return fromBody === undefined || fromBody === null ? "" : String(fromBody).trim();
}

// ---- scopedQuery chokepoint (F9 §2.3.2) ----------------------------------------------
// The ONE place a contest_slug filter is appended (scopingLint.test.mjs pins
// this). Takes a RESOLVED contest (never a bare slug — that would skip
// resolveContest's existence/open checks) or the explicit ALL_CONTESTS
// sentinel for deliberate cross-contest reads.

export function scopedQuery(queryable, contest) {
  if (contest === ALL_CONTESTS) return queryable;
  if (!contest || typeof contest !== "object" || typeof contest.slug !== "string" || !contest.slug) {
    throw httpError(500, "scopedQuery requires a resolved contest or ALL_CONTESTS");
  }
  const filterValue = contest.legacy_empty_slug ? "" : contest.slug;
  return queryable.where("contest_slug", "==", filterValue);
}

// ---- access code ----------------------------------------------------------------------

function randomAccessCode() {
  let code = "";
  for (let i = 0; i < ACCESS_CODE_LENGTH; i++) {
    code += ACCESS_CODE_ALPHABET[_randomInt(ACCESS_CODE_ALPHABET.length)];
  }
  return code;
}

async function mintAccessCode() {
  for (let attempt = 0; attempt < ACCESS_CODE_MINT_ATTEMPTS; attempt++) {
    const code = randomAccessCode();
    const clash = await contestsCol().where("access_code", "==", code).limit(1).get();
    if (!clash.docs.length) return code;
  }
  // 34^6 ≈ 1.5B codes — exhausting 20 attempts means something is badly wrong;
  // fail loudly rather than loop.
  throw httpError(500, "access_code_mint_failed");
}

// ---- field validators -------------------------------------------------------------------

function normalizeIdentityLabel(raw) {
  if (raw === undefined || raw === null) return IDENTITY_LABEL_DEFAULT;
  const label = String(raw).trim();
  if (!label) throw httpError(400, "identity_label must be a non-empty string");
  if (label.length > IDENTITY_LABEL_MAX) throw httpError(400, `identity_label: max ${IDENTITY_LABEL_MAX} chars`);
  return label;
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") throw httpError(400, `${field} must be a boolean`);
  return value;
}

// F9 §2.1: clamp 1..30; non-integer garbage is a 400 (never silently defaulted —
// the admin asked for SOMETHING and we couldn't honor it).
function normalizeRetentionDays(raw) {
  if (raw === undefined || raw === null) return RETENTION_DAYS_DEFAULT;
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw httpError(400, "evidence_retention_days must be an integer");
  }
  return Math.min(RETENTION_DAYS_MAX, Math.max(RETENTION_DAYS_MIN, num));
}

// Window fields are OPTIONAL in draft (the publish gate enforces presence at
// S-D); each provided value must parse, and when both are set start < end —
// the same rule adminSaveSettings enforces today.
function normalizeWindow(startRaw, endRaw) {
  const start_at = parseWindowDate(startRaw, "start_at");
  const end_at = parseWindowDate(endRaw, "end_at");
  if (start_at && end_at && Date.parse(start_at) >= Date.parse(end_at)) {
    throw httpError(400, "Start time must be before end time.");
  }
  return { start_at, end_at };
}

function parseWindowDate(raw, field) {
  if (raw === undefined || raw === null || raw === "") return null;
  const ms = Date.parse(String(raw));
  if (!Number.isFinite(ms)) throw httpError(400, `${field} must be a valid timestamp`);
  return new Date(ms).toISOString();
}

// ---- small local helpers (kept module-local: importing them from handler.mjs
// would make the dependency circular) ------------------------------------------------------

// Mirrors handler.mjs sanitizeSegment + contestSlugFromUrl for the ONE legacy
// derivation above: last non-empty path segment of contest_url, doc-id safe.
function legacySlugFromUrl(contestUrl) {
  if (!contestUrl) return "";
  let pathname;
  try {
    pathname = new URL(String(contestUrl)).pathname;
  } catch {
    return "";
  }
  const segments = String(pathname).split("/").filter(Boolean);
  if (!segments.length) return "";
  const cleaned = String(segments[segments.length - 1]).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  if (cleaned === "" || /^\.+$/.test(cleaned)) return "_";
  return cleaned;
}

function isAlreadyExists(err) {
  return err?.code === 6 || /ALREADY_EXISTS/i.test(String(err?.message || ""));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
