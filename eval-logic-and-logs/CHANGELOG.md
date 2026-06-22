# Proctor Evaluation Engine — CHANGELOG

Every entry is a **finding → the rule it changed**. This is the audit trail behind `SPEC.md`. Newest changes are appended; the `PENDING` section at the bottom holds findings ratified but not yet in code (the next phase applies them, updates the SPEC, then moves them up).

Dates are best-known (commit dates / `_nightrun` decision-doc dates). Files are under `backend/src/`. Commit hashes are on `origin/master` unless noted.

Reconciliation note: several `_nightrun` docs describe fixes (a)–(d) as "approved, not-yet-done" because they were written *before* the implementation landed. The git history shows those fixes were then committed (`a02d0e1`, finalized in `eecf164`). For "what is actually in the code", trust the hashes below over the planning docs.

---

## APPLIED (in code)

### 2026-06-12 — Baseline eval engine `9f19469`
- **Motivation:** turn raw contest evidence into a deterministic, per-candidate scorecard; add SQL as a 5th language.
- **Rule:** the original `buildScorecard` + composite + clone/skeleton clusters + recurring-pair detection. Everything below evolves from this baseline.
- **Files:** `evaluationMetrics.mjs`, `evaluation.mjs`, `evaluationClone.mjs`, `evaluationReplay.mjs`.

### 2026-06-19 — Missing/unread evidence must not read as cheating `015ce16`
- **Finding:** an eval run on `tridots-contest-20260619` flagged ~every candidate because the run read **zero** GCS evidence (transient read failure) and the detectors fired on the *absent* data — ~218 false `zero_effort_solve` flags. (`_nightrun/integrity-zero-effort-diagnosis.md`.)
- **Rules changed:**
  - Gate `zero_effort_solve` on editor-coverage being present **and** the specific problem having events (`evaluationMetrics.mjs:458-464`).
  - Gate the "large unpaired insert ⇒ pasted" inference on paste/selection telemetry being present (`evaluationReplay.mjs` availability pre-scan).
  - New explicit **`inconclusive`** integrity tier when coverage is low (zero editor+shell events, or `gcs_read_failed`) — surfaced as "no data — review manually", never a violation (`evaluationMetrics.mjs:875-896`).
  - Stop swallowing GCS read errors: retry with backoff, throw `GCS_READ_FAILED` so a read gap is distinguishable from real absence.
- **Principle established:** *absence of signal ≠ evidence of cheating.* Relied on by all later calibration work.
- **Files:** `evaluationMetrics.mjs`, `evaluationReplay.mjs`, `evaluation.mjs`, frontend `ResultsPanel`.

### 2026-06-20 — P3 read-time recommendation layer `dfed366`
- **Finding/motivation:** calibration against KPR ground truth (`proctor/junk/` — 5 actually-selected interns vs a 9-person confirmed copying ring) proved the **detector already separates them correctly**, but the eval emitted only a mute verdict with `recommended_action=null`. (`_nightrun/P3-calibration-findings.md`, `P3-OVERNIGHT-HANDOFF-2026-06-20.md`.)
- **Rule:** added the calibrated Talent×Integrity **recommendation** as a *pure read-time transform* over stored scorecards — detector untouched, zero risk to the calibrated detection.
  - **The calibration invariant:** integrity **gates** talent; the two are orthogonal and never averaged. Only `confirmed` excludes; `flag` → hold for review; **`watch`/`inconclusive` → desk-check note, never a block.** Forced by the data: 3 of the 5 genuinely-selected KPR interns carry a `watch` note (a single shared medium problem) — a naive "any flag ⇒ exclude" would have rejected most real hires.
- **File:** new `evaluationRecommend.mjs` + `/eval-ui` page.

### 2026-06-20 — P3 triple-review framing fixes + Twin-Pairs evidence `898d964`
- **Finding:** triple-review flagged honesty/over-trust risks — "absence of signal dressed up as evidence of absence." (`_nightrun/P3-MORNING-2026-06-20.md`.)
- **Rules changed (all `evaluationRecommend.mjs`):**
  - Calibration strip demoted to a neutral **methodology** note (`CALIBRATION:233-240`) — no recall-implying live claims.
  - "clean editor history" softened to coverage-aware "clean on what was recorded, not a full clearance" when capture was thin/low-confidence (`buildCase:263-279`) — the false-clear guard against retypers.
  - `recommendFor` exclude gate hardened to trim+lowercase the tier strings before gating (`:104-110`) — the most safety-critical line must survive upstream formatting drift.
  - Every integrity exclusion now ships a verifiable **Twin-Pairs** receipt (`peerEvidenceFor:306-346`): who they share code with, on how many problems (how many hard), submit-gap on the hardest shared problem, same-room corroboration.

