# Proctor Evaluation Engine — SPEC

**Status:** source of truth for all evaluation rules. Code conforms to this; this does not describe code.
**Derived from:** the live code on branch `feat/eval-logic` (evaluator_version `"4"`, recommend_version `"2"`).
**Scope:** the per-candidate + cross-candidate evaluation that turns raw contest evidence (submissions, editor/shell/clipboard telemetry) into a verdict (`integrity` tier × `talent` tier × `composite`) and a hire recommendation.

Every rule cites `file:line` from `backend/src/`. Read the code only to verify; implement from this.

## Module map

| Module | Role |
|---|---|
| `backend/src/evaluationClone.mjs` | Pure normalizers + cross-candidate clone analysis (`coreExact`, `skeleton`, `makeHardness`, `analyzeClones`). Byte-parity port of the Python `contest_eval_core`. |
| `backend/src/evaluationReplay.mjs` | Per-session keystroke replay → pastes, foreign-paste detection (`isForeign`), bare-template suppression (`isBareTemplate`), cadence, snapshots. |
| `backend/src/evaluationMetrics.mjs` | Per-candidate scorecard (`buildScorecard`), composite + tiers (`computeComposite`, `deriveTiers`), the cross-candidate pass (`crossCandidateAnalysis`, `applyCrossPatches`), all `THRESHOLDS`. |
| `backend/src/evaluationRecommend.mjs` | Read-time hire recommendation: buckets, origin-rescue, calibration invariant. Pure; served verbatim to `/eval-ui`. |
| `backend/src/evaluation.mjs` | Orchestrator: pure `evaluateCandidate` wrapper + the I/O layer `makeEvaluation` (GCS evidence read, scorecard writes, cross-pass + meta-doc write). |
| `backend/src/routes/evaluation.mjs`, `backend/src/eval-server.mjs` | HTTP surface (admin evaluate/list/status; `/eval-ui` static + `recommend.js`). |

All thresholds live in one place: `THRESHOLDS` at `evaluationMetrics.mjs:26-55`.

---

## LAYER 1 — INTEGRITY / COPY-DETECTION

The integrity axis answers: *did this candidate cheat?* It is **orthogonal to talent and never averaged with it** — integrity only *gates* talent (Layer 3). Verdict tiers: `clean` < `watch` < `flag` < `confirmed`, plus `inconclusive` (no data).

### 1.1 Code normalization (the two clone signatures)

Clone detection compares two normalized forms of source code, per problem.

**`coreExact`** — `evaluationClone.mjs:133-150`. Pipeline:
1. `stripBoiler` removes import/boilerplate lines: any line matching shebang, `import `, `os.environ`, `OUTPUT_PATH`, `__main__`, `fptr`, `package `, `using System` (`evaluationClone.mjs:120-131`).
2. Strip all comments — `//…`, `/*…*/`, `#…`, `--…` (`COMMENT` regex `:108`).
3. Strip Python `'''…'''` triple-quoted blocks.
4. Collapse all (Python-class) whitespace to a single space.
5. Strip whitespace around operators `=+-*/(),:;<>[]{}%&|!`.
6. `strip().lower()`.

Two submissions have an **exact match** iff their `coreExact` strings are byte-identical.

**`skeleton`** — `evaluationClone.mjs:163-180`. Same boiler/comment strip, then tokenize and replace: every identifier → `V`, every number → `N`, keywords (the `KW` set `:110`) and structural punctuation are kept. This catches **renamed-variable copies**. Identifier test `IDENT_RE` `:159`; digit test `DIGITS_RE` `:161`; tokenizer `TOKEN` `:154`.

> A skeleton match is *weaker* evidence than an exact match: convergent algorithms with different variable names skeleton-match without being copies. This distinction drives several rules below (and is why single-problem conclusiveness now requires `coreExact`, §1.4).

### 1.2 Hardness (`makeHardness`) — **rare-solve, not algorithmic difficulty**

`evaluationClone.mjs:89-102`. For a problem with `s` = number of accepted solvers:

