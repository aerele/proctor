# Aerele Proctor — Roadmap

The single source of **direction**: what is **Done**, and what is planned for
**v2 / Future**. The active version's committed worklist lives in
[`BACKLOG.md`](BACKLOG.md). How this file is maintained: see
[`AGENTS.md`](AGENTS.md) → "THE ROADMAP RULE". Shipped behaviour is documented
under [`docs/`](docs/README.md); proposals under [`docs/proposed/`](docs/proposed/).

> Legend: **Done** = built, integrated, green · **v1.1** = the active cut (see
> `BACKLOG.md`) · **v2 / Future** = agreed direction, not started.

---

## Active — v1.1
The committed v1.1 cut (recording-integrity fixes, candidate-flow correctness,
the alert-feedback + bulk problem I/O features, and the tracking-discipline
cleanup) is tracked item-by-item in **[`BACKLOG.md`](BACKLOG.md)**. When an item
ships it moves from there into "Done" below.

---

## Done

### v1.1 groundwork (built, integrated, tests green)
- **Privacy & consent.** Consent gate blocks exam entry until T&C + Privacy are
  viewed and a choice is recorded; per-contest data retention/erasure anchored to
  the contest's exam-end (deletes recordings/audio/snapshots/keystrokes/PII, keeps
  roll numbers/scores/eval results); application-level, contest-scoped (never a
  bucket-wide lifecycle); deleted-vs-retained disclosure + admin per-contest
  data-size view.
