# GOAL — Own-Editor overnight build (2026-06-09 → morning)

**Read this + `MORNING-NOTES.md` first. Then work `TODO.md` top-down.**

## The goal
By morning, have a **complete, working, tested** core product:
1. **FIRM (must finish + test + audit):** Slice 1 — candidate codes in our same-origin Monaco editor inside `StudentApp`, **Run**s sample tests and **Submit**s to hidden tests via the swap-able Judge0 adapter (verdict), and **every keystroke/cursor/selection/paste/focus is captured** to GCS NDJSON, tied to the proctor `session_id`.
2. **STRETCH (build down the priority list, each shipped working + tested):** see `MORNING-NOTES.md` → "Scope" (fullscreen-first + top-bar + 1–5 progress; roster + unique-ID login + room dropdown; invigilator portal minus signed-QR — incl OTP distribution + start-now bypass + basic stats + selective alerts; problem authoring; dynamic-time + end-now; attendance stats; IP report).
3. **DEFER (do NOT build tonight):** server-signed-QR verification; OMR markers + local overlay detection (+ focus-correlation, fullscreen-exit challenge, alert screenshots, jump-to-chunk); analytics (Slice 4).

## How to work (every item)
- **spec → plan → build → test → commit (local).** Slice 1 already has both:
  - Design: `docs/superpowers/specs/2026-06-09-own-editor-design.md` (§4 = Slice 1; §11 = Judge0 facts).
  - Plan: `docs/superpowers/plans/2026-06-09-own-editor-slice1.md` (TDD tasks).
  - For each STRETCH item: write a short spec + a TDD plan into `docs/superpowers/`, THEN build it the same way.
- **Coordinator pattern:** plan + dispatch subagents (Opus) + verify; subagents do the reading/coding/testing so this context survives. Adversarially review each finding/diff before trusting it.
- **Keep the logs current:** append to `NIGHT-LOG.md` (one line per task/test/commit/blocker); keep `MORNING-NOTES.md` §1/§2/§3 updated (done+evidence, judgment calls, blockers).

## DONE BAR (be honest about depth — gcloud/emulators are NOT installed here)
Tonight, each piece is "done" when it is: **(a) node:test unit-tested** (backend, against the `__setClientsForTest` + `__setJudge0AdapterForTest` injected fakes — NOT the real GCS/Firestore/Judge0), **(b) demo-mode browser-verified** in the :9222 Chromium (`VITE_DEMO_MODE=true VITE_ADMIN_PASSWORD=dev npm run dev`), and **(c) committed locally**.
- **Real GCS/Firestore/live-Judge0 end-to-end is a MORNING task** (needs Karthi's deploy + the Judge0 key; no gcloud/emulators locally). In every log line, state which layer the test hit ("unit+stub" / "demo browser" / "build"). **NEVER claim real-backend behavior you could not actually run.**
- Frontend: `npx tsc --noEmit` + `npm run build` + `npx vitest run` must pass. Backend: `npm test` must stay green (baseline 155/155).

## Commits / push
- **Commit locally, frequently (per task).** **DO NOT push to GitHub** — Karthi pushes one-shot in the morning. Stay on `master`.

## Judge0 adapter must-dos (design §11 — key VERIFIED LIVE 2026-06-09)
**Key is PRESENT + working:** `monitoring/.data/judge0.env` (gitignored) holds `JUDGE0_MODE=rapidapi`, `JUDGE0_BASE_URL`, `JUDGE0_RAPIDAPI_HOST`, `JUDGE0_API_KEY` — tested live: Python(71)+C++(54) → Accepted. Adapter must: send a browser **`User-Agent`** on every call (RapidAPI/Cloudflare 403s "error 1010" without it — live-discovered) + `X-RapidAPI-Key` + `X-RapidAPI-Host`; `enable_network: false` + explicit fixed cpu/wall/memory limits on every graded submission; `base64_encoded=true`; async `wait=false` + token polling or `/submissions/batch` (≤20) for scale (NOTE: `wait=true` *does* work for single dev submissions on this tier); backend-side **queue + bounded concurrency + 429 backoff-with-jitter + separate Run/Submit lanes**; Python graded = stdlib-only (CE has no NumPy). Key stays **server-side** (load from the env file; never commit, never send to the client). Unit tests still use the injected stub adapter; demo mode needs no key.

## Final audits (after the build — the morning gate)
1. **Code review:** `~/arogara/code-review` — use `general.md` + the builtin `/security-review` and `/code-review`. There is NO react/ts/web guideline file; do NOT hunt for one (optionally author a short web/exam-UI/Judge0 rubric if useful). 
2. **Security audit:** `/security-review` + `gitleaks` (v8.30.0 is installed) over the diff/secrets.
3. **PII / privacy audit:** `~/arogara/pii-audit/scan.sh <repo>` — it is a SIBLING of code-review (NOT inside it). Candidate data (name/email/roll/room/keystrokes) handling is the focus.

## Pending-dependency / don't-stall flags
- **Judge0 key:** PRESENT + verified at `monitoring/.data/judge0.env`. The adapter + `/api/exec/*` can be **integration-tested against REAL Judge0 tonight** — run the backend locally (`cd backend && JUDGE0_API_KEY=... functions-framework --target=api`, or source the env file) and hit the endpoints; outbound HTTPS works, so the Judge0 path is real without any GCP. (The submission/event STORAGE still needs Firestore/GCS — mock those locally; full GCP e2e waits on the dev project below.)
- **No deploy target / GCP creds locally** → do NOT attempt a real backend deploy unattended. Leave deploy + live e2e for the morning.
- Keep a running **MORNING-NOTES §2** list of judgment calls; only ping Karthi on Telegram for a TRUE hard blocker.

## Stop condition (for /goal)
Keep working until the FIRM Slice 1 is **done + unit-tested + demo-verified + audited + locally committed**, AND you've made honest, tested progress down the STRETCH list — or until genuinely blocked (then log it in MORNING-NOTES and, if it's a hard blocker, ping Telegram). Do not stop early on "good enough"; do not push; do not touch DEFER.