```
s <= 10  -> "hard"
s <= 40  -> "med"
else     -> "easy"
```

This is a **solver-rarity** bucket: a problem nobody solved is "hard" even if trivial; a canonical exercise everyone solves is "easy". This rare-solve conflation was the root cause of a canonical-SQL false-positive class — addressed by the **canonical guard** (§1.4a) rather than by changing `makeHardness` itself (the rare-solve bucket is still useful as a *prior*; the canonical guard is the correction).

### 1.3 Exact / skeleton clusters

`analyzeClones` (`evaluationClone.mjs:227-…`) builds, per problem, groups of **Accepted** submissions sharing a normalized signature, keeping only groups with **>1 distinct user** (`clusters()` `:262`, multi-user gate). Output per cluster: `{ch, hardness, n_users, members[]}`. Records require real code, `len>=15`. Two cluster sets are produced: `exact_clusters` (key=`coreExact`) and `skeleton_clusters` (key=`skeleton`). The output also carries the JS-only `canonical` per-problem map (§1.4a) and the per-recurring-pair conclusiveness enrichments (§1.4).

Cross-pass mapping to per-candidate patches: `attachClusterRefs` (`evaluationMetrics.mjs:1381-1408`) tags each cluster member with `{problem_id, kind: exact|skeleton, n_users, hardness, canonical, others}` — the `canonical` flag down-weights a hard cluster on a canonical problem (§1.4a).

### 1.4 Recurring pairs + the **conclusive** threshold

Two candidates form a **recurring pair** when they co-occur in **skeleton** clusters (`pairProblems` over `skelCl`, `evaluationClone.mjs:324-343`). A pair is *surfaced* when:

```
chs.size >= 2  ||  hardChs.size >= 1
```
i.e. they share ≥2 skeleton problems, **or** share ≥1 **hard** skeleton problem. Each surfaced pair carries `n_problems`, `n_hard`, and the conclusiveness enrichments (`evaluationClone.mjs:363-381`):
- `n_exact` / `exact_problems` — problems where the pair shares a byte-identical **coreExact** accepted form (a strict subset of the skeleton-shared problems, derived from the exact clusters).
- `n_hard_conclusive` / `hard_conclusive_problems` — hard problems that are coreExact-matched **and not canonical** (§1.4a).

The pair becomes **conclusive** in the cross-pass (`evaluationMetrics.mjs:1296-1308`). It is conclusive iff it is EITHER:

```js
// MULTI-problem: ≥2 shared skeleton problems, ≥1 of them non-canonical.
const canonicalShared = rp.problems.filter((c) => canonicalMap[c]).length;
const nNonCanonProblems = rp.n_problems - canonicalShared;
const multiProblem = rp.n_problems >= 2 && nNonCanonProblems >= 1;
// SINGLE-problem: the one shared problem is coreExact AND hard AND non-canonical
// AND the pair has a proximity signal (§1.5).
const singleProblem = rp.n_problems === 1 && rp.n_hard_conclusive >= 1 && pairProximity(a, b);
const conclusive = multiProblem || singleProblem;
```

`deriveCrossFlags` (`:1568-1582`) emits a `recurring_pair_conclusive` critical flag and sets escalation `"confirmed"` for any pair with `conclusive === true`.

> **Why two paths (the 2026-06-22 fixes (i)/(iii)):** a single canonical-SQL match between two strangers must not confirm copying. So a **single-problem** pair now requires a byte-identical `coreExact` match (skeleton-only convergence on one problem is not proof — fix (i)), on a hard **non-canonical** problem (fix (ii) §1.4a), **and** a proximity signal (fix (iii) §1.5). A **multi-problem** pair keeps the original skeleton-based signal (two independent skeleton matches is real copying even when variables were renamed) — the coreExact requirement is single-problem-only, so renamed-variable copy rings (sharing ≥2 problems by skeleton) stay conclusive; only a pair whose *every* shared problem is canonical is dropped.

