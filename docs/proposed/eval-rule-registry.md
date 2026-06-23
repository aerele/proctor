# EVAL-1 — Data-driven eval rule registry

**Status:** Proposal (in progress) · **Roadmap:** F14 · **Backlog:** EVAL-1 (v1.1) ·
**Author:** the agent · **Date:** 2026-06-23

> **Read first:** `eval-logic-and-logs/{CHANGELOG,SPEC,README}.md` (the live D1–D17
> contract) and `junk/nightrun-archive/eval-architecture-design.md` (the 2026-06-19
> "PLAN to make the plan" that this spec operationalizes — §4 of it is the registry
> design; this doc narrows it to a **behavior-preserving v1.1 refactor**, deferring
> the new rules / cohort-relative scoring it proposed).

---

## 0. TL;DR

`backend/src/evaluationMetrics.mjs` is a 1745-line module whose heart,
`buildScorecard()` (`evaluationMetrics.mjs:256-818`), is a single straight-line
function: it replays events, then inline-computes ~14 detectors (D1–D17), pushes
`flags`, builds `integrity`/`talent` blocks, and calls `deriveTiers`. Every
threshold is a key in one `THRESHOLDS` const (`:26-55`). Adding or removing a rule
today means editing the middle of that function and its `flags.push` sites.

This spec refactors that function **in place** into a **rule registry**: a flat
array of rule descriptors `{ id, category, needs, weight, config, fn }`, each `fn`
a pure `(features, ctx) → signal[] | null`. A thin engine (a) builds the feature
bundle **once** (the existing replay + away + cadence work, unchanged), (b) runs
each registry rule whose `needs` are satisfied, (c) collects emitted signals into
the **exact same** `flags`/`integrity`/`talent` shape `deriveTiers` already
consumes. Thresholds move out of code into a `config` object that defaults to
today's `THRESHOLDS` values and is overridable per-contest.

**Hard constraint: behavior-preserving.** The refactor must produce
**byte-identical scorecards** on existing data — same `flags`, same `tiers`, same
`composite`, same `evaluator_version`. It is validated by (i) the existing 104-test
eval suite staying green **unchanged**, (ii) a new golden-fixture diff harness, and
(iii) a read-only replay of real cohorts (KPR-66, tridots) asserting zero scorecard
diff. Verdict-changing ideas from the 2026-06-19 plan (navigation rules,
cohort-relative MAD-z, run-event rules) are **explicitly out of scope** here — this
EVAL-1 ships the *seam*, not new behavior.

**Release recommendation:** phase it. **Phase 0 + Phase 1 (the per-candidate
registry) is v1.1-appropriate** and self-contained. **Phase 2 (the cross-candidate
pass) is the higher-risk half** and should be a fast-follow, not a v1.1 blocker.
See §8.

---

## 1. The actual current code (cited, not assumed)

### 1.1 The module map

| File | Role | Lines |
|---|---|---|
| `backend/src/evaluationMetrics.mjs` | the monolith: `THRESHOLDS`, `buildScorecard`, `deriveTiers`, composite, **cross-candidate pass**, `applyCrossPatches` | 1745 |
| `backend/src/evaluationReplay.mjs` | `replaySession()` → content states, paste pairing, cadence accumulation, tamper snapshots | 855 |
| `backend/src/evaluationClone.mjs` | `coreExact`, `skeleton`, `artifacts`, `provenance`, `makeHardness`, `analyzeClones` | ~565 |
| `backend/src/evaluationRecommend.mjs` | `recommendFor`, origin-rescue, `computeRecommendationReport` (hire buckets) | ~880 |
| `backend/src/evaluation.mjs` | orchestrator: GCS/Firestore I/O, batching, lease lock, assembles `buildScorecard` input | ~880 |

`buildScorecard` imports **only** the two sibling pure modules
(`evaluationMetrics.mjs:9-22`) and is exported and consumed by `evaluation.mjs`
(`evaluation.mjs:22,49`).

