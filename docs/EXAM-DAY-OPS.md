# Exam-Day Operations Runbook (1 page)

For the person running a live test on the Aerele proctor platform. Every behavior below is verified against this repo's routes/UI; anything not directly verifiable is marked **(unverified)**. Console = `<web-url>/admin`, unlocked with `ADMIN_PASSWORD`.

Conventions: candidate URL `<web>/?contest=<slug>` · invigilator URL `<web>/invigilator?contest=<slug>&key=<invigilator_key>` (derived in `admin/contestAdmin.ts`).

---

## 1. BEFORE the exam — admin console

1. **(Optional) Template** — *Templates* tab. A named reusable blueprint (ordered problems + defaults + rules); appears in the New-contest dropdown. Built-in **`system-check`** preset = day-before, always-open, no-roster lab check; instantiate it and run one trivial problem on every machine (`backend/src/templates.mjs`).
2. **Problems** — *Problems* tab. Statement, languages (python/cpp/java/javascript), **sample + hidden tests**, time/memory limits, points, scoring `per_test` (proportional) or `all_or_nothing`, optional **per-language starter stubs**, draft → published. Only **published** problems are assignable. Editing **hidden tests while an OPEN contest references the problem** requires the typed `confirm_live_edit` confirm, else `409` (`handler.mjs`).
3. **Create the Contest** — *Contests* tab. Name (slug auto-derived); from a template (snapshots the problem list + settings) or blank. Set ordered problems, **exam window** (start/end), **rooms** (+ room-gate on/off), evidence retention days. Problem *content* stays live from the bank — delete/unpublish of a referenced problem → `409 problem_referenced`.
4. **Upload the roster** — contest's *Candidate roster* section. CSV/TSV, any columns; **`college` and `unique_id` are compulsory** (so is `name`), pick the unique-ID column (its label drives the candidate prompt). Unknown colleges hit a map-or-confirm step. **Duplicate `(college, unique_id)` → the whole file is REJECTED with row numbers** (`roster/personRoster.ts`). Identity = `person_id = "{college_norm}~{uid_norm}"`, stable across contests. A **Download template CSV** button is offered.
5. **Open + distribute** — contest detail shows the **test (access) code** for the candidate landing and the per-contest **invigilator key/link**, both copyable and **Regenerate**-able (`/api/admin/contest-regenerate`). Regenerating immediately invalidates old codes/links.
6. **Scale** — set the service **min-instances = 1** so the first candidate isn't hitting a cold start. *(deploy-time concern; see `docs/DEPLOY.md`.)*

> Verified: `night-run/evidence/e2e/admin-setup/11-contest-detail-live.png`, `.../09-roster-preview.png`, `.../07-published-problem-list.png`.

## 2. AT START

- **Invigilators** open `<web>/invigilator?contest=<slug>&key=<key>` → enter a **name only** (tokenized; the name is recorded against every code they release). Pick the room → room console.
- **Candidates** open the access-code link — **distribute the full `?contest=<slug>` link, not the bare domain**: if a legacy settings doc exists the bare `/` can show the legacy shell with no code box (E2E-live F6) → **Stage 1 Permissions** (share **Entire Screen** + allow camera/mic/clipboard; recording starts) → **Stage 2 Fullscreen** → **Stage 3 Details**: type the unique ID → roster lookup pre-fills name/email/room → **"Yes, this is me"** → **Stage 4 workspace**. If the room start-gate is on, the candidate **waits** until the invigilator releases the room.

> Verified: `night-run/evidence/e2e/candidate/01-permissions-gate.png` → `04-details-filled.png`; `invigilator/01-portal-entry-nameonly.png`, `02-room-picker.png`.

## 3. DURING — where to watch / what to do

**Watch (admin tabs):** **Live stats** (status counts incl. derived *disconnected*, 5s auto-poll, cards drill into Sessions) · **Live alerts** (newest-first; room/severity/source filters; group by candidate/type; bulk archive; video deep-links) · **Sessions** (+ detail card: events, submissions, screen/camera chunk counts) · **IP report** (cluster / off-campus detection → drill-down) · **Attendance** (taken / not-taken / absentees). The **invigilator portal** (separate `/invigilator` app) gives room staff live counters + the room candidate table.

**Time control (Live stats → Exam time card):** push a new end-time live, or **End now…** (two-click; immediate end for everyone). The candidate timer follows session status and stops on end.

