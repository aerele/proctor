# Morning Notes — for Karthi to review (own-editor night run)

This is the first thing to read in the morning. Three sections, kept current through the night.

## 1. What's done + tested (with evidence)
<!-- per slice/feature: built? unit-tested? integration-tested in browser? committed? -->

## 2. Judgment calls I made autonomously (review these)
<!-- decisions taken without you while you slept, with the reasoning, so you can veto/adjust -->

## 3. Open questions / blockers / what I deliberately did NOT do
<!-- anything I couldn't resolve, deferred, or that needs your call -->

---
## Decisions locked BEFORE the run (2026-06-09 pre-compact discussion) — RUN GUARDRAILS

### Scope
- **FIRM** (must be DONE + browser-integration-tested + audited by morning): **Slice 1** — Monaco editor in `StudentApp` (same-origin) + Judge0 adapter Run(sample)/Submit(hidden→verdict) + full editor-event capture (keystroke/insert/delete/paste/cursor/selection/focus/run/submit), all tied to the proctor `session_id`.
- **STRETCH** (build in this priority order; each gets its own spec→plan→build→test; ship as far as quality allows):
  1. Fullscreen-first onboarding + unique top bar (disappears on any anomaly) + 1–5 onboarding progress (at-a-distance invigilation).
  2. Roster upload (flexible columns + designated unique-ID) + unique-ID-confirm login + room dropdown (+ "Other").
  3. Invigilator portal **MINUS the server-signed-QR verification** — room OTP/passcode distribution + a "start now / allow all" bypass (like the admin) + basic room stats + selective alerts.
  4. Problem authoring = **question bank + sample/hidden test cases + time/memory limits + scoring** (replaces Slice 1's placeholder problem). [Confirmed this is what "problem authoring" means.]
  5. Dynamic time + "end now" (admin).
  6. Attendance stats from the roster (taken / not-taken / absentees).
  7. IP-address report (IP-wise count of logged-in users).
- **DEFER** (NOT tonight — own design night): server-signed-QR ID verification; OMR markers + local overlay detection (+ focus-correlation, fullscreen-exit challenge, alert screenshots + jump-to-chunk); keystroke analytics (Slice 4 — needs captured data first).

### Process / policy
- **Commits: LOCAL only, frequent (per task). NO push.** Karthi pushes one-shot in the morning.
- **Done bar:** every shipped piece is a real working app — unit-tested AND browser integration-tested (via the :9222 MCP) — and committed locally.
- **Final audits** (after the build): (a) code review via `~/arogara/code-review` with project-specific guidelines (React/Vite/TS frontend + Node/GCP backend + Judge0 integration + exam UI); (b) security audit; (c) **PII/privacy audit** — use the PII-audit folder under the code-review project.
- **Defaults taken:** Slice 1 placeholder problem "sum-two"; raw editor events → GCS NDJSON per session; candidates see only pass/fail counts on hidden tests (never hidden inputs).

### Dependencies / logistics
- **Judge0 key:** Karthi provides; kept SERVER-SIDE (backend env); used only for live integration tests. Build + test against mocks/demo until then — never block on it.
- **Browser:** Chrome on :9222 (verified UP) for MCP integration testing.
- **Machine must stay AWAKE** — the run only progresses while the machine is awake (it slept ~11h last night).

---
## §1 progress (as of ~01:25) — FIRM Slice 1: BUILT + FIXED + VERIFIED
- **All 11 plan tasks done via TDD** (commits e5c0d2b…0328ef9), then **two adversarial review rounds fixed everything found**: round 1 (13 findings) → F1-F6 fix commits (d199ad5, fb670be, 5960988, aea48b2, 9c8923f); round 2 re-review (6 follow-ons) → 3a8a688 + 792eed9.
- **Suites green at HEAD:** backend 183/183 (node:test), frontend vitest 30/30 + tsc clean + build OK.
- **Browser demo verified on :9222** (student flow → RECORDING → Monaco → typed sum-two → Run 2/2 samples → Submit accepted 4/4 counts-only). Evidence: `night-run/evidence/slice1-workspace-typed.png`, `slice1-submit-accepted.png`. (Screen-share picker can't render in a remote-controlled browser, so the demo stubs getDisplayMedia with a fake monitor canvas stream via CDP initScript — demo technique only, no product change.)
- Key hardening already in: enable_network:false + full explicit limits + ≤20 chunking + 90s poll budget + judging_timeout; UA header (RapidAPI 403 workaround); submit response = counts only (§9 lock); editor-event sanitization preserving 2000-char paste text; source cap 64KB; Object.hasOwn guards; Cloud Run timeout 30s→120s; own-editor copy gating (studentCopy.ts).

## §2 judgment calls (review these)
1. **judging_timeout → candidate verdict "error"** (neutral "Judging failed — submit again"), never wrong_answer: infra failures shouldn't read as candidate failures.
2. **Hidden-test detail**: response carries verdict+counts ONLY; full per-test detail stays in the stored Firestore submission (admin-side).
3. **Editor event text capped at 2000 chars/event** (text_truncated flag beyond) — paste forensics intact, storage bounded.
4. **Submission doc ids = randomUUID()** (was session_id-composed — injection-shaped).
5. **Cloud Run request timeout 120s** to fit the 90s judge poll budget.
6. **Workspace REPLACES the HackerRank link** when a problem is configured; all candidate-facing copy switches via studentCopy.ts (HackerRank wording kept when no problem configured).
7. **Usage throttle** (per your TG ask): one workflow at a time, gate at 90% of measured ceiling, idle till window reset if crossed.

---
## S1 exam shell — BUILT + BROWSER-VERIFIED (~02:10)
- 5 TDD commits (a79b326, 14bb70a, 9ce1526, 8d7a7c6, 0ce7640): pure stage logic + anomaly reducer (61 vitest tests), useExamShell hook, ExamTopBar/FullscreenGate/AnomalyPanel, StudentApp wiring. Suites: 91/91 vitest + tsc + build + backend 232/232.
- **Full 10-point demo browser walkthrough PASSED on :9222** (evidence: night-run/evidence/s1-01…s1-10*.png): gate(ticking clock)→DETAILS→IN EXAM bar(name/room/REC/elapsed)→blur vanishes bar + anomaly panel→stacked fullscreen reason gates restore→restore ⚑1→event audit (topbar_hidden/restored, onboarding_stage, fullscreen_enter/exit)→second episode ⚑2→END: 5 DONE bar persists chip, fullscreen exited→pre-recording exit returns GATE (no anomaly, form value preserved).
- Live bonus finding: integrity checkpoint expiring mid-end-flow counted as a third ⚑ — correct per the pinned anomaly list (session_ended reducer path exercised live).
- Review findings being fixed (wsc2n21df): ⚑ persistence across reload (was React-state-only — evadable); locked screen vs gate overlay precedence. Judgment call: client-side persistence is a deterrent, server events remain the durable record.

---
## DEPLOYED-STACK E2E — PASSED (~04:55) — task #18
- **Both services live on aerele-proctor-dev:** backend https://proctor-api-238846959672.asia-south1.run.app (rev 00001-snb, Judge0 env baked), frontend https://proctor-web-238846959672.asia-south1.run.app (admin unlock = hash of the ADMIN_PASSWORD in .env.deploy.local).
- **Full candidate flow on the deployed stack:** fullscreen gate → details → real session → RECORDING (real public IPv6 captured; camera degraded gracefully to permission_denied; screen chunk-00001.webm in real GCS) → Monaco → **Run 2/2 + Submit accepted 4/4 via LIVE Judge0 through Cloud Run** → submission doc in real Firestore → End test → 5 DONE bar with ⚑ persisting.
- **KEYSTROKE FORENSICS PROVEN ON REAL INFRA:** per-character editor_insert events (text+position+timestamp) + focus + coalesced cursor batched to /api/editor-events → GCS NDJSON; reconstructed the typed string '#api-probe\n' byte-for-byte from the stored events.
- **False alarm survived (important methodology note):** initial deployed runs showed NO keystroke events — root cause was the TEST INSTRUMENT, not the product: CDP type_text does not reach Monaco's hidden textarea in an unfocused remote window (and the demo "typed" screenshot was actually the starter code, which is identical to the solution). Driving Monaco via editor.trigger('keyboard','type',…) proved the full pipeline works. ALL future remote-browser Monaco tests must use editor.trigger.
- **Two items for your review:**
  1. Screen chunk-2+ PUTs to GCS signed URLs intermittently fail with net::ERR_CONNECTION_CLOSED on my home IPv6; chunk-1 succeeded. Pre-existing recorder code (untouched tonight) and it does NOT retry failed chunks — consider a retry queue as a follow-up.
  2. Remote-walkthrough stubs used (demo-only, no product change): fake getDisplayMedia, camera NotFoundError, clipboard stub (clipboard.readText would hang awaiting a permission prompt on the new origin — REAL candidates will see the prompt and click it; not a product bug).
