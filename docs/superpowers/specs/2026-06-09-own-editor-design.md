# Own Editor — self-hosted coding-contest platform (design)

**Status:** DRAFT — awaiting Karthi's review (he stepped away 2026-06-09; this is the restartable source of truth).
**Author:** Ram. **Date:** 2026-06-09.
**Related:** `RESUME.md`, `TODO-admin-polish.md`, the hiring-round notes (`hiring-round-software-developer-internship-summary-2026-06-06.md`).

---

## 1. Vision & context

Today candidates code on **HackerRank** (an external `contest_url`) while our proctoring app records only their **screen**. Keystrokes/mouse/editor events are uncapturable because HackerRank is **cross-origin** — the browser won't let our page read events inside it.

The own-editor goal: **replace HackerRank's coding surface with our own editor, embedded same-origin inside the proctored page**, so we capture keystroke/mouse/editor events for authenticity analytics, run/judge code via Judge0, and own the whole exam experience (fullscreen lockdown, invigilation, identity). End state = a **full HackerRank-replacement platform** (Karthi's choice).

We build it in **slices** (architect-style: each slice locked and valid before the next). The full platform is the destination; Slice 1 is the first spec.

---

## 2. Locked decisions (brainstorm outcomes, 2026-06-09)

1. **Scope:** full platform (auto-judge + leaderboard + problem bank + authoring), built slice-by-slice.
2. **Execution engine:** **hosted Judge0 API (pay-per-use)** for now, behind a **thin swap-able adapter** in our backend (so we can flip to self-hosted ephemeral Judge0 later with no app changes). Self-host is parked — do NOT build it now. Karthi supplies the API key at the build step. Judge0 key lives **server-side only**, never in the client.
3. **Languages (Slice 1):** Python, C/C++, Java, JavaScript (all four).
4. **Capture depth (Slice 1):** keystrokes (insert/delete), paste, **editor cursor position, selection range**, line changes, focus/blur, run/submit. **OS mouse-movement is DEFERRED** to the analytics slice. (Editor cursor/selection is low-volume + high-signal — the "revisiting / non-linear editing" signal; OS mouse-pointer is the noisy one we skip.) Coalesce rapid cursor moves.
5. **Candidate identity:** **roster-based** (NOT pure self-asserted) — see §6/§7. Pre-fed compulsory student list + unique-ID confirm + fullscreen-first + room-wise session-start OTP + invigilator ID check.
6. **Editor session = proctor session** — one `session_id` ties screen recording + keystroke capture + submissions to one identity.
7. **Cost (corrected):** hosted Judge0 is ~€0.001/$0.0011 **per submission** (judge0.com → RapidAPI). Billed per student-submit, a KEC-scale event (~9k submissions) ≈ **~$10**; ~$100–150/year. (My earlier $800–1,850/yr figure was ~7× too high — it wrongly billed each hidden test-case + sample-run as a separate unit. Corrected here.) Self-host ephemeral GCE would be ~$30–80/yr but is parked.

---

## 3. Build order (slices)

- **Slice 1 — Candidate workspace + execution + capture (THE VERTICAL CORE).** One config-driven problem. Monaco editor inside `StudentApp` (same-origin), language selector, problem pane, Run (sample tests) + Submit (hidden tests → verdict) via the Judge0 adapter, console output, and **full keystroke/cursor/selection/paste/focus + run/submit capture** into the existing event pipeline. Front-loads all the risk + the unique value. **← we design + build this first.**
- **Slice 2 — Problem & test-case management.** Admin authoring/store: statements, languages, sample + hidden tests, limits, scoring. Replaces Slice 1's hardcoded problem.
- **Slice 3 — Contest orchestration + candidate flow + invigilation.** Contest = problems + roster + window. Roster upload, unique-ID-confirm login, fullscreen-first anti-proxy, room dropdown, room-wise start OTP, unique top bar, invigilator portal (**signed-QR ID check is DEFERRED — build the portal without it**), leaderboard, dynamic time / end-now. (Absorbs most of the 2026-06-09 exam-feedback features — see §8.)
- **Slice 4 — Keystroke analytics.** Derived metrics → rule-based authenticity flags → admin visualization (spec phase 1→2→3), consuming the captured events. Adds OS mouse-movement capture if wanted.

