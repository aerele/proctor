# Candidate Evaluation — deterministic talent + integrity scorecards

After a contest ends, an admin presses **Evaluate** on the Results tab and the
platform computes, per candidate, a deterministic scorecard from the captured
session evidence — keystroke/paste telemetry, the replayed editor state, the
submissions, and the shell/clipboard event streams. Outputs are **evidence and
flags, never verdicts**; a supervised round (or the owner) is ground truth.

Two orthogonal axes, **never averaged**:

- **Talent** — how strong a problem-solver the candidate is (a sortable 0–100
  composite + a tier).
- **Integrity** — whether the work is the candidate's own (a tier). Confirmed
  cheating **gates** talent (caps it to `weak`).

Evaluation runs **only on the admin's button press** (no auto-run at contest
end). It reads only persisted session evidence + submissions — nothing
exam-time — so a contest is evaluable the moment the window closes.

---

## What it computes — the D1–D17 signal families

Pure, fixture-tested modules (`evaluationReplay.mjs`, `evaluationClone.mjs`,
`evaluationMetrics.mjs`) produce these. All thresholds are **fixed v1 constants**
in one block (`THRESHOLDS` in `evaluationMetrics.mjs`).

### Integrity signals

| ID | Signal | What it measures |
|----|--------|------------------|
| D1 | `paste_ratio` | `pasted_chars / (typed + pasted)` per problem + overall. Pasted = inserts paired to an `editor_paste` (±500 ms, matching len) or large unpaired non-autocomplete inserts; the rest is typed. |
| D2 | `foreign_pastes[]` | Pasted text (≥30 chars, ws-collapsed) that was **never** in the candidate's own prior content (any problem/time). Self-moves are benign. |
| D3 | `away_paste_correlations[]` | Foreign paste / burst within 10 s after a switch-away episode (blur / hidden / fullscreen-exit). The highest-precision live-copy signal. |
| D4 | `cadence` | Inter-keystroke gaps; `superhuman_bursts` (≥25 single-char inserts at ≥14 cps); `metronomic` (CV<0.15 over ≥40 keys — replayer tell). |
| D5 | Clone clusters | `coreExact` + `skeleton` over accepted code (≥15 chars), per problem, hardness-tagged, >1 identity = cluster. **Plus failed-submission clustering** (identical wrong code — very low FP). |
| D6 | Paste-content matching | Foreign-paste text (≥80 chars) matched against every other candidate's content + submissions ⇒ directed `{from,to,problem_id,ts}` edges. |
| D7 | Recurring pairs | Two people sharing skeleton-identical code on ≥2 problems OR ≥1 hard ⇒ **conclusive** (the strongest standalone proof). |
| D8 | Tight-gap / same-minute | Hard-cluster members within ≤60 s (`SAME-MINUTE`) / ≤300 s (`tight-gap`), annotated same-room / same-IP-prefix. |
| D9 | Artifacts + provenance | Raw-byte scan (smart quotes, NBSP, zero-width, BOM, dashes, mixed-indent) + `PROV` regex hits per submission. |
| D10 | Zero-effort solve | Accepted med+ solve with `active_ms < 120 s` AND `typed_chars < 0.15 × |code|`. |
| D15 | Entry-clipboard | First foreign paste matches the entry `review/clipboard.jsonl` snapshot ⇒ premeditated-paste. |
| D16 | Coverage / tamper | Silent-editor gaps lower confidence; **replay mismatch** (submitted code ≠ replayed editor state at submit, normalized line-distance > 0.15) ⇒ `telemetry_tampered` (critical). |
| D17 | Shell rollups | `tab_away_total_ms`, away-episode count, `fullscreen_violations`, `ip_change_count` from session docs + shell events. |

### Talent signals

