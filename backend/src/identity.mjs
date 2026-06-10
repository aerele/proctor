// backend/src/identity.mjs
// S-C — THE identity core (vision §7 row 3, AMENDED person layer).
//
// Specs:
//   docs/superpowers/specs/2026-06-10-f10-product-vision.md
//     §2.2 College + the canonicalization gate (LOCKED — the only enforceable
//       moment to stop spelling drift from forking every person in a drive)
//     §2.3 Person — durable (college, unique_id) identity, the multi-round spine
//     §2.4 identity chain (username_norm = person_id under identity_mode:"person")
//     §2.8 roster upload validation ORDER (LOCKED)
//     §2.9 Enrollment — stable person × contest row
//   docs/superpowers/specs/2026-06-10-f9-identity-data-lifecycle-design.md
//     D5 (duplicate hard-reject on final-norm form), D16 (proctor_admin_audit),
//     D17 (roster meta = roster_meta::{slug}; entry id SCHEME unchanged:
//     v{version}:{idnorm} — under person mode the idnorm IS the person_id, so
//     two colleges sharing a roll number get two distinct entry docs)
//
// This module owns proctor_colleges / proctor_persons / proctor_enrollments and
// the PER-CONTEST roster pipeline. Only contests with identity_mode:"person"
// ever reach it: the legacy global-roster path in handler.mjs stays bit-for-bit
// (the S-C canary), and handler.mjs routes here only when an upload names a
// real person-mode contest.
//
// GLOBAL RULE (vision §2.1): composite ids are NEVER parsed back apart — their
// components are always stored as fields alongside them.
import { randomUUID } from "node:crypto";
import { scopedQuery } from "./contests.mjs";

export const PERSON_ID_SEPARATOR = "--";

// Same bounds as the legacy roster path (handler.mjs) — kept as local copies so
// this module has no circular dependency on handler.mjs.
const ROSTER_LIMIT = 5000;
const ROSTER_COLUMNS_LIMIT = 30;
const ROSTER_CELL_MAX = 200;
const COLLEGES_QUERY_LIMIT = 500;
const ENROLLMENTS_QUERY_LIMIT = 20000;
const ROSTER_ENTRY_LOOKUP_LIMIT = 10;
const WRITE_CONCURRENCY = 20;

// Fields an admin may map roster columns onto for PERSON contests. No
// hackerrank_username here — F9 D2 deletes it for new contests; "college" is
// the S-C compulsory addition.
const PERSON_MAPPABLE_FIELDS = ["name", "email", "roll_number", "room", "college"];

// Wired by handler.mjs at module load with a Firestore GETTER (not the
// instance) so the __setClientsForTest fakes propagate here too — the exact
// configureContestStore pattern.
let store = null;
export function configureIdentityStore({ getFirestore, collections }) {
  store = { getFirestore, collections };
}

function db() {
  if (!store) throw httpError(500, "identity store is not configured");
  return store.getFirestore();
}

function col(name) {
  return db().collection(store.collections[name]);
}

// ---- normalization (F9 §1.1) ------------------------------------------------
// identityNorm = sanitizeSegment ∘ normalizeUniqueId — both mirror the frozen
// handler.mjs implementations exactly (pinned by the golden tests). The person
// id is doc-id/GCS-path safe BY CONSTRUCTION: each component is sanitized and
// the "--" separator is inside the safe charset.

export function normalizeUniqueId(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, "");
}

export function sanitizeSegment(value) {
  const cleaned = String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  if (cleaned === "" || /^\.+$/.test(cleaned)) return "_";
  return cleaned;
}

export function identityNorm(value) {
  return sanitizeSegment(normalizeUniqueId(value));
}

export function personIdOf(collegeNorm, uniqueIdNorm) {
  return `${collegeNorm}${PERSON_ID_SEPARATOR}${uniqueIdNorm}`;
}

export function enrollmentIdOf(contestSlug, personId) {
  return `${contestSlug}::${personId}`;
}