### 2026-06-20 — P3 detector calibration: the four fixes (a)–(d) `a02d0e1`
Implements the approved (a)–(d) plan (`_nightrun/P3-RESUME-2026-06-20-v2.md`, `origin-rescue-plan.md`). Bumped `EVALUATOR_VERSION` 1→2.

- **(a) Bare-template foreign-paste suppression** — `evaluationReplay.mjs:617-811` (`isBareTemplate`, used in `isForeign` at `:825`).
  - **Finding:** HackerRank muscle-memory template loads (imports + I/O scaffold + empty function body, no algorithm) were the #1 false desk-check class. The proctor's own starters don't carry the full HR template, so a template load was misclassified as a *foreign* paste. (E.g. a candidate's 308-char "foreign paste" was his own earlier submission.)
  - **Rule:** a paste is a bare template (and suppressed before the foreign substring checks) iff it matches a proctor starter, or matches a `BARE_TEMPLATE_SIGNATURES` preamble + scaffold-markers **and** has a bare (no-algorithm) user-function body under the length bound — `bareTemplateBodyHasAlgorithm===false` (`:798`); plus an SQL DDL/seed guard (`:801-809`). A template that *retains* the scaffold but fills the body with a real algorithm stays foreign.

- **(b) Discount non-genuine partials from the composite** — `evaluationMetrics.mjs:481-491` (accumulate), `:830-838` (apply).
  - **Finding:** a real "gem-gamer" case in the calibration data showed multi-problem stub/partial-gamers out-ranking a genuine 2-problem solver on the composite.
  - **Rule:** every partial solve is non-genuine (a `genuine_arc` requires a full solve), so its **full** points are subtracted from `score_frac` via `discountedPartialPoints` (widened from "only near-stub partials" to all partials). Honest partial progress is still credited separately via `reach_frac`, so this is calibration-safe. Demotes by rank only — `recommendFor` buckets on tiers, never on the composite.

- **(c) Strong-talent floor + `solid_hire` rescue** — `evaluationMetrics.mjs deriveTiers` + `evaluationRecommend.mjs`.
  - **Finding:** the prior strong gate (`genuineMed>=2`) let thin "strong" labels through in weak fields (12 of 14 audit disagreements).
  - **Rule:** tighten strong to `genuineHard>=1 || genuineMed>=3` (the commit also briefly added an `honest_reach>0` clause — removed in `eecf164`, see next). New `solid_hire` bucket keeps a demoted thin-strong (a moderate with ≥2 genuine medium solves) as a **hire**, so the spec hard rule "nobody drops below hire" holds and nobody previously below-bar is newly promoted (`evaluationRecommend.mjs:82-90`, `:158-172`).

- **(d) Origin-rescue bucket** — `evaluationRecommend.mjs:36`, `:370-460`, `:499-503`.
  - **Finding/plan:** read-only analysis (`origin-rescue-plan.md`) found the eval over-excludes genuine solvers who were *copied from* — ~17 rescuable origins across contests (KPR 6, tridots-0618 **0** — a clean sanity check, tridots-0619 11).
  - **Rule:** new `genuine_copied` bucket. For each conclusive clone group/recurring pair, rank members by submit time; the **earliest** member who typed it (`paste_ratio<0.12`), has ≥2 genuine arcs, and has no foreign paste is the genuine **origin** — rescued from `EXCLUDE` to a separate visible bucket (talent kept, integrity demoted to a note). If the earliest member has a foreign paste, the whole group is externally sourced ⇒ **no rescue**. Copiers/external sources stay excluded.

### 2026-06-20 — `honest_reach` is NOT a strong-talent qualifier (final shape of (c)) `eecf164`
- **Finding:** the live recompute exposed over-firing in the (c) gate — the `honest_reach>0` clause labeled candidates who solved **nothing** as "strong". On one contest **165 of 166** strong-tier candidates were reach-only, 58 with zero full solves — inflating the hire pool ~10× (the exact "let in people without talent" failure calibration guards against).
- **Rule changed:** strong = `genuineHard>=1 || genuineMed>=3` only (drop the `honest_reach` clause). `honest_reach` stays credited in the composite (`reach_frac`) and in ranking, just not as a talent-tier qualifier (`evaluationMetrics.mjs:915-927`). The 5 KPR ground-truth interns are all strong via genuine solves and unaffected. Bumped `EVALUATOR_VERSION` 2→3.
- **File:** `evaluationMetrics.mjs`.