### 1.2 The single entry point and its inputs

`evaluation.mjs` assembles the input bundle and calls `buildScorecard(input)`
(`evaluation.mjs:48-49`, real call at the per-candidate loop `:466-471`). The input
contract (destructured at `evaluationMetrics.mjs:257-273`):

```
contest_slug, identity, sessions[], submissions[], editorEvents[], shellEvents[],
problemPoints{}, stubsByProblem{}, hardness(pid)→tier, maxTotal, clipboardEntries[],
evidenceReadFailed, extraSelfTexts[]
```

`problemPoints` / `stubsByProblem` / `maxTotal` / `hardness` are built per-contest
in `evaluation.mjs:187-233` (`makeHardness` over accepted-distinct-identity counts).

### 1.3 What `buildScorecard` actually does, in order

This is the straight-line body that becomes the registry. Each numbered step is one
prospective rule (or a feature-extraction step that stays shared):

1. **Replay** (`:290`) — `replaySession()`. Shared feature extraction; **stays**.
2. **Availability gates** (`:296-306`) — `editorCoveragePresent`,
   `problemsWithEvents`, `pasteInferenceAvailable`. These are exactly the `needs`
   the registry formalizes. **Becomes the availability layer.**
3. **Away episodes / cadence / away-paste correlation** (`:309-315`) — shared
   features; **stay** (`awayEpisodes`, `computeCadence`, `correlateAwayPastes` are
   already standalone exported pure fns at `:72`, `:123`, `:188`).
4. **Foreign pastes** assembly (`:318-332`) — shared feature.
5. **Per-problem loop** (`:385-540`) — computes per-problem stats AND inline-fires
   three detectors:
   - **D10 zero-effort solve** (`:458-479`) → `zero_effort_solve` critical flag.
   - **D12 partial discount + partial gamer** (`:481-506`) → `discountedPartialPoints`
     accumulator + `partial_gamer` info flag.
   - **D13 honest reach** (`:508-511`), **D14 first-attempt** (`:513-516`) → talent lists.
6. **D1 high paste ratio** (`:562-569`) → `high_paste_ratio` critical (gated on
   `pasteInferenceAvailable`).
7. **D2 foreign-paste flags** (`:571-589`) → `foreign_paste_after_away` critical /
   `foreign_paste` warning.
8. **D4 cadence flags** (`:591-608`) → `superhuman_cadence` / `metronomic_cadence`
   warnings.
9. **D9 artifacts + provenance** (`:610-618`) → `integrity.artifacts` / `provenance_hits`.
10. **D16b replay-vs-submission mismatch** (`:620-675`) → `telemetry_tampered`
    critical, with the empty-snapshot + glitch gates.
11. **D15 premeditated clipboard** (`:677-698`) → `premeditated_clipboard` critical.
12. **D17 integrity rollups** (`:700-707`) — away totals, fullscreen, ip-change.
13. **Composite + tiers** (`:709-720`, `computeComposite` `:830`, `deriveTiers`
    `:860`) — the aggregator. **Stays as the aggregator.**
14. **Coverage / confidence** (`:732-749`, `computeCoverage` `:989`) — **stays.**
15. **cross_inputs** (`:787`, `buildCrossInputs` `:1021`) — produced for Phase 2.
16. **Assemble + return** the scorecard doc (`:798-817`).

### 1.4 The cross-candidate pass (Phase 2 territory)

`crossCandidateAnalysis()` (`:1149-1354`) is a **second, cohort-wide** function:
clone clusters, recurring pairs with the conclusiveness gate (`:1290-1311`),
paste-match edges, tight/submit clusters → per-identity `patches`.
`applyCrossPatches()` (`:1710-1734`) merges a patch into a scorecard and re-derives
tiers. The conclusiveness gate carries the entire 2026-06-22 canonical-SQL fix
(CHANGELOG (i)–(iv)). This is **denser, higher-stakes, and harder to make
data-driven** than the per-candidate detectors — hence the phasing in §8.