### 1.4a Canonical-answer / low-entropy guard

`computeCanonical` (`evaluationClone.mjs:64-96`). A problem is **canonical** (its accepted solutions are a handful of near-identical short forms, so an identical match is convergence not copying) iff, over the cohort's accepted submissions for that problem, all three hold:

```
distinct coreExact forms  <= CANONICAL_MAX_FORMS   (8)    (evaluationClone.mjs:44)
median accepted form length <= CANONICAL_MAX_LEN    (200)  (:45)
distinct independent solvers >= CANONICAL_MIN_SOLVERS (5)  (:51)
```

The three-part gate is deliberate: *few short forms* catches canonical one-liners (SQL / editorial); the *length* bound protects a substantive algorithm that merely has few distinct forms (a 672-char identical match is copying even at 4 forms); the *min-solvers* bound prevents a 2-person identical-short-code pair (suspicious convergence) from being excused as canonical. The per-problem map is exposed as `clone.canonical` (and the contest `meta.canonical`, `evaluationMetrics.mjs:1349`).

Effects: a hard clone cluster on a canonical problem is **down-weighted** — `attachClusterRefs` tags the ref `canonical:true` (`evaluationMetrics.mjs:1381-1408`) and `deriveCrossFlags` (`:1577-1582`) treats it as a warning `clone_cluster`, **not** a critical `hard_clone_cluster`; and a canonical problem never contributes to `n_hard_conclusive`, so it cannot drive single-problem conclusiveness (§1.4). It is byte-stripped from `cloneAnalysisCanonical` (the Python-parity output) since it is a JS-only enrichment.

### 1.5 Tight-gap / same-minute co-submission + the proximity gate

On **hard** skeleton clusters, member pairs whose submit times are within 300s are recorded as `tight` (`evaluationClone.mjs:383-403`): `dt <= 60` → `SAME-MINUTE`, else `tight-gap`. The cross-pass annotates each tight record with `same_room` and `same_ip_prefix` proximity (`evaluationMetrics.mjs:1232-1238`).

**Proximity now gates single-problem escalation** (fix (iii)). `pairProximity(a, b)` (`evaluationMetrics.mjs:1242-1255`) is true iff the pair shares a **room** OR an **IP /24 prefix** OR has a **tight-gap** co-submission on any shared problem. A **single-problem** cluster may only reach `confirmed` when `pairProximity` holds (§1.4). A different-room / different-machine / far-apart single-problem match is not a confirmed copy. (Multi-problem conclusiveness does not require proximity — two independent skeleton matches is sufficient.)

> **Caveat for single-LAN contests:** `same_ip_prefix` at /24 is non-discriminating when a whole cohort sits behind one campus NAT (every pair "shares" the egress /24). In that regime the proximity gate alone would not separate strangers from copiers — but the canonical guard (§1.4a) independently removes the canonical-SQL problem from conclusiveness, so the false-positive is cleared without leaning on the IP signal.

### 1.6 Foreign-paste detection (`isForeign`)

`evaluationReplay.mjs:819-839`. A pasted blob (whitespace-collapsed text `c`) is **foreign** iff:
1. `c.length >= MIN_FOREIGN_PASTE_LEN` (=30, `:21`/`:821`), AND
2. `c` is **not** a bare template (`isBareTemplate(c)` — §1.7) (`:825`), AND
3. `c` is not a substring of: the current problem's prior content (`:826`), any *other* problem's current content (`:827-834`), the session's own removed-text history (`selfHistory`, `:835`), any stub (`:836`), or any extra self-text (`:837`).

If it survives all of these it is foreign — code that entered the session without being typed and was not present elsewhere in the candidate's own work.

A foreign paste of **`len >= FULL_SOLUTION_PASTE_LEN`** (=300, `THRESHOLDS:48`) that lands **after an away-episode** (`after_away_ms != null`) is treated as a full-solution import after leaving the tab — a `confirmed`-level signal (§1.10).

