# Overnight Build Goal — Proctor (full roadmap minus iframe) + contest-eval monitoring

**Mission:** Autonomously build, in `/home/karthi/arogara/proctor`, the **entire `docs/ROADMAP.md` except the iframe work (Epic 1, dead)** PLUS the contest-eval live monitoring pipeline — all of it **before** the stretch goals. Work as **COORDINATOR**: delegate heavy reading/coding/testing to subagents/workflows (Opus); keep your own context lean. Log every step to `night-run/NIGHT-LOG.md`; put only real decisions/must-test items in `night-run/MORNING-REVIEW.md`. Stay in build mode (no Telegram replies).

---

## NORTH STAR (non-negotiable)
By morning Karthi must be able to **just use the tool**:
- The **contest-eval monitoring tool** runs with one command + a `night-run/HOW-TO-RUN.md`.
- Every shipped feature is **working OR gracefully-degraded** — never a hard hang or a half-wired path that breaks.
- If the full surface can't all reach quality, deliver a **coherent working whole** and flag the remainder in `MORNING-REVIEW.md` — do NOT ship broken features to hit scope.

---

## SCOPE
**IN tonight (everything in `docs/ROADMAP.md` except iframe):**
- Epic 0.1 remove entry + exit passcodes; 0.3 single-session-per-username. (0.2 test-link config already exists.)
- Epic 2 sessions & resilience: persistent server-side session that survives reload; stop re-asking details; resume-approval (admin bulk/one-by-one); prominent identity confirmation.
- Epic 3 student UX / guided flow (clear what's-happening/next, self-service).
- Epic 4 admin live monitoring: real-time alerts; room-number capture + in alerts; remote approve/lock/bypass (per-person + bulk); live stats (live/locked/finished/yet-to-start).
- Epic 5 live submission evaluation (contest-eval pipeline → alerts).
- Epic 6 platform: alerts-ingestion API + API keys; deterministic rules; live-update transport (polling baseline + WebSocket enhancement if feasible).
- Recording storage foldered by contest (the "minor" change).
**EXCLUDED:** Epic 1 iframe lockdown (dead). **STRETCHES (after all the above):** S1 logo→tab-away; S2 extension.

---

## OPERATING RULES
- Branch off main (`feat/roadmap-and-contest-eval`); **never commit to main**. Spec → commit → push at each phase boundary. End with a **triple review** (code-review repo lens + independent correctness lens + security-review).
- **Live HackerRank testing:** use Karthi's authenticated CDP browser on `:9222` via chrome-devtools MCP, **READ-ONLY & non-disruptive** — open your OWN tabs; never touch/close his tabs or the browser. If `:9222` is gone, fall back to fixtures.
- **No GCP access overnight:** build + unit-test against mocks/fixtures + demo mode; **do NOT deploy**. The GCS change must be **surgical, backward-compatible, no refactor**; flag for morning testing.
- **No separate paid API calls** for LLM verdicts — use Karthi's Claude subscription via the seam below.
- **Never commit PII:** the `MCET-06-26` fixtures are gitignored test data; keep them + any candidate data out of git and any shared store.
- **Proceed on the documented DEFAULTS** (`MORNING-REVIEW.md` "OPEN DECISIONS"); don't block on them. HOLD only true blockers: extension permission set/job (S2) and the S1 logo sample.
- **Never invent real secrets:** placeholder `ALERTS_INGEST_API_KEY` for tests; Karthi sets the real one at deploy; it must NOT be `ADMIN_PASSWORD`.
- **Architecture caution — WebSockets:** the backend is stateless Cloud Functions (functions-framework). Build **short-polling as the reliable live-update baseline** (works on the current stack); attempt WebSockets as an **enhancement only if it doesn't risk the stack** — never break the working polling path for it. Log the call in `MORNING-REVIEW.md`.
- **Keep the proctor demo-mode working** throughout, so every UI feature is testable locally without GCP.

---

## BUILD PLAN (architect order; each phase locks before the next)
**Priority logic:** Phase 1 delivers the **contest-eval monitoring tool as a complete, usable vertical slice** — the guaranteed "use it in the morning" deliverable — so it lands even if later phases overrun. Phases 2–3 then complete the rest of the roadmap. Commit/push at every phase boundary so partial progress is never lost.

### PHASE 1 — Contest-eval monitoring tool (the guaranteed usable headline) 🎯
- **1.1 Alerts ingestion API + key** — `POST /api/alerts` (`x-api-key`, timing-safe) + `GET /api/admin/alerts` (admin) + a `proctor_alerts` Firestore collection; env wiring. Unit tests (accept/reject key; payload validation; read-back).
- **1.2 Minimal Live Alerts Console (admin)** — `Alert`/`AlertSeverity` types + `fetchAlerts` (+ demo branch with canned alerts + `/public/sample.webm`); an Alerts tab in `AdminApp`; severity styling, timestamp, username, clickable video deep-link. Works fully in `VITE_DEMO_MODE`; `tsc -b && vite build` green.
- **1.3 contest-eval live poller (deterministic)** — extract the inline acquisition recipes (`contest-eval/METHOD-handoff.md`/`METHODOLOGY.md`) into a standalone parameterized poller (`--contest-id`/`--slug`) reproducing the exact meta/code JSON contracts + field renames; **429-safe discipline** (never store failed fetches; sleeps ~1s/8s; hardest-accepted-first; per-batch persist; never navigate the fetch tab); parameterize the hardcoded contest IDs in `clone_detect.py` & siblings; per cycle: `analyze_meta` → optional lazy code-fetch for flagged → `clone_detect` → alert objects → `POST /api/alerts`. Validate vs the `MCET-06-26` fixtures (reproduce committed `clone_analysis` clusters); live-validate vs `:9222` if available.
- **1.4 LLM-judgment seam (subscription only — NO paid API)** — deterministic loop is the backbone (fully usable on deterministic flags). Decouple LLM verdicts via a **file-queue**: poller writes scoped requests to `night-run/verdict-queue/pending/<id>.json`, reads fixed-format verdicts from `done/<id>.json`.
  - **Default responder = a Claude Code session running `/loop 1m`** with a ready-made prompt that drains `pending/` → writes a strict fixed-schema verdict to `done/`. Karthi keeps this session open during the test (subscription, no API). Ship the exact `/loop` prompt + run steps in `HOW-TO-RUN.md`.
  - **Option B = C3 "ContestEval" injection** — a C3 adapter/bridge that injects the scoped context into a Claude Code session via the C3 broker and captures the fixed-format reply into the queue (more token-efficient). Read the C3 adapter-authoring docs in `/home/karthi/arogara/c3` first; **wrapper/adapter, do not fork**. Build + test as a **config-selectable** transport.
  - **Graceful degradation:** if no responder runs, deterministic flags still surface and the verdict field stays `pending` — never blocks.
- **1.5 End-to-end harness + HOW-TO-RUN** — one command: fixtures (or live `:9222`) → poller → locally-run backend → admin console shows alerts; verdict queue demonstrated with a Claude Code responder. Write `night-run/HOW-TO-RUN.md`. **At the end of Phase 1 the monitoring tool is USABLE — commit + push.**

### PHASE 2 — Backend roadmap completion
- **2.1 GCS contest-foldering** — ONE slug helper (legacy fallback), applied at all 7 key-build sites + `video-worker` merge path; persist `contest_slug`/`storage_prefix` on the session doc; zero extra per-chunk reads. Unit tests.
- **2.2 Session model (Epic 2 + 0.1 + 0.3)** — server-side persistent session keyed to `username_norm`+`contest_slug` that survives reload (return existing session instead of re-collecting details); **single active session per HackerRank username** (new login for an active username → "log out old?" requiring admin approval; different-browser/genuine case → admin approve or one-time code); **resume-approval** (admin bulk + one-by-one) with "wait for unlock / ask for code" states; **remove the entry + exit passcodes** entirely; keep an admin **unlock** path for locked/contingency. Unit tests.
- **2.3 Sure-shot proctor alerts (Epic 4)** — derive from existing session fields + event JSONL (recording/screen-share stopped, invalid surface, recording error, IP change), each with a deep-link signed video URL (raw-chunk fallback); noisy events not surfaced; feed the alerts console. Unit tests.
- **2.4 Live-update transport + stats + remote actions (Epic 6 + 4)** — `GET /api/admin/stats` (live/locked/finished/yet-to-start) + remote-action endpoints (approve/lock/bypass, per-person + bulk); short-polling baseline; WebSocket enhancement only if safe. Unit tests.

### PHASE 3 — Frontend roadmap completion
- **3.1 Student flow (Epic 2 + 3 + 0.x)** — remove passcode inputs; persistent-session resume (no re-ask of details on reload); **prominent identity confirmation**; **room-number capture** up front; guided, self-service UX (clear status + next-step at every step); "wait for unlock / locked" states. Works in `VITE_DEMO_MODE`; build green.
- **3.2 Admin console completion (Epic 4)** — fold sure-shot proctor alerts into the Alerts Console (room+name, severity, video deep-link); **live stats dashboard**; **remote actions** (approve/lock/bypass, per-person + bulk); demo-mode branches. Build green.

### PHASE 4 — Audit / commit / close
- Full e2e audit (7 GCS sites consistent; no `ADMIN_PASSWORD` reuse; PII gitignored; 429-drop correct; session/single-session logic sound; polling path solid).
- **Triple review** (code-review repo + independent correctness + security-review: ingest key, timing-safe compare, CORS, signed-URL expiry, PII in `proctor_alerts`, session-auth).
- Apply obvious <50-LOC fixes; escalate subjective/design items to `MORNING-REVIEW.md`. Commit + push branch; open PR. Write `HOW-TO-RUN.md`. Update `MORNING-REVIEW` + `NIGHT-LOG`.

### STRETCH (only after Phase 4 closes, without regressing the usable core)
- **S1 — Local logo-missing → tab-away detection** over a recording (HackerRank logo absent >1 min continuous → `tab_away` alert with timestamp + video deep-link). Scaffold + matcher interface; HOLD final tuning until Karthi provides a sample recording + logo crop.
- **S2 — Extension** (MV3, MINIMUM permissions for its one-line job, ready to upload to the verified CWS dev account). BLOCKED until Karthi confirms the extension's job/permissions in the morning. Last; internal scaffolding only.

---

## STOP CONDITION
The full IN-scope roadmap (above) is implemented to the North Star bar AND the contest-eval monitoring tool is **usable** (one-command run + `HOW-TO-RUN.md`, every feature working or gracefully-degraded) — clean build, unit tests green, triple-reviewed, branch pushed, PR opened, `MORNING-REVIEW` + `NIGHT-LOG` current. Then attempt the stretch goals within their HOLD constraints. Where a piece is genuinely too large to finish to quality, ship the working subset + flag the rest in `MORNING-REVIEW.md` rather than break the usable whole.
