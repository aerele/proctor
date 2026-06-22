# Docs cleanup proposal (architect-from-scratch)

**Status:** PROPOSAL ONLY — do not execute. This feeds a later restructure task that
runs on the merged tree. It inventories every Markdown doc, flags what is stale /
redundant / not genuinely required, and proposes where each doc *should* live if
Proctor were documented from scratch.

**Author's note on the current state.** The docs are in good shape — code-verified,
honest about unverified claims, and reasonably organized. The biggest real issues
are: (1) a flat `docs/features/` folder that mixes candidate / admin / invigilator /
reference / runbook concerns; (2) two pairs of runbooks (terse + narrated) that
overlap heavily; (3) genuinely stale pre-build research from the abandoned
HackerRank-iframe era; and (4) a large `superpowers/` design-history tree that is
valuable but mis-placed as if it were operator documentation. Nothing here is a
crisis — this is tidying, not rescue.

---

## Proposed structure (if built fresh)

```
README.md                      # positioning / marketing (just rewritten — keep at root)
CONTRIBUTING.md                # keep at root (GitHub convention)
SECURITY.md                    # keep at root (GitHub convention)
LICENSE                        # keep at root

docs/
  README.md                    # documentation index / table of contents
  ROADMAP.md                   # current roadmap pointer (or fold into GitHub issues)

  guides/                      # operator + developer how-to (task-oriented)
    local-dev.md               # ← moved from root LOCAL_DEV.md
    deploy.md                  # ← was docs/DEPLOY.md (merge the narrated runbook in)
    exam-day-ops.md            # ← was docs/EXAM-DAY-OPS.md (merge the narrated runbook in)
    conductor-guide.md         # ← was docs/CONDUCTOR-GUIDE.md (non-technical room staff)

  features/                    # per-area, code-verified deep dives (behaviour reference)
    candidate/
      candidate-flow.md
      enforcement-ladder.md
    admin/
      contests-templates.md
      problems-stubs-autocomplete.md
      roster-rooms-identity.md
      live-monitoring.md
      results-people.md
      recording-review.md
      data-lifecycle.md
      candidate-evaluation.md  # the integrity + talent engine
    invigilator/
      invigilator-portal.md
    optional/
      contest-eval-monitoring.md

  reference/                   # canonical, not narrated
    architecture-overview.md   # the single-page technical tour ("read this first")
    http-api-reference.md      # the 77-route table (just relocated here, in docs/features for now)
    alert-taxonomy.md          # the Alert contract + alert catalogs

  research/                    # pre-build / background — clearly archival
    proctoring-research.md
    platform-alternatives.md

  design-history/              # ← was docs/superpowers/  (specs + plans, archival)
    specs/
    plans/

  assets/                      # screenshots, unchanged
    harness/ e2e/ e2e-live/ verification/
```

The three top-level folders that matter: **`guides/`** (how do I *do* a thing),
**`features/` + `reference/`** (how does it *behave*), **`research/` +
`design-history/`** (why was it *built* this way — archival). A newcomer reads
`docs/README.md` → `reference/architecture-overview.md` → the relevant guide. That
ordering is what the current flat layout obscures.

---

## Per-file disposition

### Root-level Markdown

| File | Disposition | Notes |
|---|---|---|
| `README.md` | **KEEP (root)** | Just rewritten as the positioning page. Stays at root. |
| `CONTRIBUTING.md` | **KEEP (root)** | GitHub convention; small and current. |
| `SECURITY.md` | **KEEP (root)** | GitHub convention; vuln reporting + operator security duties. |
| `LOCAL_DEV.md` | **MOVE → `docs/guides/local-dev.md`** | It is a how-to guide, not a root concern. Leave a one-line root pointer if desired (the README already links it). Low priority — keeping it at root is also defensible. |

### `docs/` top level

| File | Disposition | Notes |
|---|---|---|
| `docs/README.md` | **KEEP** | The index. Update its internal links after any move. Already good. |
| `docs/DEPLOY.md` | **KEEP → `docs/guides/deploy.md`** | The canonical deploy runbook. **Merge `features/deploy-runbook.md` into it** (see below) — two deploy runbooks is the redundancy. |
| `docs/EXAM-DAY-OPS.md` | **KEEP → `docs/guides/exam-day-ops.md`** | Canonical operator exam-day runbook. **Merge `features/exam-day-ops-runbook.md` into it.** |
| `docs/CONDUCTOR-GUIDE.md` | **KEEP → `docs/guides/conductor-guide.md`** | Non-technical room-staff script. Distinct audience from EXAM-DAY-OPS; keep separate. |
| `docs/ROADMAP.md` | **KEEP (thin) or DELETE** | Now a 12-line pointer that says "old dump removed, see issues." Either keep as a stub or delete and let GitHub issues be the roadmap. Low value as a file. |
| `docs/proctoring-research.md` | **ARCHIVE → `docs/research/`** | **Stale era:** pre-build (2026-06-05) decision report for the *HackerRank-we-cannot-iframe* approach that was abandoned (F8 dropped HackerRank from the candidate path). Historically valuable threat-model reasoning; clearly label as archival, do **not** delete. |
| `docs/platform-alternatives.md` | **ARCHIVE → `docs/research/`** | **Stale era:** 2026-06-04 research on *embeddable* contest platforms for the iframe approach that no longer exists. Archival, not current. Keep but mark. |

### `docs/features/` (the flat folder)

All are current, code-verified deep dives. Disposition is **reorganize into
sub-folders**, not delete — except the two narrated runbooks which should merge.