### 1.7 Bare-template suppression (`isBareTemplate`)

`evaluationReplay.mjs:783-811`. Candidates paste the standard HackerRank language template (imports + I/O scaffold + empty function body, **no algorithm**) out of muscle memory. That carries zero integrity/talent signal and must not count as a foreign paste. A collapsed string is a bare template iff:
- it exactly matches a proctor starter (`PROCTOR_STARTERS_COLLAPSED`, `:786`), OR
- it matches a `BARE_TEMPLATE_SIGNATURES` entry: starts with the signature `preamble`, is `<= sig.maxLen`, hits all `markerGroups`, **and** the user function body is a bare stub — `bareTemplateBodyHasAlgorithm(c) === false` (`:787-799`). If the body holds a real algorithm it is a foreign paste, not a template (`:798`).
- SQL DDL/seed guard: `len <= 4000` and contains `create table` and (`insert into` or `expected output`) → bare (`:801-809`).

`bareTemplateBodyHasAlgorithm` (`:757-778`) isolates the user-function body, strips placeholder/trivial-return/punctuation, and returns true if a loop/conditional/assignment or ≥several non-trivial tokens remain.

### 1.8 Inter-candidate paste-content matching (directed paste)

`computePasteMatchEdges` (`evaluationMetrics.mjs:1422-…`): when candidate A's foreign paste content (≥`FOREIGN_PASTE_MATCH_MIN`=80, `THRESHOLDS:46`) matches candidate B's submitted code, an edge B→A is recorded. `provable` is set when the owner held the content **before** the paste timestamp (`:1447-1465`). The receiving side gets a **critical** `directed_paste_match` flag (`deriveCrossFlags:1599-1609`).

### 1.9 Telemetry-tampered detection

`evaluationMetrics.mjs:620-675`. Compares the **replayed** editor content against the **submitted** source via `normalizedLineDistance` (`evaluationReplay.mjs:204-212`). A per-problem mismatch counts only if `dist > MISMATCH` (=0.15, `THRESHOLDS:52`) **and** the problem had editor events, is glitch-free (`glitches === 0`), and the snapshot is non-empty (`:649-666`). ≥1 real mismatch with editor coverage present ⇒ `telemetry_tampered = true` (`:668`) → critical flag (`:670`) → `confirmed` tier. Glitchy replays degrade *confidence*, never raise tamper (`:663-664`).

### 1.10 Other per-candidate integrity flags

All in `buildScorecard` (`evaluationMetrics.mjs`). Severity in parentheses.

| Flag (code) | Sev | Condition | Cite |
|---|---|---|---|
| `zero_effort_solve` | critical | full solve, tier ≠ easy, editor coverage present + this problem has events, `active_ms < ZERO_EFFORT_ACTIVE_MS` (120000) **and** `typed < ZERO_EFFORT_TYPED_FRAC`(0.15)·`|code|` | `:458-479` |
| `high_paste_ratio` | critical | paste telemetry present **and** scoring paste-ratio > `PASTE_RATIO_FLAG` (0.6) | `:562-565` |
| `foreign_paste_after_away` | critical | a foreign paste with `after_away_ms != null` | `:576` |
| `foreign_paste` | warning | a foreign paste (no away correlation) | `:583` |
| `superhuman_cadence` | warning | ≥`SUPERHUMAN_CPS`(14) cps over a run ≥`SUPERHUMAN_RUN`(25) single-char inserts | `:592-596`, `:30-31` |
| `metronomic_cadence` | warning | keystroke-gap CV < `METRONOMIC_CV`(0.15) over ≥`METRONOMIC_MIN_KEYS`(40) keys | `:601-604`, `:32-33` |
| `telemetry_tampered` | critical | §1.9 | `:670` |
| `premeditated_clipboard` | critical | entry-clipboard snapshot matches the first foreign paste (≥`CLIPBOARD_MATCH_MIN`=40) | `:691-696`, `:54` |
| `partial_gamer` | **info** | partial score with `stub_delta_lines < STUB_DELTA_LINES`(10) — a *talent-honesty* note, **never** an integrity flag; must not move the integrity axis | `:499-506`, `:40` |

