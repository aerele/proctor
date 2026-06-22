# Aerele Proctor — Roadmap

The single tracked source of truth for what is **built**, what is **in flight**, and
what is **planned**. Shipped behavior is documented under [`docs/`](docs/README.md);
this file tracks direction, not feature reference.

> Status legend: **Done** = built, integrated, and green on the active release
> branch · **In flight** = under active work · **Planned** = agreed, not started.

---

## Done — v1.1 (built, integrated, tests green)

The v1.1 release groups are complete and integrated on the release branch (backend
and frontend test suites green; type-check clean). Four groups:

- **Privacy & consent.** A consent gate blocks exam entry until the candidate has
  viewed the Terms & Conditions and Privacy pages and recorded an explicit choice
  (consent version + timestamp). Per-contest data retention/erasure is **anchored to
  the contest's exam-end** so the sweep actually runs: it deletes recordings, audio,
  snapshots, keystrokes, and PII while **keeping** roll numbers, scores, and
  evaluation results. The sweep is an **application-level, contest-scoped** operation
  — never a blunt bucket-wide lifecycle that could delete unrelated data. Candidates
  see a clear deleted-vs-retained disclosure; admins get an async per-contest
  data-size view.
- **Anti-cheat hardening.** A browser/codec preflight with an anti-spoof **hard
  block**: capability detection actually attempts screen + keystroke + cursor
  capture and blocks entry (with a "use the latest Chrome" prompt) if it cannot be
  established. Best-effort DevTools/Inspect detection logs and warns (heuristic, not
  bypass-proof by design).
- **Infrastructure hardening.** Candidate-telemetry rate limits (sized so real data
  is never throttled); hot-path caches with correct invalidation; signed-URL size
  cap + HD headroom + tightened bucket CORS; a request body-size cap; and a
  **Firestore-backed sharded token-bucket limiter** that absorbs Judge0 429s under
  load, with a documented scale ceiling (see
  [`docs/JUDGE0-RATE-LIMITER.md`](docs/JUDGE0-RATE-LIMITER.md)).
- **Cleanup.** The standalone video-worker service was **removed** (service, deploy,
  and code). Exam-window timezone handling and basic non-ASCII identity
  normalization were tidied where the fix was simple.

## Done — evaluation engine

- The deterministic **talent + integrity evaluation** engine is live (admin-triggered
  from the Results tab; cursor-batched and idempotent). See
  [`docs/features/candidate-evaluation.md`](docs/features/candidate-evaluation.md).
- A **per-test self-improvement loop** verifies the engine's verdicts for high-stakes
  categories after each test and tightens the algorithm within the retention window.

## Done — removals

- **Video-worker** removed entirely (service + deploy + code), behavior-preserving
  for everything else.
- **HackerRank poller subsystem** removed entirely: the offline laptop poller and its
  monitoring directory, the HackerRank data-fetch path, and the HackerRank-sourced
  analytics that were pushed into admin alerts. Proctor no longer integrates
  HackerRank — candidates work entirely inside the in-app own-editor platform. The
  **core proctoring alerts** (tab-hidden, focus loss, etc.) are unaffected.

## Done — cost & operations

- Long-term **archive lifecycle armed** (auto-delete at 300 days). Lesson applied:
  object **count**, not bytes, drives storage Class-A cost, so archives are bundled
  before any archive copy.
- Per-contest **evidence cleared** after the evaluation pass was validated.

---

## In flight

- **Deploy v1.1.** Stage the v1.1 release through the standard zero-downtime cut
  (build → no-traffic tagged revision → pre-flight health-check → cut traffic, prior
  revision kept at 0% for instant rollback). See [`docs/DEPLOY.md`](docs/DEPLOY.md).
- **Privacy/consent copy sign-off.** The Terms & Conditions and Privacy page drafts
  are written and awaiting a final content review before they go live.

## Planned

### Cost & billing visibility
- Re-arm the short (≈4-day) per-contest evidence retention, carefully scoped so it
  never affects preserved live-test data.
- Enable billing visibility: Cloud Billing API + a billing-viewer grant + a
  forward-only BigQuery billing export.
- Keep `min-instances = 0` for idle cost; the deploy flow scales up only for a test
  and scales back down after, warning the deployer either way.

### Evaluation
- Ratify the eval logic/spec workflow (finding → changelog → spec → rebuild from
  spec) and merge the eval-logic docs to the mainline.
- Make the per-test verdict self-check run automatically after every test.

### Product / structure
- Split the candidate exam frontend into its own deployable instance.
- Bulk export/import of problems + templates (multi-select, dedup, versioning).
- In-browser Run/Submit via WASM to offload Judge0.
- A managed limiter (e.g. Memorystore/Redis) once scale exceeds the documented
  Firestore sharded-limiter ceiling.

---

*Planned work and open questions are also tracked as GitHub issues on this
repository. When an item ships, it moves from a "Planned"/"In flight" section up
into "Done" and its behavior is documented under [`docs/`](docs/README.md).*