| File | Disposition | Target |
|---|---|---|
| `candidate-flow.md` | **MOVE** | `features/candidate/candidate-flow.md` |
| `candidate-enforcement-ladder.md` | **MOVE** | `features/candidate/enforcement-ladder.md` |
| `admin-contests-templates.md` | **MOVE** | `features/admin/contests-templates.md` |
| `admin-problems-stubs-autocomplete.md` | **MOVE** | `features/admin/problems-stubs-autocomplete.md` |
| `admin-roster-rooms-identity.md` | **MOVE** | `features/admin/roster-rooms-identity.md` |
| `admin-live-monitoring.md` | **MOVE** | `features/admin/live-monitoring.md` |
| `admin-results-people.md` | **MOVE** | `features/admin/results-people.md` |
| `admin-recording-review.md` | **MOVE** | `features/admin/recording-review.md` |
| `admin-data-lifecycle.md` | **MOVE** | `features/admin/data-lifecycle.md` |
| `candidate-evaluation.md` | **MOVE** | `features/admin/candidate-evaluation.md` (the engine is driven from the admin Results tab) |
| `invigilator-portal.md` | **MOVE** | `features/invigilator/invigilator-portal.md` |
| `contest-eval-monitoring.md` | **MOVE** | `features/optional/contest-eval-monitoring.md` |
| `architecture-overview.md` | **MOVE** | `reference/architecture-overview.md` — it is reference, not a feature. |
| `alert-taxonomy.md` | **MOVE** | `reference/alert-taxonomy.md` — it is the contract reference. |
| `http-api-reference.md` | **MOVE** | `reference/http-api-reference.md` — newly created in this pass (the README's old route table). |
| `deploy-runbook.md` | **MERGE → DELETE** | Narrated companion to `DEPLOY.md`. The two overlap ~80%. **Fold the narration into `guides/deploy.md`** and delete this file, OR keep one canonical + drop the other. Two deploy runbooks is the clearest redundancy in the set. |
| `exam-day-ops-runbook.md` | **MERGE → DELETE** | Narrated companion to `EXAM-DAY-OPS.md`. Same redundancy — **fold into `guides/exam-day-ops.md`** and delete. |

### `docs/superpowers/` (design history — 25 files, ~1.1 MB)

| Item | Disposition | Notes |
|---|---|---|
| `superpowers/specs/*` (13 files) | **ARCHIVE → `docs/design-history/specs/`** | Original design specs (S1–S7, F8–F10, evaluation). Valuable historical record; not operator docs. Rename the folder away from "superpowers" (an internal tool name that means nothing to a reader). |
| `superpowers/plans/*` (12 files) | **ARCHIVE → `docs/design-history/plans/`** | Implementation plans, incl. `2026-06-12-omr-overlay-detection.md` (OMR/overlay detection — verify it shipped or mark as a never-built plan) and `2026-06-18-decomposition-resume.md` (a resume note that may be fully superseded — candidate for deletion if the decomposition is done). |

> **Two specific files to check during the restructure:** `plans/2026-06-18-decomposition-resume.md`
> (a mid-task resume note — likely fully obsolete now the decomposition shipped;
> delete if so) and `plans/2026-06-12-omr-overlay-detection.md` (confirm whether
> overlay detection shipped; if it is an unbuilt plan, keep but label clearly).

### `docs/assets/` (screenshots)

| Set | Disposition | Notes |
|---|---|---|
| `assets/harness/` (688 K) | **KEEP** | Curated set sampled by the README + several guides. |
| `assets/e2e/` (7.9 M) | **KEEP** | Per-feature walkthrough captures embedded across many guides. Large but referenced. |
| `assets/e2e-live/` (1.5 M) | **KEEP** | Live-run walkthrough captures; referenced. |
| `assets/verification/` (1.8 M) | **REVIEW** | One-off `s2-`/`s3-`/`wave2-` build-wave verification grabs. Referenced by a few guides today, but the most likely set to contain orphaned images. During restructure, prune any image no longer referenced by any `.md` (grep each filename); keep the rest. |

### Subdirectory READMEs (code-adjacent)

| File | Disposition | Notes |
|---|---|---|
| `backend/README.md` | **KEEP (in place)** | Code-adjacent service README; correct location. |
| `frontend/README.md` | **KEEP (in place)** | Same. |
| `video-worker/README.md` | **KEEP (in place)** | Same (optional service). |
| `monitoring/README.md` | **KEEP (in place)** | Same (optional poller). These belong next to their code, not in `docs/`. |

---

## Summary of recommended actions

| Action | Count | Files |
|---|---|---|
| **Keep at root** | 4 | `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` |
| **Keep in place** | 4 | the four subdir `README.md`s |
| **Reorganize into sub-folders** (no content change) | ~15 | the `features/` deep dives + the 3 reference docs |
| **Move to `guides/`** | 4 | `LOCAL_DEV.md`, `DEPLOY.md`, `EXAM-DAY-OPS.md`, `CONDUCTOR-GUIDE.md` |
| **Merge then delete** (redundant) | 2 | `features/deploy-runbook.md`, `features/exam-day-ops-runbook.md` → fold into the canonical guides |
| **Archive to `research/`** (stale era, keep) | 2 | `proctoring-research.md`, `platform-alternatives.md` |
| **Archive to `design-history/`** (rename from `superpowers/`) | 25 | `superpowers/specs/*` + `superpowers/plans/*` |
| **Delete-candidate** | 1–2 | `superpowers/plans/2026-06-18-decomposition-resume.md` (if decomposition shipped); `docs/ROADMAP.md` stub (optional) |
| **Prune orphaned images** | — | `assets/verification/` — drop any unreferenced PNG |

**One mandatory follow-through for any move:** every relative link in `docs/README.md`,
in the cross-linking `features/` pages, and in the root `README.md` must be updated
in the same pass (the docs link to each other heavily). A link-check after the move
is non-negotiable.
