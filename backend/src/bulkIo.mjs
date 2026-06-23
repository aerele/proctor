// backend/src/bulkIo.mjs
// BANK-1 (F11): the PURE core of bulk problem/template export+import. No store,
// no env, no http — handler-side route code (routes/adminBankIo.mjs) supplies
// pre-fetched docs and the live save paths. Mirrors contestProblems.mjs /
// dataLifecycle.mjs: everything here is a deterministic function of its inputs so
// the A/B/C/D conflict resolver, the canonical content hashing, and the bundle
// assembly/parse are unit-testable without a fake Firestore.
//
// Spec: docs/proposed/bulk-problem-template-io.md
//
// Identity model (§1): a problem/template carries an OPTIONAL `portable_id`
// (uuid v4) that travels with it across export→import forever; the slug is
// instance-local and the WRONG cross-instance key. Conflict detection is
// content-hash-AT-IMPORT-TIME (computed, never stored) keyed by `portable_id`
// (stored). Stored docs gain at most `portable_id` + `origin` (both additive,
// optional) — never `content_hash`/`parent_hash`/`version`, which live in the
// bundle item only.

import { createHash, randomUUID } from "node:crypto";

// The self-describing bundle magic + schema version (§2). Anything else is
// rejected at preview so an unrelated JSON can never be imported.
export const BUNDLE_KIND = "proctor.bank-bundle";
export const BUNDLE_VERSION = 1;

// Bundle caps (§4): bound a malicious/accidental upload so import can never OOM.
// Problems are additionally bounded per-item by PROBLEM_BOUNDS at validate time;
// these cap the COUNT before any per-item resolution runs.
export const MAX_BUNDLE_PROBLEMS = 200;
export const MAX_BUNDLE_TEMPLATES = 50;

// ---- portable identity -------------------------------------------------------

// uuid v4, lowercase, 36 chars — the cross-instance match key. randomUUID()
// already emits the lowercase canonical form; the guard below is the importer's
// shape check (a bundle could carry anything).
export function mintPortableId() {
  return randomUUID();
}

const PORTABLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isValidPortableId(value) {
  return typeof value === "string" && PORTABLE_ID_PATTERN.test(value);
}

// ---- canonical content hashing (the dedup primitive, §1.1) -------------------

// Stable, recursive key-sort so two objects with the same content but different
// key INSERTION order hash identically. Arrays keep their order (ordered tests /
// problem entries are content). Primitives pass through.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${parts.join(",")}}`;
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

// Build the stable-key-ordered object of ONLY authored problem content,
// excluding portable_id/origin/created_at/updated_at (and the preset/references
// projections that are never on a stored doc). Runs the SAME normalization the
// storage rule does — an absent statement_format and "plain" hash equal
// (problems.mjs:246), languages/tags are sorted, stubs key-sorted — so a doc and
// its round-trip bundle item hash identically. The id/slug IS included (a slug
// rename is a content change a human cares about — §1.1 note).
export function canonicalProblemContent(doc) {
  const d = doc && typeof doc === "object" ? doc : {};
  const languages = Array.isArray(d.languages) ? [...d.languages].map(String).sort() : [];
  const tags = Array.isArray(d.tags) ? [...d.tags].map(String).sort() : [];
  const sampleTests = Array.isArray(d.sampleTests)
    ? d.sampleTests.map((t) => ({ input: String(t?.input ?? ""), expected: String(t?.expected ?? "") }))
    : [];
  const hiddenTests = Array.isArray(d.hiddenTests)
    ? d.hiddenTests.map((t) => ({ input: String(t?.input ?? ""), expected: String(t?.expected ?? "") }))
    : [];
  const stubs = d.stubs && typeof d.stubs === "object" && !Array.isArray(d.stubs)
    ? Object.fromEntries(Object.keys(d.stubs).sort().map((k) => [k, String(d.stubs[k])]))
    : {};
  return {
    id: String(d.id ?? ""),
    title: String(d.title ?? ""),
    statement: String(d.statement ?? ""),
    // absent/"plain" both normalize to "plain" (storage omits the field then) so
    // a plain doc and a bundle item that explicitly carries "plain" hash equal.
    statement_format: d.statement_format === "markdown" ? "markdown" : "plain",
    languages,
    cpuTimeLimit: Number(d.cpuTimeLimit),
    memoryLimit: Number(d.memoryLimit),
    points: Number(d.points ?? 100),
    scoring: String(d.scoring ?? "per_test"),
    status: String(d.status ?? "draft"),
    tags,
    sampleTests,
    hiddenTests,
    stubs
  };
}