### 1.5 The aggregator's contract (what the registry must feed unchanged)

`deriveTiers({ flags, talent, integrity, coverage })` (`:860-942`) is the seam we
preserve. It reads:
- `flags[]` — `{ code, severity: critical|warning|info, problem_id, evidence }`.
  It buckets by `severity` (`:862-863`) and checks specific `code`s via
  `hasCode()` (`recurring_pair_conclusive`, `strong_gem`).
- `integrity.{telemetry_tampered, foreign_pastes[], paste_ratio}` — the
  confirmed-tier conditions (`:884-905`).
- `talent.{composite, per_problem{...,_tier,genuine_arc}, n_solved_full}` —
  talent-tier counting via `countGenuine` reading `pp._tier` (`:944-958`).
- `coverage.{confidence, editor_events_n, shell_events_n, gaps[]}` — the
  inconclusive/no-data tier (`:875-880`).

**The registry's only job is to produce that exact `flags`/`integrity`/`talent`
trio.** As long as the bytes are identical, `deriveTiers`, `computeComposite`,
`buildOneLine`, and every downstream consumer (`evaluationRecommend`, `scoreboard`,
routes, the admin UI) are untouched.

### 1.6 The test + version surface that pins behavior

- `backend/test/evaluationMetrics.test.mjs` (1108 lines, **104 assertions** with
  the clone/recommend tests) exercises `buildScorecard` per-detector
  (`:214-...`), and **asserts every `THRESHOLDS` value explicitly** (`:87-105`).
  → The registry's default config must keep `THRESHOLDS` exported with identical
  values, or this test breaks. We keep it.
- `EVALUATOR_VERSION = "4"` (`:24`) gates recompute: `evaluation.mjs:270` skips a
  candidate whose stored `evaluator_version` matches. **A behavior-preserving
  refactor must NOT bump it** (bumping would force a full, pointless recompute of
  every stored scorecard). The version bumps only when a *verdict* changes — i.e.
  in a later phase that adds rules, never in this one.

Baseline confirmed green this session: `node --test` over the three eval suites →
**104 pass, 0 fail**.

---

## 2. Design goals & non-goals

**Goals**
1. Adding/removing a per-candidate rule = a one-entry edit to a registry array (or
   one new `evalRules/<id>.mjs` file), with **no edit to the engine, aggregator,
   serialization, or routes**.
2. Thresholds are **data**: a `config` object, defaulting to today's `THRESHOLDS`,
   overridable per-contest with **no code change** (and, optionally later, from a
   Firestore `proctor_eval_config/{slug}` doc).
3. Each rule **declares the signals it needs**; the engine refuses to run it when
   they are absent — formalizing the ad-hoc availability gates (`:296-306`,
   `:458-464`, `:562`) into one mechanism. This *is* the 2026-06-19 "missing-data =
   inconclusive, never a violation" fix, but expressed structurally.
4. **Behavior-preserving:** identical scorecards on existing data; existing tests
   green unchanged; `EVALUATOR_VERSION` unchanged.

**Non-goals (deferred — they change verdicts, so out of a behavior-preserving cut)**
- New rules (navigation, run-event trajectory, keystroke-authenticity) — 2026-06-19
  plan §5. These need calibration on KPR before they can be trusted.
- Cohort-relative / MAD-z thresholds — 2026-06-19 plan §4.3. Different scoring mode.
- Making the **cross-candidate** conclusiveness gate data-driven — §8 Phase 2.
- LLM judgment queue — separate feature (F13, see §9).

---

## 3. The registry — data model

### 3.1 Rule descriptor