Each slice: its own spec → plan → build.

### 3.1 Priority overlay — FIRM / STRETCH / DEFER

A cross-cutting priority lens over the slices, for when time is the constraint:

- **FIRM:** Slice 1 (the vertical core — candidate workspace + execution + capture).
- **STRETCH (in priority order):**
  1. Fullscreen-first onboarding + unique top bar + 1–5 onboarding-progress (color-coded).
  2. Roster upload + unique-ID-confirm login + room dropdown.
  3. Invigilator portal (**minus signed-QR**) — incl. room-OTP distribution + **start-now / allow-all OTP bypass** + basic room stats + selective alerts.
  4. Problem authoring (question bank + sample/hidden tests + limits/scoring).
  5. Dynamic time control + end-now.
  6. Attendance stats.
  7. IP-address report.
- **DEFER:** server-signed-QR ID verification; OMR-style screen markers + local overlay detection (incl. focus-change correlation, fullscreen-exit "type-the-sentence" challenge, alert screenshots, jump-to-chunk); analytics (Slice 4).

---

## 4. Slice 1 — detailed design

### 4.1 Scope (in vs out)
**In:** a candidate, inside the existing proctored `StudentApp` (same-origin, screen recording running), solves **one config-driven problem** in our Monaco editor; **Run** against sample tests; **Submit** against hidden tests → verdict (accepted/wrong + per-test pass/fail); **all editor events captured**; submissions + raw events stored, tied to the proctor `session_id`.
**Out (later slices):** problem authoring UI (Slice 2); multi-problem nav, leaderboard, roster/OTP/invigilator/fullscreen-first flow (Slice 3); analytics + mouse-move (Slice 4). Slice 1 **reuses the existing proctor identity** (session_id) and existing fullscreen handling — it must not preclude the Slice 3 flow.