> Later commits (`29f1f4e`, `ce73a79`, `e4fe867`, `594b668`, `05e5e7b`) are de-identification, dead-code removal, and comment neutralization — **not** eval-logic changes.

---

## PENDING (2026-06-22, from the June-20 `tridots-coding-contest-20062026` verification)

Findings ratified for the next phase. **Not yet in code.** Source: re-run of contest `tridots-coding-contest-20062026` (the 2026-06-20 ~300-student contest); `_nightrun/TAKEHOME-V1.1-DECISIONS-2026-06-22.md`. When applied, each becomes an APPLIED entry, the SPEC is updated to match, and the change is validated against ground truth (NISHANTH → `strong_hire`).

### 1. NISHANTH S (23alr060) — false-positive "confirmed copied"
- **Finding:** excluded **solely** on `weather-observation-station-5`, a canonical HackerRank SQL exercise everyone solves identically. He typed it himself (0 pasted, genuine arc, 5 solves including a hard one); his "twin" was in a **different room/IP, 75 min apart**. This is a genuine `strong_hire` wrongly excluded.

### 2. Root cause — rare-solve "hardness" × single-hard-problem conclusiveness
- `makeHardness` (`evaluationClone.mjs:28-41`) calls a problem **"hard" at ≤10 distinct solvers** — that is *rare-solve*, not *algorithmically hard*. A canonical SQL one-liner that few people happened to submit is bucketed "hard".
- Then `evaluationMetrics.mjs:1253` makes a recurring pair **conclusive on a single shared hard problem** (`n_hard >= 1`). One canonical-SQL skeleton match between two strangers ⇒ conclusive ⇒ `confirmed` (`deriveTiers:891-893`) ⇒ exclude. The two failure modes compound.

### 3. Fixes to apply next phase (logged, not yet applied)
- **(i) No single SKELETON-ONLY match is conclusive.** Require exact `coreExact` agreement (not just `skeleton`) before a *single-problem* cluster can drive conclusiveness. Skeleton-only convergence on one problem is not proof. → `evaluationClone.mjs` (recurring-pair / clusters) + `evaluationMetrics.mjs:1253`.
- **(ii) Canonical-answer guard.** For problems whose accepted solutions collapse to **very few distinct normalized forms cohort-wide** (low solution entropy — typical SQL / editorial one-liners), down-weight clone clusters **regardless** of solver-count "hardness". Identical answers on a convergent problem are not evidence of copying. → `evaluationClone.mjs` (cluster weighting) + `evaluationMetrics.mjs` (flag emission / `confirmed` gating).
- **(iii) Require a PROXIMITY signal before single-problem escalation to `confirmed`.** A single-problem cluster may only escalate to `confirmed` when a proximity signal is present: **same room OR same IP OR tight-gap** (`meta.tight` / `same_room` / `same_ip_prefix` already computed at `evaluationMetrics.mjs:1232-1238`, currently surfaced but not gating). NISHANTH's twin fails all three (different room/IP, 75 min apart) ⇒ would not have escalated. → `evaluationMetrics.mjs` (`deriveTiers` confirmed gate / `deriveCrossFlags`).
- **(iv) Tighten origin-rescue.** (a) Origin-rescue must **not** fire on skeleton-only-differing pairs (consistent with (i)). (b) A group resolves to **at most one** origin — no mutual-origin; the current merge of one candidate as origin of multiple groups (`evaluationRecommend.mjs:439-447`) plus skeleton-pair groups (`:421-427`) is fragile and must be constrained. → `evaluationRecommend.mjs` (`computeOriginRescues`).

### Related deferred design (not blocking, captured for context)
- **Rule-registry refactor** (`_nightrun/eval-architecture-design.md`, 2026-06-19): split the ~1600-line `buildScorecard` into a data-driven registry where each rule declares its `needs` and the aggregator checks availability before running. The narrow availability fixes landed in `015ce16`; the full registry refactor did not. Forward-looking only.