```js
// backend/src/evalRules/types.mjs (doc only — JS has no types; this is the shape)
/**
 * @typedef {Object} Rule
 * @property {string}   id         stable id, e.g. "zero_effort_solve"
 * @property {"integrity"|"talent"} category
 * @property {string[]} needs      availability keys this rule requires; if any is
 *                                  unsatisfied the rule is SKIPPED (emits nothing —
 *                                  never a violation). e.g. ["editor_coverage"],
 *                                  ["paste_inference"], ["per_problem_events"].
 * @property {number}   weight     advisory ordering/priority; does NOT change math
 *                                  in this phase (composite weights stay in
 *                                  computeComposite). Reserved for future scoring.
 * @property {function(features, ctx): (Signal[]|Signal|null)} fn   pure.
 * @property {boolean}  [enabled=true]
 */

/**
 * @typedef {Object} Signal   one of:
 *   { kind:"flag", code, severity:"critical"|"warning"|"info", problem_id, evidence }
 *   { kind:"talent", field, value }       // e.g. honest_reach pid, first_attempt pid
 *   { kind:"integrity", field, value }    // e.g. telemetry_tampered=true
 *   { kind:"accumulate", field, delta }   // e.g. discountedPartialPoints += best_score
 */
```

`fn` returns an **array of Signals** (or `null`). It never mutates shared state, never
pushes to `flags`, never reads another rule's output. The engine routes Signals to
the right slot — this is what keeps `deriveTiers`'s input byte-identical while
removing the inline `flags.push` calls.

### 3.2 The feature bundle (`features`) — built ONCE, shared by all rules

The engine computes the existing shared work and hands every rule the same frozen
bundle. This is **lifted verbatim** from the current top-of-`buildScorecard` body:

```
features = {
  // identity / context
  contest_slug, identity, identity_key, session_ids, sessions, submissions,
  problemPoints, stubsByProblem, maxTotal, hardness,

  // replay-derived (evaluationReplay.replaySession — UNCHANGED)
  replay,                          // full replay object
  episodes,                        // awayEpisodes(shellEvents)
  cadence,                         // computeCadence(replay.single_char_ts_by_problem)
  awayCorr, awayCorrByPasteTs,     // correlateAwayPastes(...)
  foreign_pastes,                  // assembled D2 list

  // per-problem table (the :385-540 loop, MINUS the inline detectors)
  per_problem,                     // best_score, active_ms, paste_ratio, stub_delta_lines, _tier, ...
  allPids, byProblemSubs, typedByProblem, pastedByProblem,
  totalTyped, totalPasted,

  clipboardEntries,
}
```

### 3.3 Availability (`avail`) — declared, checked once

```
avail = {
  editor_coverage:   replay.events_n > 0,                 // :297
  per_problem_events: (pid) => problemsWithEvents.has(pid),// :300
  paste_inference:   replay.paste_inference_available,     // :306
  shell_events:      shellEvents.length > 0,
  submissions:       submissions.length > 0,
  clipboard:         (clipboardEntries||[]).length > 0,
}
```

The engine, for each rule, checks `rule.needs.every(k => satisfied(avail, k))`. If
not satisfied → the rule contributes nothing (the existing "absent ⇒ inconclusive"
semantics, now uniform). **This reproduces today's behavior exactly** because
today's gates already suppress those same detectors under those same conditions
(zero-effort gate `:459-460`, paste-ratio gate `:562`). We are not loosening or
tightening — we are relocating the identical predicate.

### 3.4 Config (`config`) — thresholds as data