export function canonicalProblemHash(doc) {
  return sha256Hex(stableStringify(canonicalProblemContent(doc)));
}

// Template content (§1.1). The problem REFS are hashed by their PORTABLE id (not
// the instance-local slug) so the hash is stable across instances where the
// referenced problems live under different slugs (§2.2). `entries` is the
// portable-ref list ([{problem_portable_id, points, order}]); `defaults` is the
// normalized defaults block.
export function canonicalTemplateContent({ name, description, defaults, entries }) {
  const refs = Array.isArray(entries)
    ? entries.map((e) => ({
        problem_portable_id: String(e?.problem_portable_id ?? ""),
        points: e?.points ?? null,
        order: Number(e?.order ?? 0)
      }))
    : [];
  return {
    name: String(name ?? ""),
    description: String(description ?? ""),
    problems: refs,
    defaults: defaults && typeof defaults === "object" ? defaults : {}
  };
}

export function canonicalTemplateHash(content) {
  return sha256Hex(stableStringify(canonicalTemplateContent(content)));
}

// A token over the WHOLE bundle so a commit can detect that the bundle changed
// since the preview was computed and refuse (§3.5). Hash of the canonical bundle
// JSON minus the volatile exported_at header (which is diagnostic only).
export function bundleToken(bundle) {
  const b = bundle && typeof bundle === "object" ? bundle : {};
  return sha256Hex(stableStringify({
    kind: b.kind,
    bundle_version: b.bundle_version,
    problems: b.problems,
    templates: b.templates
  }));
}

// ---- the A/B/C/D conflict resolver (§3.1) ------------------------------------
// PURE: given an incoming bundle problem item, the local portable_id→doc map,
// the local slug→doc map (for legacy un-keyed collisions), and an optional
// per-item override, return the planned action + target slug + reason. No I/O.
//
//   A. New        — no local doc with this portable_id            -> create
//   B. Identical  — local exists, content hashes equal            -> skip (dedup)
//   C. Update     — differs, local == bundle.parent_hash          -> update in place
//   D. Divergent  — differs, local != parent_hash                 -> fork to -2
//   Legacy        — slug collides a local doc with NO portable_id -> fork (default
//                   "keep both"); override "adopt" stamps the id + updates.

export const PROBLEM_ACTIONS = ["create", "skip", "update", "fork", "adopt"];

