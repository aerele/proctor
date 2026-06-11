// backend/test/dataLifecycle.test.mjs — Wave7-G PURE logic (S-G/S-H).
// Specs: docs/superpowers/specs/2026-06-10-f9-identity-data-lifecycle-design.md
//          §3.1 (export bundle/manifest), §3.2 (triple-gated purge),
//          §3.4 (retention sweep), Decision 12 (purge gates), Decision 14.
//        docs/superpowers/specs/2026-06-10-f10-product-vision.md
//          §2.16 (lifecycle re-scoped: persons/enrollments/colleges in export,
//          enrollments survive purge with snapshot), §10.4 (export-zip 10-day
//          retention + sweep deletes expired zips).
//
// These are the PURE seams the task demands tested first:
//   buildExportBundle  — assembles the manifest + per-dataset entries from
//                        already-fetched docs (no Firestore).
//   evaluatePurgeGate  — the triple gate (export present / confirm flag / typed
//                        slug) as a pure decision; missing any → reject.
//   selectExpiredEvidence / selectExpiredExports — retention-sweep selection on
//                        a clock seam (which contests' evidence + which export
//                        zips are due).
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  buildExportBundle,
  evaluatePurgeGate,
  selectExpiredEvidence,
  selectExpiredExports,
  EXPORT_RETENTION_DAYS,
  exportObjectPath
} = await import("../src/dataLifecycle.mjs");

// ---- buildExportBundle (pure assembly) -------------------------------------

function sampleDatasets() {
  return {
    sessions: [{ _id: "s1", contest_slug: "kec-r1", username_norm: "21cs001" }],
    submissions: [
      { _id: "sub1", contest_slug: "kec-r1", username_norm: "21cs001", problem_id: "p1", score: 80 },
      { _id: "sub2", contest_slug: "kec-r1", username_norm: "21cs001", problem_id: "p2", score: 50 }
    ],
    alerts: [{ _id: "a1", contest_slug: "kec-r1", username_norm: "21cs001", severity: "warning" }],
    submission_events: [],
    enrollments: [{ _id: "kec-r1::col~21cs001", contest_slug: "kec-r1", person_id: "col~21cs001" }],
    persons: [{ _id: "col~21cs001", unique_id: "21 CS 001", college_norm: "col" }],
    colleges: [{ _id: "col", college_norm: "col", name: "KEC" }],
    roster_entries: [{ _id: "v1:col~21cs001", contest_slug: "kec-r1" }],
    reviews: [],
    review_claims: [],
    room_gates: [],
    live_locks: []
  };
}

const sampleContest = {
  slug: "kec-r1",
  name: "KEC June 2026 Round 1",
  status: "open",
  identity_mode: "person",
  identity_label: "Roll Number"
};

const sampleResults = {
  configured: true,
  contest_slug: "kec-r1",
  problems: [{ problem_id: "p1", title: "P1" }, { problem_id: "p2", title: "P2" }],
  rows: [{ rank: 1, person_id: "col~21cs001", total: 130 }]
};

test("buildExportBundle: manifest carries schema_version, contest snapshot, exact per-dataset counts", () => {
  const bundle = buildExportBundle({
    contest: sampleContest,
    datasets: sampleDatasets(),
    results: sampleResults,
    exportedAt: "2026-06-11T10:00:00.000Z"
  });
  assert.equal(bundle.manifest.schema_version, 1, "schema_version pinned at 1 (vision §2.16)");
  assert.equal(bundle.manifest.exported_at, "2026-06-11T10:00:00.000Z");
  assert.deepEqual(bundle.manifest.contest, sampleContest, "contest doc snapshotted verbatim");
  assert.equal(bundle.manifest.counts.sessions, 1);
  assert.equal(bundle.manifest.counts.submissions, 2);
  assert.equal(bundle.manifest.counts.alerts, 1);
  assert.equal(bundle.manifest.counts.enrollments, 1);
  assert.equal(bundle.manifest.counts.persons, 1);
  assert.equal(bundle.manifest.counts.colleges, 1);
  assert.equal(bundle.manifest.counts.submission_events, 0);
});

test("buildExportBundle: emits one ndjson entry per dataset + the manifest + results rollup", () => {
  const bundle = buildExportBundle({
    contest: sampleContest,
    datasets: sampleDatasets(),
    results: sampleResults,
    exportedAt: "2026-06-11T10:00:00.000Z"
  });
  const names = bundle.entries.map((e) => e.name);
  assert.ok(names.includes("manifest.json"));
  assert.ok(names.includes("results.json"), "the Results rollup ships in the bundle");
  assert.ok(names.includes("sessions.jsonl"));
  assert.ok(names.includes("submissions.jsonl"));
  assert.ok(names.includes("enrollments.jsonl"));
  assert.ok(names.includes("persons.jsonl"));
  assert.ok(names.includes("colleges.json"));
});