```js
// backend/src/evalRules/config.mjs
export const DEFAULT_RULE_CONFIG = {
  // identical values + comments to today's THRESHOLDS (:26-55)
  away_paste_window_ms: 10000,
  superhuman_cps: 14, superhuman_run: 25,
  metronomic_cv: 0.15, metronomic_min_keys: 40,
  zero_effort_active_ms: 120000, zero_effort_typed_frac: 0.15,
  paste_ratio_flag: 0.6, stub_delta_lines: 10,
  reach_min_submits: 2, reach_min_active_ms: 600000, reach_max_paste: 0.3,
  foreign_paste_match_min: 80, full_solution_paste_len: 300,
  silent_gap_ms: 300000, mismatch: 0.15, clipboard_match_min: 40,
};
// Back-compat: keep exporting THRESHOLDS (the test at :87-105 asserts it).
export const THRESHOLDS = { AWAY_PASTE_WINDOW_MS: DEFAULT_RULE_CONFIG.away_paste_window_ms, ... };
```

Config resolution order (all no-code-change): `DEFAULT_RULE_CONFIG` →
per-contest override object passed by `evaluation.mjs` → (future) Firestore
`proctor_eval_config/{slug}`. In **this phase the resolved config equals
`DEFAULT_RULE_CONFIG`** so output is identical; the override plumbing exists but is
unused until a calibrated change wants it (and that change would bump
`EVALUATOR_VERSION`).

---

## 4. The engine

```js
// backend/src/evalRules/engine.mjs
export function runRegistry(features, { rules = RULES, config = DEFAULT_RULE_CONFIG }) {
  const ctx = { config, avail: buildAvail(features) };
  const collected = { flags: [], talent: { honest_reach: [], first_attempt_solves: [], ... },
                      integrity: { telemetry_tampered: false, ... }, accumulators: {} };
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (!rule.needs.every(k => availSatisfied(ctx.avail, k, features))) continue; // inconclusive
    const out = rule.fn(features, ctx);
    if (!out) continue;
    for (const sig of [].concat(out)) route(sig, collected);
  }
  return collected;
}
```

`buildScorecard` becomes a thin orchestrator:

```js
export function buildScorecard(input) {
  const features = extractFeatures(input);          // §3.2 — the lifted shared body
  const collected = runRegistry(features, { config: input.ruleConfig });
  // merge collected into the same integrity/talent blocks the code builds today,
  // call computeComposite + deriveTiers EXACTLY as now (:709-817), assemble doc.
  ...
}
```

**Crucial ordering note.** Today flags are appended in a fixed source order
(zero-effort first, then high-paste, then foreign, then cadence, then tamper, then
clipboard). `deriveTiers`/`buildOneLine` use `flags.find(...)` for "the top flag"
(`:981`), and `applyCrossPatches` dedupes by `code|problem_id|evidence` (`:1718`).
**The registry array order must replicate the current append order** so the
`one_line`'s "top flag" and any order-dependent output are byte-identical. This is
captured as a verification assertion (§7), and is the single most likely source of
a behavior diff — call it out in review.

---

## 5. The initial registry (D1–D17, behavior-preserving)

Every entry below is a **relocation** of existing code, not new logic. Order = the
current flag-append order so output is identical.

| # | id | category | needs | source today | emits |
|---|---|---|---|---|---|
| 1 | `zero_effort_solve` | integrity | `editor_coverage`, `per_problem_events` | `:458-479` | flag `zero_effort_solve`/critical (per pid) |
| 2 | `partial_discount` | talent | — | `:488-491` | `accumulate discountedPartialPoints` |
| 3 | `partial_gamer` | talent | — | `:499-506` | flag `partial_gamer`/info |
| 4 | `honest_reach` | talent | — | `:508-511` | `talent honest_reach += pid` |
| 5 | `first_attempt_solve` | talent | — | `:513-516` | `talent first_attempt_solves += pid` |
| 6 | `high_paste_ratio` | integrity | `paste_inference` | `:562-569` | flag `high_paste_ratio`/critical |
| 7 | `foreign_paste` | integrity | — | `:571-589` | flag `foreign_paste_after_away`/critical or `foreign_paste`/warning |
| 8 | `superhuman_cadence` | integrity | `editor_coverage` | `:592-600` | flag `superhuman_cadence`/warning |
| 9 | `metronomic_cadence` | integrity | `editor_coverage` | `:601-608` | flag `metronomic_cadence`/warning |
| 10 | `artifacts_provenance` | integrity | `submissions` | `:610-618` | `integrity.artifacts` / `provenance_hits` |
| 11 | `replay_tamper` | integrity | `editor_coverage` | `:620-675` | flag `telemetry_tampered`/critical + `integrity.telemetry_tampered` + `replay_mismatches` |
| 12 | `premeditated_clipboard` | integrity | `clipboard` | `:677-698` | flag `premeditated_clipboard`/critical |

