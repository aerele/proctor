// backend/src/dataLifecycle.mjs — Wave7-G PURE data-lifecycle logic (S-G/S-H).
//
// SENSITIVE: this module underpins irreversible deletion. It holds ONLY the
// pure decision/assembly logic so every gate and selection is unit-tested on a
// clock seam with no Firestore/GCS. The handler owns the actual reads, GCS
// object deletes, Firestore batch deletes and tombstone writes — and only ever
// deletes a contest's heavy data after evaluatePurgeGate() returns ok:true.
//
// Specs:
//   docs/superpowers/specs/2026-06-10-f9-identity-data-lifecycle-design.md
//     §3.1 (export → manifest + per-dataset jsonl), §3.2 (triple-gated purge,
//     tombstone), §3.4 (retention sweep), Decision 12 (gates), Decision 14
//     (ONE daily scheduler → sweep endpoint).
//   docs/superpowers/specs/2026-06-10-f10-product-vision.md
//     §2.9 (purge-survivor: enrollments + final_snapshot retained),
//     §2.16 (export carries persons/enrollments/colleges, schema_version:1),
//     §10.4 (export zips auto-delete after 10 days via the same daily sweep).

// Per F9 §2.1 / Q2: evidence retention defaults to 4 days when a contest has no
// (or a garbage) evidence_retention_days. Clamp lives in contests.mjs at write;
// this is the read-time fallback the sweep uses so a legacy/synth doc still
// resolves a window.
export const DEFAULT_RETENTION_DAYS = 4;

// Vision §10.4: export zips in GCS auto-delete 10 days after creation. The
// purge gate's "fresh export" notion (≤24h, enforced at the handler if Karthi
// confirms F9 Q3) is far inside this window, so the two never collide.
export const EXPORT_RETENTION_DAYS = 10;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The lossless per-dataset files in the export bundle (F9 §3.1). JSONL = one raw
// doc per line keyed by `_id` (the round-trip basis); a couple of small datasets
// (persons/colleges/roster meta/results) ship as plain JSON. Order is stable so
// the archive listing is deterministic.
const JSONL_DATASETS = [
  "sessions",
  "submissions",
  "alerts",
  "submission_events",
  "enrollments",
  "persons",
  "roster_entries",
  "reviews",
  "review_claims",
  "room_gates",
  "live_locks"
];
const JSON_DATASETS = ["colleges"];

// ---- export bundle assembly (PURE) ------------------------------------------
//
// Takes already-fetched, already-paginated docs (the handler uses dedicated
// readers, never the capped query helpers — F9 D11) and produces:
//   { manifest, entries:[{name, body}] }
// The handler serializes `entries` into the GCS object (a zip if a zip util is
// available, else an ndjson/text bundle). Counts in the manifest are the SOURCE
// OF TRUTH the purge gate cross-checks against live counts.
export function buildExportBundle({ contest, datasets = {}, results = null, exportedAt }) {
  const at = String(exportedAt || new Date().toISOString());
  const counts = {};
  const entries = [];

  for (const name of JSONL_DATASETS) {
    const rows = Array.isArray(datasets[name]) ? datasets[name] : [];
    counts[name] = rows.length;
    entries.push({ name: `${name}.jsonl`, body: toNdjson(rows) });
  }
  for (const name of JSON_DATASETS) {
    const rows = Array.isArray(datasets[name]) ? datasets[name] : [];
    counts[name] = rows.length;
    entries.push({ name: `${name}.json`, body: JSON.stringify(rows, null, 2) });
  }

  const manifest = {
    schema_version: 1,
    exported_at: at,
    contest: contest || null,
    counts
  };

  // manifest first, then results rollup, then the dataset entries (already
  // pushed) — assemble the final ordered list.
  return {
    manifest,
    entries: [
      { name: "manifest.json", body: JSON.stringify(manifest, null, 2) },
      { name: "results.json", body: JSON.stringify(results ?? null, null, 2) },
      ...entries
    ]
  };
}