export function rosterMetaIdFor(contestSlug) {
  return `roster_meta::${contestSlug}`;
}

export function rosterEntryIdFor(version, personId) {
  return `v${version}:${personId}`;
}

// ---- per-contest roster meta -------------------------------------------------

function rosterMetaRefFor(contestSlug) {
  return col("settings").doc(rosterMetaIdFor(contestSlug));
}

// The ACTIVE per-contest roster meta, or null (no roster → person_id:null
// sessions, vision §2.4 no-roster rule).
export async function getContestRosterMeta(contest) {
  const doc = await rosterMetaRefFor(contest.slug).get();
  const meta = doc.exists ? doc.data() : null;
  return meta && meta.configured ? meta : null;
}

// GET /api/admin/roster?contest= summary (meta only, never the rows).
export async function getContestRosterSummary(contest) {
  const meta = await getContestRosterMeta(contest);
  if (!meta) return { configured: false, contest: contest.slug };
  return {
    configured: true,
    contest: contest.slug,
    count: meta.count || 0,
    unique_id_column: meta.unique_id_column || "",
    college_column: meta.college_column || "",
    column_mapping: meta.column_mapping || {},
    columns: meta.columns || [],
    updated_at: meta.updated_at || ""
  };
}

// ACTIVE-version roster entries for a typed unique id — ALL colleges that carry
// it in this contest (0 = not on roster, 1 = resolved, 2+ = the ambiguity
// picker). Sorted by college_norm for a deterministic picker order.
export async function findContestRosterEntries(meta, uniqueIdValue) {
  const norm = identityNorm(uniqueIdValue);
  if (!norm || norm === "_") return [];
  const snapshot = await col("roster")
    .where("roster_version", "==", meta.version)
    .where("unique_id_norm", "==", norm)
    .limit(ROSTER_ENTRY_LOOKUP_LIMIT)
    .get();
  return snapshot.docs
    .map((doc) => doc.data())
    .filter((entry) => entry.roster_version === meta.version && entry.unique_id_norm === norm)
    .sort((a, b) => String(a.college_norm || "").localeCompare(String(b.college_norm || "")));
}

// All known colleges (for the map-or-confirm UI + the ambiguity picker labels).
export async function listColleges() {
  const snapshot = await col("colleges").limit(COLLEGES_QUERY_LIMIT).get();
  return snapshot.docs
    .map((doc) => doc.data())
    .map((college) => ({ college_norm: college.college_norm, name: college.name || college.college_norm }))
    .sort((a, b) => a.college_norm.localeCompare(b.college_norm));
}

// ---- the per-contest roster upload pipeline ----------------------------------
//
// VALIDATION ORDER IS LOCKED (vision §2.8):
//   1. college column missing / blank cells → 400, whole file rejected
//   2. college canonicalization gate — map-or-confirm NEW college names
//   3. duplicate (college_norm, unique_id_norm) on FINAL-norm form → 400
//      duplicate_unique_ids with row numbers, whole file rejected
//   4. same unique_id under DIFFERENT colleges → allowed with warning
//   5. blank-id rows → skip-with-report
// Row numbers in every reject/skip payload are 1-BASED DATA rows (header
// excluded) — the numbers an admin counts when fixing the file.