// Compute the next free `<base>-N` slug given a set of taken slugs (local +
// already-planned-in-this-batch). Mirrors createTemplateDoc / the contest slug
// suffix loop (-2, -3, …); the resolver only PROPOSES the slug, the writer's
// atomic .create() loop is the real collision authority.
export function nextForkSlug(baseSlug, takenSlugs) {
  const taken = takenSlugs instanceof Set ? takenSlugs : new Set(takenSlugs || []);
  for (let n = 2; n <= 1000; n++) {
    const candidate = `${baseSlug}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Pathological: 1000 forks of one slug. Caller surfaces as a blocked item.
  return null;
}

// Resolve ONE problem. `ctx`:
//   incoming       — the bundle problem item (carries portable_id, content_hash,
//                    parent_hash, id, …)
//   byPortableId   — Map<portable_id, localDoc>
//   bySlug         — Map<slug, localDoc>
//   takenSlugs     — Set<string> of slugs already taken (local + planned)
//   override       — one of PROBLEM_ACTIONS (optional)
// Returns { action, target_slug, reason, portable_id, id, status }.
export function resolveProblem({ incoming, byPortableId, bySlug, takenSlugs, override }) {
  const portableId = incoming?.portable_id;
  const slug = String(incoming?.id ?? "");
  const incomingHash = canonicalProblemHash(incoming);
  const parentHash = incoming?.parent_hash || incomingHash;
  const status = String(incoming?.status ?? "draft");
  const base = { portable_id: portableId, id: slug, status };

  const local = isValidPortableId(portableId) ? byPortableId.get(portableId) : undefined;

  // ---- portable-id match: the A/B/C/D machine ----
  if (local) {
    const localHash = canonicalProblemHash(local);
    if (override && PROBLEM_ACTIONS.includes(override)) {
      return applyProblemOverride({ override, base, local, slug, takenSlugs });
    }
    if (localHash === incomingHash) {
      return { ...base, action: "skip", target_slug: local.id, reason: "identical" };
    }
    if (localHash === parentHash) {
      return { ...base, action: "update", target_slug: local.id, reason: "local_unchanged_since_export" };
    }
    const forkSlug = nextForkSlug(local.id, takenSlugs);
    if (!forkSlug) return { ...base, action: "blocked", target_slug: null, reason: "fork_slug_exhausted" };
    return { ...base, action: "fork", target_slug: forkSlug, reason: "divergent", forked_from: portableId };
  }

  // ---- no portable-id match: maybe a legacy slug collision (§3.3) ----
  const legacy = bySlug.get(slug);
  if (legacy && !isValidPortableId(legacy.portable_id)) {
    if (override === "adopt") {
      return { ...base, action: "adopt", target_slug: slug, reason: "adopt_legacy" };
    }
    if (override === "skip") return { ...base, action: "skip", target_slug: slug, reason: "skipped" };
    // default: keep both — never silently overwrite an un-keyed local doc.
    const forkSlug = nextForkSlug(slug, takenSlugs);
    if (!forkSlug) return { ...base, action: "blocked", target_slug: null, reason: "fork_slug_exhausted" };
    return { ...base, action: "fork", target_slug: forkSlug, reason: "legacy_collision", forked_from: null };
  }

  // A slug collision with a KEYED local doc that has a DIFFERENT portable id:
  // two genuinely different problems that happen to share a slug — keep both.
  if (bySlug.has(slug)) {
    if (override === "skip") return { ...base, action: "skip", target_slug: slug, reason: "skipped" };
    const forkSlug = nextForkSlug(slug, takenSlugs);
    if (!forkSlug) return { ...base, action: "blocked", target_slug: null, reason: "fork_slug_exhausted" };
    return { ...base, action: "fork", target_slug: forkSlug, reason: "slug_collision", forked_from: null };
  }

  // ---- A: brand new ----
  if (override === "skip") return { ...base, action: "skip", target_slug: slug, reason: "skipped" };
  return { ...base, action: "create", target_slug: slug, reason: "new" };
}

function applyProblemOverride({ override, base, local, slug, takenSlugs }) {
  switch (override) {
    case "skip":
      return { ...base, action: "skip", target_slug: local.id, reason: "override_skip" };
    case "update":
      return { ...base, action: "update", target_slug: local.id, reason: "override_update" };
    case "create":
    case "fork": {
      const forkSlug = nextForkSlug(local.id, takenSlugs);
      if (!forkSlug) return { ...base, action: "blocked", target_slug: null, reason: "fork_slug_exhausted" };
      return { ...base, action: "fork", target_slug: forkSlug, reason: "override_fork", forked_from: base.portable_id };
    }
    case "adopt":
      // adopt only makes sense for a legacy un-keyed doc; for a keyed match
      // treat it as an update (the admin means "take it over").
      return { ...base, action: "update", target_slug: local.id, reason: "override_update" };
    default:
      return { ...base, action: "skip", target_slug: local.id, reason: "override_skip" };
  }
}

// ---- bundle assembly (§2) ----------------------------------------------------
// PURE shaping of already-fetched docs into a bundle item. The route code does
// the Firestore reads + portable_id minting/write-back; this only projects the
// portable export shape (and stamps content_hash/parent_hash into the item).

// Project a stored problem doc to its bundle item: the full authored surface
// (admin includes hiddenTests) PLUS portable_id/origin and the self-describing
// content_hash/parent_hash. created_at/updated_at are stripped (never content).
export function problemToBundleItem(doc) {
  const d = doc && typeof doc === "object" ? doc : {};
  const item = {
    portable_id: d.portable_id,
    id: d.id,
    title: d.title,
    statement: d.statement,
    languages: Array.isArray(d.languages) ? [...d.languages] : [],
    cpuTimeLimit: d.cpuTimeLimit,
    memoryLimit: d.memoryLimit,
    points: d.points,
    scoring: d.scoring,
    status: d.status,
    tags: Array.isArray(d.tags) ? [...d.tags] : [],
    sampleTests: (d.sampleTests || []).map((t) => ({ input: t.input, expected: t.expected })),
    hiddenTests: (d.hiddenTests || []).map((t) => ({ input: t.input, expected: t.expected }))
  };
  if (d.statement_format === "markdown") item.statement_format = "markdown";
  if (d.stubs && typeof d.stubs === "object" && Object.keys(d.stubs).length) item.stubs = { ...d.stubs };
  if (d.origin && typeof d.origin === "object") item.origin = { ...d.origin };
  const hash = canonicalProblemHash(d);
  item.content_hash = hash;
  // §3.2: parent_hash carries one-deep lineage. A freshly authored/exported item
  // has no recorded parent → its own hash IS the parent (first-ever export). A
  // doc imported earlier carries `parent_hash` we preserve so A→B→A is exact.
  item.parent_hash = d.parent_hash || hash;
  return item;
}

// Project a stored template doc to its bundle item, translating each problem
// entry's local slug → its portable id via the supplied resolver map
// (slug → portable_id). Entries whose slug has no portable id are stamped with a
// null portable id + the slug hint (the route mints/back-fills before calling).
export function templateToBundleItem(doc, slugToPortableId) {
  const d = doc && typeof doc === "object" ? doc : {};
  const entries = (d.problems || []).map((entry) => ({
    problem_portable_id: slugToPortableId.get(entry.problem_id) || null,
    problem_id_hint: entry.problem_id,
    points: entry.points ?? null,
    order: entry.order
  }));
  const item = {
    portable_id: d.portable_id,
    slug: d.slug,
    name: d.name,
    description: d.description ?? "",
    defaults: d.defaults,
    problems: entries
  };
  if (d.origin && typeof d.origin === "object") item.origin = { ...d.origin };
  const hash = canonicalTemplateHash({
    name: d.name, description: d.description, defaults: d.defaults, entries
  });
  item.content_hash = hash;
  item.parent_hash = d.parent_hash || hash;
  return item;
}

// Assemble the final bundle header around the already-built item arrays.
export function assembleBundle({ problems, templates, instanceLabel, exportedAt }) {
  return {
    kind: BUNDLE_KIND,
    bundle_version: BUNDLE_VERSION,
    exported_at: exportedAt,
    exported_from: instanceLabel,
    counts: { problems: problems.length, templates: templates.length },
    problems,
    templates
  };
}

// ---- bundle parse / validation (§2, §6.4/§6.5) -------------------------------
// Shape + magic + version + caps. Returns {ok:true, bundle}|{ok:false, code}.
// The per-item field validation is the existing validateProblemInput /
// validateTemplateInput at commit — this is only the envelope gate so a bad
// envelope is a clean 400 before any resolution runs.
export function validateBundleEnvelope(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "bundle_not_object" };
  if (raw.kind !== BUNDLE_KIND) return { ok: false, code: "unsupported_bundle" };
  if (raw.bundle_version !== BUNDLE_VERSION) return { ok: false, code: "unsupported_bundle_version" };
  const problems = Array.isArray(raw.problems) ? raw.problems : [];
  const templates = Array.isArray(raw.templates) ? raw.templates : [];
  if (problems.length > MAX_BUNDLE_PROBLEMS) return { ok: false, code: "bundle_too_many_problems" };
  if (templates.length > MAX_BUNDLE_TEMPLATES) return { ok: false, code: "bundle_too_many_templates" };
  return { ok: true, bundle: { ...raw, problems, templates } };
}
