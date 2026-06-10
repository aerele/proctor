# RESUME ANCHOR — own-editor night run (written 2026-06-10 ~10:10, pre-compaction)

Read this first after compaction. Repo: /home/karthi/arogara/proctor, branch master, ~60 local commits ahead of origin. **NO PUSH until the history scrub (see Push gate below).**

## DONE (built + tested + reviewed + committed local)
- **FIRM Slice 1**: same-origin Monaco workspace in StudentApp; /api/exec/run + /api/exec/submit via swap-able Judge0 adapter (RapidAPI, UA header, enable_network:false, full limits, ≤20 chunking); /api/editor-events → per-session GCS NDJSON (sanitized, 2000-char text preserved); counts-only submit responses; randomUUID submission ids.
- **Hardening**: execQueue (run/submit/poll lanes, bounded concurrency, 429/5xx backoff w/ jitter, retryable:false phase-awareness — never re-bills a submitted batch), per-session cooldowns + submit caps (clock seam), judge_unavailable 503s, stored:false verdict salvage.
- **S1 exam shell**: FullscreenGate (real modal) + ExamTopBar (5-stage, ⚑ flags, persistence across reload) + AnomalyPanel (role=alert) + useExamShell; 10-point browser walkthrough PASSED (evidence night-run/evidence/s1-*.png).
- **S2 roster login**: versioned roster store + exact-norm guard + version-prefixed ids; public exam-config + masked lookup; server-side identity override + roster_verified; CSV/TSV parser; admin rooms+roster UI; identity-confirm login + room dropdown.
- **S3 invigilator portal**: timing-safe auth (invigilator or admin password), room OTP gate ENFORCED on exec server-side, release-code/open-room, room dashboard (least-privilege: NO session_id, NO IPs, NO alert detail), student waiting room, 20-attempt cap (NaN-guarded).
- **S4 problem authoring**: Firestore problem bank (validation, per_test/all_or_nothing scoring), admin CRUD + Problems tab, active-problem assignment, server-driven candidate problem (SLICE1_PROBLEM removed), built in worktree + MERGED (3ec65f4).
- **S5 dynamic time + end-now**: admin exam-time card (+/-min, exact set, 2-click end-now), student live countdown + time-up state. VERIFIED (commit 72aad0f).
- **S6 attendance**: GET /api/admin/attendance (current roster version, taken/not-taken/absentees), pure math + CSV, api client.
- **Audits**: full sweep DONE (night-run/AUDIT-REPORT.md: 0 blockers; all mechanical majors FIXED + re-review-verified — M2 keystroke disclosure, M5 roster clear deletes, M7, M8 CSV injection, M9-M11 a11y/errors, M12/M13 invigilator least-privilege). S3 delta-audit done (security clean).
- **Deployed e2e (dev GCP aerele-proctor-dev)**: backend https://proctor-api-238846959672.asia-south1.run.app + frontend https://proctor-web-238846959672.asia-south1.run.app — full candidate flow incl LIVE Judge0 + keystroke forensics ('#api-probe' reconstructed byte-for-byte from GCS NDJSON). NOTE: deployed images predate S3-S7 — final redeploy pending.

## IN FLIGHT at compaction
- Workflow **waz7af0gl** (resume of wf_a5a43681-607, script s5-s7-final-builds-*.js): S7 IP-report remaining frontend tasks (admin tab + demo parity; backend tasks 1-2 already committed: 8181b83, 3cd4cc5) + final suites verify + final delta-review of S5-S7. All S5/S6 tasks replay from journal cache.
- If it died again: check journal /home/karthi/.claude/projects/-home-karthi-arogara/d1d95247-a2f0-4d67-a73c-a24d64c7473f/subagents/workflows/wf_a5a43681-607/journal.jsonl, reset any uncommitted partial edits (git status), TaskStop the stale task id, re-invoke Workflow({scriptPath: ".../s5-s7-final-builds-wf_a5a43681-607.js", resumeFromRunId: "wf_a5a43681-607"}).

## REMAINING (in order)
1. S7 workflow completes → read its verify + delta-review findings; fix anything major (small focused agent).
2. **Final merged-stack demo-browser walkthrough** on :5173 (VITE_DEMO_MODE dev server should be running; restart: cd frontend && VITE_DEMO_MODE=true VITE_ADMIN_PASSWORD=dev npm run dev). Walk: student (gate→details→roster→waiting room if gate on→workspace w/ authored problem→countdown) + /invigilator portal + admin tabs (Problems, attendance, IP report, exam time). Browser MCP on :9222; Monaco typing MUST use editor.trigger('keyboard','type',{text}) — CDP type_text does NOT reach Monaco. getDisplayMedia/clipboard stubs via initScript (see NIGHT-LOG ~00:15 + ~04:45 entries).
3. **Redeploy BOTH images to aerele-proctor-dev** (everything S3-S7 + fixes): source .env.deploy.local; backend: gcloud builds submit backend --tag asia-south1-docker.pkg.dev/aerele-proctor-dev/proctor/api:latest --async (poll: gcloud builds list), then gcloud run deploy proctor-api (same flags as NIGHT-LOG ~04:0x incl JUDGE0_* env). Frontend: npm --workspace frontend run build with VITE_API_BASE_URL + VITE_ADMIN_PASSWORD_HASH (sha256 of ADMIN_PASSWORD), builds submit frontend --async, gcloud run deploy proctor-web. Quick deployed smoke.
4. Update MORNING-NOTES (final summary already mostly written §-by-§), TODO ticks, final commit.

## Push gate (Karthi does this, NOT the agent)
65 contest-eval verdict files with real student PII exist in HISTORY at acdba86 (removed from tree at 6640247). Before ANY push: `git filter-repo --path night-run/archive-2026-06-05-sshgate-v12/verdict-queue/ --invert-paths` or keep repo private. Details in MORNING-NOTES "PUSH GATE".

## Karthi's design-call list (morning discussion — in MORNING-NOTES)
M3 roster-lookup enumeration mitigation · M4 per-candidate start credential · M6 pre-session clipboard scope · username fallback on blank roster cell · chunk-upload retry (pre-existing) · OTP plaintext (accepted) · Monaco still CDN-loaded (bundle before a real offline exam).

## Key environment facts
- Judge0 key: monitoring/.data/judge0.env (gitignored). Deploy env: .env.deploy.local (gitignored; API_URL filled). GCP SA: ~/proctor-dev-sa.json via monitoring/.data/gcp-dev.env; gcloud at ~/google-cloud-sdk/bin.
- Usage gate script: night-run/check-usage.sh (5h windows; resets 09:30/14:30 IST pattern).
- Suites at last green: backend 330/330; frontend 159 vitest + tsc + build (before S7 frontend tasks).