export async function saveContestRoster(contest, body, actor = {}) {
  if (body.clear === true) return clearContestRoster(contest);

  const columns = Array.isArray(body.columns)
    ? body.columns.map((c) => String(c).trim().slice(0, ROSTER_CELL_MAX)).filter(Boolean)
    : [];
  if (!columns.length) throw httpError(400, "columns must be a non-empty array");
  if (columns.length > ROSTER_COLUMNS_LIMIT) throw httpError(400, `max ${ROSTER_COLUMNS_LIMIT} columns`);
  const uniqueIdColumn = String(body.unique_id_column ?? "").trim();
  if (!uniqueIdColumn || !columns.includes(uniqueIdColumn)) {
    throw httpError(400, "unique_id_column must be one of columns");
  }
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || !rows.length) throw httpError(400, "rows must be a non-empty array");
  if (rows.length > ROSTER_LIMIT) throw httpError(400, `max ${ROSTER_LIMIT} roster rows`);

  // Only known identity fields may be mapped, and only onto known columns.
  const mapping = {};
  for (const [field, column] of Object.entries(body.column_mapping || {})) {
    if (!PERSON_MAPPABLE_FIELDS.includes(field)) continue;
    const mapped = String(column || "").trim();
    if (mapped && columns.includes(mapped)) mapping[field] = mapped;
  }

  // (1) COMPULSORY college column: an explicit body.college_column, the mapped
  // "college" field, or a column literally named "college" (case-insensitive).
  const collegeColumn = resolveCollegeColumn(body, mapping, columns);
  if (!collegeColumn) throw httpError(400, "college_column_required");
  mapping.college = collegeColumn;

  const projected = rows.map((row, index) => {
    const fields = {};
    for (const column of columns) {
      fields[column] = String(row?.[column] ?? "").trim().slice(0, ROSTER_CELL_MAX);
    }
    return { row: index + 1, fields, uniqueId: fields[uniqueIdColumn], college: fields[collegeColumn] };
  });

  // (1) blank college cell anywhere → whole file rejected (LOCKED).
  const blankCollegeRows = projected.filter((r) => !r.college).map((r) => r.row);
  if (blankCollegeRows.length) throw httpError(400, "college_required", { rows: blankCollegeRows });

  // (2) canonicalization gate — distinct CSV college strings grouped by FINAL
  // norm, matched against proctor_colleges. Exact-norm match links silently;
  // anything else needs an explicit map-or-create resolution from the admin.
  const groups = new Map(); // norm → { college_norm, name (first raw), names, rows }
  for (const r of projected) {
    const norm = identityNorm(r.college);
    if (!groups.has(norm)) groups.set(norm, { college_norm: norm, name: r.college, names: [], rows: 0 });
    const group = groups.get(norm);
    if (!group.names.includes(r.college)) group.names.push(r.college);
    group.rows += 1;
  }
  const existingCollegeNorms = new Set();
  await mapWithConcurrency([...groups.keys()], WRITE_CONCURRENCY, async (norm) => {
    const doc = await col("colleges").doc(norm).get();
    if (doc.exists) existingCollegeNorms.add(norm);
  });
  const resolutions = body.college_resolutions && typeof body.college_resolutions === "object"
    ? body.college_resolutions
    : {};
  const resolvedNorms = new Map(); // group norm → final college_norm
  const collegesToCreate = new Map(); // final norm → display name
  const unresolved = [];
  for (const group of groups.values()) {
    if (existingCollegeNorms.has(group.college_norm)) {
      resolvedNorms.set(group.college_norm, group.college_norm);
      continue;
    }
    const resolution = resolutions[group.college_norm];
    if (resolution && resolution.action === "map") {
      const target = identityNorm(String(resolution.college_norm || ""));
      const targetDoc = await col("colleges").doc(target).get();
      if (!targetDoc.exists) {
        throw httpError(400, `college_resolutions["${group.college_norm}"]: unknown target college`);
      }
      resolvedNorms.set(group.college_norm, target);
    } else if (resolution && resolution.action === "create") {
      resolvedNorms.set(group.college_norm, group.college_norm);
      collegesToCreate.set(group.college_norm, String(resolution.name || group.name).trim() || group.name);
    } else {
      unresolved.push(group);
    }
  }
  if (unresolved.length) {
    // PREVIEW response — the admin UI renders the map-or-confirm panel and
    // re-posts with college_resolutions. NOTHING has been written.
    return {
      ok: false,
      needs_college_confirmation: true,
      new_colleges: unresolved
        .map(({ college_norm, name, names, rows: count }) => ({ college_norm, name, names, rows: count }))
        .sort((a, b) => a.college_norm.localeCompare(b.college_norm)),
      known_colleges: await listColleges()
    };
  }

  // (5) blank-id rows skip first so (3) keys on real candidates only.
  const skipped = [];
  const candidates = [];
  for (const r of projected) {
    if (!r.uniqueId) {
      skipped.push({ row: r.row, reason: "empty_unique_id" });
      continue;
    }
    const collegeNorm = resolvedNorms.get(identityNorm(r.college));
    const uniqueIdNorm = identityNorm(r.uniqueId);
    candidates.push({ ...r, collegeNorm, uniqueIdNorm, personId: personIdOf(collegeNorm, uniqueIdNorm) });
  }
  if (!candidates.length) throw httpError(400, "no valid roster rows (every row was skipped)");

  // (3) duplicate (college_norm, unique_id_norm) on the FINAL-norm form →
  // HARD-reject the whole upload with row numbers (LOCKED; resolves F9 Q1 —
  // a silently-kept first row would pre-fill the WRONG student's identity).
  const firstByPersonId = new Map();
  const duplicates = [];
  for (const c of candidates) {
    const first = firstByPersonId.get(c.personId);
    if (first) {
      duplicates.push({ row: c.row, college: c.college, unique_id: c.uniqueId, conflicts_with_row: first.row });
    } else {
      firstByPersonId.set(c.personId, c);
    }
  }
  if (duplicates.length) throw httpError(400, "duplicate_unique_ids", { duplicates });

  // (4) same unique_id under DIFFERENT colleges → allowed, warned (veto-able
  // default): those candidates get the college picker at login.
  const collegesByIdNorm = new Map();
  for (const c of candidates) {
    if (!collegesByIdNorm.has(c.uniqueIdNorm)) collegesByIdNorm.set(c.uniqueIdNorm, new Set());
    collegesByIdNorm.get(c.uniqueIdNorm).add(c.collegeNorm);
  }
  const ambiguousIds = [...collegesByIdNorm.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([idNorm, set]) => ({ unique_id_norm: idNorm, colleges: [...set].sort() }))
    .sort((a, b) => a.unique_id_norm.localeCompare(b.unique_id_norm));

  // ---- writes (entries first, meta LAST — a crashed upload never activates a
  // half-written version; mirrors the legacy path's discipline) ----
  const now = new Date().toISOString();
  const version = randomUUID();
  const unique = [...firstByPersonId.values()];

  const collegesCreated = [];
  for (const [norm, name] of collegesToCreate) {
    try {
      await col("colleges").doc(norm).create({ college_norm: norm, name, created_at: now, source: "roster_upload" });
      collegesCreated.push(norm);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error; // concurrent create: already linked
    }
  }

  const personStats = { created: 0, updated: 0 };
  const identityColumns = new Set([uniqueIdColumn, ...Object.values(mapping)]);
  await mapWithConcurrency(unique, WRITE_CONCURRENCY, async (c) => {
    const result = await upsertPerson(c, { contest, mapping, identityColumns, version, now, actor });
    personStats[result] += 1;
  });

  await mapWithConcurrency(unique, WRITE_CONCURRENCY, async (c) => {
    await col("roster").doc(rosterEntryIdFor(version, c.personId)).set({
      unique_id: c.uniqueId,
      unique_id_norm: c.uniqueIdNorm,
      college: c.college,
      college_norm: c.collegeNorm,
      person_id: c.personId,
      contest_slug: contest.slug,
      roster_version: version,
      fields: c.fields,
      created_at: now
    });
  });

  const enrollmentStats = await reconcileEnrollments(contest, unique, firstByPersonId, { version, now });

  // Meta written LAST: only now does the new version become the active roster.
  await rosterMetaRefFor(contest.slug).set({
    configured: true,
    contest_slug: contest.slug,
    version,
    unique_id_column: uniqueIdColumn,
    college_column: collegeColumn,
    column_mapping: mapping,
    columns,
    count: unique.length,
    updated_at: now
  });

  // Derived read-only colleges list on the contest doc (vision §2.7).
  const collegeNorms = [...new Set(unique.map((c) => c.collegeNorm))].sort();
  await col("contests").doc(contest.slug).set({ colleges: collegeNorms, updated_at: now }, { merge: true });

  return {
    ok: true,
    configured: true,
    contest: contest.slug,
    count: unique.length,
    skipped,
    ambiguous_ids: ambiguousIds,
    colleges_created: collegesCreated.sort(),
    persons: personStats,
    enrollments: enrollmentStats
  };
}