- **Anti-cheat hardening.** Browser/codec preflight with an anti-spoof hard block
  (actually attempts screen+keystroke+cursor capture, blocks entry if it can't);
  best-effort devtools/inspect detection (heuristic).
- **Infrastructure hardening.** Candidate-telemetry rate limits; hot-path caches
  with correct invalidation; signed-URL size cap + tightened bucket CORS; request
  body-size cap; Firestore-backed sharded token-bucket limiter that absorbs Judge0
  429s (see [`docs/JUDGE0-RATE-LIMITER.md`](docs/JUDGE0-RATE-LIMITER.md)).
- **Cleanup.** Standalone video-worker removed; exam-window timezone + non-ASCII
  identity normalization tidied.

### Evaluation engine
- Deterministic **talent + integrity evaluation** is live (admin-triggered from
  Results; cursor-batched, idempotent). See
  [`docs/features/candidate-evaluation.md`](docs/features/candidate-evaluation.md).
- A per-test self-improvement loop verifies verdicts for high-stakes categories
  within the retention window. (Auto-run-after-every-test → v2/Future, below.)

### Removals
- **Video-worker** removed entirely (service + deploy + code).
- **HackerRank poller subsystem** removed entirely; candidates work entirely
  inside the in-app own-editor. Core proctoring alerts unaffected.

### Cost & operations
- Long-term archive lifecycle armed (auto-delete at 300 days); small objects
  bundled before archive (object **count** drives Class-A cost).
- Per-contest evidence cleared after the evaluation pass was validated.

### Recording-pipeline incident fixes (2026-06-23, on `fix/recording-drain-gate`)
- Evidence-bucket CORS allows `x-goog-content-length-range` (chunk-upload
  regression); candidate end-of-test can never claim "safe to exit" while
  recording chunks are unsent. *(These are the v1.1 REC-1/REC-2 items — listed in
  `BACKLOG.md` until the v1.1 cut ships.)*

---

## v2 / Future

### Candidate exam
- **Flags viewable to the candidate** — flags-only filter on the candidate's
  proctoring-events view. *(triage F2)*
- **In-exam SQL/SQLite function reference** — searchable function list +
  descriptions so candidates don't memorise dialect syntax. *(F3)*

### Proctoring / admin
- **Top per-candidate progress bar** for invigilators (problems 1–N, colour as
  done) to read who's on-track/stuck from afar. *(F5)*
- **True-push live status (WebSockets)** vs the current 5s polling/beacon, ~500
  concurrent. *(F7)*
- **OMR-style screen markers** detected locally in the recording (edges/middle)
  to catch overlay/cheat tools → timestamped alerts. Spec:
  `docs/design-history/plans/2026-06-12-omr-overlay*`. *(F8)*
- **Unified settable alert-types list** (enable/disable + severity, proctor +
  eval). *(F9)*

### Evaluation / talent
- **Automatic AI verification after every test** — re-check the whole record
  (selections/exceptions) automatically, not just admin-triggered (task #144).
  **Confirmed v2 on 2026-06-23** — distinct from the v1.1 **F14** rule-registry
  refactor (EVAL-1 in `BACKLOG.md`): F13 is the new auto-run + judgment capability.
  *(F13)*
- **Multi-round** — select a subset of / append to a previous round's roster,
  link rounds by college + unique-ID, show combined scores. Spec:
  `docs/design-history/specs/2026-06-10-f10-product-vision.md`. *(F15)*

### Testing / robustness
- **Real-question health-check** — extend the admin health-check to actually
  solve + verify each contest's real questions/stubs/test cases (AI + Judge0),
  selectable per contest. Would catch the class of bug that broke chunk upload.
  *(R2)*
- **Code-driven, no-AI E2E integrated test suite** (multi-browser, all flows:
  entry, permissions, lock/unlock, recording, admin, approval). *v2+ (lower
  priority).* *(R3)*
- **Committed problem-seed source** — problem/template definitions currently live
  only in the live bank (admin-API-authored), so broken stubs are invisible to CI
  and review (this is how the v1.1 STUB-1 stubs slipped). Add a committed
  seed/export source — BANK-1's export format gives the serialization — so problem
  changes become reviewable diffs and CI can validate stubs. Tied to R2.
  *(prevention, agreed 2026-06-23)*
- **DSL-driven stub generation for authoring** — author writes one DSL stub (e.g.
  function signature + I/O shape) and per-language stubs are generated automatically,
  instead of hand-writing each language. *(triage T9 — silently dropped in the
  2026-06-23 BACKLOG rewrite, never built; recovered 2026-06-24.)*

### Infra / ops
- **Self-scoped min-instances** — the instance sets min-instances=1 before a test
  and 0 after; answer the cold-start/warm-duration/scale questions. *(O1)*
- **Re-arm per-contest evidence retention** (~4-day, carefully scoped so it never
  touches preserved live-test data). *(O2)*
- **Billing visibility** — Cloud Billing API + billing-viewer grant + forward-only
  BigQuery billing export. *(O3, #151)*
- **Split the candidate exam frontend** into its own deployable instance so eval
  can redeploy without risking the live exam path. *(O4)*
- **In-browser run/submit via WASM** to offload Judge0 (with an anti-spoof /
  browser-trust plan). *(O5)*
- **Scale-to-zero self-hosted Judge0** investigation (on-demand containers, easy
  bring-up/tear-down). Parked behind a swap-able adapter. *(O6)*
- **Managed limiter (Memorystore/Redis)** once scale exceeds the Firestore
  sharded-limiter ceiling. *(O7)*
- **Eval-iframe `sandbox` hardening** — add a `sandbox` (e.g.
  `allow-scripts allow-same-origin`) to the admin Evaluation-tab iframe. The
  https-only build assertion half already shipped (`add9217`); the sandbox needs
  eval-UI browser verification before it lands (could break the cross-origin
  /eval-ui if scoped too tightly). *(v1.1-r2 security-review MINOR / DiD)*

### Housekeeping / open
- **Candidate-visible leaderboard** (optional, per-contest toggle, HackerRank-style)
  — **v2** (agreed TG 2026-06-12; re-confirmed 2026-06-23). Was briefly read as
  *"not adopting"* after `PRODUCT-BACKLOG.md` was deleted; resolved — it's a v2
  feature. *(M2)*
- **Prune excessive tests** (~914 backend / ~853 frontend — remove repetitive /
  pointless). *(M4)*