**Candidate LOCKED — the ladder (`shell/enforcement.ts`):**
- **L1 (self-serve):** on a fullscreen exit while recording, a takeover overlay requires TYPING `I will not exit full screen after this` **and** re-entering fullscreen within the countdown (default ~20s, admin-configurable). No staff needed. **⚠️ Set the contest's re-entry window to 45–60s** — at the 20s default, typing the 38-char phrase + re-entering rarely fits (E2E-live verified: near-impossible even deliberately) and compliant candidates get locked.
- **L2 (needs you):** countdown expiry **or** more than K exits → session **LOCKED**. To release: the invigilator mints a **6-digit unlock code** (its own namespace — **NOT the room start code**) and reads it to that one student to type in the candidate Unlock panel; **or** uses the per-row **Unlock** action; **or** an admin unlocks from Sessions.
- **Genuine environment problem:** invigilator sets a **per-student enforcement exemption** (Fullscreen / Switch-away toggle) — an exempt session never engages the overlay (the exemption releases any active overlay on the next heartbeat). Switch-away is debounced (notification, not auto-block).

**Floor protocol (glance test — W2 redesign):** a healthy candidate screen shows a **slim dark strip** on top (green stage block + pulsing REC). A **big red full-width banner** means a live problem (fullscreen exit, share/camera lost, recording stopped) — **red banner = walk over**. (Inverted from the pre-2026-06-12 build, where the prominent bar showed when healthy.)

**Invigilator room actions** (`routes/invigilator.mjs`): release/regenerate the room **START** code (only when room-gate enabled), **open room** (start-now/allow-all), mint **unlock** code, per-student exemptions, per-student unlock. Invigilators see **only** alert types the admin marked "Share with invigilator" (**default: all OFF**).

> Verified: `night-run/evidence/e2e/candidate/11-enforcement-overlay.png`, `12-enforcement-locked.png`; `invigilator/05-unlock-code-generated.png`, `06-candidate-table-exemption-toggles.png`; `admin-review/01-live-stats.png`, `04a-alerts-console.png`, `05-ip-report-drilldown.png`, `06-attendance.png`.

## 4. AFTER

1. **Results** tab — ranked table (per-problem best, integrity column). Shortlist / select / reject candidates, then **Mark selection done** (freezes a snapshot + starts the retention clock). CSV export. Cross-round per-person view in **People**; recordings in **Recordings** (screen + camera, events/alerts timeline, click-to-jump).
2. **Data lifecycle** (contest detail) — **Export** first (downloads a self-contained archive). Then the **triple-gated Purge**: a prior export must exist + tick "I understand…" + **type the contest slug exactly**. Purge deletes sessions/submissions/recordings; **scores and selection always survive** (tombstone). Evidence auto-deletes via GCS lifecycle at **age 3 days**; export zips at **age 11 days** (`backend/gcs-lifecycle.json`).

> Verified: `night-run/evidence/e2e/admin-review/07d-results-selection-done.png`, `09-export-done-purge-enabled.png`.

---

## If X → do Y

| If… | Do… |
|---|---|
| Candidate's screen says **"YOU LEFT FULLSCREEN"** (L1) | Nothing — they type the exact sentence + re-enter fullscreen before the countdown; self-resumes. |
| Candidate is **LOCKED** (L2) | Invigilator mints the **6-digit unlock code** (not the start code), reads it to that one student to type; or uses the per-row **Unlock**. |
| Genuine environment issue (flaky fullscreen / must alt-tab to a tool) | Invigilator toggles the **per-student exemption** for that candidate. |
| Candidate **"Waiting"** at stage 3 | Room start-gate is on — invigilator **releases the room code** or **opens the room** (allow-all). |
| Candidate's **ID not found** | They mistyped the unique ID, or it isn't on the roster — verify against the uploaded CSV. |
| Roster CSV **rejected** | Duplicate `(college, unique_id)` or missing `college`/`unique_id`/`name` — read the row numbers, fix, re-upload. |
| **Second device** for the same person/contest | New device shows `pending_approval` (one live session per person). |
| Need to **stop the whole exam** | Live stats → **End now…** (immediate end for everyone). |
| Need **more time** | Live stats → set a new end-time (pushes live to candidates). |
| Invigilator code **leaked** | *Contests* detail → **Regenerate** the access code / invigilator key (old ones die instantly). |
| Can't see expected **alerts in the portal** | Admin must mark those alert types "Share with invigilator" (default all OFF). |

*Detail on any feature: see `docs/features/`.*