test("buildExportBundle: jsonl entries are newline-delimited raw docs, lossless _id round-trip", () => {
  const bundle = buildExportBundle({
    contest: sampleContest,
    datasets: sampleDatasets(),
    results: sampleResults,
    exportedAt: "2026-06-11T10:00:00.000Z"
  });
  const submissions = bundle.entries.find((e) => e.name === "submissions.jsonl");
  const lines = submissions.body.trim().split("\n");
  assert.equal(lines.length, 2, "one line per submission");
  const parsed = lines.map((l) => JSON.parse(l));
  assert.deepEqual(parsed.map((d) => d._id).sort(), ["sub1", "sub2"]);
  assert.equal(parsed[0].score, 80);
});

test("buildExportBundle: empty dataset emits an empty (but present) entry, count 0", () => {
  const bundle = buildExportBundle({
    contest: sampleContest,
    datasets: sampleDatasets(),
    results: sampleResults,
    exportedAt: "2026-06-11T10:00:00.000Z"
  });
  const events = bundle.entries.find((e) => e.name === "submission_events.jsonl");
  assert.ok(events, "even an empty dataset gets an entry so the archive is self-describing");
  assert.equal(events.body, "");
  assert.equal(bundle.manifest.counts.submission_events, 0);
});

test("exportObjectPath: exports/{slug}/{stamp}.zip under the contest prefix", () => {
  const key = exportObjectPath("kec-r1", "2026-06-11T10:00:00.000Z");
  assert.match(key, /^exports\/kec-r1\//);
  assert.match(key, /\.zip$/);
  // The stamp must be doc-id/path safe (no colons from the ISO string).
  assert.ok(!key.includes(":"), "ISO colons stripped from the object path");
});

// ---- evaluatePurgeGate (the triple gate, pure) -----------------------------

const purgedContest = { slug: "kec-r1", name: "KEC June 2026 Round 1" };

test("evaluatePurgeGate: all three gates satisfied → allow", () => {
  const decision = evaluatePurgeGate({
    contest: { ...purgedContest, last_export_at: "2026-06-11T09:00:00.000Z" },
    confirm: true,
    typedSlug: "kec-r1"
  });
  assert.equal(decision.ok, true);
});

test("evaluatePurgeGate: NO prior export → reject export_required", () => {
  const decision = evaluatePurgeGate({
    contest: { ...purgedContest, last_export_at: null },
    confirm: true,
    typedSlug: "kec-r1"
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "export_required");
});

test("evaluatePurgeGate: confirm flag missing/false → reject confirm_required", () => {
  for (const confirm of [false, undefined, "true", 1, null]) {
    const decision = evaluatePurgeGate({
      contest: { ...purgedContest, last_export_at: "2026-06-11T09:00:00.000Z" },
      confirm,
      typedSlug: "kec-r1"
    });
    assert.equal(decision.ok, false, `confirm=${JSON.stringify(confirm)} must reject`);
    assert.equal(decision.code, "confirm_required");
  }
});

test("evaluatePurgeGate: wrong / missing typed slug → reject slug_mismatch", () => {
  for (const typed of ["kec-r2", "", "  ", "KEC-R1", undefined, null]) {
    const decision = evaluatePurgeGate({
      contest: { ...purgedContest, last_export_at: "2026-06-11T09:00:00.000Z" },
      confirm: true,
      typedSlug: typed
    });
    assert.equal(decision.ok, false, `typedSlug=${JSON.stringify(typed)} must reject`);
    assert.equal(decision.code, "slug_mismatch");
  }
});

test("evaluatePurgeGate: gate order is export → confirm → slug (first failure wins, clearest message)", () => {
  // Missing export AND missing confirm AND wrong slug — export_required surfaces first.
  const decision = evaluatePurgeGate({
    contest: { ...purgedContest, last_export_at: null },
    confirm: false,
    typedSlug: "wrong"
  });
  assert.equal(decision.code, "export_required");
});

test("evaluatePurgeGate: already-tombstoned contest → no-op (idempotent re-purge)", () => {
  const decision = evaluatePurgeGate({
    contest: { ...purgedContest, last_export_at: "2026-06-11T09:00:00.000Z", purged_at: "2026-06-11T09:30:00.000Z" },
    confirm: true,
    typedSlug: "kec-r1"
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.already_purged, true, "re-purge of a tombstoned contest is a flagged no-op");
});

// ---- selectExpiredEvidence (retention sweep selection, clock seam) ---------

function contestAt(slug, { selectionDoneAt = null, retentionDays = 4, evidencePurgedAt = null } = {}) {
  return {
    slug,
    selection_done_at: selectionDoneAt,
    evidence_retention_days: retentionDays,
    evidence_purged_at: evidencePurgedAt
  };
}

const NOW = "2026-06-20T00:00:00.000Z";

test("selectExpiredEvidence: contest whose retention window elapsed is due", () => {
  // selection done 2026-06-10, 4-day retention → expires 2026-06-14 < NOW(06-20).
  const due = selectExpiredEvidence(
    [contestAt("kec-r1", { selectionDoneAt: "2026-06-10T00:00:00.000Z", retentionDays: 4 })],
    NOW
  );
  assert.deepEqual(due.map((c) => c.slug), ["kec-r1"]);
});

test("selectExpiredEvidence: window NOT yet elapsed → not due", () => {
  // selection done 2026-06-18, 4-day → expires 2026-06-22 > NOW(06-20).
  const due = selectExpiredEvidence(
    [contestAt("kec-r2", { selectionDoneAt: "2026-06-18T00:00:00.000Z", retentionDays: 4 })],
    NOW
  );
  assert.equal(due.length, 0);
});

test("selectExpiredEvidence: exactly at the threshold is NOT yet due (strict <)", () => {
  // selection done 2026-06-16, 4-day → expires EXACTLY at NOW(06-20). Not due
  // until strictly past, so a same-instant sweep never deletes early.
  const due = selectExpiredEvidence(
    [contestAt("kec-r3", { selectionDoneAt: "2026-06-16T00:00:00.000Z", retentionDays: 4 })],
    NOW
  );
  assert.equal(due.length, 0);
});

test("selectExpiredEvidence: no selection_done_at → never swept", () => {
  const due = selectExpiredEvidence(
    [contestAt("kec-r4", { selectionDoneAt: null, retentionDays: 4 })],
    NOW
  );
  assert.equal(due.length, 0);
});

test("selectExpiredEvidence: already evidence-purged → skipped (idempotent)", () => {
  const due = selectExpiredEvidence(
    [contestAt("kec-r5", { selectionDoneAt: "2026-06-01T00:00:00.000Z", retentionDays: 4, evidencePurgedAt: "2026-06-06T00:00:00.000Z" })],
    NOW
  );
  assert.equal(due.length, 0);
});

test("selectExpiredEvidence: retention_days defaults to 4 when unset/garbage", () => {
  // No retention field → 4-day default; done 06-10 → expires 06-14 < NOW.
  const due = selectExpiredEvidence(
    [{ slug: "kec-r6", selection_done_at: "2026-06-10T00:00:00.000Z", evidence_purged_at: null }],
    NOW
  );
  assert.deepEqual(due.map((c) => c.slug), ["kec-r6"]);
});

test("selectExpiredEvidence: mixed batch returns only the due contests", () => {
  const due = selectExpiredEvidence(
    [
      contestAt("due-a", { selectionDoneAt: "2026-06-01T00:00:00.000Z", retentionDays: 4 }),
      contestAt("not-due", { selectionDoneAt: "2026-06-19T00:00:00.000Z", retentionDays: 4 }),
      contestAt("never", { selectionDoneAt: null }),
      contestAt("already", { selectionDoneAt: "2026-06-01T00:00:00.000Z", evidencePurgedAt: "2026-06-06T00:00:00.000Z" }),
      contestAt("due-b", { selectionDoneAt: "2026-06-05T00:00:00.000Z", retentionDays: 10 }) // expires 06-15 < NOW
    ],
    NOW
  );
  assert.deepEqual(due.map((c) => c.slug).sort(), ["due-a", "due-b"]);
});

// ---- selectExpiredExports (10-day zip retention, clock seam) ----------------

test("selectExpiredExports: export zip older than 10 days is due for deletion", () => {
  const exports = [
    { name: "exports/kec-r1/2026-06-05T00-00-00.zip", created_at: "2026-06-05T00:00:00.000Z" }
  ];
  // NOW 06-20; created 06-05 → 15 days old > 10.
  const due = selectExpiredExports(exports, NOW);
  assert.deepEqual(due.map((f) => f.name), ["exports/kec-r1/2026-06-05T00-00-00.zip"]);
});

test("selectExpiredExports: zip within 10 days survives", () => {
  const exports = [
    { name: "exports/kec-r1/2026-06-15T00-00-00.zip", created_at: "2026-06-15T00:00:00.000Z" }
  ];
  // 5 days old < 10.
  const due = selectExpiredExports(exports, NOW);
  assert.equal(due.length, 0);
});

test("selectExpiredExports: exactly 10 days is NOT yet due (strict >)", () => {
  const exports = [
    { name: "exports/kec-r1/2026-06-10T00-00-00.zip", created_at: "2026-06-10T00:00:00.000Z" }
  ];
  // exactly 10 days old → survives this sweep, deleted on the next.
  const due = selectExpiredExports(exports, NOW);
  assert.equal(due.length, 0);
});

test("selectExpiredExports: EXPORT_RETENTION_DAYS is 10 (vision §10.4)", () => {
  assert.equal(EXPORT_RETENTION_DAYS, 10);
});

test("selectExpiredExports: a file with no parseable created_at is left alone (never delete on ambiguity)", () => {
  const exports = [{ name: "exports/kec-r1/bad.zip", created_at: "not-a-date" }];
  const due = selectExpiredExports(exports, NOW);
  assert.equal(due.length, 0, "unparseable timestamp → conservative keep");
});
