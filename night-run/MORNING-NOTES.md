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
