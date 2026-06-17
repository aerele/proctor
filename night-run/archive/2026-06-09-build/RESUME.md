# RESUME.md — read this FIRST after a break/compaction

I am **Ram** (`~/arogara/PERSONA.md`), working with **Karthi** in `~/arogara/proctor`, attached to the `proctor` C3 topic. Repo branch `master`. **Standing rule: commit locally, do NOT push to GitHub** (Karthi deploys himself).

## WHERE WE ARE (2026-06-09)
The **admin-polish batch is done + committed locally** (commit `c38e623`; contest-filter banner, Sessions drill-down, recording summary card, details CSV, submission-event tooling — 155 backend tests pass, reviewed + visually verified). Not pushed.

We are now on the **own-editor stretch goal** and have just FINISHED BRAINSTORMING + PLANNING Slice 1. Two authoritative docs are on disk:
- **Design:** `docs/superpowers/specs/2026-06-09-own-editor-design.md` (vision, locked decisions, slice plan, Slice 1 detail, all of Karthi's feature requests organized).
- **Plan:** `docs/superpowers/plans/2026-06-09-own-editor-slice1.md` (bite-sized TDD tasks for Slice 1).

## IMMEDIATE NEXT STEP
**Karthi reviews the design doc + the Slice 1 plan.** He stepped away (laptop closing) and pre-authorized writing the plan. When he's back: get his approval, then execute Slice 1 (subagent-driven per task, recommended). Do NOT start coding before he approves.

## LOCKED DECISIONS (own editor)
- Full HackerRank-replacement platform, built in **slices**: (1) candidate workspace + Judge0 execution + full event capture; (2) problem/test-case authoring; (3) contest orchestration + candidate/invigilation flow; (4) keystroke analytics.
- **Engine:** hosted **Judge0 API** (pay-per-use, ~$0.0011/submission ≈ ~$10/test event) behind a **swap-able adapter**; self-host parked. Karthi gives the API key at the build step; key stays **server-side**.
- Editor is **Monaco inside `StudentApp`** (same-origin — that's what makes keystroke capture possible). Editor session == proctor `session_id`.
- Languages: Python, C/C++, Java, JavaScript. Capture: keystrokes/insert/delete/paste/**cursor**/**selection**/focus/run/submit (OS mouse-move DEFERRED to Slice 4).
- Identity: **roster-based** — compulsory student-list upload + unique-ID confirm + fullscreen-first anti-proxy + room-wise start OTP + invigilator portal + server-signed-QR ID check (mostly Slice 3).
- Raw editor events → GCS NDJSON per session; submissions → Firestore `proctor_submissions`.

## BACKLOG (do not start without Karthi)
- The own-editor Slices 2–4.
- **2026-06-09 test-day proctoring features** (in `TODO-admin-polish.md` §"Proctoring/exam features" AND organized in the design doc §8): IP-address report; OMR-style screen markers + local overlay detection + focus-correlation + fullscreen-exit challenge; alert screenshots + jump-to-chunk (lazy-load neighbors); roster/room-dropdown/fullscreen-first/unique-top-bar/onboarding-progress/attendance; invigilator portal + signed-QR; dynamic time + end-now. Most fold into Slice 3; OMR/IP/screenshots are their own items.
- Earlier non-own-editor backlog (SSHGate v1.2, etc.) lives in the memory index, untouched.

## REPO STATE
Working tree clean after the local commits below. `master` HEAD will be the own-editor design+plan commit. Frontend = React/Vite/TS/Tailwind; backend = GCP Cloud Function `backend/src/handler.mjs` + `node:test`; Firestore + GCS. Demo mode: `VITE_DEMO_MODE=true VITE_ADMIN_PASSWORD=dev npm run dev`.

## 2026-06-10 night-run state
Authoritative resume anchor: `night-run/RESUME-ANCHOR.md` (post-compaction entry point).