// Person upsert — THE multi-round linking mechanism (vision §2.3): the
// deterministic person_id makes any future CSV with the same (college,
// unique_id) resolve to the same person. Profile fields are latest-wins;
// identity components are immutable (they ARE the doc id). Returns
// "created" | "updated".
async function upsertPerson(c, { contest, mapping, identityColumns, version, now, actor }) {
  const mappedField = (field) => (mapping[field] ? c.fields[mapping[field]] || "" : "");
  const extra = {};
  for (const [column, value] of Object.entries(c.fields)) {
    if (!identityColumns.has(column)) extra[column] = value;
  }
  const profile = { name: mappedField("name"), email: mappedField("email"), extra };

  const ref = col("persons").doc(c.personId);
  const doc = await ref.get();
  if (!doc.exists) {
    await ref.set({
      person_id: c.personId,
      college_norm: c.collegeNorm,
      unique_id: c.uniqueId,
      unique_id_norm: c.uniqueIdNorm,
      ...profile,
      created_at: now,
      updated_at: now,
      created_from: { contest_slug: contest.slug, roster_version: version },
      merged_into: null // alias pointer reserved day one (vision §8.3)
    });
    return "created";
  }

  const existing = doc.data();
  // Gap fix (vision §2.3): silent cross-round renames leave an audit trail.
  const changes = {};
  if ((existing.name || "") !== profile.name) changes.name = { from: existing.name || "", to: profile.name };
  if ((existing.email || "") !== profile.email) changes.email = { from: existing.email || "", to: profile.email };
  await ref.set({
    ...existing,
    unique_id: c.uniqueId, // display form, latest wins
    ...profile,
    updated_at: now
  });
  if (Object.keys(changes).length) {
    await writeAudit({
      action: "person_profile_updated",
      person_id: c.personId,
      contest_slug: contest.slug,
      roster_version: version,
      changes
    }, actor, now);
  }
  return "updated";
}