Notes that must survive the move (these are real, load-bearing gates — do not drop):
- Rule 1 and 11 share `editorCoveragePresent` + `problemsWithEvents` — keep them in
  `avail`, not re-derived per rule.
- Rule 11 keeps the **empty-snapshot guard** (`:650`), **glitch gate** (`:665-666`),
  and the glitchy-mismatch → coverage-gap routing (`:742-747`). The coverage-gap
  side-effect is **not** a Signal kind; it writes to `coverage.gaps`. Two clean
  options — pick one in review: (a) `replay_tamper.fn` also returns
  `{ kind:"coverage_gap", value:"replay_base_unreliable:pid" }` signals and the
  engine routes them into coverage; or (b) leave the glitchy-mismatch→coverage-gap
  computation in the post-registry assembly (it reads `replay_mismatches` which the
  rule surfaces). **Recommend (a)** — keeps all tamper logic in one rule.
- D17 rollups (`:700-707`), composite, coverage, cross_inputs are **engine/assembly
  steps, not rules** — they read the whole candidate, not a rule's slice. They stay
  in `buildScorecard` as plain function calls (already factored: `computeComposite`,
  `computeCoverage`, `buildCrossInputs`).

**Per-problem rules (1–5)** run inside the existing per-problem iteration. The clean
factoring: the per-problem loop stays in `extractFeatures` and produces
`per_problem` + the per-problem inputs; rules 1–5 are invoked **per pid** by the
engine with a `features.problem = per_problem[pid]` view. Equivalent alternative
(less surgery, recommended for the first cut): keep the loop, but replace the inline
`if (zeroEffort)…push` / discount / reach / first-attempt blocks with calls to the
rule fns, accumulating their Signals. Either way the **math is the relocated math**.

---

## 6. What does NOT change (de-risking inventory)

- `evaluationReplay.mjs`, `evaluationClone.mjs` — untouched.
- `deriveTiers`, `computeComposite`, `buildOneLine`, `countGenuine`,
  `computeCoverage`, `buildCrossInputs` — untouched (same signatures, same inputs).
