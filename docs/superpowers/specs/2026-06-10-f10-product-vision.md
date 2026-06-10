# Aerele Proctor — Consolidated Product Vision (v1 FINAL, 2026-06-10)

**Status: BUILD TARGET.** This document consolidates the two F10.6 vision drafts (standard-first + usecases-first), applies both judges' grafts, and closes every flagged gap. It amends and supersedes the F9 design (`/home/karthi/arogara/proctor/docs/superpowers/specs/2026-06-10-f9-identity-data-lifecycle-design.md`) **only** where stated in §7; everything F9 froze stays frozen. Karthi's 2026-06-10 locked decisions are incorporated verbatim and are non-negotiable.

---

## 1. Executive summary

Aerele Proctor is a self-hosted campus hiring-contest platform. An admin builds a **Template** (named, ordered group of problems + settings) from a global **Problem bank**, instantiates it into a **Contest** (one administered round, with its own roster, rooms, window, and lifecycle), and uploads a college **Roster** whose rows resolve to durable **Persons** keyed by **(college, unique_id)** — the identity spine that makes Round 2 recognize Round 1's people by construction. Each contest hands out two derived links: a candidate portal URL and a per-contest tokenized invigilator URL. Candidates take the exam in the proctored fullscreen shell (screen + mic recorded; camera recorded by default at ~10fps low-res) with the built-in Monaco/Judge0 workspace. Post-exam: a **Results** tab (rank + per-problem scores + integrity evidence) drives bulk **selection** on **Enrollment** rows; the next round is built from a selected subset or a fresh CSV that auto-links to the same persons; a **People** tab shows each person's cross-round scorecard. The F9 data lifecycle (export → triple-gated purge → tombstone; selection-done + retention sweep) survives re-scoped: persons and colleges are never purged with a contest, and a frozen per-enrollment score snapshot keeps cross-round scorecards alive after purge. Integrity remains evidence-collection + human review — never auto-disqualification. Legacy exam data stays readable at every stage.

**Consolidation note.** Judging scored the two visions a near-tie (86 vs 86.5 / 100). This document takes the standard-first entity model (Enrollment with durable selection state, pre-build person-mode identity, unified Results surface, lifecycle sequenced after the person layer) merged with usecases-first's leaner mechanics (server-side college resolution, no-roster `person_id:null` handling, derived display phases, explicit scoring defaults, exhaustive feature inventory), plus fixes for all eight judge-identified gaps (§2.13–2.15, §7 notes).

---

## 2. Entity model

### 2.1 Layer diagram

```
GLOBAL ASSETS                  DEFINITION                 ADMINISTRATION               PEOPLE
─────────────                  ──────────                 ──────────────               ──────
Problem bank ──┐                                                                       College
               ├──> Template ──instantiate──> Contest ──────┐                             │
Alert types ───┘    (ordered problems[]      (round: slug,  │                          Person = (college, unique_id)
(global settings)    + settings defaults;    window, roster,│                             │
                     no schedule/roster)     rooms, links,  ├──< Enrollment >─────────────┘
                                             lifecycle)     │    (person × contest:
                                                  │         │     selection_status,
                                      previous_contest_slug │     final_snapshot)
                                                            ├──< Session (person × contest × device-run)
                                                            │      ├── Submissions (per problem, scored)
                                                            │      ├── Evidence (GCS: screen/, camera/, events, editor NDJSON)
                                                            │      └── Alerts / Reviews
                                                            └──> Lifecycle (export → purge → tombstone; retention sweep)
```

Three-layer content model (Library → Template → Instance, the Mettl definition/administration split) plus the Greenhouse Person/Candidacy split (Person + Enrollment) that pure assessment platforms lack. The research's negative result is honored: **a round IS a contest** — rounds link through Persons and a `previous_contest_slug` pointer, never as sub-entities of one test.

**Global rule (grafted): composite ids are never parsed; their components are always stored as fields.**

### 2.2 College — `proctor_colleges` (doc id = `college_norm`)

```js
{ college_norm: "kec",            // identityNorm(name) — FROZEN once created
  name: "KEC",                    // display, admin-editable (rename = display only)
  created_at, source: "roster_upload" | "manual" }
```

First-class (locked). An identity namespace and grouping axis — no per-college settings, no SPOC/contacts (candidate, §8).

**Canonicalization gate (gap fix — protects the locked multi-round auto-link).** Roster upload runs a college-match step *before* any person is upserted: every distinct college string in the CSV is normalized and matched against `proctor_colleges`. Exact-norm match → linked silently. No match → the upload preview blocks with *"This upload creates N NEW college(s): 'K.E.C.' — use existing 'KEC' or create new?"* and the admin must map-or-confirm each one. This is the only enforceable moment to stop spelling drift from forking every person in the drive.

### 2.3 Person — `proctor_persons` (doc id = `person_id`)

```js
{ person_id: "kec--21cs001",      // "{college_norm}--{unique_id_norm}", deterministic
  college_norm: "kec",            // components stored, never parsed back out
  unique_id: "21 CS 001",         // display form, latest upload wins
  unique_id_norm: "21cs001",      // identityNorm(unique_id) — existing function
  name, email?, phone?, extra: {…other CSV columns},
  created_at, updated_at,
  created_from: { contest_slug, roster_version },
  merged_into: null }             // alias pointer reserved day one (merge UI = candidate, §8)
```