// Enrollment reconciliation (vision §2.8 re-upload removal semantics + §2.9):
// new persons get enrollments minted; previously-enrolled persons missing from
// this upload are marked removed (KEPT, never deleted — audit + history);
// re-added persons reactivate the SAME doc. An in-flight session for a removed
// person continues and raises a roster_removed_mid_exam admin alert.
async function reconcileEnrollments(contest, unique, byPersonId, { version, now }) {
  const snapshot = await scopedQuery(col("enrollments"), contest).limit(ENROLLMENTS_QUERY_LIMIT).get();
  const existing = new Map(snapshot.docs.map((doc) => [doc.data().person_id, doc.data()]));
  const stats = { created: 0, reactivated: 0, removed: 0 };

  await mapWithConcurrency(unique, WRITE_CONCURRENCY, async (c) => {
    const ref = col("enrollments").doc(enrollmentIdOf(contest.slug, c.personId));
    const current = existing.get(c.personId);
    if (!current) {
      await ref.set({
        contest_slug: contest.slug,
        person_id: c.personId,
        college_norm: c.collegeNorm,
        status: "active",
        source: "csv",
        selection_status: "none",
        selection_updated_at: null,
        selection_by: null,
        final_snapshot: null,
        created_at: now
      });
      stats.created += 1;
    } else if (current.status === "removed") {
      await ref.set({ ...current, status: "active", removed_at: null, reactivated_at: now });
      stats.reactivated += 1;
    }
  });

  for (const [personId, enrollment] of existing) {
    if (byPersonId.has(personId) || enrollment.status === "removed") continue;
    await col("enrollments").doc(enrollmentIdOf(contest.slug, personId)).set({
      ...enrollment, status: "removed", removed_at: now
    });
    stats.removed += 1;
    await raiseRosterRemovedAlert(contest, enrollment, version, now);
  }
  return stats;
}

