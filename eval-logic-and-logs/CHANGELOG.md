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

### 2026-06-22 — Canonical-SQL false-positive fixes (i)–(iv) — APPLIED on `feat/eval-logic`
Implements the four ratified fixes below. Bumped `EVALUATOR_VERSION` 3→4 and `RECOMMEND_VERSION` 1→2 (verdicts change). Validated by a **non-destructive** local recompute of `tridots-coding-contest-20062026` (282 cards, read-only GET from the deployed eval service; Firestore untouched) plus the KPR ground-truth oracle.

> PII note: the candidate names/IDs that exposed this finding live ONLY in `proctor/junk/` (gitignored). This entry describes them by role (the canonical-SQL false-positive pairs; the substantive-copy pairs) — never by name/ID — since this file is in a public repo.

- **Motivation / finding:** the June-20 re-run excluded **four candidates** (two single-problem pairs) as "confirmed copied" **solely** on `weather-observation-station-5` — a canonical HackerRank SQL exercise. Each typed it themselves (0 pasted, genuine arcs, ≥1 hard solve); the two members of each pair were in a **different room, ~75 min apart**. Two compounding root causes: (a) `makeHardness` calls a problem "hard" at ≤10 *distinct solvers* — rare-solve, not algorithmic difficulty — so a canonical SQL one-liner that few people submitted is bucketed "hard"; (b) a recurring pair was made **conclusive on a single shared hard problem** (`n_hard >= 1`), so one canonical-SQL match between two strangers ⇒ `confirmed` ⇒ exclude.

- **(i) No SINGLE skeleton-only match is conclusive** — `evaluationClone.mjs` (recurring-pair enrichment `:363-381`) + `evaluationMetrics.mjs` (conclusiveness gate `:1296-1308`). The recurring-pair record now carries `n_exact` / `exact_problems` (problems where the pair shares a byte-identical **coreExact** accepted form, derived from the exact clusters). A **single-problem** pair may drive conclusiveness only when that one problem is a coreExact match — skeleton-only agreement on one problem is convergent-algorithm noise, not proof. **Scope:** the coreExact requirement is single-problem-only; a **multi-problem** skeleton ring (renamed-variable copying across ≥2 problems) stays conclusive. (Restricting the multi-problem path to coreExact was tried and **rejected**: it released a real renamed-variable ring in the KPR oracle — a false negative far worse than the false positive being fixed.)

- **(ii) Canonical-answer / low-entropy guard** — `evaluationClone.mjs` (`computeCanonical` `:64-96`, thresholds `:44-51`) + `evaluationMetrics.mjs` (`attachClusterRefs` canonical down-weight `:1381-1408`, `deriveCrossFlags` `:1585-1594`, conclusiveness gate). A problem is **canonical** iff, cohort-wide, its distinct accepted normalized forms are FEW (`≤ CANONICAL_MAX_FORMS = 8`) **AND** the median accepted solution is SHORT (`≤ CANONICAL_MAX_LEN = 200`) **AND** enough independent solvers converged (`≥ CANONICAL_MIN_SOLVERS = 5`). On a canonical problem an identical match is convergence, so its hard clone cluster is **down-weighted** (the critical `hard_clone_cluster` flag degrades to a warning `clone_cluster`) and it does NOT count toward conclusiveness. The three-part gate is what separates a canonical one-liner from a substantive algorithm: the SQL station problem (7 forms / 165-char median / 10 solvers → CANONICAL) vs the 672-char Josephus problem (4 forms but 672-char median → NOT — a substantive identical 672-char copy stays conclusive). The `min-solvers` clause stops a 2-person identical-short-code pair (suspicious convergence) being mislabeled canonical. On June-20, **exactly one** problem (the SQL station exercise) was flagged canonical.

- **(iii) Proximity required before SINGLE-problem escalation** — `evaluationMetrics.mjs` (`pairProximity` `:1242-1255`, gate `:1296-1308`). A single-problem cluster may escalate to `confirmed` only when a proximity signal is present: **same room OR same IP /24 OR tight-gap co-submission** (`same_room` / `same_ip_prefix` / `meta.tight`, already computed at `:1232-1238`). The June-20 false-positive twins fail all three (different room, ~75 min apart) ⇒ no escalation. **Note for single-LAN contests:** `same_ip_prefix` at /24 is non-discriminating when a whole cohort sits behind one campus NAT — in this dataset the canonical guard (ii) already removed the SQL problem from conclusiveness, so the proximity gate is a *second independent* requirement, not the sole lever.

- **(iv) Tightened origin-rescue** — `evaluationRecommend.mjs` (`computeOriginRescues` `:421-500`). (a) Recurring-pair rescue groups now **skip skeleton-only-differing pairs** (`n_exact < 1`) — a skeleton-only pair is not a copy, so it has no victim to rescue (exact CLUSTERS are coreExact by construction and unaffected). (b) A clone group resolves to **at most one origin — no mutual origin**: a candidate who is a downstream COPIER (a non-earliest member) in ANY group can never also be rescued as an origin. This kills the fragile case where two byte-identical typists each rank "earliest" on a different problem and BOTH get rescued as victims (one such pair was double-rescued in production) — now neither is rescued and both stay excluded. A clean unambiguous origin (earliest *everywhere*, never a copier — typed it, ≥2 arcs, no foreign paste) is still rescued; `genuine_copied` is NOT a hire bucket, so the copying detection still holds (the rescued origin's detector tier stays `confirmed`).

- **Validation (non-destructive, read-only):**
  - **June-20** (`tridots-coding-contest-20062026`, 282 cards): integrity-tier transitions — `clean→clean` 188, `watch→watch` 72, `confirmed→confirmed` 10, **`confirmed→watch` 4** (the four false-positives), `confirmed→flag` 2 (two skeleton-only single-problem pairs now *held for review*, not excluded), **NEW confirmations: 0** (no new false exclusions). The 4 FPs → `hire_deskcheck` (now hire-eligible, talent strong); the 3 real substantive-copy pairs **remain `confirmed`**; no confirmed copier enters the hire set; the genuine hire set is unchanged (no genuine hire dropped).
  - **KPR oracle** (`proctor/junk/`): 5 SELECTED interns all stay hires; the 9-person ring all stay excluded/`confirmed` (incl. a skeleton-only 2-problem pair — caught via the multi-problem path); hire set 12→12, no member promoted.
  - Eval unit tests extended (`evaluationClone.test.mjs` +6, `evaluationMetrics.test.mjs` +5 cross-pass, `evaluationRecommend.test.mjs` +4 origin-rescue) and green.

---

## PENDING

_(none — the 2026-06-22 canonical-SQL fixes (i)–(iv) were applied above.)_

### Related deferred design (not blocking, captured for context)
- **Rule-registry refactor** (`_nightrun/eval-architecture-design.md`, 2026-06-19): split the ~1600-line `buildScorecard` into a data-driven registry where each rule declares its `needs` and the aggregator checks availability before running. The narrow availability fixes landed in `015ce16`; the full registry refactor did not. Forward-looking only.
