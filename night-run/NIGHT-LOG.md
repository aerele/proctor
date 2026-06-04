# NIGHT LOG — overnight build (chronological)

Append-only log of what was done, one step at a time. Curated decisions live in `MORNING-REVIEW.md`.

---

## 2026-06-04 — Setup / pre-build

- Cloned & set up proctor; brought up demo-mode dev instance (`:5173`), verified `/` + `/admin`.
- Iframe feasibility spike → **HackerRank cannot be iframed** (XFO SAMEORIGIN + Akamai), confirmed in real browser. Spike + findings in `spike/iframe-test/`.
- Research: proctoring best-practices (`docs/PROCTORING_RESEARCH.md`) + embeddable-platform alternatives (`docs/PLATFORM_ALTERNATIVES.md`). Conclusion: browser companion = evidence + triage, not lockdown; live submission-eval + oral-defense is the spine.
- Decisions locked: **stay on HackerRank** (no self-host), **extension de-prioritized to stretch #2**, proctor = recording + sure-shot alerts only.
- Built proctor-extension spike + CWS publishing research (`docs/` / `spike/proctor-extension/`).
- Confirmed access to Karthi's authenticated HackerRank session on CDP `:9222` (do NOT disturb his tabs; open my own).
- Set up `night-run/` with this log + `MORNING-REVIEW.md`.

## 2026-06-05 — Build start

- Goal set; created branch `feat/roadmap-and-contest-eval`; committed planning baseline (`c2e5746`); gitignored secrets (`*.pem`, `.crx`, verdict-queue scratch).
- **Phase 1 (monitoring vertical slice) — dispatched** 3 parallel implementation agents: (A) backend alerts-ingestion API + key, (B) admin Live Alerts Console + demo data, (C) contest-eval live poller + LLM verdict-queue seam.

### Phase 1 — monitoring vertical slice (in progress)
- **Backend alerts API** (handler.mjs): `POST /api/alerts` (x-api-key, timing-safe, closed-by-default) + `GET /api/admin/alerts` (admin) + `proctor_alerts` collection, idempotent by alert.id, signed video deep-links. **23/23 unit tests pass.**
- **Admin Live Alerts Console** (frontend): Alert types, `fetchAlerts` + demo data (both sources), Alerts tab in AdminApp, video links. **lint + build green.**
- **contest-eval poller + LLM verdict-queue seam** (monitoring/): deterministic poller, wrapper-over-fork of the contest-eval analysis (originals untouched), file-queue verdict seam + `/loop` responder prompt. **Reproduces committed clone_analysis.json byte-for-byte (both MCET slots); POST to backend works; verdict round-trip works; live read-only acquisition CONFIRMED against :9222 (leaderboard 291, submissions 1569) non-disruptively.**
- Consolidation agent dispatched: unattended CDP driver (deterministic live loop) + monitoring tests + `HOW-TO-RUN.md` + one-command demo, then commit Phase 1.

### Phase 1 — DONE ✅ (committed 142d80b, pushed)
Monitoring tool usable unattended: alerts API (23/23) + admin console (build green) + poller/cdp driver (30/30, live :9222 confirmed) + one-command demo + HOW-TO-RUN.

### Phase 2 — backend roadmap completion (in progress)
Dispatched one comprehensive backend agent (handler.mjs is monolithic → single coherent agent): GCS contest-foldering, session model (persistent/resume + single-session + remove passcodes + admin approve/lock/unlock), sure-shot proctor alerts → proctor_alerts, stats + remote-action endpoints. Then verify + commit, then Phase 3 frontend.

### Phase 2 — backend roadmap completion DONE ✅ (handler.mjs + video-worker + tests, NOT yet committed)
- **2.1 GCS contest-foldering** — added `contestSlugFromUrl()` (last path segment → `sanitizeSegment`; empty/invalid → legacy, no `contests//`), `buildStoragePrefix()`, `sessionPrefix()`. Persisted `contest_slug`+`storage_prefix` on the session doc at start; all 7 key-build sites + admin-evidence listing now read the persisted prefix (zero extra reads). `video-worker/src/server.mjs` scans BOTH layouts and writes merged output beside the chunks. New shape `contests/<slug>/sessions/<username_norm>/<session_id>/...`.
- **2.2 Session model** — removed entry passcode (start gated by time window only) + exit end-code (only assurance checkbox). Added `status` (active/locked/pending_approval/ended), `POST /api/session/resume`, idempotent same-`session_id` start, single-active-session → `pending_approval` on a different session_id, admin unlock path.
- **2.3 Sure-shot proctor alerts** — `/api/events` (recording_stopped/screen_share_stopped/invalid_share_surface/recording_error = critical) + heartbeat (recording_state stopped = critical; ip_changed = warning) upsert idempotent `source:'proctor'` alerts into `proctor_alerts` with `video_key` deep-link; noisy events not surfaced; they appear in `GET /api/admin/alerts` automatically.
- **2.4 Stats + remote actions** — `GET /api/admin/stats` (live/locked/pending_approval/finished/total, optional `?contest_slug=`); `POST /api/admin/session-action` (approve/lock/unlock/bypass/end; per-session or bulk usernames[]).
- **Env/docs** — added `backend/firestore.indexes.json` (composite index username_norm+contest_slug) + idempotent index-create step in `deploy-gcp.sh`; README Phase-2 section (storage layout, session-doc shape, all new/changed endpoints, sure-shot table, index note); runbooks de-passcoded. No new secrets.
- **Tests** — `backend/test/phase2.test.mjs` (29 tests, richer fake Firestore supporting create/update/FieldValue.increment + fake Storage). **Full suite 52/52 green (23 Phase-1 + 29 Phase-2).** Module + video-worker syntax-check clean; video-worker dual-layout parse validated.

### Phase 2 — DONE ✅ (committed 18d815c, pushed) — 52/52 tests

### Phase 3 — frontend roadmap completion (in progress)
Dispatched one comprehensive frontend agent (App.tsx monolithic): student flow (remove passcodes, session resume, identity confirmation, room capture, guided UX, locked/pending states) + admin completion (live stats dashboard, remote actions, alerts console room+name/filters) consuming Phase-2 contracts; demo-mode kept working. Then verify + commit, then Phase 4 audit.

### Phase 3 — DONE ✅ (frontend)
Student flow: passcodes removed, room capture, persistent-session resume, prominent identity card, 3-step guided UX, pending_approval/locked/ended screens. Admin: live stats dashboard, remote actions (per-candidate + bulk approve/lock/unlock/bypass/end), alerts polish (filters, room+name, expandable data, video deep-link). Demo-mode works throughout. lint + build green. N4 (XSS) safe — no dangerouslySetInnerHTML.

### Backend security pass — DONE ✅ (front-loaded Phase 4 gate)
Read-only audit found real issues. **Fixed tonight:** H1 single-session start race → atomic lock doc (`proctor_live_locks`); H3 locked/ended/pending sessions now reject writes (lock/end actually stop the client); M1 pure-dot segment sanitize; M3 500s no longer leak exception messages; N3 malformed JSON → 400. **81/81 backend tests.** **Escalated to MORNING-REVIEW:** C1 (admin password in public bundle — critical, pre-existing, needs real auth), H2 (session_id sole bearer → session_token), M2/M4/L1/L2.

_(appended as phases complete.)_