// roster_removed_mid_exam (vision §2.8): the session CONTINUES — removal is a
// human call, never an auto-kick. Deterministic alert id (idempotent per
// upload version), same field shape the alerts console already renders.
async function raiseRosterRemovedAlert(contest, enrollment, version, now) {
  const snapshot = await scopedQuery(
    col("sessions").where("username_norm", "==", enrollment.person_id),
    contest
  ).limit(ROSTER_ENTRY_LOOKUP_LIMIT).get();
  const live = snapshot.docs.map((doc) => doc.data()).find((s) => s.status && s.status !== "ended");
  if (!live) return;
  const id = `proctor:roster_removed_mid_exam:${enrollment.person_id}:${contest.slug}:${version}`;
  await col("alerts").doc(id).set({
    id,
    source: "proctor",
    type: "roster_removed_mid_exam",
    severity: "warning",
    timestamp: now,
    received_at: now,
    hackerrank_username: live.candidate_id || "",
    candidate_id: live.candidate_id || "",
    username_norm: enrollment.person_id,
    title: "Removed from roster mid-exam",
    detail: "A roster re-upload removed this candidate while their session was live. The session continues; review and decide.",
    contest_slug: contest.slug,
    session_id: live.session_id,
    room: live.room || ""
  });
}

// Per-contest clear — mirrors the legacy M5 discipline: PURGE the active
// version's entry docs (they hold PII), then flip the meta off. Enrollments
// are durable person × contest rows and deliberately survive (a later upload
// reconciles them); persons/colleges are never touched.
async function clearContestRoster(contest) {
  const meta = await getContestRosterMeta(contest);
  if (meta?.version) {
    const snapshot = await col("roster")
      .where("roster_version", "==", meta.version)
      .limit(ROSTER_LIMIT)
      .get();
    const ids = snapshot.docs.map((doc) => doc.data()).map((entry) => rosterEntryIdFor(meta.version, entry.person_id));
    await mapWithConcurrency(ids, WRITE_CONCURRENCY, async (entryId) => {
      await col("roster").doc(entryId).delete();
    });
  }
  await rosterMetaRefFor(contest.slug).set({
    configured: false,
    contest_slug: contest.slug,
    cleared_at: new Date().toISOString()
  });
  return { ok: true, configured: false, contest: contest.slug, count: 0, skipped: [] };
}

// ---- proctor_admin_audit (F9 D16: global, rows carry contest_slug, never
// purged; actor_ip/actor_ua captured automatically, honor-system identity) ----

export async function writeAudit(entry, actor = {}, at = new Date().toISOString()) {
  const id = randomUUID();
  await col("audit").doc(id).set({
    id,
    ...entry,
    at,
    actor_ip: String(actor.ip || ""),
    actor_ua: String(actor.userAgent || "")
  });
}

// ---- small local helpers ------------------------------------------------------

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

function resolveCollegeColumn(body, mapping, columns) {
  const explicit = String(body.college_column || "").trim();
  if (explicit && columns.includes(explicit)) return explicit;
  if (mapping.college) return mapping.college;
  return columns.find((column) => column.toLowerCase() === "college") || "";
}

function isAlreadyExists(error) {
  return error?.code === 6 || /ALREADY_EXISTS/i.test(String(error?.message || ""));
}

function httpError(statusCode, message, payload) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (payload) error.payload = payload;
  return error;
}
