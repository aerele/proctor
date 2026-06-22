# Eval Logic & Logs

The durable record of **how the proctor evaluation engine decides** — its rules, why each rule exists, and how it is changed safely.

Three files:

| File | What it is |
|---|---|
| **`SPEC.md`** | The **single source of truth** for all evaluation logic, as a ruleset an engineer can implement from. Covers the three layers — integrity/copy-detection, talent scoring, recommendation/selection — with `file:line` citations into `backend/src/`. |
| **`CHANGELOG.md`** | The history of eval-logic decisions: every **finding → the rule it caused**, with date, commit hash, and file. Plus a `PENDING` section for ratified-but-unapplied findings. |
| **`README.md`** | This file — the maintenance process. |

## The core principle

**The SPEC is the source of truth. Code conforms to the SPEC, not the other way around.**

The eval engine assigns real consequences (who gets hired, who gets excluded for cheating). Its rules must be inspectable and deliberate, not emergent from whatever the code happens to do. So we maintain the SPEC as the authoritative description and treat any code/SPEC divergence as a bug in the code.

## The maintenance loop

When a finding surfaces (a false positive, a false negative, a miscalibration, a new evidence source), follow this loop **in order**:

1. **Append to `CHANGELOG.md`.** Write the finding first, while it is fresh and concrete: the contest/candidate that exposed it, the observed-vs-correct verdict, and the root cause. If it is ratified but not yet implemented, put it under `PENDING`. This is the audit trail; it is written even if the fix is deferred.

2. **Update `SPEC.md`.** Change the ruleset to the intended new behavior, with the exact thresholds/conditions and the `file:line` it will live at. The SPEC now describes the *target*, which the code does not yet match — that is expected and temporary.

3. **Change the eval code to match the SPEC.** Implement in `backend/src/` so the code conforms to the updated SPEC. Bump `EVALUATOR_VERSION` (`evaluationMetrics.mjs`) and/or `RECOMMEND_VERSION` (`evaluationRecommend.mjs`) when the verdict for any candidate can change. Keep citations in the SPEC accurate to the new line numbers.

4. **Re-run / validate against ground truth.** Re-run the affected contest(s) and confirm the verdict moved as intended **and** that nothing else regressed. The standing ground-truth anchors live in `proctor/junk/` (PII — local only, never committed/deployed): the KPR `SELECTED-GROUND-TRUTH` (5 selected interns must never be excluded) and the 9-person confirmed copying ring (must all be excluded). The calibration invariant — *honest candidates are ~never excluded; only conclusive copying excludes* — must hold after every change. The unit tests under `backend/test/evaluation*.test.mjs` pin the pure logic; run them too.

5. **Move PENDING → APPLIED.** Once the change is in code and validated, promote the `CHANGELOG.md` entry from `PENDING` to a dated `APPLIED` entry with its commit hash.

## Rules of thumb

- **Integrity gates talent; they are orthogonal and never averaged.** Only `confirmed` excludes. `flag` holds for review. `watch`/`inconclusive` are desk-check notes, never a block. Any change must preserve this.
- **Absence of signal ≠ evidence of cheating.** Missing/unread telemetry lands a candidate in `inconclusive` (review manually), never in a violation. Detectors that read interaction telemetry must gate on that coverage being present.
- **No candidate drops below "hire" who is a genuine solver.** The `solid_hire` and origin-rescue (`genuine_copied`) buckets exist to honor this; do not let a refactor quietly drop a genuine solver to below-bar/exclude.
- **Cite `file:line` in the SPEC, always.** A rule without a citation is undocumented behavior. Re-check citations after every refactor that moves lines.
- **A finding without a CHANGELOG entry did not happen.** Even deferred decisions get logged under `PENDING` so the reasoning survives.
- **Validate before claiming done.** "If the docs say it works, it works" — so the docs only say it works after step 4 passes against ground truth, not before.
