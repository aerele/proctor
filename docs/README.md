# Aerele Proctor — Documentation

Aerele Proctor is a **standalone own-editor exam platform**: candidates register,
share their **entire screen**, and solve coding problems entirely inside our own
**React + Monaco** workspace with **Judge0-backed Run/Submit**. Admins run the
exam from a single console (contests, problems, roster/people, live stats, alerts,
results, recording review, data lifecycle); invigilators work a tokenized
per-room portal. Evidence (screen video + a separate low-res camera stream + JSONL
event logs) streams to Google Cloud Storage, and every integrity **alert** lands in
one console.

HackerRank was dropped from the candidate path (F8.2) — candidates never leave our
editor. A clearly-labelled **optional** secondary component still exists: a Python
**contest-eval monitoring poller** (`monitoring/`) that live-watches an
*externally-hosted* HackerRank contest and feeds cheating alerts into the **same**
alerts pipeline. It is not part of the candidate experience and is not required to
run an exam.

> **Standard of truth.** Every page here documents only behavior verified against
> the code/UI in this repo or an existing screenshot. Anything not independently
> confirmed is marked **(unverified)**. The product owner's rule: *if the docs say
> it works, it works.* The live build-state single-source-of-truth is
> [`../night-run/RESUME-ANCHOR.md`](../night-run/RESUME-ANCHOR.md) — read it before a
> real contest.

This page is the index. New here? Read
[`features/architecture-overview.md`](features/architecture-overview.md) first for
the fullest single-page tour, then jump to the area you need below.

---

## Getting started (operators)

| Page | What it covers |
|---|---|
| [`DEPLOY.md`](DEPLOY.md) | From-scratch GCP build + deploy runbook: isolated project, backend/frontend/(optional) video-worker deploy scripts, the env vars the scripts do **not** set (Judge0, invigilator, retention-sweep, `EXEC_*`), retention lifecycle + daily sweep, redeploy (merge vs wipe), and a verify-the-deploy smoke test. |
| [`EXAM-DAY-OPS.md`](EXAM-DAY-OPS.md) | The one-page, action-ordered exam-day runbook: BEFORE setup → AT START → DURING → AFTER, plus an "if X then do Y" table for the test-day team. |

Deeper, narrated versions of both live under Feature guides as
[`features/deploy-runbook.md`](features/deploy-runbook.md) and
[`features/exam-day-ops-runbook.md`](features/exam-day-ops-runbook.md).

## Feature guides

Per-area, code-verified deep dives under [`features/`](features/).

### Candidate

| Page | What it covers |
|---|---|
| [`features/candidate-flow.md`](features/candidate-flow.md) | The full candidate journey: permissions-first onboarding → fullscreen → roster identity confirm → multi-problem Monaco workspace with per-language stubs, curated autocomplete, and live Judge0 Run/Submit → integrity-assurance end. |
| [`features/candidate-enforcement-ladder.md`](features/candidate-enforcement-ladder.md) | The fullscreen-enforcement ladder: L1 typed-ack blocking overlay, L2 lock, the three unlock paths, per-session exemptions, switch-away debounce, and `alert_first` mode. |

### Admin console

| Page | What it covers |
|---|---|
| [`features/admin-contests-templates.md`](features/admin-contests-templates.md) | Templates (author/duplicate/delete, the built-in System-check preset, snapshot-on-instantiate) and Contests (create/open/archive, access code + invigilator key, exam window, rooms + start gate, guard-aware open-contest edits, global selector + `?contest=` routing). |
| [`features/admin-problems-stubs-autocomplete.md`](features/admin-problems-stubs-autocomplete.md) | The Problem bank: authoring (statement, sample + hidden tests, limits, points, scoring, draft→published), per-language starter stubs (F12.2), curated Monaco autocomplete (F12.3), and the live-save / live-reference guards. |
| [`features/admin-roster-rooms-identity.md`](features/admin-roster-rooms-identity.md) | Flexible-column CSV/TSV roster upload, the legacy-vs-person paths, the compulsory college column + two-stage canonicalization, duplicate-id hard-reject, the `person_id = "{college_norm}~{uid_norm}"` model (persons/colleges/enrollments), rooms + room-gate, and candidate-side identity confirm. |
| [`features/admin-live-monitoring.md`](features/admin-live-monitoring.md) | Live stats (status cards, room filter, 5 s auto-poll, drill-down), Sessions + detail card + actions (approve/lock/unlock/bypass/end), the Live alerts console (filters, grouping, bulk archive, video deep-links), the IP report, Attendance, and near-live disconnection. |
| [`features/admin-results-people.md`](features/admin-results-people.md) | The Results tab (ranked table, AND-filters, bulk selection, gated "Mark selection done" snapshot + retention clock, CSV export) and the People tab (cross-round per-person scorecards with live/snapshot/purged fallback), plus the legacy "Adopt into person model" backfill. |
| [`features/admin-recording-review.md`](features/admin-recording-review.md) | Recording review: chunk-based screen/camera playback, the test-relative scrubber (submission markers, gap hatching, alert dots, event lane), the click-to-jump activity log, the picker + Sessions deep-link, review mode, and the clearly-marked caveats. |
| [`features/admin-data-lifecycle.md`](features/admin-data-lifecycle.md) | Per-contest export, the triple-gated purge → tombstone, the evidence-retention clock + daily sweep, the GCS lifecycle backstop, the export-existence safety floor, and the lifecycle-phase badges. |