Cross-pass flags (`deriveCrossFlags`, `evaluationMetrics.mjs:1524-1612`):

| Flag | Sev | Condition | Cite |
|---|---|---|---|
| `recurring_pair_conclusive` | critical | §1.4 conclusive pair → escalation `confirmed` | `:1568-1582` |
| `hard_clone_cluster` | critical | member of an exact/skeleton cluster with `hardness === "hard"` **and `canonical !== true`** (a hard cluster on a canonical problem is down-weighted, §1.4a) | `:1585-1594` |
| `clone_cluster` | warning | member of any non-hard **or canonical** exact/skeleton cluster | `:1595-1603` |
| `failed_clone_cluster` | critical / warning | identical **failed** code with a peer: critical if ≥2 shared failed problems with the same peer, else warning | `:1605-1640` |
| `directed_paste_match` | critical | §1.8 | `:1642-1652` |

Failed-submission clustering (`computeFailedClusters`, `:1383-…`) prefers the candidate's persisted, near-stub-filtered `failed_norms` so convergent bare-stub guesses never cluster.

### 1.11 Availability gate (no data ≠ cheating)

Coverage `confidence` is derived (`evaluationMetrics.mjs:1006-1014`): `low` if evidence read failed OR `editor_events_n === 0` OR `gaps.length > 2`; `high` if events present and zero gaps; else `medium`. Silent-gap detection (D16a) flags editor gaps > `SILENT_GAP_MS` (300000) while the session is active (`:1006`, `:50`).

### 1.12 Integrity verdict decision tree (`deriveTiers`)

`evaluationMetrics.mjs:860-942`. In order (first match wins, `:882-905`):

```
noEvidence-exception: if conclusiveRecurring -> "confirmed"           (:891-893)
   (code-similarity proof is independent of the interaction stream;
    it is NOT downgraded to inconclusive)
elif noEvidence                              -> "inconclusive"        (:894-896)
   noEvidence = coverage.confidence=="low" AND
                (gcs_read_failed OR (editor_events_n==0 AND shell_events_n==0))  (:875-880)
elif telemetry_tampered OR fullSolnAfterAway -> "confirmed"           (:897-898)
   fullSolnAfterAway = a foreign paste with after_away_ms!=null AND len>=300     (:888-890)
elif any critical flag                       -> "flag"                (:899-900)
elif any warning flag                        -> "watch"              (:901-902)
else                                         -> "clean"              (:904)
```

Only `confirmed` is an exclusion; `flag` holds for review; `watch`/`inconclusive` are desk-check notes (Layer 3).

---

## LAYER 2 — TALENT SCORING

The talent axis answers: *is this a genuine problem-solver?* It is computed independently of integrity, then **gated** by it (§2.5).

### 2.1 Genuine arc (`genuine_arc`) — the unit of real talent

Per problem (`evaluationMetrics.mjs:465-469`):

```js
genuine_arc = solvedFull
           && paste_ratio < 0.5
           && !zeroEffort
           && (wrong_before_solve >= 1 || runs >= 2 || typedMajority);
```

`solvedFull` = `best_score >= problemPoints[pid]`. `typedMajority` = `typed >= pasted` (`:451`). `zeroEffort` per §1.10. So a genuine arc = a real full solve, mostly typed, not zero-effort, with evidence of *work* (a wrong try, or multiple runs, or typing the majority). Each problem also records `_tier` (its hardness bucket) for later tier counting (`:538`).

### 2.2 Honest reach (`honest_reach`) — effort, not talent

`evaluationMetrics.mjs:509`: an **unsolved** problem with `submits >= REACH_MIN_SUBMITS`(2), `active_ms >= REACH_MIN_ACTIVE_MS`(600000 / 10 min), and `paste_ratio < REACH_MAX_PASTE`(0.3). Honest reach credits *effort* in the composite (reach_frac) but is **deliberately not** a talent-tier qualifier (`:915-919` — on a live recompute, reach-only labeling made 0-solve candidates "strong").

