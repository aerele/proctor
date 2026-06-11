# TODO — Own-Editor overnight build (master checklist)

Work top-down. Read `GOAL.md` + `MORNING-NOTES.md` first. Each item: spec → plan → build → test → **commit locally**. Tick boxes as you go; log each in `NIGHT-LOG.md`.

## Pre-run gates (true before the /goal fires)
- [x] Design doc + Slice 1 plan written and **punch-list-corrected** (test seam → `__setClientsForTest`/`__setJudge0AdapterForTest`; GCS key via `sessionPrefix`; ownership gating; no `nowIso`/`globalThis`).
- [x] Debug Chromium on :9222 (up).
- [x] night-run workspace fresh; GOAL/MORNING-NOTES/NIGHT-LOG present.
- [ ] **Sleep inhibitor armed** + laptop on AC + lid→do-nothing (Karthi/Ram, right before /goal).
- [x] Judge0 key supplied (optional for tonight — live smoke is a morning gate).

## FIRM — Slice 1 (must finish + test + audit)
Detailed TDD tasks: `docs/superpowers/plans/2026-06-09-own-editor-slice1.md`. Summary:
- [x] T1 — `judge0Adapter.mjs` (swap-able; async batch; `enable_network:false`; base64; limits) + tests.
- [x] T2 — `problems.mjs` (sum-two: statement, language_ids, 2 sample + ≥4 hidden tests, limits) + test.
- [x] T3 — `POST /api/exec/run` (sample tests; `requireWritableSession`) + tests.
- [x] T4 — `POST /api/exec/submit` (hidden tests → verdict, no leaked inputs, store submission) + tests.
- [x] T5 — `POST /api/editor-events` (batch → GCS NDJSON under `sessionPrefix`) + tests.
- [x] T6 — frontend types (`EditorEvent`/`ExecRequest`/`RunResult`/`SubmitResult`).
- [x] T7 — `editorEvents.ts` pure mappers + coalescing + batcher (+ vitest).
- [x] T8 — api.ts: `sendEditorEvents`/`execRun`/`execSubmit` (+ demo branches; execRun demo returns BOTH samples).
- [x] T9 — `MonacoEditor.tsx` (lazy; keystroke/cursor/selection/paste/focus capture).
- [x] T10 — `CodingWorkspace.tsx` + render in `StudentApp` (gate `status==='recording'`).
- [x] T11 — E2E verify: backend `npm test` green; frontend `vitest` + `build`; demo-mode browser walkthrough on :9222 (screenshot); commit.
- [x] Add the adapter **queue + bounded-concurrency + 429 backoff + separate Run/Submit lanes** (design §11) — can be a focused add after T1–T11 land.

## STRETCH (priority order — each = spec → plan → build → test → commit)
- [x] S1 — Fullscreen-first onboarding + unique top bar (vanishes on anomaly) + 1–5 onboarding progress (at-a-distance invigilation).
- [x] S2 — Roster upload (flexible columns + designated unique-ID) + unique-ID-confirm login + room dropdown (+ "Other").
- [x] S3 — Invigilator portal (NO signed-QR): room OTP/passcode distribution + **start-now/allow-all bypass** + basic room stats + selective alerts.
- [x] S4 — Problem authoring: question bank + sample/hidden test cases + time/memory limits + scoring (replaces the placeholder problem).
- [x] S5 — Dynamic time + "end now" (admin).
- [x] S6 — Attendance stats (taken / not-taken / absentees).
- [x] S7 — IP-address report (IP-wise count of logged-in users).

## DEFER — do NOT build tonight
Server-signed-QR verification · OMR markers + local overlay detection (+ focus-correlation, fullscreen-exit challenge, alert screenshots, jump-to-chunk) · analytics (Slice 4).

## Final audits (after the build)
- [x] Code review — `~/arogara/code-review` (`general.md` + `/code-review` + `/security-review`).
- [x] Security audit — `/security-review` + `gitleaks` over the diff/secrets.
- [x] PII / privacy audit — `~/arogara/pii-audit/scan.sh <repo>`.
- [ ] Write the morning summary into `MORNING-NOTES.md` (done+evidence, judgment calls, blockers, what's left).

## Morning gates (NOT tonight — log, don't attempt unattended)
- [ ] Live Judge0 smoke: one real Run + Submit per language (needs the key + a deploy/run target).
- [ ] Real GCS/Firestore end-to-end (needs deploy; gcloud/emulators not installed locally).
- [ ] Push to GitHub (Karthi does this one-shot in the morning).
