# Roadmap build (minus iframe) + contest-eval live monitoring

**Branch:** `feat/roadmap-and-contest-eval` · **Open it:** https://github.com/aerele/proctor/pull/new/feat/roadmap-and-contest-eval
**Base:** use **`master`** (this repo's default branch, which the work forked from cleanly — 6 commits). `main` is a divergent commit; don't base on it without checking.

## What this delivers
The full `docs/ROADMAP.md` **except the iframe lockdown (Epic 1, proven impossible — see `spike/iframe-test/FINDINGS.md`)**, plus the contest-eval live monitoring tool.

### Contest-eval monitoring (the headline — usable unattended)
- `monitoring/` deterministic poller drives Chrome on `:9222` itself (`cdp.py`, stdlib) — no agent-in-the-loop; reproduces the committed clone clusters byte-for-byte; 429-safe code fetch.
- Backend **alerts ingestion API** (`POST /api/alerts` x-api-key, timing-safe, closed-by-default) + `GET /api/admin/alerts`, `proctor_alerts` collection, idempotent, signed video deep-links.
- Admin **Live Alerts Console** + filters + per-candidate/bulk remote actions.
- **LLM verdict seam** (file-queue): default = a Claude Code `/loop 1m` responder (subscription, no API); C3 transport = future swap. Deterministic-only graceful degradation.

### Proctor roadmap
- **Storage** foldered by contest (`contests/<slug>/sessions/<user>/<sid>/…`), legacy fallback.
- **Session model:** passcodes removed; persistent session + resume-on-reload; single-active-session-per-username (atomic lock doc); admin approve/lock/unlock/bypass/end (per-candidate + bulk); status-gated writes.
- **Student UX:** room capture, prominent identity confirmation, 3-step guided flow, locked/pending/ended states.
- **Sure-shot proctor alerts** (recording/screen-share stopped, IP change) → the same alerts console, with video deep-links.
- **Live stats dashboard** (live/locked/pending/finished/total).

### Hardening (review-driven)
Security pass fixed H1 (single-session race), H3 (status-gated writes), M1/M3/N3. Audit pass fixed B0 (admin console stuck-loading — caught by live verification), B1 (lock now stops the recorder), B2/B3 (alert contract mismatches), B4/B5/B6.

## Tests
85 backend (mocked Firestore), 30 monitoring, frontend lint+build green. Admin console + student flow visually verified in demo mode.

## ⚠️ Before a real contest — see `night-run/MORNING-REVIEW.md`
- **C1 (critical, pre-existing):** admin password is in the public student bundle → exposes all recordings. Needs real staff auth (IAP/SSO).
- Untested against real GCP (no creds overnight): storage foldering, live backend alert routes, B4 cross-bucket video signing, the deploy.
- Open decisions (defaults chosen) + the deferred H2 session-token hardening are listed in the morning review.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