function toNdjson(rows) {
  if (!rows.length) return "";
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

// GCS object path for an export: exports/{slug}/{stamp}.zip under the contest's
// storage namespace. The ISO stamp's colons are stripped so the key is path-
// safe and copy-pasteable (mirrors the sanitizeSegment discipline elsewhere).
export function exportObjectPath(slug, exportedAt) {
  const stamp = String(exportedAt || new Date().toISOString()).replace(/[:.]/g, "-");
  return `exports/${slug}/${stamp}.zip`;
}

// ---- the triple gate (PURE decision) ----------------------------------------
//
// SERVER-ENFORCED, not just UI (F9 D12). Returns:
//   { ok:true }                              → caller may delete
//   { ok:true, already_purged:true }         → tombstoned already; caller no-ops
//   { ok:false, code, message }              → reject with a 4xx
//
// Gate order is export → confirm → slug so the FIRST failure surfaces the
// clearest next action for the admin. The three gates are exactly:
//   (a) a prior successful export exists  (contest.last_export_at present)
//   (b) an explicit boolean confirm flag  (=== true; no truthy coercion)
//   (c) the typed contest slug echoes EXACTLY (case-sensitive, trimmed)
export function evaluatePurgeGate({ contest, confirm, typedSlug }) {
  const c = contest || {};

  // Idempotent re-purge: a tombstoned contest is a flagged no-op REGARDLESS of
  // the gates (a re-POST after a resumed/retried purge must not 4xx).
  if (c.purged_at) {
    return { ok: true, already_purged: true };
  }

  if (!c.last_export_at) {
    return { ok: false, code: "export_required", message: "Export the contest before purging (no prior export found)." };
  }
  if (confirm !== true) {
    return { ok: false, code: "confirm_required", message: "Set confirm:true to authorize the purge." };
  }
  const typed = typeof typedSlug === "string" ? typedSlug.trim() : "";
  if (!typed || typed !== String(c.slug || "")) {
    return { ok: false, code: "slug_mismatch", message: "Type the exact contest slug to confirm the purge." };
  }
  return { ok: true };
}

// ---- retention sweep selection (PURE, clock seam) ---------------------------
//
// selectExpiredEvidence: which contests are DUE for an evidence purge given a
// caller-supplied `now`. A contest is due when:
//   - selection_done_at is set (the human "selection done" event started the
//     clock; absent → NEVER swept), AND
//   - now is STRICTLY past selection_done_at + retention_days (so a same-instant
//     sweep never deletes early; exactly-at-threshold waits for the next run),
//     AND
//   - evidence_purged_at is unset (idempotent — already-swept contests skip).
export function selectExpiredEvidence(contests = [], now) {
  const nowMs = Date.parse(String(now));
  if (!Number.isFinite(nowMs)) return [];
  return (Array.isArray(contests) ? contests : []).filter((contest) => {
    if (!contest || contest.evidence_purged_at) return false;
    const doneMs = Date.parse(String(contest.selection_done_at || ""));
    if (!Number.isFinite(doneMs)) return false; // no/garbage selection_done_at → never
    const days = retentionDaysOf(contest);
    const expiresMs = doneMs + days * MS_PER_DAY;
    return nowMs > expiresMs;
  });
}

function retentionDaysOf(contest) {
  const raw = contest?.evidence_retention_days;
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) return DEFAULT_RETENTION_DAYS;
  return num;
}

// selectExpiredExports: which export-zip objects are due for deletion (vision
// §10.4 — auto-delete after 10 days). STRICTLY older than EXPORT_RETENTION_DAYS;
// an object whose created_at can't be parsed is left alone (never delete on
// ambiguity — the conservative bias the whole module shares).
export function selectExpiredExports(files = [], now) {
  const nowMs = Date.parse(String(now));
  if (!Number.isFinite(nowMs)) return [];
  const cutoffMs = EXPORT_RETENTION_DAYS * MS_PER_DAY;
  return (Array.isArray(files) ? files : []).filter((file) => {
    const createdMs = Date.parse(String(file?.created_at || ""));
    if (!Number.isFinite(createdMs)) return false;
    return nowMs - createdMs > cutoffMs;
  });
}