- **A person = (college, unique_id) — stable across contests and rounds (locked).** Round 2 recognizes Round 1's person by construction, not by email heuristics.
- `person_id` is deterministic → linking is idempotent: any future CSV with the same (college, unique_id) resolves to the same person. The upsert **is** the multi-round linking mechanism.
- Profile fields update on each upload (latest wins); identity components are immutable. **Gap fix:** any upload that changes a person's `name`/`email` writes a `proctor_admin_audit` entry (`person_profile_updated`, old → new, contest + roster_version) — silent cross-round renames now leave a trail.
- **Aggregates are NEVER stored on the person.** Cross-round views are computed joins (plus post-purge enrollment snapshots, §2.9).
- **Never deleted by contest purge** — persons are the multi-round memory.

### 2.4 Identity chain — supersedes F9 §1 PRE-build

F9's `identity_mode: "unique_id"` **never ships**. Since the F9 build has not started, new contests go straight to `identity_mode: "person"` — no third stranded identity generation in production data.

```
candidate types unique_id (label-driven prompt, e.g. "Roll Number")
  → server resolves college from the contest roster        // candidate never types a college;
    (college picker rendered ONLY if the same unique_id    //  picker only on genuine ambiguity
     exists under 2+ colleges in this contest)
  → person_id = "{college_norm}--{identityNorm(unique_id)}"
  → session.username_norm = person_id                      // identity_mode:"person"
  → (username_norm, contest_slug) = (person × contest)     // Karthi's locked composite key,
                                                           //  riding the EXISTING universal join key
```

- `username_norm` field name stays **frozen** (F9 D1); only the derivation changes, gated by per-contest `identity_mode` exactly as F9 D3 designed. Enum: `"person"` (all new contests) | `"legacy_username"` (synthesized legacy contest). `candidateOf()` dual-read, dual-norm resume, CI "username" grep — carried verbatim from F9.
- Everything keyed on the composite — live locks (`live:{norm}:{slug}`), alert ids, submission-event ids, GCS paths `contests/{slug}/sessions/{username_norm}/{session_id}/`, review ids — works unchanged; the norm string gains a college prefix. `--` separator is safe inside `:`-delimited ids.
- Within-contest uniqueness is per (college, unique_id): two colleges sharing roll "21CS001" in one contest = two persons, two norms, no collision (extends F9 §1.6 by one row).
- **No-roster contests:** sessions carry `person_id: null` — they don't participate in multi-round linking. Documented limitation. Publish gate requires roster OR an explicit "no-roster contest" acknowledgement.
- **Verification task named in-stage (gap fix):** the longer prefixed norm must pass `sanitizeSegment`, the >120-char `identityNorm` golden tests, Firestore doc-id length limits, and GCS path limits before S-C ships.

### 2.5 Problem — `proctor_problems` (EXISTS, global bank, shape unchanged)

Statement, languages, sample + hidden tests, limits, points, scoring mode, draft/published. Additions: free-form `tags: []` for template building; **assignment moves from the contest's single `problem_id` to membership in template/contest `problems[]` lists** (legacy `problem_id` reads through a shim).

**Live-reference guard (gap fix).** A problem referenced by any non-archived contest's `problems[]` cannot be deleted or unpublished (today's delete-clears-live-assignment behavior at `backend/src/handler.mjs:1388` is replaced by a referenced-by check → 409 with the contest list). Editing hidden tests of a problem referenced by an **open** contest requires a typed confirmation. Rejudge stays a non-committed candidate (§8) — this guard is the v1 protection.

### 2.6 Template — `proctor_templates` (doc id = template slug) — NEW

```js
{ slug, name, description, archived: false,
  problems: [{ problem_id, points, order }],   // ORDERED — "a named group of questions" (locked)
  defaults: {                                  // snapshot-copied at instantiation
    duration_minutes,                          // prefills end_at at instantiation
    identity_label: "Roll Number",
    room_gate_enabled: true,
    camera_recording: { enabled: true, fps: 10, width: 320 },   // F10.1 locked: ON by default,
                                                                // ~10fps low-res; admin owns knobs
    enforcement: { mode, fullscreen_reentry_seconds, fullscreen_exit_limit },
    evidence_retention_days: 4,
    languages: [...] },
  created_at, updated_at }
```

- Templates carry **no schedule, no roster, no rooms** — those are administration (Contest).
- **Instantiation = deep snapshot copy** onto the contest doc + display-only `template_slug` provenance. Template edits never back-propagate (universal clone semantics). Templates have a `Clone` verb. Problem *content* stays bank-resident; the contest snapshots the list + points.
- Alert-type settings stay GLOBAL (F8 decision 5 stands).

### 2.7 Contest — `proctor_contests` (doc id = slug) — F9 §2.1 shape, amended

F9's doc survives wholesale (slugify rules, slug immutable after first session, `status: draft|open|archived`, `listed`, start_at/end_at + S5 semantics, full lifecycle block). Deltas:

```js
{ ...F9 fields,
  template_slug: "aptitude-r1" | null,            // provenance, display-only
  previous_contest_slug: null,                    // round N-1 pointer
  previous_mode: "subset" | "fresh_csv" | null,
  problems: [{ problem_id, points, order }],      // replaces problem_id (legacy shim reads old field)
  colleges: ["kec", "psgtech"],                   // derived from roster at upload, read-only
  identity_mode: "person",
  camera_recording: { enabled: true, fps: 10, width: 320 },
  invigilator_key: "k7Jq…" }                      // per-contest token, regenerable (locked)
```

- **Stored status stays minimal** (F9's three states). Display phase is **derived**: `Draft → Scheduled → Live → Ended → Selection done → Evidence purged → Purged → Archived` — rendered by the lifecycle badge/timeline, never multiplied into stored state.
- **Publish gate** (draft → open): ≥1 problem + window set + (roster uploaded OR explicit no-roster acknowledgement).
- **URLs are DERIVED; `contest_url` is dead (locked).** Candidate portal: `https://<host>/?contest={slug}`. Invigilator: `https://<host>/invigilator?contest={slug}&key={invigilator_key}`. Contest detail shows both with copy buttons + QR codes. The global invigilator password is demoted to Aerele-staff fallback.

### 2.8 Roster — per-contest (F9 mechanics + locked amendments)

Versioned entries + meta-written-last, unchanged. Entry: `{ unique_id, college, name, email, roll_number?, room?, person_id }` — `person_id` resolved (person upserted) at upload. Template CSV (F8.3): `college,unique_id,name` required + `roll_number,email,room` optional.

Upload validation (whole-file atomic, in order):
1. **College column missing/blank → 400, whole file rejected** (locked).
2. **College canonicalization gate** (§2.2) — map-or-confirm new college names.
3. **Duplicate (college_norm, unique_id_norm) pairs on final-norm form → reject the WHOLE upload with line numbers** (locked; resolves F9 Q1 as hard-reject): `400 { error: "duplicate_unique_ids", duplicates: [{ row, college, unique_id, conflicts_with_row }] }`.
4. Same unique_id under *different* colleges in one roster → allowed with warning banner ("N ids ambiguous at login; those candidates will pick their college"). *Veto-able default.*
5. Blank-id rows: skip-with-report (F9, unchanged).

**Re-upload removal semantics (gap fix).** A re-upload that drops a previously-rostered person: the enrollment is marked `status: "removed"` (kept, never deleted — audit + history); an in-flight session **continues** and raises a `roster_removed_mid_exam` admin alert for a human call; attendance denominator = active (non-removed) enrollments. Re-adding the person in a later upload reactivates the same enrollment.

### 2.9 Enrollment — `proctor_enrollments` (doc id = `{contest_slug}::{person_id}`) — NEW

The stable person × contest row that survives roster re-uploads — and, in snapshot form, contest purges.

```js
{ contest_slug, person_id, college_norm,
  status: "active" | "removed",
  source: "csv" | "carry_over", source_contest_slug?,
  selection_status: "none" | "shortlisted" | "selected" | "rejected",
  selection_updated_at, selection_by,
  final_snapshot: null | {                      // frozen at "Mark selection done" (refreshed at purge)
    total_score, per_problem: {problem_id: score},
    integrity: { alerts_by_severity, review_verdict },
    session_status },
  created_at }
```

- Selection = status + bulk transitions with a `from_status` precondition (cheap race guard); the shortlist itself needs no entity (filter + transition, the ATS rule).
- Attendance computes against active enrollments.
- **Purge-survivor rule (gap fix, resolves the locked-purge vs locked-cross-round-view collision):** contest DB purge deletes sessions/submissions/evidence per F9 but **retains enrollments**, stamping/refreshing `final_snapshot` first. The cross-round scorecard reads live data where it exists and falls back to `final_snapshot` after purge — Round 1's score and selection outlive Round 1's purge as "light data". *Pending Karthi confirmation (Q2).*

### 2.10 Session — `proctor_sessions` (EXISTS, additive fields only)

F9 §1.2 shape + `person_id`, `college_norm` denormalized at start; `username_norm = person_id` under person mode. Status machine (`active|locked|pending_approval|ended`), live-lock, resume, second-device pending_approval, enforcement fields, `storage_prefix` — all unchanged. Capture state gains `camera: recorded|live-only|denied`. Evidence adds `camera/chunk-*.webm` under the same `storage_prefix` (F10.1 — **modeled here, designed and built separately**, locked; retention sweep covers camera chunks for free).

### 2.11 Submission & scoring

`proctor_submissions` per (session, problem): F9 D7 denorm (`contest_slug`, `username_norm`, `candidate_id`) **plus `person_id` and `problem_id`** on new docs. Exec/submit already accept per-submission `problem_id` (`handler.mjs:813, 866–868`) — multi-problem is contest-doc + workspace UI + scoring rollup.

Scoring (computed, never stored on the person; *veto-able defaults*): per-problem score = **best** submission; contest score = Σ best-per-problem; tie-break = earlier last score-improving submission time.

### 2.12 Rooms, gates, invigilator access

Per-contest `rooms[]`, `proctor_room_gates` (start codes, unlock codes, open state), exemptions, lock-release, `show_to_invigilator` filtering, least-privilege room projection (F9.1–9.4) — unchanged. Invigilator access = per-contest link token (§2.7) + name entry for attribution. **Rooms are cleared on carry-over rosters** (Round 2 halls differ).

### 2.13 Alerts, review, monitoring — multi-problem & multi-college ripple (gap fixes)

- Shared alert contract unchanged; person-mode norms slot into existing composite ids.
- **Problem-id partitioning:** once contests carry `problems[]`, contest-eval similarity (peer-copy/web-paste) is computed **per problem**; submission-event ids and alert dedupe keys gain a `problem_id` component on new data (S-F scope, accept-both on ingest).
- **Multi-college projection rule:** wherever a candidate is rendered on an operational surface (invigilator rows, alerts, attendance, sessions, Results) and `contest.colleges.length > 1`, the college is appended to the label-driven identity ("Roll Number 21CS001 · KEC") — two same-roll candidates are now humanly distinguishable, not just key-distinct.
- Review collections: F9 `{norm}::{reviewer}::{slug}` ids unchanged. Recordings Review mode gains a synced camera pane, and (late-stage) a **code-replay scrubber** over the already-captured editor-event NDJSON.

### 2.14 Results & cross-round views

- **Results tab (NEW, one surface):** per-contest ranked table — rank, candidate (label-driven id + name + college), total, per-problem scores, integrity column (alert counts by severity + review verdicts), selection_status, bulk selection transitions, "Mark selection done" (starts the retention clock). **Admin-only — candidates never see each other's scores** (hiring context; deliberate divergence from contest platforms). CSV export.
- **People tab (NEW):** directory (search by college/id/name) → person page = cross-round scorecard: one row per contest (status, score, integrity, selection; live join or `final_snapshot` fallback). Exportable CSV. Uses an explicit ALL_CONTESTS sentinel so the F9 no-bleed canary suite stays intact.

### 2.15 Legacy adoption into the person model (gap fix — the first real Round 2 depends on this)

Contests already run (legacy/F9-era norms, no college component) get a one-time **"Adopt into person model"** action on contest detail: re-upload that contest's roster **with the college column** → rows match existing sessions/submissions via the contest's own identity lookup → `person_id` is **stamped as a denormalized field** onto those docs and enrollments are materialized (`source:"csv"`, snapshot computed). `username_norm` and all keys stay untouched (frozen). After adoption, the already-run contest appears on person scorecards and can seed a carry-over Round 2.

### 2.16 Data lifecycle — F9 §3 survives wholesale, re-scoped (locked)

Export (GCS-first zip, paginated readers, JSONL truth + CSV derivations) → triple-gated purge (fresh-export AND-checks, typed name, zero live sessions, no force flags) → tombstone with `evidence_prefixes` → import/relocate → `proctor_admin_audit` → selection-done + daily Cloud Scheduler retention sweep (default 4 days; F9 Q2 default stands). Deltas:
- Export zip gains `enrollments.jsonl`, `persons.jsonl` (referenced persons), `colleges.json` — **from `schema_version: 1`**, because lifecycle is staged after the person layer (§7). Exports stay self-contained.
- Contest purge deletes contest data but **NOT persons or colleges**; **enrollments are retained with `final_snapshot`** (§2.9).
- F9 YAGNI items explicitly REVERSED by F10: cross-contest candidate linking (now Person), templates/cloning (now Template), global cross-contest views (now People). Everything else in F9 §9 stands.

---

## 3. Naming standard

| Term | Means | Replaces / banned |
|---|---|---|
| **Person** | durable (college, unique_id) identity across contests | "user", email-keyed anything |
| **Candidate** | a person in the context of one contest | "student" in admin/invigilator UI |
| **College** | identity namespace + grouping axis, first-class | "organization", "tenant" |
| **Problem** | atomic item in the global bank | "question", "challenge" in UI |
| **Template** | named ordered problem group + settings defaults; no schedule/roster | — |
| **Contest** | one administered round (admin/internal word) | "test"; "the exam" as a global singleton; `contest_url` (dead) |
| **Exam** | candidate-facing word for the contest being taken | — |
| **Round** | informal word for a contest in a drive sequence — NOT an entity | — |
| **Roster** | the per-contest uploaded CSV artifact (versioned) | "invite list" |
| **Enrollment** | stable person × contest membership + selection state + final snapshot | "shortlist" as a noun/entity |
| **Session** | one device-run of a candidate (the only word; "attempt" not used) | — |
| **Submission** | one scored submit on one problem | — |
| **Selection** | shortlisted/selected/rejected status on enrollments | — |
| **{identity_label}** | admin-designated label ("Roll Number") drives ALL candidate-facing identity strings | **"username" — banned in rendered UI, CI-grep enforced** (F9) |
| **Invigilator** | room-level human | "proctor" (reserved: product name) |
| **Lifecycle** | export → purge → tombstone; selection-done → retention sweep | — |
| Frozen internals | `username_norm`, `hackerrank_username` (legacy read-only), `proctor_*` collection names, `storage_prefix`, `college_norm` once created | never rename (F9 D1) |

---

## 4. Primary user journeys

### J1 — Admin sets up a drive (template → contest → roster → links)

1. **Template** (once per round-type): Templates tab → "Aptitude Round 1" → pick problems from bank (tags/search), order, points → defaults (camera ON @10fps, room gate ON, enforcement knobs, identity label "Roll Number", duration) → save. Or clone.
2. **Contest:** Contests tab → New → pick template (or blank) → name "KEC June 2026 — Round 1" → live slug preview → window (end_at prefilled from duration) → rooms → settings pre-filled, editable → create (`draft`). Two parallel colleges = two contests, zero shared state (no-bleed canary suite is the proof).
3. **Roster:** contest detail → upload CSV → college gate (map-or-confirm new names) → dup-reject with line numbers if dirty → persons upserted/auto-linked, enrollments materialized, colleges chip-listed.
4. **Links out:** candidate URL + invigilator URL (+ QR for both). Set `open` (publish gate). Lab admins pre-open the candidate URL.
5. **Day-before:** the always-open **system-check contest** (a tiny no-roster contest from a preset template) verifies each weak lab machine — permissions, fullscreen, Judge0 round-trip. Day-of: demo mode + admin's own smoke run.

### J2 — Invigilator, day of exam

Per-contest tokenized link on the room machine → name entry → room picker → room dashboard: stat tiles (clickable filters), expected-roster rows with status/recording badges → release/regenerate the 6-digit room start code (or room-wide Start now) → watches room-scoped alerts (college appended when multi-college) with click-to-expand candidate detail → unlock codes for enforcement-locked students, per-student exemptions, approves pending second-device sessions with the candidate standing there. All shipped (S3 + F5.5/5.6 + F9.1–9.4); only the link/auth entry changes.

### J3 — Candidate (weak lab machine)

`/?contest={slug}` (or open-contest picker fallback) → **permissions first** (screen required; camera/mic prompts — camera now recorded at ~10fps low-res when enabled, recording indicator shown) → **fullscreen gate** → identity: "Enter your Roll Number" (label-driven; server resolves college from roster, picker only on genuine ambiguity) → roster match prefills name (server-override) → consent → recording starts → **room gate** waits for the invigilator's code → **multi-problem workspace**: problem-list sidebar, Monaco per problem, Run (samples) / Submit (hidden tests) per problem with per-problem budgets and verdict banners, free switching → enforcement as shipped (L1 typed re-entry, L2 lock/alert_first, switch-away episodes, anomaly-hiding top bar) → End: integrity checkbox → done. Reload resumes; machine death → another machine, same URL, same roll number, invigilator approves the pending session.

### J4 — Post-exam: review → selection → next round → lifecycle

1. **Review:** Recordings Review mode (reviewer-gated verdicts, timeline overlay, camera pane synced, code replay), alerts console triage, contest-eval poller alerts (peer-copy/web-paste, per problem), IP report sweep.
2. **Results:** ranked table + integrity column → filter (college, room, score, no-critical-alerts) → bulk `shortlisted` → refine → `selected`/`rejected` → **Mark selection done** (snapshots enrollments, starts the 4-day evidence clock).
3. **Next round:** Contests tab → New → template "Tech Round 2" → **roster source "From a previous contest"** → pick Round 1 → filter (selection_status / score threshold / manual ticks) → enrollments created `source:"carry_over"`, same person_ids, rooms cleared — OR upload a fresh CSV, which auto-links to the same persons anyway (locked: both paths). `previous_contest_slug` recorded.
4. **Lifecycle:** Export (zip → GCS, signed URL) → retention sweep purges evidence → later, triple-gated DB purge → tombstone; enrollment snapshots survive; contest stays in the selector ("data purged — restore from export").
5. **Cross-round view:** People tab → person → scorecard: Round 1 + Round 2 side by side (locked), final-selection CSV export.

---

## 5. Surface map

| # | Surface | Purpose | Status |
|---|---|---|---|
| **Candidate app (`/`)** | | | |
| C1 | Contest entry (`?contest=` + open-contest picker fallback) | route to the right contest | NEW (F9 S-D specced) |
| C2 | Permissions gate | all prompts pre-fullscreen; camera stream now recorded | REWORK (camera recording wiring, F10.1) |
| C3 | Fullscreen gate | anti-proxy blank screen | EXISTS |
| C4 | Identity panel | label-driven id entry; server-side college resolution, picker on ambiguity; roster prefill | REWORK (F9 label plan + college) |
| C5 | Room code panel | invigilator start gate | EXISTS |
| C6 | Exam workspace | Monaco + Run/Submit | REWORK (**multi-problem sidebar, per-problem submit state/budgets, score sum**) |
| C7 | Exam top bar | time/name/room, anomaly-hide | EXISTS |
| C8 | Camera self-view / PiP | candidate sees own camera | REWORK (recording indicator) |
| C9 | Enforcement overlay / blocked / unlock | L1/L2 + invigilator unlock | EXISTS |
| C10 | End / done / retry panels | integrity checkbox, manifest | EXISTS |
| **Admin (`/admin`)** | | | |
| A1 | Contest selector | scopes every tab; URL-param (per-tab) so two parallel drives = two browser tabs | REWORK (F8 d.11 + per-tab scoping) |
| A2 | Contests tab | list (name, slug, derived phase badge, window, counts, lifecycle badge) + create-from-template + roster-source-from-previous-contest | NEW (F9 S-D skeleton + template/carry-over pickers) |
| A3 | Contest detail | links+QR, invigilator key (regenerate), roster upload + college gate, rooms, settings, problems snapshot, round provenance, lifecycle timeline + export/purge/restore/selection-done, adopt-into-person-model, audit trail | NEW (F9 §4.3 + this spec) |
| A4 | Templates tab | template CRUD, ordered problem builder, defaults, clone, archive | NEW |
| A5 | People tab + person page | directory search (college/id/name) → cross-round scorecard; CSV export | NEW |
| A6 | Results tab | rank + per-problem + integrity column + bulk selection + selection-done | NEW |
| A7 | Live stats + ExamTimeCard | live counts, extend/end-now | EXISTS (scoped) |
| A8 | Alerts console | triage, grouping, bulk, contextual actions | EXISTS (scoped; college appended when multi-college) |
| A9 | Sessions + SessionDetailCard | drill-down, status actions | REWORK (label-driven, person link, college, camera capture state) |
| A10 | IP report | cluster/off-campus detection | EXISTS (scoped) |
| A11 | Attendance | taken/not-taken vs active enrollments, CSV | REWORK (enrollment-based, college column) |
| A12 | Recordings (browse + review mode) | stitched playback, timeline overlay, verdicts | REWORK (camera pane; code-replay scrubber late-stage; F8.2 de-HR'd labels) |
| A13 | Review tab | per-session evidence search; session-details CSV (Item B) | REWORK (F8.2 redo without HR usernames, label-driven) |
| A14 | Problems tab | bank CRUD | REWORK (tags; live-reference guard; assignment moves to templates/contests) |
| A15 | Settings tab | GLOBAL-only residue: alert types, credentials, defaults | REWORK (per-contest fields migrate to A3/A4) |
| A16 | Purge modal / lifecycle panels | F9 S-G UI | NEW |
| **Invigilator (`/invigilator`)** | | | |
| I1 | Entry | per-contest link + key, name entry | REWORK (token auth) |
| I2 | Room dashboard | tiles, gate card, unlocks, exemptions, alerts | EXISTS (F9.1–9.4 shipped) |
| **System** | | | |
| S1 | Lifecycle endpoints + Cloud Scheduler sweep | F9 §3 | NEW (F9 S-G/S-H) |
| S2 | Monitoring poller / contest-eval + verdict seam + tab-away detector | integrity alerts ingest | REWORK (F8.5 restartability; problem_id partitioning; Item C tooling contest-scoped) |
| S3 | Video worker | merge for review | EXISTS (+ camera merge later) |
| S4 | Demo mode | full-UI localStorage fake | REWORK (**parity for every NEW surface — non-negotiable acceptance bar**: Templates, People, Results, lifecycle panels) |
| S5 | Deploy scripts | — | EXISTS |
| S6 | System-check contest | day-before lab-machine verification (preset template, always-open, no-roster) | NEW (thin: preset + docs) |

---

## 6. Feature mapping — every current feature + every F5–F10 ask. Nothing dropped.

| Item | Slot | Disposition |
|---|---|---|
| S1 exam shell, 5-stage onboarding | C2–C10, J3 | shipped, kept |
| S2 roster login | §2.4, §2.8 | shipped; gains server-side college resolution |
| S3 invigilator portal + room gates | §2.12, I1–I2, J2 | shipped; gains per-contest token link |
| S4 problem authoring | §2.5, A14 | shipped; feeds templates; + tags + live-reference guard |
| S5 dynamic time / end-now | §2.7 (per-contest window) | shipped, per-contest per F9 |
| S6 attendance | A11 | shipped; enrollment-based + college column |
| S7 + F8.1 IP report drill-down | A10 | shipped, kept |
| Exec queue, Judge0 adapter, submission budgets | C6, §2.11 | carried; per-problem under `problems[]` |
| F5.1 permissions-first | C2 | shipped; camera stream reused for recording |
| F5.2 integrity-checkpoint investigation | C6/C10 | KEPT-OPEN: remove if click-only/no-signal — discuss with Karthi (in-flight task) |
| F5.3–5.7 enforcement L1/L2, switch-away, exemptions, unlock, top-bar | C7, C9, I2 | shipped; L2 "approve-before-block" optional mode stays a settings knob on template/contest |
| F6.3/6.4/6.6/6.7 session card, alert actions, capture state, timeline | A8/A9/A12 | shipped; capture-state wording (task #35) superseded by camera-recorded state |
| F7 encoding optimization | recorder, S3 | unchanged: LAST, discuss-before-build |
| F8.2 HR de-dependency | §3, A13 | carried in full (F9 S-A/S-E + CI grep) |
| F8.3 roster template CSV | §2.8 | shipped; gains compulsory `college` column |
| F8.4 multi-test S-A→S-F | §2.7, A1–A3 | carried; absorbed into amended staging (§7) |
| F8.5 contest-eval restartability + zero-alerts bug | S2 | carried, stays S-F; + problem_id partitioning (§2.13) |
| F9.1–9.4 invigilator UX | I1–I2 | shipped; final verification (task #33) stays open, slotted in §7 S-D acceptance |
| F9.5 identity/label | §2.4 | build-ready; `identity_mode:"unique_id"` superseded by `"person"` PRE-build |
| F9.6 contests + no-bleed | §2.7, A1–A3 | build-ready, kept verbatim; People tab uses explicit ALL_CONTESTS sentinel |
| F9.7 lifecycle (S-G) | §2.16, A3, A16, S1 | build-ready; + persons/enrollments/colleges in export; persons+colleges excluded from purge; enrollments survive with snapshot |
| F9.8 retention (S-H) | §2.16 | build-ready; Q2 4-day default stands; camera chunks covered free via `storage_prefix` |
| F10.1 camera recording ON | §2.10, C2/C8, A12 | modeled (default ENABLED, `{enabled,fps,width}`, `camera/chunk-*.webm`, review playback); **designed/built separately (locked)** |
| F10.2 person = (college, unique_id) | §2.3–2.4 | THE central amendment; reverses F9 YAGNI on cross-contest linking |
| F10.3 dup-reject with line numbers | §2.8 | locked; scoped to (college, unique_id) final-norm; resolves F9 Q1 |
| F10.4 multi-round + cross-contest score view | §2.9 carry_over, §2.15, J4, A5 | both locked paths (subset carry-over + auto-linking fresh CSV); People scorecard; legacy adoption backfill |
| F10.5 templates → instances, per-contest links | §2.6–2.7, J1 | snapshot instantiation; invigilator_key + derived URLs; `contest_url` dead |
| F10.6 vision exercise | this document | done; amends F9 per §7 |
| F2 / F2.1 / F2.2 (OMR markers, focus correlation, exit challenge) | enforcement backlog | unscheduled backlog, carried (partially absorbed by F5) |
| Wave-3 polish (task #38) | A7–A15 | carried as-is, scheduled post-S-D |
| Item B — session-details CSV (shipped) | A13 | kept; identity columns go label-driven + dual-norm handling carries over |
| Item C — submission-events download/upload tooling (shipped, `monitoring/*.sh`) | S2 | kept; reworked contest-scoped + problem_id-aware in S-F |
| ROADMAP 6.1 WebSockets vs 5s polling | S2/A7 | surfaced to Karthi (Q5) — keep-dead or backlog |
| Demo mode | S4 | kept; parity for every NEW surface is an acceptance bar |
| Video worker, deploy scripts | S3, S5 | kept |
| Monitoring poller + verdict seam + tab-away detector | S2 | kept |
| Legacy exam data readable | F9 §6 shim + §2.15 adoption | kept verbatim (locked) + gains opt-in person adoption |

---

## 7. Amended migration staging

F9's stage spine survives; this section **supersedes F9 §5 where the entity model changes it**. Every stage independently shippable, testable, rollback-safe; legacy data readable at every stage (F9 §6 frozen-invariants spine untouched); destructive ops only behind S-G/S-H gates. Per stage: spec → TDD → local commit, **no push** (locked).

| Stage | Content | Amendments vs F9 |
|---|---|---|
| **S-A** | Frontend rename, "Candidate ID" interim label, CI "username" grep | unchanged |
| **S-B** | Contests collection ships dark; `resolveContest`; legacy-contest synthesis; `scopedQuery` chokepoint | `identity_mode` enum = `"person" \| "legacy_username"` — **`"unique_id"` is deleted from the design before any code exists** |
| **S-C** | Scoping + identity core: per-contest roster, hard-reject dup validation, `candidateOf` DTOs, dual-norm resume, per-contest review ids, submissions denorm, canary isolation suite | **AMENDED — person layer folds in pre-build:** `proctor_persons` + `proctor_colleges` + `proctor_enrollments`; person-norm derivation (`username_norm = person_id`); compulsory college column + canonicalization gate + dup-reject with line numbers; server-side college resolution + ambiguity picker; re-upload removal semantics; person-profile audit entries; no-roster `person_id:null`; **named acceptance task: composite-norm bounds verification** (sanitizeSegment, identityNorm goldens, doc-id/GCS path limits). Legacy contest keeps today's code path bit-for-bit |
| **S-D** | Admin + candidate UX: Contests tab + detail skeleton, selector scopes every tab, `?contest=` routing + picker, label-driven surfaces, duplicate-reject panel, demo parity | **AMENDED:** + invigilator token auth (key on contest doc, regenerate, global password → fallback); selector scoping via URL param (per-tab, parallel-drive safe); F9.1–9.4 final verification (task #33) closes here; Wave-3 polish (#38) rides behind |
| **S-E** | HR field cleanup: `candidate_id` on new sessions, ingest aliases forever, `contest_url` write paths deleted | unchanged |
| **S-I (NEW)** | **Templates + multi-problem:** `proctor_templates`, Templates tab, snapshot instantiation, clone; contest `problems[]` + legacy `problem_id` shim; multi-problem candidate workspace (C6 sidebar, per-problem Run/Submit/budgets); scoring rollups (best-per-problem defaults); problem live-reference guard + tags; system-check template preset | the largest single delta to the product — sequenced as its own stage; scope of the candidate-workspace half gated on Q1 |
| **S-J (NEW)** | **Results + rounds + people:** Results tab (rank/per-problem/integrity column/bulk selection/selection-done trigger); carry-over roster source with filters (`source:"carry_over"`, rooms cleared, `previous_contest_slug`); People tab + cross-round scorecard; legacy adopt-into-person-model backfill (§2.15); demo parity for all three | new; **must land before S-G** so exports are self-contained from day one |
| **S-G** | Data lifecycle: export → gated purge → tombstone → import/relocate → audit → lifecycle UI | **AMENDED:** export `schema_version:1` includes `persons.jsonl`/`enrollments.jsonl`/`colleges.json` from the start (no later schema bump); purge retains persons, colleges, and snapshot-stamped enrollments (§2.9, pending Q2) |
| **S-H** | Evidence retention: selection-done, sweep endpoint + Cloud Scheduler, manual purge button | unchanged; selection-done now triggered from Results; camera chunks swept free via `storage_prefix` |
| **S-F** | Contest-eval adapter restartability + zero-alerts investigation | stays LAST (lands on final field names); **AMENDED:** + problem_id partitioning of similarity/dedupe keys; Item C tooling reworked contest-scoped |
| **Parallel track** | Camera recording (F10.1) | modeled in this spec (`{enabled, fps, width}` default ON @ ~10fps low-res, `camera/chunk-*.webm`, review camera pane); **designed and built separately (locked)** — lands whenever ready, no stage dependency |
| **Post-spine** | Code-replay scrubber over editor NDJSON; F7 encoding optimization (discuss first) | sequenced after S-F |

---

## 8. Standard-pattern candidates — flagged, NOT committed

1. **Typed 6-char contest access code** (Mettl invitation-key) — bare landing page + short code beats typing slug URLs on weak lab machines. Strongest candidate → Q3.
2. **Per-attempt integrity rollup chip** (High/Med/Low, HackerRank/Mettl pattern) — all inputs exist in the Results integrity column; only the rollup formula is missing. Human-review-feeding, never auto-reject.
3. **Person merge UI** — `merge(a,b)` admin op for typo-forked identities. `merged_into` field is reserved on day one (cheap schema insurance); the college canonicalization gate is the v1 mitigation; build the UI the first time it bites.
4. **Rejudge verb** (Codeforces system-test pattern) — re-run submissions after a broken hidden test or Judge0 outage; the live-reference guard is the v1 protection.
5. **Session reset/reopen verb** — archive-and-start-clean for "wrong person logged in as me"; resume already covers machine death.
6. **Drive/Campaign grouping entity** — `previous_contest_slug` chains + People tab cover the mechanics; YAGNI until funnel reporting demands it.
7. **Per-candidate duration** — our halls are synchronized by design; only if remote/async contests ever happen.
8. **Person-level PII retention** (purge persons with no remaining contest data) — the GDPR-shaped gap; deliberate non-goal for now since persons ARE the multi-round memory.
9. **Cross-contest similarity corpus** for contest-eval (Codility pattern).
10. **Multi-contest live ops board** — per-tab URL scoping (S-D) makes two browser tabs work for parallel drives; a combined read-only board waits for demand.
11. **Reports API / ATS metadata passthrough** — only if an external system ever orchestrates Aerele.
12. **Explicitly NOT adopting:** email invites + expiry/reminder machinery (no reliable candidate emails — rosters + hall links are the model), candidate-visible leaderboards (hiring context), question-variation anti-leak pools, virtual replay/hacking phases, RBAC/SSO/multi-tenancy (F9 YAGNI stands).

**Veto-able defaults shipped without asking:** same unique_id under two colleges in one roster = warn-not-reject; per-problem score = best submission; tie-break = earlier last improvement; persons never auto-purged; evidence retention default 4 days (F9 Q2).

---

## 9. OPEN QUESTIONS FOR KARTHI (voice-answerable)

1. **Multi-problem timing.** Templates as "named group of questions" makes contests multi-problem — the costliest single build item (candidate workspace switcher + per-problem scoring). Build the full multi-problem workspace in this push (S-I as written), or ship templates first restricted to one problem and add the switcher as the next stage? *(Answer: "full now" / "single-problem first".)*
2. **Scores survive purge?** Contest purge deletes sessions/submissions, but your cross-round scorecard needs Round 1's numbers after Round 1 is purged. Plan: keep tiny per-person enrollment rows with a frozen final score + selection status through the purge ("light data"), everything heavy still deleted. OK? *(yes/no)*
3. **Typed access code.** Add a 6-character contest code + bare landing page so lab machines type a short code instead of a slug URL? *(yes/no)*
4. **Export-zip retention (F9 Q3, still open).** Export zips in GCS: keep forever until manually deleted, or auto-delete after N days? *(forever / N days)*
5. **ROADMAP 6.1.** WebSockets vs the current 5s polling — kill the idea or keep it on the backlog? *(kill/backlog)*