| ID | Signal | What it measures |
|----|--------|------------------|
| D11 | `active_ms` per problem | Editor-timeline time, gaps > 60 s excluded. |
| D12 | Stub-delta | Final code vs the problem stub, line-level edit distance. `score>0 AND delta<10 lines` ⇒ `partial_gamer` (the KEC gem-gamer lesson). |
| D13 | Honest reach | Unsolved with ≥2 submits AND `active_ms ≥10 min` AND `paste_ratio < 0.3` ⇒ genuine reach. |
| D14 | First-attempt solve | First submit accepted, no prior failed run — neutral alone, flag only paired with D1/D2/D10. |
| — | Iteration arcs / breadth | `{runs, submits, wrong_before_solve, score_climb}`; `n_solved_full`, `n_medplus_solved`, `hardest_tier`, `languages`. |

Difficulty is solver-count hardness (`makeHardness`: ≤10 solvers = hard, ≤40 =
med, else easy), computed per contest from accepted-distinct-identity counts.

---

## The two routes

| Method · Path | Body / Query | Returns |
|---|---|---|
| `POST /api/admin/contest-evaluate` | `{ contest, limit?=25, cursor?, force? }` | `{ evaluated, skipped, cursor?, done, meta_written? }` |
| `GET /api/admin/contest-evaluations` | `?contest=<slug>[&identity=|&person_id=]` | `{ evaluations: [scorecards], meta: metaDoc \| null }` |

Both are **admin-only** (`requireAdmin` first). The contest is resolved with
`requireOpen:false` (evaluation runs after close); an unknown/blank slug → 400.

`contest-evaluate` is **cursor-batched** so a large contest fits a Cloud Run
request timeout: each call evaluates up to `limit` identities and (when more
remain) returns the `cursor` to resume from. It is **idempotent** — an identity
whose stored scorecard already has the current `evaluator_version`, the same
sorted `session_ids`, and the same `submissions_n` is **skipped** unless
`force:true`. When a call reaches the end of the identity universe (`done:true`),
it runs the **cross-candidate pass** (clones, recurring pairs, paste-matching,
submit clusters) over the accumulated normalized corpus, back-patches each
scorecard's cross refs, and writes the contest **meta** doc.

**Identity universe** = active enrollments' `person_id`s ∪ submission identity
keys not consumed by an enrollment (mixed keying — an evaluation identity is the
`person_id` when present, else the bare `username_norm`). Keys are sorted; the
cursor is the last processed key.

---

## Storage

`EVALUATIONS_COLLECTION` (`proctor_evaluations`, env-overridable). One doc per
contest × identity, id `{contest_slug}::{identity_key}`; contest-level artifacts
(clusters, pairs, hardness table, cohort norms) under `__meta::{contest_slug}`.
Every read goes through the `scopedQuery` chokepoint, so the contest-isolation
canary holds (the `__meta::` doc is held out of the `evaluations` array and
returned as `meta`). `EVALUATOR_VERSION` + `schema_version` gate recompute.

---

## Scorecard schema

```json
{ "schema_version": 1, "evaluator_version": "1", "computed_at": "...",
  "contest_slug": "...", "person_id": null, "username_norm": "...", "candidate_id": "...", "name": "...",
  "identity_key": "...", "session_ids": ["..."],
  "coverage": { "editor_events_n": 0, "shell_events_n": 0, "submissions_n": 0, "sessions_n": 0, "gaps": [], "confidence": "high|medium|low" },
  "talent": { "composite": 0, "total_score": 0, "max_total": 0, "n_solved_full": 0, "n_medplus_solved": 0,
              "hardest_tier": "easy|med|hard|none", "per_problem": { "<pid>": { "best_score": 0, "max_points": 0,
              "active_ms": 0, "runs": 0, "submits": 0, "wrong_before_solve": 0, "score_climb": [],
              "paste_ratio": 0, "stub_delta_lines": null, "genuine_arc": false } },
              "honest_reach": [], "first_attempt_solves": [], "languages": [] },
  "integrity": { "typed_chars": 0, "pasted_chars": 0, "paste_ratio": 0, "foreign_pastes": [],
                 "away_paste_correlations": [], "cadence": {}, "zero_effort_solves": [],
                 "clone_cluster_refs": [], "recurring_pair_refs": [], "paste_match_edges": [],
                 "artifacts": {}, "provenance_hits": [], "tab_away_total_ms": 0, "away_episode_count": 0,
                 "fullscreen_violations": 0, "ip_change_count": 0, "replay_mismatches": [], "telemetry_tampered": false },
  "flags": [ { "code": "...", "severity": "critical|warning|info", "problem_id": null, "evidence": "one line" } ],
  "tiers": { "talent": "strong|moderate|weak", "integrity": "clean|watch|flag|confirmed", "one_line": "..." },
  "llm": { "judgments_pending": [], "verdicts": {} },
  "recommended_action": null }
```