### Invigilator

| Page | What it covers |
|---|---|
| [`features/invigilator-portal.md`](features/invigilator-portal.md) | The tokenized, name-only per-room portal: key/password auth, room picker + console, clickable status filters, the start-code gate, the separate enforcement-unlock namespace, per-student unlock + exemption toggles, selective alerts (default all OFF), and least-privilege scope. |

### Optional contest-eval poller

| Page | What it covers |
|---|---|
| [`features/contest-eval-monitoring.md`](features/contest-eval-monitoring.md) | The optional `monitoring/` Python poller for externally-hosted HackerRank contests: the one-cycle pipeline, the unattended CDP driver, the file-queue LLM verdict seam, the local tab-away detector, the submission-events runbook, the offline demo + tests, and PII/git hygiene. |

### Runbooks (narrated)

| Page | What it covers |
|---|---|
| [`features/deploy-runbook.md`](features/deploy-runbook.md) | The narrated GCP deploy runbook (companion to [`DEPLOY.md`](DEPLOY.md)): project bootstrap, the `.env.deploy.local` key table, exact Cloud Run params per service, Wave-7 retention split + scheduler sweep, `EXEC_*` tuning, and the real-exam standing rules. |
| [`features/exam-day-ops-runbook.md`](features/exam-day-ops-runbook.md) | The narrated exam-day runbook (companion to [`EXAM-DAY-OPS.md`](EXAM-DAY-OPS.md)): admin setup order, candidate flow, invigilator live-ops, the L1/L2 lock-and-unlock ladder, live time control, monitoring surfaces, and post-exam Results/People/Recording/Lifecycle. |

## Reference

| Page | What it covers |
|---|---|
| [`features/architecture-overview.md`](features/architecture-overview.md) | The fullest single-page tour: the three path-routed frontend surfaces, the partially-decomposed `handler.mjs` backend, the 20+ Firestore collections + GCS evidence prefixes, the `person_id` identity model, the shared Alert contract, the not-deployed video-worker, and the ~81-route HTTP inventory. **Read this first.** |
| [`features/alert-taxonomy.md`](features/alert-taxonomy.md) | The shared Alert JSON contract (required fields, idempotent merge on `id`), the proctor alert catalog + admin alert-settings defaults, per-type Share-with-invigilator (default OFF), the optional contest-eval alert types, the `x-api-key` ingest (closed-by-default, batch ≤ 500), and the enforcement-violation lock-ladder flow. |

### Background research (pre-build)

These predate the current build and capture the design rationale rather than the
shipped surfaces:

- [`PROCTORING_RESEARCH.md`](PROCTORING_RESEARCH.md) — threat model + browser-proctoring research.
- [`PLATFORM_ALTERNATIVES.md`](PLATFORM_ALTERNATIVES.md) — platform alternatives evaluated.
- [`ROADMAP.md`](ROADMAP.md) — design background and roadmap.

---

## Conventions used across these docs

- **Own-editor platform** — the primary product; candidates code in our React +
  Monaco workspace with Judge0 Run/Submit. The `monitoring/` contest-eval poller is
  always called out as the **optional** secondary component.
- **Person identity** — `person_id = "{college_norm}~{uid_norm}"`, stable across
  contests; the multi-round spine. Legacy contests use bare `username_norm` until
  adopted.
- **Contest vs template** — a *template* is a reusable blueprint (ordered problems +
  default settings); a *contest* is one administered round instantiated from a
  template or blank (snapshot-copy, not a live link).
- **(unverified)** — flags a behavior the page could not confirm against code or a
  screenshot.

Screenshots used throughout these pages are kept under
[`assets/`](assets/) so `docs/` is self-contained.