### 4.2 Components
**Frontend** (new, inside `frontend/src`, rendered within `StudentApp`):
- `CodingWorkspace` — layout: problem-statement pane | Monaco editor + language selector + Run/Submit | console/output + sample-test results.
- Monaco integration — **lazy-loaded** (it's heavy). Capture hooks → ProctorEvents:
  - `onDidChangeModelContent` → `editor_insert` / `editor_delete` / `editor_replace` (with text, range, lengths).
  - `onDidPaste` → `editor_paste` (size, range).
  - `onDidChangeCursorPosition` → `editor_cursor` (line/col) — **coalesced/debounced**.
  - `onDidChangeCursorSelection` → `editor_selection` (range).
  - focus/blur → `editor_focus` / `editor_blur`.
- Execution client → calls **our backend** (`/api/exec/*`), never Judge0 directly (key stays server-side; lets us swap engines).
- Events batched client-side and flushed via the existing `sendEvents` pipeline (see §4.4).

**Backend** (extend the existing Cloud Function `backend/src/handler.mjs`, or a sibling module):
- `POST /api/exec/run` — body `{session_id, problem_id, language, source_code}` → runs against **sample** tests via the adapter → returns stdout/stderr/result per sample.
- `POST /api/exec/submit` — same body → runs against **hidden** tests → returns verdict (accepted/wrong) + per-test pass/fail (without leaking hidden inputs) + stores the submission.
- `judge0Adapter` module — the **swap point**: `runCode({language, source, stdin, expectedOutput})` → calls Judge0 (hosted RapidAPI now: base `https://judge0-ce.p.rapidapi.com`, headers `X-RapidAPI-Key`/`X-RapidAPI-Host`; self-host later: `X-Auth-Token`). Uses **async** `wait=false` + token polling or `POST /submissions/batch` (≤20/req) — never `wait=true` (doesn't scale). Base64-encode source/stdin. Config-driven base URL + auth so hosted↔self-host is a config flip.
- Problem config — Slice 1 ships **one** problem as config/seed: statement, allowed languages + Judge0 `language_id` map, sample tests, hidden tests, time/memory limits.

**Data:**
- Submissions: code + verdict + per-test results + timestamps, keyed by `session_id`+`problem_id`.
- Raw event stream: append-only (see §4.4).
- Judge0 key: backend env/secret only.

### 4.3 Judge0 adapter (the swap point)
One module, one interface (`runBatch(submissions[]) → results[]`). Implementations: `hostedRapidApi` (now) and `selfHosted` (later) — selected by config (`JUDGE0_BASE_URL`, `JUDGE0_AUTH_*`, `JUDGE0_MODE`). The rest of the app only knows the interface. This is what makes "hosted now, self-host someday" a config change, not a rewrite.

### 4.4 Event capture & storage
Keystroke/cursor events are **higher-volume** than today's proctor events. Approach: capture in the client, **batch** (e.g. flush every N events or T ms), POST. Storage is **LOCKED to GCS NDJSON, per-session** — an **append-only raw NDJSON stream per `session_id`** (keyed by `session_id`+`problem_id`), chosen because it's cheaper at high volume. (Firestore is not used for the raw stream.) The existing `/api/events` may be reused or a dedicated `/api/editor-events` added if volume/shape warrants. Raw stream stays separate from derived analytics (spec §5.1).

### 4.5 Fullscreen (Slice 1)
Slice 1 runs inside the already-proctored page; keep the editor under the **existing** fullscreen handling. The full **fullscreen-first anti-proxy** flow (blank → "go fullscreen" → welcome → instructions → warnings/block) is **Slice 3** — but Slice 1 must not fight it.

### 4.6 Testing
- `judge0Adapter`: unit tests with a mocked Judge0 (token flow, batch, error/timeout, verdict normalization).
- `/api/exec/run` + `/api/exec/submit`: verdict logic, sample-vs-hidden separation, no hidden-input leakage, per-test results.
- Event-capture mapping: Monaco event → ProctorEvent shape (pure functions, unit-tested).
- Frontend: a **demo/mock mode** so the editor + capture + run/submit flow is exercisable offline (mirrors the existing demo-mode pattern).
- Manual/visual verification in the browser (as we did for admin polish).

---

## 5. Future slices (summaries)
- **Slice 2:** problem/test-case authoring + store (admin); migrate Slice 1's config problem into it.
- **Slice 3:** contest orchestration + the full candidate/invigilation flow (see §8 — most exam-feedback features land here).
- **Slice 4:** analytics (derived metrics, rule-based authenticity flags, admin viz; add mouse-move capture).

---

## 6. Candidate identity & exam flow (target — mostly Slice 3, informs Slice 1's session model)
- **Roster upload (compulsory):** student list with flexible columns (some colleges give email/extra fields); admin designates a **unique-ID column**.
- **Login:** candidate enters their unique ID → record pre-fills → candidate confirms "yes, this is me" → enters.
- **Fullscreen-first anti-proxy:** on opening the link, BEFORE entering name: blank screen, "Go fullscreen now"; start proctoring/recording first, then proceed → "Welcome" + instructions (don't exit fullscreen / don't switch away → warning 1st, blocked 2nd; warning-or-not configurable).
- **Room-wise session-start OTP:** a per-room one-time code released by the invigilator ~2 min before start (after confirming everyone's logged in + fullscreen). Two modes, both supported, keep simple: (a) released live just before start, or (b) pre-generated and distributed.
- **Invigilator ID check via signed QR — DEFERRED (do NOT build now):** the design intent is a server-**signed QR** on the candidate screen; invigilator's app scans → verifies the signature with the server public key → reveals name + ID to check against the person. This is **deferred** — the invigilator portal ships without it (see §7, §10). Recorded here only to preserve the design option.

---

## 7. Invigilator portal (Slice 3)
- **Separate link.** Invigilator enters their name → selects their room (re-selectable but warns it will lock) → proceeds.
- **Room-scoped minimal stats:** count of people in the room, who's logged in / blocked — minimal, not the full alert feed.
- **Start-now / allow-all OTP bypass:** the invigilator can **release the start to the whole room immediately, skipping/overriding the room-OTP gate** (§6/§8 room-wise session-start OTP) — for mis-distributed OTPs or when everyone's ready early. Mirrors the admin's start-now. This is the immediate-release escape hatch alongside the normal OTP path.
- **ID verification via signed QR — DEFERRED (do NOT build now):** the design intent is to scan the signed QR (§6) to reveal name + ID. **Deferred** — build the invigilator portal WITHOUT it (see §10).

---

## 8. Proctoring / exam feature backlog (2026-06-09 test-day feedback — organized)
*These came from Karthi across two multi-part replies. Many fold into the slices above; the rest are proctoring-integrity/admin features.*

**→ Fold into Slice 3 (candidate flow / contest / invigilation):**
- Room number = pre-fed **dropdown** + "Other".
- **Compulsory roster upload** + unique-ID-confirm login (§6).
- **Fullscreen-first** anti-proxy onboarding (§6).
- **Unique top bar** — shows time + name + room; **disappears on any anomaly** so invigilators read status from across the room. Name+ID on the bar → random ID-card checks.
- **Onboarding progress (1–5 steps), color-coded** on the bar — at-a-distance invigilation of who's on track / done / not started; usable during the test too (and by the recording).
- **Attendance stats** (from the roster): taken / not-taken / absentees list.
- **Room-wise session-start OTP** (§6).
- **Invigilator portal** (§7) — incl. OTP distribution + **start-now / allow-all OTP bypass**. **Signed-QR ID check is DEFERRED** (build the portal without it; see §10).
- **Dynamic time control:** update end-time live; **"end now"** for everyone (new time or immediate).

**→ Proctoring integrity (pairs with fullscreen lockdown; own work item, schedule vs slices):**
- **OMR-style screen markers + local overlay detection:** render OMR-like markers covering **all edges** (overlay/cheat tools are small + hug edges) + a few middle/top/bottom points; a lightweight **local** image-recognition check on recorded frames (even on a weak CPU) detects occluded/missing markers → overlay tool present. **Timestamped** alerts naming which markers vanished; jump-to-timestamp in the recording.
  - **Correlate with focus-change:** marker-gone + NO focus change = overlay tool for sure (real alert); marker-gone + focus change + quick return (one accidental fullscreen exit) = tag clip for review, not a hard alert.
  - **Fullscreen-exit handling (two alert types):** (a) the overlay alert; (b) big/scary/red **fullscreen-exit warning** — the "type 'I will not exit full screen again' within N seconds or be blocked/paused until re-admitted" challenge (from the iframe session — polish it).
- **Alert screenshots + jump-to-chunk:** every relevant alert carries a **screenshot** (last frame if recording stopped, else the relevant frame); clicking jumps the recording to that chunk, **lazy-loading** only neighboring chunks (a few before/after).

**→ Proctor admin analytics:**
- **IP-address report:** admin screen/status showing **IP-wise count** of logged-in users (catch off-campus testing); group/flag clusters.

---

## 9. Open questions to confirm with Karthi
- **Timeline / forcing-function** for Slice 1 (and the platform)? (No hard date set yet.)
- ~~Raw-event storage: Firestore subcollection vs GCS NDJSON (§4.4)~~ — **RESOLVED:** LOCKED to **GCS NDJSON, per-session** (§4.4).
- Sequencing of the §8 proctoring-integrity features (OMR/IP/screenshots) vs the editor slices — "right after this," but relative order TBD.
- ~~Hidden-test result detail shown to candidates (pass/fail counts only, or which sample failed)?~~ — **RESOLVED:** LOCKED to **pass/fail counts only**.

---

## 10. Decisions NOT to revisit (guardrails)
- Don't build self-hosted Judge0 now (parked; adapter preserves the option).
- Don't capture OS mouse-movement in Slice 1 (deferred).
- Don't build the server-signed-QR ID verification now (deferred) — the invigilator portal ships WITHOUT it (§6, §7, §8).
- Don't break the existing proctor screen-recording or session model — the editor rides on top of them.
- Keep the Judge0 key server-side.

---

## 11. Judge0 integration — confirmed API facts + adapter requirements (research 2026-06-09)
*From the official Judge0 CE docs + `judge0.conf` + the blog case studies. Verify the starred ⚠ items live on the purchased host via `GET /config_info` and `GET /languages` before the first real contest.*

### Confirmed constants (stock CE)
- **Hosted base/auth:** `https://judge0-ce.p.rapidapi.com`; headers `X-RapidAPI-Key` + `X-RapidAPI-Host: judge0-ce.p.rapidapi.com`. Self-host auth: `X-Auth-Token`.
- **Language IDs (CE):** Python `71` (3.8.1), C++ `54` (GCC 9.2), Java `62` (13.0.1), JavaScript `63` (Node 12). Newer versions exist (Py `92/100/109/113`, C++ `105`, JS `93/97/102`). **Resolve via `GET /languages` and pin in config** — ids differ on Extra CE (entirely different id space).
- **Batch cap:** `POST /submissions/batch` max **20** submissions/request; `MAX_QUEUE_SIZE` 100. Chunk hidden tests to ≤20.
- **Limits (default / max):** `cpu_time_limit` 5/15 s, `wall_time_limit` 10/20 s, `memory_limit` 128000/512000 KB, `stack_limit` 64000/128000 KB, `max_processes_and_or_threads` 60/120, `max_file_size` 1024/4096 KB, `number_of_runs` 1/20. **Set explicit fixed limits on every graded submission — never rely on defaults** (determinism under 800-concurrent load).
- **Status ids:** 1 In Queue, 2 Processing, 3 Accepted, 4 Wrong Answer, 5 TLE, 6 Compile Error, 7–12 Runtime Error (11 = NZEC), 13 Internal, 14 Exec Format. Terminal = id ≥ 3. (Matches the adapter's `normalizeStatus`.)
- **Async:** `wait=false` + poll `GET /submissions/{token}` (or `/batch?tokens=`). `wait=true` is **disabled on RapidAPI (400)** — polling only. Use `fields=` to trim poll payloads.
- **`base64_encoded=true`** on create + fetch (avoids 422 on non-UTF-8 source/stdin) — decode responses. (Adapter already does this.)
- **`callback_url` webhooks** exist but **won't work behind RapidAPI** (no inbound) — use only if self-hosted.

### Adapter requirements (fold into Slice 1's `judge0Adapter` + a queue layer)
**✅ VERIFIED LIVE 2026-06-09** with Karthi's RapidAPI key (stored gitignored at `monitoring/.data/judge0.env` — `JUDGE0_MODE/BASE_URL/RAPIDAPI_HOST/API_KEY`): Python (id 71) + C++ (id 54) both returned **Accepted** with correct output in ~3–11 ms; `wait=true` works for single submissions on this tier (use async+batch only for the 800-burst).
0. **RapidAPI transport (CRITICAL — live-discovered):** the RapidAPI/Cloudflare edge **403s any request missing a normal browser `User-Agent`** ("error code: 1010", *before* key validation). The adapter MUST send a `User-Agent` (e.g. a Chrome UA) on EVERY call, alongside `X-RapidAPI-Key` + `X-RapidAPI-Host: judge0-ce.p.rapidapi.com`. (Self-host needs no UA.)
1. **Security:** send **`enable_network: false`** explicitly on every submission (default is off, but `ALLOW_ENABLE_NETWORK` is true so clients *can* turn it on; on a shared host we can't lock it, so always send false). Set the explicit fixed limits above.
2. **Backpressure (NEW, from the case studies):** do NOT let 800 concurrent candidate clicks hit Judge0 in lockstep. Build, backend-side and engine-agnostic: a **bounded concurrency limiter** sized to the purchased RapidAPI quota, an **internal FIFO queue** between candidates and Judge0, **exponential backoff with jitter** on 429/5xx (honor `Retry-After`; read `X-RateLimit-Requests-Remaining/Reset`), and **separate Run-vs-Submit lanes** so a submit storm doesn't starve quick sample runs.
3. **Python module contract:** hosted CE has **no NumPy/pandas** (only stdlib). For graded problems, either keep Python **stdlib-only with an author-time import lint**, or point the adapter at **Judge0 Extra CE** (separate host + ids; bundles numpy/pandas/scipy/sklearn — verify live). Slice 1's placeholder problem is stdlib-only, so CE is fine.
4. **UX:** Submit = batch the hidden tests (async, poll, ~3 s backoff; p50 ~2 min is normal); Run-against-samples is a separate lighter lane.
5. **Capacity gate:** before any real contest, **load-test the purchased tier at a 500–800 submit burst**; if it throttles, that's the trigger to un-park self-host (the adapter seam makes the swap cheap). Self-host is a *likely* v2 at our scale.
