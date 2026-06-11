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
import { randomBytes, randomInt } from "node:crypto";
import { SUPPORTED_LANGUAGES } from "./problems.mjs";
import {
  normalizeProblemEntries,
  normalizeTemplateCameraRecording,
  normalizeTemplateEnforcement
} from "./templates.mjs";
import { contestProblemEntries } from "./contestProblems.mjs";

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
const ACCESS_CODE_PATTERN = new RegExp(`^[${ACCESS_CODE_ALPHABET}]{${ACCESS_CODE_LENGTH}}$`);

// S-D: per-contest invigilator portal token (vision §2.7) — 18 random bytes,
// base64url (24 chars, URL/doc-id safe). Minted at create, regenerate-able;
// the GLOBAL invigilator password is demoted to Aerele-staff fallback.
const CONTESTS_ROOMS_LIMIT = 50; // mirrors handler CONFIGURED_ROOMS_LIMIT

function mintInvigilatorKey() {
  return randomBytes(18).toString("base64url");
}

// Cross-contest reads must OPT IN with this sentinel — scopedQuery never
// defaults to unscoped (F9 §2.3.2). A Symbol so no JSON payload can forge it.
export const ALL_CONTESTS = Symbol("ALL_CONTESTS");

// Wired by handler.mjs at module load with a Firestore GETTER (not the
// instance) so the __setClientsForTest fakes propagate here too — the exact
// configureProblemStore pattern.
let store = null;
export function configureContestStore({ getFirestore, collection, settingsCollection, settingsId, dataCollections }) {
  store = { getFirestore, collection, settingsCollection, settingsId, dataCollections: dataCollections || [] };
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
  // S-I §1.3/§1.4: ordered problems[] + the snapshot-copied template defaults.
  // Shape-validation only here — PUBLISHED-state checks (and the template
  // resolution itself) live in the handler, which has the problem bank.
  const problems = normalizeContestProblems(body?.problems);
  const templateSlug = body?.template_slug ? String(body.template_slug) : null;
  const cameraRecording = normalizeTemplateCameraRecording(body?.camera_recording);
  const enforcement = normalizeTemplateEnforcement(body?.enforcement);
  const languages = normalizeContestLanguages(body?.languages);
  const roomGateEnabled = body?.room_gate_enabled === undefined
    ? false
    : requireBoolean(body.room_gate_enabled, "room_gate_enabled");
  const rooms = normalizeContestRooms(body?.rooms);
  // W4: an admin-ASSIGNED code is validated + clash-checked exactly like
  // setContestAccessCode; absent/blank -> mint a random one (collision-checked
  // against ALL contests, stricter than the open-only rule, kept as-is).
  const hasCustomCode = body?.access_code !== undefined && body?.access_code !== null
    && String(body.access_code).trim() !== "";
  const accessCode = hasCustomCode ? normalizeCustomAccessCode(body.access_code) : await mintAccessCode();
  if (hasCustomCode) await requireCodeFreeAmongOpenContests(accessCode, null);
  const legacy = await synthesizeLegacyContest();
  const now = new Date().toISOString();

  // Atomic .create() decides slug ownership — two concurrent creates of the
  // same name can never overwrite each other; the loser walks to the next
  // suffix. The synthesized legacy slug is skipped outright so a new contest
  // can never shadow today's legacy exam data — and so is any HISTORIC legacy
  // slug (wave-4 fix): sessions/submissions/alerts from earlier exam runs
  // carry contest_slug values derived from old contest_url settings, which
  // look exactly like slugify output. Adopting one would resolve that whole
  // old population onto the new contest doc (contestForSession, scopedQuery).
  for (let n = 1; n <= SLUG_COLLISION_LIMIT; n++) {
    const slug = n === 1 ? baseSlug : `${baseSlug}-${n}`;
    if (legacy && legacy.slug === slug) continue;
    if (await slugCarriesOrphanedData(slug)) continue;
    const item = {
      slug,
      name,
      status: "draft",
      listed,
      identity_mode: "person",
      identity_label: identityLabel,
      access_code: accessCode,
      invigilator_key: mintInvigilatorKey(),
      start_at: window.start_at,
      end_at: window.end_at,
      end_at_updated_at: null, // S5 semantics move per-contest at S-C/S-D
      // S-I: the contest OWNS these from the moment it exists — template edits
      // after instantiation can never reach them (snapshot semantics, §1.4.1).
      problems,
      template_slug: templateSlug,
      camera_recording: cameraRecording,
      enforcement,
      languages,
      room_gate_enabled: roomGateEnabled,
      rooms,
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

// Does any data collection (sessions / submissions / alerts — wired by
// handler.mjs) already carry this candidate slug? At create time no real
// contest doc owns it (that would be an ALREADY_EXISTS), so any hit is an
// ORPHANED legacy population the new contest must never absorb. The probe
// goes through scopedQuery so the scoping lint keeps its single chokepoint;
// the synthetic `{ slug }` scope is exactly "this candidate slug".
async function slugCarriesOrphanedData(slug) {
  for (const name of store.dataCollections) {
    const snapshot = await scopedQuery(db().collection(name), { slug }).limit(1).get();
    if (snapshot.docs.length) return true;
  }
  return false;
}

// ---- update / status ----------------------------------------------------------

// Display/settings edits only. THE rule: a rename NEVER changes the slug — the
// slug is embedded in doc ids, GCS paths and links the moment a session exists.
// identity_mode, access_code and status are not updatable here (status has its
// own endpoint; the other two are mint-once).
export async function updateContest(slugRaw, body) {
  const existing = await getRealContest(slugRaw);
  if (body?.identity_mode !== undefined) throw httpError(400, "identity_mode is immutable");
  if (body?.access_code !== undefined) throw httpError(400, "use /api/admin/contest-set-code to change the test code");
  // S-D: secrets are mint-only — /api/admin/contest-regenerate is the ONLY
  // writer, so an admin typo can never plant a guessable key.
  if (body?.invigilator_key !== undefined) throw httpError(400, "invigilator_key cannot be edited");
  if (body?.status !== undefined) throw httpError(400, "use /api/admin/contest-status to change status");
  if (body?.template_slug !== undefined) throw httpError(400, "template_slug is display-only provenance and cannot be edited");

  const patch = {};
  // S-I: problems[] edits (shape-validated; the open-contest confirm/submission
  // rules run in the handler BEFORE this is called) + the snapshot fields.
  if (body?.problems !== undefined) patch.problems = normalizeContestProblems(body.problems);
  if (body?.camera_recording !== undefined) patch.camera_recording = normalizeTemplateCameraRecording(body.camera_recording);
  if (body?.enforcement !== undefined) patch.enforcement = normalizeTemplateEnforcement(body.enforcement);
  if (body?.languages !== undefined) patch.languages = normalizeContestLanguages(body.languages);
  if (body?.room_gate_enabled !== undefined) patch.room_gate_enabled = requireBoolean(body.room_gate_enabled, "room_gate_enabled");
  // S-D: per-contest rooms list (vision §2.12) — same sanitize/dedupe rules as
  // the legacy settings rooms editor.
  if (body?.rooms !== undefined) patch.rooms = normalizeContestRooms(body.rooms);
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
  // S-I publish gate (vision §2.7): a contest can only OPEN with ≥1 problem.
  if (status === "open" && contestProblemEntries(existing).length === 0) {
    throw httpError(400, "contest_has_no_problems");
  }
  // W4 activation gate: two OPEN contests must never share a test code (the
  // public resolver would go ambiguous). The admin changes one code first
  // (set-code or regenerate), then opens.
  if (status === "open" && existing.access_code) {
    const clash = await findOpenContestWithCode(existing.access_code, existing.slug);
    if (clash) {
      throw httpError(
        409,
        `Cannot open this contest: its test code ${existing.access_code} is already used by the open contest "${clash.name}" (${clash.slug}). Change this contest's test code first, then open it.`
      );
    }
  }
  const item = { ...existing, status, updated_at: new Date().toISOString() };
  await contestRef(item.slug).set(item);
  return item;
}

// W4: set a CUSTOM test code (the admin's chosen handout code). Normalization
// and shape mirror the minted codes — anything outside ACCESS_CODE_PATTERN
// would be untypeable on the candidate landing page (candidateRouting.ts pins
// the same 6-char alphabet client-side). The synthesized legacy contest 404s
// via getRealContest like every other write path.
export async function setContestAccessCode(slugRaw, codeRaw) {
  const existing = await getRealContest(slugRaw);
  const code = normalizeCustomAccessCode(codeRaw);
  await requireCodeFreeAmongOpenContests(code, existing.slug);
  const item = { ...existing, access_code: code, updated_at: new Date().toISOString() };
  await contestRef(item.slug).set(item);
  return item;
}

// S-D: regenerate one of the contest's two distribution secrets. The old value
// dies instantly — printed handouts/links go stale by design (that is the
// point of regenerating). Legacy contest -> 404 via getRealContest.
export async function regenerateContestSecret(slugRaw, fieldRaw) {
  const field = String(fieldRaw ?? "");
  if (field !== "access_code" && field !== "invigilator_key") {
    throw httpError(400, "field must be access_code or invigilator_key");
  }
  const existing = await getRealContest(slugRaw);
  const patch = field === "access_code"
    ? { access_code: await mintAccessCode() }
    : { invigilator_key: mintInvigilatorKey() };
  const item = { ...existing, ...patch, updated_at: new Date().toISOString() };
  await contestRef(item.slug).set(item);
  return item;
}

// S-D (vision §10.3): the PUBLIC access-code resolver behind the landing page.
// Codes only resolve OPEN contests — a draft/archived code is indistinguishable
// from an unknown one (no contest enumeration via lifecycle state). Normalizes
// case so lab machines can type lowercase.
export async function resolveAccessCode(codeRaw) {
  const code = String(codeRaw ?? "").trim().toUpperCase();
  if (!ACCESS_CODE_PATTERN.test(code)) throw httpError(400, "invalid_code");
  const snapshot = await contestsCol().where("access_code", "==", code).limit(2).get();
  const match = snapshot.docs.map((doc) => doc.data()).find((contest) => contest.status === "open");
  if (!match) throw httpError(404, "code_not_found");
  return { slug: match.slug, name: match.name || match.slug };
}

// S-D: per-contest exam-time (S5 semantics moved onto the contest doc) —
// mirrors the legacy /api/admin/exam-time contract field-for-field: exactly
// one of end_at | extend_minutes | end_now, schedule must already be set,
// the end must stay after the start, end_at_updated_at stamps the edit.
// The HANDLER ends live sessions on end_now (it owns the session collection).
export async function applyContestExamTime(slugRaw, body) {
  const provided = ["end_at", "extend_minutes", "end_now"].filter(
    (key) => body?.[key] !== undefined && body[key] !== null && body[key] !== ""
  );
  if (provided.length !== 1) throw httpError(400, "Provide exactly one of end_at, extend_minutes, end_now");
  const field = provided[0];

  const existing = await getRealContest(slugRaw);
  if (!existing.start_at || !existing.end_at) {
    throw httpError(400, "Contest schedule is not configured yet.");
  }
  const startMs = Date.parse(existing.start_at);
  const currentEndMs = Date.parse(existing.end_at);
  const now = new Date().toISOString();

  let newEndMs;
  if (field === "end_now") {
    if (body.end_now !== true) throw httpError(400, "end_now must be true");
    newEndMs = Date.parse(now);
  } else if (field === "end_at") {
    newEndMs = Date.parse(String(body.end_at));
    if (!Number.isFinite(newEndMs)) throw httpError(400, "end_at must be a valid ISO 8601 date");
  } else {
    const delta = Number(body.extend_minutes);
    if (!Number.isFinite(delta) || delta === 0) throw httpError(400, "extend_minutes must be a non-zero number");
    if (!Number.isFinite(currentEndMs)) throw httpError(400, "Stored end time is invalid; set an absolute end_at instead.");
    newEndMs = currentEndMs + delta * 60_000;
  }
  if (!Number.isFinite(startMs) || newEndMs <= startMs) {
    throw httpError(400, "End time must be after the start time.");
  }
  const item = {
    ...existing,
    end_at: new Date(newEndMs).toISOString(),
    end_at_updated_at: now,
    updated_at: now
  };
  await contestRef(item.slug).set(item);
  return { contest: item, field, now };
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
    invigilator_key: null,
    start_at: settings.start_at || null,
    end_at: settings.end_at || null,
    end_at_updated_at: settings.end_at_updated_at || null,
    room_gate_enabled: Boolean(settings.room_gate_enabled),
    rooms: Array.isArray(settings.rooms) ? settings.rooms : [],
    // S-I: the legacy single-problem assignment rides the synthesized doc so
    // contestProblemEntries (the §1.3 shim) reads it like any other contest.
    problem_id: String(settings.problem_id || ""),
    template_slug: null,
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

// W4: custom-code normalization — uppercase + strip ALL whitespace (the same
// cleanup the landing page applies to what candidates type), then the mint
// pattern: exactly 6 chars from A-Z / 2-9 (0 and 1 are never used).
function normalizeCustomAccessCode(raw) {
  const code = String(raw ?? "").toUpperCase().replace(/\s+/g, "");
  if (!ACCESS_CODE_PATTERN.test(code)) {
    throw httpError(400, "Test code must be exactly 6 characters using letters A-Z or digits 2-9 (0 and 1 are never used).");
  }
  return code;
}

// W4 uniqueness rule: a test code must be unique AMONG OPEN ("active")
// contests — resolveAccessCode picks among status:"open" matches, so two open
// holders would make the public resolver ambiguous. Draft/archived contests
// MAY hold a clashing code; the OPEN transition re-checks (setContestStatus).
// Status is filtered in memory (like resolveAccessCode) so no composite
// Firestore index is needed.
async function findOpenContestWithCode(code, exceptSlug) {
  if (!code) return null;
  const snapshot = await contestsCol().where("access_code", "==", code).limit(25).get();
  return snapshot.docs
    .map((doc) => doc.data())
    .find((contest) => contest.status === "open" && contest.slug !== exceptSlug) || null;
}

async function requireCodeFreeAmongOpenContests(code, exceptSlug) {
  const clash = await findOpenContestWithCode(code, exceptSlug);
  if (clash) {
    throw httpError(409, `Test code ${code} is already used by the open contest "${clash.name}" (${clash.slug}). Choose a different code.`);
  }
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

// S-I: contests may legitimately hold ZERO problems while draft (the publish
// gate blocks opening) — so unlike templates, an absent/empty list is [].
function normalizeContestProblems(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw httpError(400, "problems must be an array");
  if (!raw.length) return [];
  const checked = normalizeProblemEntries(raw);
  if (!checked.ok) throw httpError(400, checked.error);
  return checked.entries;
}

// S-I: per-contest language allow-list (intersected with per-problem languages
// at serve time). Absent -> all supported; explicit garbage -> 400.
function normalizeContestLanguages(raw) {
  if (raw === undefined || raw === null) return [...SUPPORTED_LANGUAGES];
  if (!Array.isArray(raw)) throw httpError(400, "languages must be an array");
  const languages = [...new Set(raw.map(String))];
  if (!languages.length) throw httpError(400, "languages must be non-empty");
  for (const language of languages) {
    if (!SUPPORTED_LANGUAGES.includes(language)) throw httpError(400, `unsupported language: ${language}`);
  }
  return languages;
}

// S-D rooms: mirrors handler.mjs sanitizeRoom + normalizeRooms (trim, strip
// non [a-zA-Z0-9 ._-], 80-char cap, case-insensitive dedupe, 50-room cap) so a
// contest-doc room label always equals the form sessions store it in. Absent
// -> [] (a contest may run without configured rooms); non-array garbage -> 400.
function normalizeContestRooms(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw httpError(400, "rooms must be an array");
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const room = String(item).trim().replace(/[^a-zA-Z0-9 ._-]/g, "").slice(0, 80);
    if (!room || seen.has(room.toLowerCase())) continue;
    seen.add(room.toLowerCase());
    out.push(room);
    if (out.length >= CONTESTS_ROOMS_LIMIT) break;
  }
  return out;
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