- The scorecard schema, `schema_version: 1`, `EVALUATOR_VERSION: "4"` — unchanged.
- `evaluation.mjs` orchestration, batching, lease lock, routes — unchanged (it
  still calls `buildScorecard(input)`; it may optionally pass `input.ruleConfig`,
  defaulting to today's behavior when absent).
- `evaluationRecommend.mjs`, `scoreboard.mjs`, admin UI, CSV — unchanged
  (they consume the scorecard doc, which is byte-identical).
- The exported `THRESHOLDS` const — kept (the explicit-value test depends on it).
- **Phase 1 does NOT touch `crossCandidateAnalysis` / `applyCrossPatches`.**

---

## 7. Migration & verification plan (the load-bearing part)

Behavior-preservation is the whole game. Three independent checks, all must pass
before merge:

**V1 — existing suite, unchanged.** `backend/test/evaluationMetrics.test.mjs`
(+clone +recommend) must pass **without editing a single assertion**. The 104 tests
already pin per-detector behavior and every threshold value (`:87-105`). If any
needs editing, the refactor changed behavior — stop and reconcile. (Baseline this
session: 104 pass / 0 fail.)

**V2 — golden-fixture diff harness (new, `backend/test/evalRegistryParity.test.mjs`).**
Before refactoring, capture golden scorecards from the *current* `buildScorecard`
over a curated input matrix (every detector firing + each availability-gate
combination: no-editor-events, no-paste-markers, glitchy-replay, empty-snapshot,
read-failed). Commit them as fixtures. After the refactor, assert
`deepStrictEqual(newScorecard, golden)` for each (minus the volatile `computed_at`
timestamp, which is masked). This catches **flag ordering** and `one_line` "top
flag" regressions the per-detector tests can miss.

**V3 — real-cohort read-only replay.** Run the refactored engine over real cohorts
(KPR-66, tridots — data lives in `proctor/junk/`, gitignored) **read-only** (no
Firestore write) and diff scorecards old-vs-new per candidate. Expected diff:
**zero** (excluding `computed_at`). This is the strongest signal that production
verdicts are unchanged. Tooling note: reuse the recon harness pattern from
`junk/nightrun-archive/EVAL-PROD-RECLASSIFY-RECON-2026-06-22.md` (the 2026-06-22 fix
was validated the same way — non-destructive integrity-tier transition counts). A
clean run reports `N→N identical, 0 changed`.

**V4 — `EVALUATOR_VERSION` discipline.** Assert `EVALUATOR_VERSION` is **still
`"4"`** in the test. A behavior-preserving refactor must not bump it; bumping forces
a full recompute of every stored scorecard for no verdict change. (The first phase
that adds a *new* rule will bump it deliberately.)

**Build order (each step ends green + committed):**
1. **Phase 0** — extract `THRESHOLDS`→`config.mjs` (re-export `THRESHOLDS`
   unchanged); add the parity harness V2 capturing goldens from current code; land
   V3 read-only diff tool. *No engine change yet — goldens are the contract.*
2. **Phase 1a** — introduce `evalRules/{types,engine}.mjs`; move the **whole-session**
   integrity detectors (rules 6–12) into the registry; `buildScorecard` calls the
   engine for those; per-problem detectors still inline. Run V1–V4.
3. **Phase 1b** — move the **per-problem** detectors (rules 1–5) into the registry.
   Run V1–V4. After this, the per-candidate path is fully data-driven.
4. **(Fast-follow, not v1.1)** **Phase 2** — registry-ize the cross-candidate pass
   (§8). Separate spec section, separate PR, separate review.

---

## 8. Phasing & release-risk assessment (read this before scheduling)

**Is this v1.1-appropriate?** The per-candidate half (Phase 0+1) — **yes, with the
verification gates above.** It is a behavior-preserving relocation of ~250 lines of
the middle of `buildScorecard`, fully fenced by the existing 104-test suite plus the
golden + real-cohort diffs. There is no new math, no `EVALUATOR_VERSION` bump, no
schema change. The risk is **mechanical** (flag ordering, a dropped gate), and the
three diff checks (V2/V3 especially) catch exactly that class of bug.

**Where the real risk lives — Phase 2 (cross-candidate).** `crossCandidateAnalysis`
(`:1149-1354`) carries the **2026-06-22 canonical-SQL conclusiveness gate**
(CHANGELOG (i)–(iv): single-vs-multi-problem, canonical down-weight, proximity
requirement, origin-rescue). That logic is genuinely cohort-relational (it reasons
about pairs, rooms, IP /24, canonical maps) and is **not a clean
`(features,ctx)→signal` shape** — forcing it into the per-candidate registry model
would be a poor fit and risks re-introducing one of the four false-positive classes
that fix just closed. **Recommendation: keep Phase 2 out of v1.1.** Ship the
per-candidate registry now; treat the cross-pass as its own later proposal that can
afford a slower, more adversarial review (it is the part most expensive to get
wrong).

**Net recommendation:** v1.1 carries **Phase 0 + Phase 1** (per-candidate registry).
Phase 2 (cross-candidate) is a documented fast-follow. This delivers the stated
intent ("add/remove a rule with no structural change") for the rules operators
actually tune, while not gambling the release on the highest-stakes module. If
schedule is tight, even Phase 1a alone (whole-session detectors) is a shippable,
self-contained slice.

---

## 9. ⚠️ OPEN QUESTION — F14 vs F13

This work is **F14 (EVAL-1: data-driven rule registry)** — the refactor specced
above. The directive was "**F14 done now**," but the backlog flags a real ambiguity
(`BACKLOG.md:94-97`, `ROADMAP.md:86-88`): it may have meant **F13 — automatic AI
verification after every test (task #144)**, a *different* feature. Scoping both so
the maintainer can confirm which one to pull into v1.1:

- **F14 / EVAL-1 (this spec).** Refactor the deterministic eval into a rule
  registry so rules are add/remove-able as data. Behavior-preserving. ~Phase 0+1.
  Touches `evaluationMetrics.mjs` only. **No new verdict behavior.**
- **F13 / task #144 — "Automatic AI verification after every test."** Per
  `ROADMAP.md:86-88`: today the deterministic eval + the LLM/self-improvement
  verification loop are **admin-triggered** from Results. F13 makes the whole-record
  re-check (selections/exceptions) run **automatically after every test** within the
  retention window, instead of on demand. That is an **orchestration/trigger +
  LLM-judgment** feature (wiring an auto-run, the `evalJudgments` queue the
  2026-06-19 plan left as a "clean seam"), **not** a refactor of the rule math. It
  is a much larger, behavior-*adding* change.

**These are disjoint.** EVAL-1 (F14) is the safe, mechanical refactor; F13 is a new
auto-run + AI-judgment capability. Recommend: **confirm which one "done now" meant.**
If F14 — proceed with §1–8. If F13 — this spec is not it, and F13 needs its own
proposal (the registry seam here makes F13 *easier* later, since a rule can mark a
candidate `needs_judgment` for the auto-run queue to consume).

---

## 10. Acceptance criteria (Phase 0+1)

- [ ] `evaluationMetrics.test.mjs` (+clone +recommend) pass with **zero assertion
      edits** (V1).
- [ ] New `evalRegistryParity.test.mjs` green: refactored scorecards
      `deepStrictEqual` to pre-refactor goldens across the detector/availability
      matrix (V2).
- [ ] Real-cohort read-only diff (KPR-66 + a tridots cohort): **0 scorecards
      changed** old-vs-new (V3).
- [ ] `EVALUATOR_VERSION === "4"` unchanged; `THRESHOLDS` still exported with
      identical values (V4).
- [ ] Adding a demo rule = appending one registry entry + one `evalRules/<id>.mjs`
      (or one array object) — **no edit to `engine.mjs`, `deriveTiers`,
      serialization, or routes** — demonstrated by a throwaway rule in a test.
- [ ] Disabling a rule (`enabled:false`) and changing a threshold via `config`
      both work with **no code edit** to the engine.
- [ ] `crossCandidateAnalysis` / `applyCrossPatches` untouched in Phase 1.
- [ ] Triple-review (correctness + spec-conformance + security) over the diff.

---

## 11. References

- Live contract: `eval-logic-and-logs/{SPEC,CHANGELOG,README}.md`.
- Deferred design (operationalized here): `junk/nightrun-archive/eval-architecture-design.md` §4.
- 2026-06-22 canonical-SQL fix (Phase 2 risk): `eval-logic-and-logs/CHANGELOG.md`
  (i)–(iv); gate at `evaluationMetrics.mjs:1290-1311`.
- Real-cohort recon pattern (V3 tooling): `junk/nightrun-archive/EVAL-PROD-RECLASSIFY-RECON-2026-06-22.md`.
- Code: `backend/src/{evaluationMetrics,evaluationReplay,evaluationClone,evaluationRecommend,evaluation}.mjs`;
  tests `backend/test/evaluation*.test.mjs`.
