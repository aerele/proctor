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

_(Build phases appended below as they happen.)_