The scorecard projects onto each Results row as
`evaluation: { talent_tier, integrity_tier, composite, paste_ratio, flags_by_severity, confidence, one_line, recommended_action }`
(null until evaluated — behavior-preserving for unevaluated contests).

---

## Tier rules + composite (fixed v1)

**Integrity tier.**
- `confirmed` ⇔ a **conclusive recurring pair** (≥2 shared problems or ≥1 hard) OR `telemetry_tampered` OR a foreign paste ≥300 chars after-away on a subsequently-accepted problem.
- `flag` ⇔ any **critical** flag (zero-effort med+ solve; HARD clone-cluster member; overall `paste_ratio > 0.6` across scoring problems; directed paste-match recipient; foreign-paste-after-away; premeditated clipboard).
- `watch` ⇔ warnings only. `clean` otherwise.

**Talent tier.**
- `strong` ⇔ ≥1 hard OR ≥2 med solved with **genuine arcs**.
- `moderate` ⇔ ≥1 med+ genuine OR a strong-gem.
- `weak` otherwise. `genuine_arc(problem)` = solved AND `paste_ratio < 0.5` AND not zero-effort AND (`wrong_before_solve ≥ 1` OR `runs ≥ 2` OR typed-majority one-shot).
- **Gate:** `integrity = confirmed` ⇒ talent forced `weak`.

**Talent composite (0–100).**
`round(55·score_frac + 20·hardness_frac + 15·genuine_frac + 10·reach_frac)`
where `score_frac = total/maxTotal`; `hardness_frac = Σweight(solved-full)/Σweight(all scoring)` with `easy=1, med=2, hard=4`; `genuine_frac = genuine-arc solves / max(1, n_solved_full)`; `reach_frac = min(1, honest_reach/2)`. `integrity = confirmed` ⇒ `composite = min(composite, 20)`.

**Confidence.** `low` if `editor_events_n == 0` OR >2 coverage gaps; `high` if `editor_events_n > 0` AND no gaps; else `medium`.

---

## Owner defaults (v1)

- **7-action vocabulary** (`REJECT-CHEAT / PEN-PAPER / AI-SUSPECT / ADVANCE / VERIFY-DESK / REJECT / NOT-ADVANCED`) is **reserved** but **not applied** in P1: `recommended_action` always ships `null`.
- **Trigger:** evaluation runs **only on the Evaluate button press** — never auto-run at contest end or selection-done.
- **Thresholds:** fixed v1 defaults (per-contest configurable thresholds are a later phase, if ever).
- **P2 (not built):** an LLM-judgment work queue (paste-provenance, gem-verify, etc.) that fills `llm.verdicts` and re-derives `recommended_action`. The platform never calls an LLM, never blocks, never spends money; absence of verdicts degrades gracefully.

---

## Related

- [admin-results-people.md](admin-results-people.md) · [admin-recording-review.md](admin-recording-review.md)
- [contest-eval-monitoring.md](contest-eval-monitoring.md) · [alert-taxonomy.md](alert-taxonomy.md)
- [architecture-overview.md](architecture-overview.md) · [exam-day-ops-runbook.md](exam-day-ops-runbook.md)