### 2.3 First-attempt solves

`evaluationMetrics.mjs:514-515`: first submission accepted with zero prior wrong submissions. Surfaced as a FOR-point in the recommendation case.

### 2.4 Composite score

`computeComposite` (`evaluationMetrics.mjs:830-858`):

```
composite = round( 55·score_frac + 20·hardness_frac + 15·genuine_frac + 10·reach_frac )
```

- `score_frac` = `max(0, total_score − discountedPartialPoints) / maxTotal` (`:838`).
  **Partial discount:** every partial solve (`best_score>0 && best_score<effMax`) is non-genuine (a genuine arc requires a full solve), so its **full** points are subtracted (`discountedPartialPoints`, `:488-491`, accumulated per problem). This stops a multi-problem partial/stub-gamer from outranking a genuine 2-problem solver.
- `hardness_frac` = Σweight(full-solved scoring problems) / Σweight(all scoring problems), weights `{easy:1, med:2, hard:4}` (`TIER_WEIGHT:829`, `:839-849`).
- `genuine_frac` = (# `genuine_arc` problems) / `max(1, n_solved_full)` (`:850-855`).
- `reach_frac` = `min(1, honest_reach.length / 2)` (`:856`).

### 2.5 Talent tiers + the strong floor

`deriveTiers` (`evaluationMetrics.mjs:920-927`). Let `genuineHard`/`genuineMed` = count of genuine arcs per tier (`countGenuine`, `:944-958`, reads `pp._tier`).

```
strong   if genuineHard >= 1 || genuineMed >= 3      (:925)
moderate if genuineMedPlus >= 1 || strong_gem flag   (:926)   (genuineMedPlus = hard+med)
weak     otherwise                                    (:927)
```

The **strong floor** is `genuineHard>=1 || genuineMed>=3` (tightened from the prior `genuineMed>=2`, which let thin "strong" labels through in weak fields). A demoted thin-strong (gm=2, gh=0) falls to **moderate** (via `genuineMedPlus>=1`), never below — the spec hard rule "nobody drops below hire" is honored at the recommendation layer (§3.3).

### 2.6 Confirmed-integrity gate on talent

`deriveTiers:931-933`: if `integrityTier === "confirmed"`, force `talentTier = "weak"` and `composite = min(composite, 20)`. This is how integrity gates talent — a confirmed copier cannot present as talented.

---

## LAYER 3 — RECOMMENDATION / SELECTION

`evaluationRecommend.mjs` — a pure read-time transform over stored scorecards + cross-pass meta. The detector's tiers already separate genuine hires from the copying ring; the recommendation is additive and never re-derives detection.

**Calibration invariant** (`:21-28`, `CALIBRATION:233-240`): integrity **gates** talent and the two are never averaged. **Only `confirmed` excludes.** `flag` → hold; `watch`/`inconclusive` → desk-check note, never a block. (In the calibration cohort a majority of genuinely-selected candidates carry a `watch` note — a naive "any flag ⇒ exclude" would have rejected most real hires.)

### 3.1 Participant gate

`isParticipant` (`:69-72`): a card counts only if it has ≥1 editor event OR ≥1 submission. Zero-evidence placeholder docs are excluded from every ranked view (no fabricated "clean 0").

### 3.2 Per-candidate buckets (`recommendFor`)

`evaluationRecommend.mjs:102-181`. Tier strings normalized (trim+lowercase) before gating — the exclude gate is the most safety-critical line and must survive upstream formatting drift (`:104-110`). In order:

```
integrity == "confirmed"                         -> EXCLUDE_INTEGRITY   (:113-120)
integrity == "flag"                              -> HOLD_REVIEW         (:122-129)
talent == "strong" && integrity == "clean"       -> STRONG_HIRE         (:131-139)
talent == "strong" && integrity in {watch,incon} -> HIRE_DESKCHECK      (:141-151)
talent == "moderate" && integrity in {clean,watch}
        && genuineMedCount(card) >= 2            -> SOLID_HIRE          (:158-172)
otherwise                                        -> BELOW_BAR           (:174-180)
```

`composite` is carried through but does **not** itself gate a bucket; it is the ranking key (§3.5). For confirmed candidates the composite is already capped at 20 by §2.6 — that capped composite is what `recommendFor` reports (`:111`).

### 3.3 SOLID_HIRE — mid-tier solver rescue

`genuineMedCount` (`:82-90`): count of `per_problem` entries with `genuine_arc===true && _tier==="med"`. A **moderate** candidate with **≥2 genuine medium solves** and clean/watch integrity is a real mid-tier solver, kept as a hire (`SOLID_HIRE`, order 3) rather than dropped below the bar. This is the floor that catches candidates demoted from thin-strong (§2.5) — "nobody drops below hire".

### 3.4 ORIGIN-RESCUE — "their work was copied" (`GENUINE_COPIED`)

`computeOriginRescues` (`evaluationRecommend.mjs:391-460`), applied in `computeRecommendationReport` (`:485-503`).

**Genuine-origin profile** (`isGenuineOriginProfile:370-373`): `paste_ratio < 0.12` AND `genuineArcCount >= 2` AND `foreignPasteCount === 0` — they typed it themselves, have ≥2 real arcs, and pasted nothing foreign.

**Group resolution:** for each exact clone cluster and each *coreExact* recurring pair, members are ordered by submit time (clusters carry `created`; pairs use earliest-seen submit). Two guards constrain which groups form and who can be an origin (fix (iv)):
- **(a) skeleton-only guard** (`evaluationRecommend.mjs:421-438`): a recurring pair is admitted as a rescue group only when it carries a real byte-identical match (`n_exact >= 1`). A skeleton-only-differing pair is not a copy, so it has no victim to rescue. (Exact CLUSTERS are coreExact by construction and are always admitted.) A pre-fix meta without `n_exact` falls back to admitting the pair (no regression on old data).
- **(b) one origin per group / no mutual origin** (`:440-500`): the set of candidates who are a downstream COPIER (a non-earliest member) in **any** group is computed first; a candidate in that set can never also be rescued as an origin. So two byte-identical typists who each rank "earliest" on a different problem are **both** excluded — neither is a clean victim.

The **earliest** member of an admitted group, if they are never a copier elsewhere (b) and pass the genuine-origin profile, is rescued from `EXCLUDE_INTEGRITY` into the separate visible bucket `GENUINE_COPIED` (order 4): talent **kept**, integrity demoted to a **note**. The later members (copiers) stay excluded. `GENUINE_COPIED` is **not** a hire bucket — the rescued origin is surfaced as a victim for review, and the underlying detector tier stays `confirmed` (the copying detection still holds).

**Guard:** if the earliest member has a foreign paste / fails the profile, the whole group is externally sourced ⇒ **no rescue** for anyone. The rescue override only ever lifts an `EXCLUDE`; it never touches a hire/hold/below-bar.

### 3.5 Report assembly

`computeRecommendationReport` (`:477-614`):
- **Talent rank:** composite desc, tiebreak raw score desc, then name (`:533-536`).
- **Raw-score rank** computed in parallel (`:539-542`); `rank_delta = raw_rank − talent_rank` surfaces leaderboard distortion (`:546`).
- `hires` = STRONG_HIRE + HIRE_DESKCHECK + SOLID_HIRE (`isHireBucket:57-60`, `:548`); shortlist depth = `hires.length` (`:562`).
- `missedByRawScore` = genuine hires a same-depth raw-score cut would skip (`:566-568`); `rawScoreTraps` = top-raw names that are not hires, each with a `why_not` (`:570-583`).
- Buckets surfaced: `hires`, `genuineCopied`, `hold`, `excluded`, `belowBar` with per-bucket counts (`:585-613`).

Bucket display order (`BUCKET_META:47-55`): strong_hire(1) → hire_deskcheck(2) → solid_hire(3) → genuine_copied(4) → hold_review(5) → exclude_integrity(6) → below_bar(7).

---

## Threshold reference (all `THRESHOLDS`, `evaluationMetrics.mjs:26-55` unless noted)

| Constant | Value | Used by |
|---|---|---|
| `AWAY_PASTE_WINDOW_MS` | 10000 | away→paste correlation (D3) |
| `SUPERHUMAN_CPS` / `SUPERHUMAN_RUN` | 14 / 25 | superhuman cadence (D4) |
| `METRONOMIC_CV` / `METRONOMIC_MIN_KEYS` | 0.15 / 40 | metronomic cadence (D4) |
| `ZERO_EFFORT_ACTIVE_MS` / `ZERO_EFFORT_TYPED_FRAC` | 120000 / 0.15 | zero-effort solve (D10) |
| `PASTE_RATIO_FLAG` | 0.6 | high_paste_ratio (D1) |
| `STUB_DELTA_LINES` | 10 | partial_gamer / near-stub filter (D12) |
| `REACH_MIN_SUBMITS` / `REACH_MIN_ACTIVE_MS` / `REACH_MAX_PASTE` | 2 / 600000 / 0.3 | honest_reach (D13) |
| `FOREIGN_PASTE_MATCH_MIN` | 80 | inter-candidate paste match (D6) |
| `FULL_SOLUTION_PASTE_LEN` | 300 | full-solution-after-away → confirmed (D2) |
| `SILENT_GAP_MS` | 300000 | silent editor gap → coverage (D16a) |
| `MISMATCH` | 0.15 | telemetry-tampered (D16b) |
| `CLIPBOARD_MATCH_MIN` | 40 | premeditated_clipboard (D15) |
| `MIN_FOREIGN_PASTE_LEN` | 30 | `REPLAY` `evaluationReplay.mjs:21` |
| hardness cutoffs | 10 / 40 | `makeHardness` `evaluationClone.mjs:88-90` |
| conclusive | multi: `n_problems>=2 && non-canonical>=1`; single: `coreExact && hard && non-canonical && proximity` | `evaluationMetrics.mjs:1296-1308` |
| `CANONICAL_MAX_FORMS` / `CANONICAL_MAX_LEN` / `CANONICAL_MIN_SOLVERS` | 8 / 200 / 5 | canonical guard `evaluationClone.mjs:44-51` |
| genuine_arc paste cap | 0.5 | `evaluationMetrics.mjs:467` |
| strong floor | `hard>=1 \|\| med>=3` | `evaluationMetrics.mjs:925` |
| origin profile | `paste<0.12, arcs>=2, foreign==0` | `evaluationRecommend.mjs:372` |
| solid-hire gate | `genuine_med>=2` | `evaluationRecommend.mjs:160` |
| confirmed composite cap | 20 | `evaluationMetrics.mjs:933` |

---

## HTTP surface

- `backend/src/routes/evaluation.mjs`: `POST /api/admin/contest-evaluate` (run/resume; body `{contest, limit?, cursor?, force?}`), `GET /api/admin/contest-evaluations?contest=…[&identity=…]` (scorecards + meta), `GET /api/admin/contest-evaluate-status?contest=…`.
- `backend/src/eval-server.mjs`: serves `/eval-ui`, `/eval-ui/app.js`, and `/eval-ui/recommend.js` — the last is the **same** `evaluationRecommend.mjs` module the node tests pin, served verbatim so the browser shows the exact logic (`:79-104`).
- `backend/src/evaluation.mjs`: pure `evaluateCandidate(input)` for the local driver/tests; `makeEvaluation(ctx)` is the I/O layer that reads GCS evidence, writes one scorecard per contest×identity, and at the end of the identity cursor runs the cross-pass (`crossCandidateAnalysis` + `applyCrossPatches`) and writes the contest meta doc.
