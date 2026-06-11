# Aerele Proctor — Product Backlog

Deferred work parked here for clarity. **None of this is needed for the 2026-06-12 live test.**
Tomorrow's only priority: candidates take the test on **this** platform with **zero breakage**, an
experience **as smooth as HackerRank**, and clean **keystroke/event data** captured for analysis.

_Last updated: 2026-06-11 (Karthi multipart prioritization, TG 1841–1845)._

---

## Maybe-soon — next stretch goal (only AFTER the live flow is verified rock-solid)
- **F2 / F2.1 — OMR screen-markers + local overlay-occlusion detection** _(task #62)_.
  Render OMR-style markers on all screen edges + a few interior points; a lightweight LOCAL CV pass
  over recorded screen frames flags when markers are occluded/missing (= an overlay/cheat tool covering
  the screen), timestamped + jump-to-recording, correlated with focus-change (no-focus-change = the real
  overlay alert; with-focus-change + quick return = tag for review, not a hard alert).
  **Karthi: the one feature we may build today — but only once the whole exam flow is confirmed glitch-free.**

## Deferred features — "some other day"
- **RT-2 (LOW, 2026-06-12 retest)**: end-screen/manifest chunk count can undercount vs GCS when a refresh interrupts manifest persistence (44 vs 48 in the retest); player unaffected (lists GCS directly).
- **RT-3 (LOW, 2026-06-12 retest)**: admin Recordings timeline merges the person's OTHER sessions' alerts at 00:00 ("SESSIONS COVERED 2") — honest timestamps, but visually confusing; consider per-session lanes or offset mapping.
- **S-F — contest-eval adapter** _(#32)_: make the Python contest-eval poller easily startable + investigate
  why the last real run produced zero contest-eval alerts.
- **F7 — recording-encoding optimization**: research done; implementation pending a discuss-round (best
  codec/settings for mostly-static screen recordings on weak candidate CPUs).
- **F10.4 — multi-round subset selection**: re-uploading a roster already auto-links to existing persons by
  the `college+unique_id` key; the convenience UI to *pick a subset of a prior roster* for the next round is unbuilt.
- **#59 — person-mode reviewer-QUEUE resolution** _(scope call)_: the recording *player* resolves person-mode
  sessions; the distributed reviewer *workflow queue* (roster→claims→verdicts→serve) is still candidate-norm-keyed.
- **#60 — person-mode submission timeline markers**: green/red submission dots on the recording timeline don't
  populate in person mode (small follow-up, bundle with #59).
- **#61 — alert→recording deep-link fallback**: fall back to the raw chunk player (or deploy the video-worker)
  when no merged review video exists.

## Security hardening — post-exam wave (2026-06-12 triple review; verdict GO, M1 already fixed+deployed)
- **L1**: upload-url hwm read-modify-write not transactional (own-session race only) → Firestore transaction/increment.
- **L2** (pre-existing): signed PUT URLs carry no `x-goog-content-length-range` size cap + no per-session URL-count cap.
- **L3**: routesAuthLint scans only `src/routes/*.mjs` — extend to handler-resident `admin*` functions (contest-set-code verified auth-first manually).
- **L4**: upload retries inflate `chunk_count` (admin duration estimate drifts; manifest stays truthful).

## Paused work — resume after the test
- **Architecture decomposition** (behavior-preserving god-file split). **B0+B1 DONE + green** (HEAD `49af4f1`,
  backend 705/705, tree clean). **Resume at B2.** Plan: `docs/superpowers/plans/2026-06-11-architecture-decomposition.md`
  (PAUSE/RESUME banner at top). Memory: `proctor_architecture_decomposition`.

## Open decisions — shipped with sensible defaults; ratify when convenient ("let it be" — Karthi)
- **D1 save-warning** wording: by contest count [shipped] vs live-session count; extend to settings saves [shipped: no].
- **Purge typed-confirm**: SLUG [shipped] vs NAME.
- **Export-zip retention** = 10 days [shipped] (GCS backstop 11d).
- **ROADMAP 6.1 — WebSockets live events**: keep-dead (5s polling supersedes) or backlog?
- FYI (no action): M6 clipboard primer middle-path, People/adopt fan-out caps, legacy start-input back-compat.

_Dropped per Karthi (TG 1843): the TG 1574/1575 broker-outage texts — no longer tracked._
