# RESUME.md — read this FIRST after a context compaction

I am **Ram** (see `~/arogara/PERSONA.md`), working with **Karthi** in `~/arogara/proctor`, attached to the `proctor` C3 topic, **CLI mode**. Repo HEAD: `master` (was `1c43c36` at compaction).

## 🎯 ACTIVE GOAL (set 2026-06-08) — self-hosted, fully-controlled coding contest for a test TOMORROW (2026-06-09)
Karthi has another coding test **tomorrow** and wants **complete control**. Requirements:
1. **Self-host** a coding-contest platform (not SaaS — every SaaS exam app blocks iframing).
2. **Embed it in our proctoring app** (iframe) with **fullscreen view + lockdown control**.
3. **Record everything — mouse movements + keystrokes** — for **analytics**. Karthi has a **full spec** for this that he WILL SEND.
4. Build it **fast** (tomorrow).

## 🧱 LOAD-BEARING ARCHITECTURAL CONSTRAINT (already surfaced to Karthi)
**Recording keystrokes/mouse requires the contest editor to be SAME-ORIGIN (ours).** A cross-origin iframe (e.g. `ide.judge0.com`) is a black box — the browser won't let our page read keydown/mousemove inside it. So "iframe a third-party app" gives the screen but NOT the keystrokes. The only way to get embed + fullscreen + event capture together is to **own the origin**:
- **Self-host Judge0** (engine + its IDE) on our domain → same-origin iframe, OR
- **Build a thin editor** (Monaco/CodeMirror + submit → Judge0 API) directly in our page (no iframe needed).
Either way **Judge0 is the execution engine behind it.**

## 📋 PLATFORM RESEARCH — `docs/PLATFORM_ALTERNATIVES.md` (2026-06-04)
SaaS exam apps near-universally set `X-Frame-Options: SAMEORIGIN` (HackerRank, HackerEarth, Codility, CodeSignal, …) → can't iframe them. Self-host open-source options:
- **Judge0 ★ (my #1)** — GPLv3 execution+judging engine + official **embeddable IDE** (verified iframe-able: no XFO, `ACAO:*`). 40+ langs, `isolate` sandbox, worker pool scales for 500. It's an ENGINE, not a turnkey UI — we build contest/auth/leaderboard (clean submission API to poll).
- **DOMjudge ★ (#2)** — turnkey ICPC contest system (Symfony), our app on our origin → iframe trivial, proven 1000+ teams. Tradeoff: ICPC accept/reject grading, manual authoring, no problem bank.
- **CMS (IOI)** — heaviest; IOI subtasks/partial scoring.
- Non-self-host fallback: embed-SDK vendors **Sphere Engine** / **Qualified.io**.

## ▶️ IMMEDIATE NEXT STEP (after compaction)
Karthi wants to **discuss and finally SELECT the platform + approach** BEFORE he sends the spec. So resume that decision: **Judge0-self-host (iframe our IDE) vs build-our-own-editor-on-Judge0-API vs DOMjudge**. My lean: own the origin via Judge0 (engine) + our own/self-hosted editor, because that's the only thing that satisfies the keystroke/mouse recording. After the platform is chosen, Karthi sends the spec → we build. **Be straight about what's realistic by tomorrow.**

## 🏗️ EXISTING REPO (what we already have to build ON)
`proctor` is a working browser proctoring app (`master 1c43c36`): screen recording (chunked webm → GCS), admin console (live stats/alerts), Firestore session model, **recording playback UI + per-submission markers + 2-hour timeline scale**, **multi-reviewer review workflow** (priority queue + atomic claims + CSV export), and a **heavy-recording 500 fix** (bounded GCS signing). Backend = GCP Cloud Functions/Cloud Run + Firestore + GCS (deployed at `aerele-proctor-api-…run.app`); frontend = React/Vite/TS/Tailwind. **It already records the SCREEN** — the new ask adds **mouse+keystroke capture + hosting the contest itself** inside this shell. Contest-eval poller (`monitoring/`) + the KEC/MCET contests are DONE/over.
