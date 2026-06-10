# F9.5-8 CONSOLIDATED DESIGN — Identity, Multi-Contest, Data Lifecycle (Aerele Proctor)

Status: BUILD-READY. Base = the **migration-risk** design (highest-scored by both judges, 8.5/8.5), with grafts from the data-model and ops-lifecycle designs as recommended by both judges, and all judge-flagged gaps resolved. Amends the committed F8 spec (`docs/superpowers/specs/2026-06-10-f8-multitest-hr-removal-design.md`) where noted. Code references are `backend/src/handler.mjs` @ HEAD.

## Summary

Contests become first-class (`proctor_contests`, name → slug, `contest_url` dies). Candidate identity becomes the admin-designated unique roster column: its normalized value feeds the existing `username_norm` join key (the field name is frozen forever — it is embedded in 5 collections' doc ids and every GCS path), and its label drives every candidate-facing string; the word "username" disappears from all rendered UI, enforced by a CI grep. Cross-contest isolation rides the already-shipped `(username_norm, contest_slug)` composite key, made provable by a scoped-query chokepoint, a lint-test, and a canary isolation suite with a coverage meta-test. A new admin data-lifecycle surface (export → gated purge → import/relocate, plus selection-done → scheduled evidence retention sweep) replaces the AI-agent-pokes-Firestore practice. Nothing legacy is rewritten: old exams stay readable, reviewable, resumable, exportable, and purgeable via dual-read adapters, the persisted `storage_prefix`, and a legacy-contest shim.

## Decisions

Each decision states the chosen default and why. All are defaults Karthi can veto; only §10's questions need his voice.

1. **`username_norm` field name frozen; derivation replaced.** New sessions: `username_norm = identityNorm(unique value)` where `identityNorm(v) = sanitizeSegment(normalizeUniqueId(v))` (both functions exist today). Renaming the field would force a dual-write rewrite of sessions/alerts/locks/submission-events/review ids and GCS paths for zero user value. Karthi explicitly allows "call it username internally."
2. **One identity field on session docs: `candidate_id` (display form).** Roster contest: `candidate_id` = roster entry's `unique_id`, server-overridden at start (existing S2 mechanism); the typed `hackerrank_username` and its "session key" exception (handler.mjs:307-311) are deleted for new contests. No-roster contest: `candidate_id` = the single typed value. Unifies F8 decision 7's two concepts into one (ops-lifecycle's amendment, graft adopted).
3. **Per-contest `identity_mode` field** (`"unique_id"` on all new contests, `"legacy_username"` on the materialized legacy contest) — the derivation switch is data, not control flow: auditable, testable, and structurally incapable of stranding an in-flight exam at deploy. (Graft from ops-lifecycle, both judges.)
4. **`identity_label` denormalized onto the session doc at start** (legacy rows render as `"Username"` via the dual-read adapter) — exports, restored data, and legacy DTOs render the right label forever even if the contest label changes mid-run. (Graft, both judges.)
5. **Duplicate roster rows hard-reject the upload** — `400 {error:"duplicate_unique_ids", duplicates:[{row, unique_id, conflicts_with_row}]}`, checked on the final `identityNorm` form (catches sanitize-collapse collisions like `a#1`/`a$1`). Blank-id rows stay skip-with-report. Rationale: a silently-kept first row pre-fills the WRONG student's identity for the second student sharing that roll number — an identity hazard, not CSV messiness; "uniqueness enforced" verbatim leans reject. Both judges graft this over the winner's skip-with-warning. **Q1 for Karthi.**
6. **Session-start race guard: the existing H1 atomic live-lock, unchanged.** `live:{norm}:{slug}` `.create()` → exactly one `active`, second `pending_approval`. Same id in two contests = two lock docs, both active. No new mechanism; new tests pin both properties.
7. **Submissions (scores) get denormalized `contest_slug` + `username_norm` + `candidate_id` on NEW docs at submit time; legacy submissions resolve via `session_id` join inside export/purge code.** Fixes the winner's incorrect "selected by contest_slug field" claim — submission docs today carry only `session_id` (handler.mjs:912). (Graft, both judges — this was the #1 flagged gap.)
8. **Resume is contest-pinned with dual-norm verification.** When `contest` is present (the new frontend always sends it): 404 unless `session.contest_slug === contest`. Identity check: `identityNorm(candidate_id) === username_norm` **OR** `normalizeUsername(candidate_id) === username_norm` (legacy leg — legacy norms don't strip inner whitespace). `contest` absent is tolerated for one transitional release only (in-flight candidates at deploy), then required. localStorage token keyed `proctor_session::{slug}`. (Winner's dual-norm + judge-2 graft on mandatory contest, reconciled with judge-1's deploy-safety ding.)
9. **No-bleed enforcement = four named mechanisms** (§4.3): mandatory `resolveContest` on candidate write paths (kills the `contestSlugFromUrl→""` shared-empty-slug hazard, today's actual bleed risk at handler.mjs:322), the `scopedQuery` chokepoint + lint-test, the canary isolation suite + coverage meta-test (graft from data-model, adopted WITHOUT the ROUTES-table refactor — a plain endpoint-name list suffices), and the frontend "username" CI grep.
10. **Existing admin GET signatures unchanged** (`contest_slug` optional filter, explicit `ALL_CONTESTS` sentinel internally) — the deployed contest-eval piggyback poller and dashboards keep working; the admin UI always sends the selector's slug; the canary suite proves the scoped path is bleed-free. (Winner's back-compat call, hardened per judge 2.)
11. **Export is GCS-first** (zip to `exports/{slug}/{ISO-ts}.zip`, signed URL returned) using **dedicated paginated readers, never the capped `SESSIONS_QUERY_LIMIT`/`REVIEWS_QUERY_LIMIT` helpers** (silent-truncation catch, winner-only). JSONL = lossless re-importable truth; CSVs = human derivations.
12. **Purge gates, no force flags ever:** (a) export exists, is ≤24 h old, manifest counts == live counts, AND no doc in any contest dataset has `updated_at > export.at` (combines both judges' strengthening — counts-match alone misses same-count mutations); (b) typed confirmation = exact contest name; (c) zero non-`ended` sessions. Contest doc is KEPT as tombstone (`db_purged_at`, status `archived`) — slug reuse by accident is impossible.
13. **Evidence-purge ordering gap closed (judge-flagged):** if DB purge runs while evidence is unpurged, the distinct `storage_prefix` list is persisted onto the tombstone (`evidence_prefixes`) BEFORE session docs are deleted. The sweep deletes via per-session/tombstone `storage_prefix` iteration (the only legacy-correct path) PLUS a reconstructed `contests/{slug}/sessions/**` prefix pass as belt-and-braces, and stamps `evidence_purged_at` only when a final GCS listing returns empty (resume-safe; scheduler retries finish the job). (Graft, both judges.)
14. **Retention mechanism: ONE — daily Cloud Scheduler → sweep endpoint** (closed-by-default auth mirroring `ALERTS_INGEST_API_KEY` discipline). "Selection done" is an explicit admin button (human event). GCS lifecycle rules rejected: they count object age, not a per-contest human event; per-object `customTime` stamping is a metadata write storm; lazy purge-on-access never fires for forgotten contests.
15. **Import = restore, not merge.** Upsert-by-id from the zip (idempotent, re-run-safe). Relocate (`as_slug`) rewrites `contest_slug` fields + slug components of doc ids; **never touches `storage_prefix`** — old video stays readable at its old path. Refuses targets with live sessions / non-empty new targets.
16. **Audit log `proctor_admin_audit` (global, rows carry `contest_slug`, never purged)** records every lifecycle action with `actor_ip` + `actor_ua` captured automatically (graft — winner's audit recorded no actor). Honor-system identity accepted; real auth is YAGNI.
17. **Review ids: `{norm}::{reviewerKey}::{slug}` suffix form; slugless = legacy** (winner's shape — data-model's prefix form deviated from F8 decision 4 for no gain). Roster entry doc ids UNCHANGED (`v{uuid}:{idnorm}` — UUID version already globally unique, verified handler.mjs:1439) + `contest_slug` field added for export/purge queries. Roster meta = separate doc `roster_meta::{slug}` (not embedded in the contest doc — avoids coupling two write paths, per judge 2).

## 1. Identity model

### 1.1 The chain

```
admin designates unique roster column (exists: unique_id_column)
  → candidate's value          = candidate_id   (display, e.g. "21 CS 001")
  → identityNorm(candidate_id) = username_norm  (e.g. "21cs001")
  → + contest_slug             = composite identity for ALL joins, locks, alert ids,
                                 submission-event ids, GCS paths
```

```js
function identityNorm(value) {
  // normalizeUniqueId: trim + lower + strip ALL whitespace ("21 CS 001" ≡ "21CS001")
  // sanitizeSegment:   path/doc-id safe, never empty/all-dots
  return sanitizeSegment(normalizeUniqueId(value));
}
```

### 1.2 Session doc (new sessions)

```js
{
  session_id, contest_slug,            // contest_slug now MANDATORY non-empty
  candidate_id: "21 CS 001",           // display form (roster unique_id | typed)
  username_norm: "21cs001",            // identityNorm(candidate_id)
  identity_label: "Roll Number",       // denormalized at start (Decision 4)
  roster_verified: true|false,
  name, email, roll_number, room, storage_prefix, ...
  // legacy fields hackerrank_username / roster_unique_id: read-only, never written
}
```

Dual-read adapter, ONE function used by every DTO/export, never writes:

```js
function candidateOf(doc) {
  return {
    id: doc.candidate_id || doc.roster_unique_id || doc.hackerrank_username || "",
    id_norm: doc.username_norm || "",
    label: doc.identity_label || "Username",          // legacy rows
    name: doc.name || "", roll_number: doc.roll_number || "", room: doc.room || ""
  };
}
```

API bodies accept `hackerrank_username` as a deprecated alias for `candidate_id` until S-E completes; monitoring ingest (`/api/alerts`, `/api/submission-events`) accepts both field names forever (cheap; poller fleet upgrades lazily).

### 1.3 Uniqueness enforcement (per contest)

- **Upload time:** hard-reject duplicates on final-norm form (Decision 5). Per-contest by construction — the roster is per-contest.
- **Start time:** H1 live-lock (Decision 6). Tests pin: same id same contest → one active + one pending with `blocked_by_session_id`; same id different contests → both active.
- **Re-upload mid-exam:** versioned entries + meta-written-last keep in-flight lookups torn-state-free; started sessions keep the identity captured at start (documented semantics).

### 1.4 No-roster contests

`identity_label` from the contest doc (default `"Candidate ID"`, admin-editable). Candidate types id + name + email; `roster_verified:false`; uniqueness = the live lock (first claimant owns the id, second goes `pending_approval`, invigilator resolves with the candidate in front of them). No ad-hoc identity registry — YAGNI.

### 1.5 Resume

`POST /api/session/resume {session_id, contest, candidate_id?}` per Decision 8. Lost-tab start-replay idempotency already compares `(username_norm, contest_slug)` — unchanged. Lost-everything: re-enter label value on the same `?contest=` URL → roster lookup → start → live-lock → `pending_approval` → invigilator approves (existing flow).

### 1.6 Collision scoping (same roll number, College A + College B, simultaneous or sequential)

| Artifact | Key | Collides? |
|---|---|---|
| Session | random id + `(username_norm, contest_slug)` | no |
| Live lock | `live:21cs001:{slug}` | no |
| Alert | `proctor:<type>:21cs001:{slug}:<dedupe>` | no |
| Submission events | `21cs001:{slug}` | no |
| Submissions | new: `contest_slug` field; legacy: session join | no |
| Evidence | `contests/{slug}/sessions/21cs001/...` | no |
| Roster entry | `v{uuid}:21cs001` + `contest_slug` field | no (UUID version) |
| Review record | `21cs001::{reviewer}::{slug}` | no |
| Resume token | `proctor_session::{slug}` localStorage key | no |

## 2. Contest & scoping model

### 2.1 `proctor_contests` (doc id = slug)

Slugify per F8: lowercase, trim, spaces→`-`, strip non `[a-z0-9-]`, collision → `-2` suffix (derived slug shown prominently at creation — the suffix is silent otherwise), reject empty. Slug immutable after first session.

```js
{
  slug, name,
  status: "draft"|"open"|"archived",
  listed: true,                          // unlisted = link-only
  identity_mode: "unique_id",            // "legacy_username" only on the materialized legacy contest
  identity_label: "Roll Number",         // no-roster fallback; roster meta's column wins when configured
  start_at, end_at, end_at_updated_at,   // moved off settings doc; S5 semantics preserved per contest
  problem_id, room_gate_enabled, rooms: [],
  created_at, updated_at,
  // lifecycle
  selection_done_at: null,
  evidence_retention_days: 4,            // clamp 1..30
  evidence_purged_at: null,
  db_purged_at: null,
  evidence_prefixes: null,               // persisted at DB-purge time if evidence unpurged (Decision 13)
  last_export: null                      // { at, gcs_key, counts }
}
```

### 2.2 Per-contest vs global

| Data | Scope | Mechanism | Why |
|---|---|---|---|
| Sessions, alerts, submission-events, live-locks, room-gates, evidence | per-contest | already composite-keyed (verified) | zero migration |
| Submissions (scores) | per-contest | denorm on new docs; session join for legacy | Decision 7 |
| Roster | per-contest | meta `roster_meta::{slug}`; entry ids unchanged + `contest_slug` field | two colleges = two rosters; THE identity namespace |
| Window, rooms, problem assignment, gate flag, label | per-contest | contest doc | definitionally |
| Review roster / reviews / claims | per-contest | `roster::{slug}`; `{norm}::{reviewer}::{slug}`; `{norm}::{slug}`; slugless = legacy | review judges one exam |
| Alert settings | GLOBAL | `alert_settings` doc | F8 decision 5; one ops team |
| Problem bank | GLOBAL | unchanged | reusable assets; assignment is per-contest `problem_id` |
| Admin/invigilator/ingest credentials | GLOBAL | env | single-tenant ops |
| `proctor_admin_audit` | GLOBAL (+`contest_slug` field) | new collection | audit must survive the purge |
| `SETTINGS_ID="active"` | legacy read-shim | §6 | old exams keep working |

### 2.3 No-bleed enforcement (the acceptance bar — four named mechanisms)

1. **Mandatory contest resolution on candidate writes.** `resolveContest(slugRaw)` → contest doc or 400 `unknown_contest` / 403 `contest_not_open`. `startSession` requires `body.contest`; `contestSlugFromUrl` is deleted from the start path (it can return `""` — two colleges with unset contest_url would share `contest_slug==""`, today's actual bleed hazard). Resume/heartbeat/events/exec derive scope from the session doc (already do).
2. **Single scoped-query chokepoint.** `scopedQuery(collection, contest)` always appends `.where("contest_slug","==",contest.filterValue)`; cross-contest reads must pass the explicit `ALL_CONTESTS` sentinel. Legacy contest translates to `contest_slug == ""` via `legacy_empty_slug` (§6).
3. **Lint-test.** node:test reads `handler.mjs` source; every `.collection(SESSION_COLLECTION|ALERTS_…|SUBMISSION_EVENTS_…|SUBMISSIONS_…|ROSTER_…|REVIEW_…)` call site must be in an allowlisted helper set. A naked query fails CI until it goes through the chokepoint or is deliberately allowlisted in the same reviewable diff.
4. **Canary isolation suite + coverage meta-test** (graft). Seed contests A and B with the SAME `candidate_id`; every B doc embeds the sentinel `BLEED-CANARY-B`. For every endpoint in a maintained contest-scoped-endpoint list, call with `contest=A` and assert zero canary occurrences in the serialized response. The meta-test diffs that list against the actual handler surface: a new contest-scoped endpoint without a canary case fails CI. (Adopted as a plain endpoint-name list — NOT data-model's full ROUTES-table refactor of the ~3500-line `api()` if-chain; both judges flagged that as the heaviest machinery for the payoff.)

Plus the frontend bar: CI grep asserting no rendered "username" string in `frontend/src` / built bundle (internal API field names allowlisted), from S-A onward.

### 2.4 Endpoint surface (delta)

```
# public / candidate
GET  /api/contests                         → [{slug, name}] for status=open AND listed=true (picker fallback)
GET  /api/exam-config?contest=<slug>       → {contest:{slug,name}, roster_required, identity_label, rooms,
                                              room_gate_enabled, start_at, end_at}
                                              (no-param call keeps legacy-shim response; unique_id_label kept
                                               as alias for one release)
POST /api/roster/lookup                    + contest
POST /api/session/start                    + contest (required; absent → legacy shim path);
                                             candidate_id replaces hackerrank_username (alias accepted)
POST /api/session/resume                   {session_id, contest, candidate_id?}   §1.5

# admin — contests
GET/POST /api/admin/contests               list / create (derives slug)
POST /api/admin/contest-update             {slug, ...fields}    (rename allowed; slug immutable after 1st session)
POST /api/admin/contest-status             {slug, status}

# admin — scoped params
GET/POST /api/admin/roster?contest=        (+ hard-reject dup validation)
review-roster / review-next / review-verdict / review-mine / reviews   + contest
GET /api/invigilator/contests; overview/room/release-code/open-room    + contest (picker at portal login)
sessions-list / alerts / stats / attendance / ip-report / submission-events / recording-sessions
                                           signatures UNCHANGED (optional filter; admin UI always sends slug)

# admin — lifecycle
GET  /api/admin/contest-data-summary?contest=
POST /api/admin/contest-export             {contest}
GET  /api/admin/contest-exports?contest=
POST /api/admin/contest-purge              {contest, confirm_name, include_evidence:false}
POST /api/admin/contest-import             {contest, export_gcs_key | zip upload, as_slug?}
POST /api/admin/selection-done             {contest, retention_days?}
POST /api/admin/evidence-purge-sweep       (Cloud Scheduler OIDC / x-api-key; also manual {contest})
GET  /api/admin/audit?contest=
```

## 3. Data lifecycle

### 3.1 Export — `POST /api/admin/contest-export {contest}`

Streams ONE zip to GCS `exports/{slug}/{ISO-ts}.zip` (GCS-first makes the purge gate server-verifiable — never trust a browser download), returns `{gcs_key, signed_url, counts}` (existing signed-URL machinery), stamps `last_export` + audit doc. **Dedicated paginated full readers** — the capped query helpers would silently truncate a big contest (winner's verified catch; manifest counts cross-check in tests).

```
manifest.json            # schema_version:1, contest doc snapshot, per-dataset counts, exported_at
sessions.jsonl  alerts.jsonl  submission_events.jsonl
submissions.jsonl        # SCORES — legacy docs get contest_slug/candidate_id backfilled via session join at export time
roster_meta.json  roster_entries.jsonl
review_roster.json  reviews.jsonl  review_claims.jsonl
room_gates.jsonl  live_locks.jsonl
sessions.csv  attendance.csv  scores.csv     # derived, human-facing; identity_label as column header; never used for import
```

JSONL = one raw doc per line with `_id` — the lossless round-trip basis. No video in the zip (heavy path is GCS-native). Export is read-only and repeatable, no confirmation friction.

### 3.2 Purge — `POST /api/admin/contest-purge {contest, confirm_name, include_evidence:false}`

Gates per Decision 12 (fresh-export AND-checks; typed name; no live sessions; no force flags). UI mirrors gate failures verbatim. Deletes idempotently and resumably (paginated, batched ≤450/commit, re-POST continues): sessions, alerts, submissions (new: by `contest_slug`; legacy: via session-id join), submission-events, live-locks, room-gates, roster entries (all versions) + meta, review records/claims/roster — legacy contest selected via the `contest_slug==""` translation / slugless review ids. Before deleting session docs, if `evidence_purged_at` unset and not `include_evidence`: persist distinct `storage_prefix` list to the tombstone (`evidence_prefixes`) — Decision 13. `include_evidence:true` deletes evidence first, via `storage_prefix` iteration (never reconstructed prefix alone — strands legacy slugless paths, handler.mjs:3540-3545), `exports/` subtree always excluded. Contest doc kept as tombstone. Audit doc written before deletion starts, updated with final per-dataset counts after.

### 3.3 Import / relocate — `POST /api/admin/contest-import`

Restore semantics only (Decision 15). Plain restore: manifest slug must match; upsert under original `_id`s; refuses targets with live sessions. Relocate (`as_slug`): rewrites `contest_slug` fields + slug components of alert/lock/review/gate doc ids during import into a fresh empty contest; `storage_prefix` untouched — old evidence readable at old paths (the invariant paying out). Stamps restore + audit. Tested round-trip property: export → purge → import → export is deep-equal modulo audit/timestamps.

### 3.4 Evidence retention

- `POST /api/admin/selection-done {contest, retention_days?}` → sets `selection_done_at` (explicit human event), default 4 days, clamp 1–30, editable until purge fires. Audit doc.
- **Daily Cloud Scheduler → `POST /api/admin/evidence-purge-sweep`** (OIDC service account or `x-api-key`; no key configured → reject). For each contest where `selection_done_at + retention_days < now` and `evidence_purged_at == null`: delete via per-session `storage_prefix` iteration (or the tombstone `evidence_prefixes` list if DB already purged), then a reconstructed `contests/{slug}/sessions/**` prefix pass (belt-and-braces); stamp `evidence_purged_at` ONLY when a final listing returns empty; audit doc per contest. Idempotent, resume-safe across timeouts.
- Manual "Purge evidence now" button calls the same endpoint with `{contest}`.
- Optional config-only backstop: bucket-wide age-365d lifecycle rule (orthogonal, not the mechanism).

## 4. UI surfaces

### 4.1 Candidate
- Login: single "Enter your {identity_label}" field (roster: existing unique-id-confirm flow; no-roster: id + name + email). The `hackerrank_username` field is deleted.
- Confirm card: name + `{identity_label}: value` (+ masked email). Top bar / blocked banner: labeled id.
- `?contest=<slug>` in the link; fallback picker of open+listed contests (slug+name only).
- Resume prompt uses the label; token per contest.

### 4.2 Invigilator
- Contest picker at portal login (one contest per portal session). Room dashboard rows, candidate search, alert-detail drawer (F9.4): name + `{identity_label}: value`. Least-privilege projection unchanged.

### 4.3 Admin
- **Contests tab**: list with name, slug, status chip, window, candidate count, **lifecycle badge** (`live / exported / purged / evidence-purged`); create form with live slug preview, identity_label, window, problem picker, rooms, retention days. (Graft: ops-lifecycle UX.)
- **Global contest selector** (today's filter banner, promoted per F8 decision 11) scopes every tab; purged contests stay selectable (empty lists + "data purged — restore from export" hint). On a legacy "(no contest)" or all-contests view, identity column header = "Candidate ID"; otherwise the selected contest's label. Sessions/alerts/attendance/IP tables, session detail card, CSV headers — all label-driven via `candidateOf`.
- **Contest detail page** (graft): counts grid; **lifecycle timeline** (created → opened → selection done → exported → data purged → evidence purged); buttons `Export data` · `Mark selection done` · `Purge contest data` (**disabled with tooltip until the export gate passes**) · `Purge evidence now` · `Restore from export`; export-history table (timestamp, counts, download link); audit trail list.
- **Purge modal**: per-dataset delete counts, evidence included/excluded statement, type-the-contest-name input, red confirm.
- Roster upload: duplicate-reject error panel with row numbers; review-roster settings gains "Load from contest sessions".

## 5. Migration stages (F8 S-A..S-F amended; S-G/S-H new)

Every stage independently shippable, testable, rollback-safe; destructive ops only in S-G/S-H behind gates. Per stage: spec → TDD → local commit, no push.

- **S-A (frontend rename)** — AMENDED: interim label is **"Candidate ID"** (never "Candidate username"); `StudentForm.hackerrank_username` → `candidate_id` send-both/accept-both; **the "username" CI grep gate lands here**. Rollback: pure labels.
- **S-B (contests collection, backend, ships dark)** — AMENDED: schema gains `identity_label`, `identity_mode`, `status`, `listed`, lifecycle block; `resolveContest`; legacy-contest synthesis (§6); `scopedQuery` chokepoint + lint-test. Nothing reads contests in prod paths yet.
- **S-C (scoping + identity core)** — AMENDED: per-contest roster (meta `roster_meta::{slug}`, entry ids unchanged) + **hard-reject dup validation**; `identityNorm` feeding `username_norm` on new-contest sessions (`identity_mode` gates it); `candidateOf` across all DTOs; dual-norm + contest-pinned resume; per-contest review ids; invigilator picker; **submissions denorm on new docs**; canary isolation suite + coverage meta-test. Legacy contest keeps today's code path bit-for-bit. Gate to S-D: legacy-fixture + bleed + race suites green.
- **S-D (admin + candidate UX)** — Contests tab + detail page skeleton, selector scopes every tab, `?contest=` routing + picker, label-driven surfaces (§4 is the checklist), session stores `identity_label`, per-contest localStorage key, duplicate-reject panel, demo parity.
- **S-E (HR field cleanup)** — stores `candidate_id` on NEW sessions; aliases on ingest; `contest_url`/`contestSlugFromUrl` deleted from write paths (legacy-shim read only); monitoring accept-both.
- **S-G (NEW: data lifecycle)** — export → purge + gates + tombstone → import/relocate → `proctor_admin_audit` → contest detail lifecycle UI. After S-E so exports carry final field names (`schema_version:1`). Ships only after round-trip + interference suites green.
- **S-H (NEW: evidence retention)** — selection-done, retention field, sweep endpoint + Cloud Scheduler job (`gcloud scheduler` one-liner in deploy notes), manual purge button.
- **S-F (contest-eval adapter restartability + zero-alerts investigation)** — unchanged, stays last (lands on new field names).

## 6. Backward compatibility (the frozen-invariants spine)

1. `username_norm` field name frozen (Decision 1). 2. Legacy `contest_slug` values frozen — never rewritten; admin selector grows a "(legacy)" entry. 3. `storage_prefix` per session is the only evidence-path truth for reads AND purges. 4. Composite key already universal; the work is making the slug mandatory-non-empty on new writes.

**Legacy contest shim** (idempotent, lazy at S-B): if `proctor_contests` empty and `active` settings doc exists, synthesize a contest doc — `slug = settings.contest_slug || contestSlugFromUrl(contest_url) || "legacy"`, `identity_mode:"legacy_username"`, `legacy_empty_slug:true` when its sessions carry `contest_slug:""` (query helpers translate to the `""` filter); global roster meta and slugless review ids attributed to it. Nothing rewritten. Legacy sessions stay readable/reviewable/resumable (dual-read adapter, dual-norm resume, `storage_prefix`), exportable and purgeable (session-join + prefix-list mechanisms). Deployed monitoring posts old field names forever; existing admin GET signatures unchanged.

**Rejected designs that would strand data:** renaming `username_norm` (5 collections + doc ids); rewriting old `contest_slug` values (strands alert ids + GCS joins); evidence purge by reconstructed prefix alone (misses legacy slugless paths); mandatory `contest` on existing admin GETs (breaks deployed contest-eval poller); mandatory `contest` on resume at deploy time (404s in-flight candidates — hence the one-release transition window).

## 7. Test strategy

node:test, in-memory Firestore/GCS fakes per existing conventions (155 passing today). Frontend: tsc + build + label-rendering tests; validate-before-send on anything shown to Karthi.

| Suite | Key cases |
|---|---|
| `identity` | `identityNorm` golden table (whitespace, case, `@`, `#`/`$` collapse, `..`, all-dots, >120 chars); legacy-vs-new derivation non-interference; `identity_mode` gating |
| `roster-uniqueness` | duplicate raw ids reject with row numbers; same-final-norm collapse rejects; blank-row skip-with-report; re-upload mid-flight (old version still resolves); started sessions keep captured identity |
| `start-race` | same id same contest → exactly one active + one pending (`blocked_by_session_id`); same id different contests → both active; replay idempotency per contest |
| `resume` | contest mismatch → 404; dual-norm legacy leg (`normalizeUsername`-built norms resume); transitional absent-contest tolerance; per-contest token key |
| `contest-bleed` (acceptance bar) | canary suite (§2.3.4) over every scoped endpoint + coverage meta-test; purge(A) leaves B bit-identical (before/after snapshot); evidence-purge(A) deletes only A's `storage_prefix` objects; GCS prefixes differ |
| `scoping-lint` | chokepoint allowlist (§2.3.3) |
| `legacy-fixtures` | prod-shaped docs (`hackerrank_username`, `contest_slug:""`, slugless review ids, legacy GCS prefix): lists, review search, resume, recording review, export, evidence purge all work |
| `lifecycle-export` | manifest counts == seeded counts incl. **submissions via session join**; pagination beyond the 2000 cap (no truncation); `_id` round-trip; CSV headers use `identity_label` |
| `lifecycle-purge` | all gate rejections (no export / stale / same-count-mutation / wrong name / live sessions); full delete incl. legacy-join submissions; tombstone survives with `evidence_prefixes` persisted when evidence unpurged; idempotent re-purge; audit before+after |
| `lifecycle-import` | export→purge→import→export deep-equal; relocate rewrites slug fields/ids, `storage_prefix` untouched; live-target refused; idempotent re-run |
| `retention-sweep` | fake clock before/at/after threshold; no selection-done → never; tombstone-list path (DB purged first); hybrid prefix second pass; **stamp only on verified-empty listing**; resume after simulated timeout; `exports/` survives; closed-by-default auth |
| CI gates | scoping lint; frontend "username" grep (S-A onward) |

Infra smoke per stage on the dev project (aerele-proctor-dev): catch Firestore composite-index `FAILED_PRECONDITION` early (new `contest_slug ==` combos).

## 8. Risks

1. Export truncation via capped helpers → dedicated paginated readers + manifest-count cross-check test.
2. Purge partial failure → idempotent resumable deletes + tombstone + re-POST continues.
3. DB-purge-before-evidence-purge ordering → tombstone `evidence_prefixes` + hybrid sweep (Decision 13).
4. `identityNorm` aggressiveness (space-only-different ids merge) → intended; surfaced at upload by dup-reject before exam day.
5. Slug collision `-2` suffix is silent → derived slug shown at creation.
6. Composite-index surprises → dev-project smoke per stage.
7. Identity-derivation switch mid-fleet → `identity_mode` is per-contest data; legacy contest untouched.
8. Honor-system actor identity (shared admin password) → `actor_ip`/`actor_ua` logged; accepted.
9. Sweep auth → closed-by-default, no key → reject.
10. Human risk on purge → triple gate, typed name, no force flags, audit, tombstone, export-is-the-recovery-path (proven by the round-trip test).

## 9. YAGNI (explicitly not building)

- No `username_norm` rename; no rewriting any legacy doc, id, or GCS path.
- No per-contest alert-settings overrides (F8 decision 5 stands); no per-contest invigilator passwords.
- No user accounts / RBAC / SSO / multi-org tenancy; no audit-grade actor identity.
- No roster column-mapping UI beyond removing the HR mapping key (template CSV F8.3 covers it).
- No partial/selective export or purge; no per-candidate purge; no import-merge conflict resolution beyond upsert-by-id; no scheduled/automatic exports; no scheduled DB purge (manual-with-gates only; only evidence purge is scheduled).
- No video in export zips; no GCS evidence copy on relocate; no per-contest GCS lifecycle rules / `customTime` machinery; no encrypted exports.
- No soft-delete/trash beyond the export artifact; no contest cloning/templates; no cold-storage archival / BigQuery export.
- No cross-contest candidate linking/dedupe ("same student, two exams"); no global cross-contest search or "all contests" candidate views.
- No automatic selection inference from review verdicts — selection-done stays an explicit click.
- No multi-window scheduling inside one contest (two timings = two contests).

## OPEN QUESTIONS FOR KARTHI

1. Duplicate roll numbers in a roster CSV: the design **rejects the whole upload** with the exact row numbers (so the college fixes the file), instead of today's silent-skip or a soft warning — a silently-kept row would pre-fill the wrong student's identity. OK to be that strict with messy college CSVs, or do you want skip-with-blocking-warning instead?
2. Evidence retention default: you said "3-4 days after selection" — I've set default **4 days**, editable per contest between 1 and 30. Confirm 4, or pick another default?
3. Export zips contain candidate PII (names, emails, scores) and live in GCS **forever** — they ARE the recovery path after a purge. Keep them forever, or should exports also get a retention period (meaning a purged contest eventually becomes unrecoverable)?