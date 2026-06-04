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

_(appended as phases complete.)_
