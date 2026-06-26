# Proposed: foreign-paste detector correctness + info-level activity log

**Status:** proposed (design) · **Raised:** 2026-06-26 (owner, after live-test re-review of one candidate) · **Backlog:** `EVAL-2`, `LOG-1`

## The ask (owner, 2026-06-26)
1. **Fix the foreign-paste detector permanently** — it must flag genuine *external*
   pastes and never flag the candidate's own / on-page content. "Detect the right
   one, not the wrong one, period."
2. **Activity log below the recording** — surface neutral signals (the normal paste
   marker and other relevant events) as **info**, hidden by default, with a **"Show
   info activities"** filter chip that is **OFF by default** so trivial entries don't
   show on load.

## Root cause (PROVEN, not hypothesised)
Re-reviewed candidate `REDACTED-ROSTER-ID` (session `0cf7bca7-…`, contest
`intern-hire-contest-slug`). Two `foreign_paste` flags (integrity tier
"watch"); both are **false positives — his own code**:
- **occupations**: he *typed* `MAX(CASE WHEN Occupation='Doctor' THEN Name END) AS Doctor,`
  by hand, then pasted 3 copies of his own line and relabelled them Professor/Singer/Actor.
- **challenge-8**: he re-pasted his own `total_painted += (current_end - current_start + 1)`
  else-branch line + `return total_painted` while refactoring.

I reproduced the flag through the real eval (`replaySession`) against his 8.4k-event
stream. The cause is **broken document reconstruction**, not a missing source list:

- The eval reconstructs the editor doc with a **flat-offset** model
  (`lineColToOffset` + `applyChange` + `TextBuffer.apply`, `backend/src/evaluationReplay.mjs:31-195`).
  On his real edit stream (heavy auto-paired brackets/quotes, mid-token cursor edits)
  it produces **garbage**: e.g. occupations reconstructs as
  `"SLECT … MAX()()CASE WHEN oOOccupation = ""Docttoror'' … aAS Doctor,"`.
- A **line/column-model** replay of the *same events in the same order* reconstructs
  the candidate's **real, valid SQL** (ground truth):
  `SELECT MAX(CASE WHEN Occupation='Doctor' THEN Name END) AS Doctor, … FROM (…) GROUP BY row_num ORDER BY row_num;`.
- `isForeign` (`evaluationReplay.mjs:819-839`, line 826 `collapseWs(beforeContent).includes(c)`)
  then asks "is the pasted text already in the doc?" — with the **garbled** beforeContent
  the answer is wrongly **no** → flagged foreign. With the **faithful** line-model
  reconstruction the answer is **yes** → not foreign.

The flat-offset model's `lineColToOffset` **clamps** out-of-range positions to
line-end / content-end (`:39`, `:46`); once any edit drifts, every later offset
compounds the error. The line model grows to the referenced line and never collapses,
so it stays aligned with Monaco's actual model. **This is a general detector bug
(any candidate with this editing pattern false-positives), not specific to a candidate.**

## Layer A — detector correctness (`EVAL-2`)
1. **Replace the flat-offset reconstruction with a faithful line/column model** in
   `replaySession`'s per-problem buffer (Monaco edit semantics: apply each
   insert/replace/delete by (startLine,startCol)-(endLine,endCol), growing to the
   referenced line, never clamping to content-end). Proven correct against a candidate's
   stream. Keep `applyChange` (used by tests) and `TextBuffer` consistent.
   - **Performance guard:** the gap buffer existed for ~2MB/200k-edit worst cases;
     exam code is KBs, so a lines model is fine — but keep a size/■op guard so a
     pathological stream can't go quadratic (fall back / cap, never crash).
2. **Add statement + sample I/O to the on-page sources** (the lesser FP class):
   `buildProblemContext` (`backend/src/evaluation.mjs:191-207`) currently threads only
   `problem.stubs`; also thread `problem.statement` + `problem.sampleTests[].input/expected`
   into `replaySession` as `onPageTexts`, and add a `collapsedOnPage` substring check
   in `isForeign` next to the stub check (`:836`). Keep separate from `extraSelfTexts`
   (the `:257-261` self-submission caveat does not apply to fixed contest content).
   Statement is markdown — also seed a markdown-stripped variant (sample I/O is plain).
3. **Re-run evaluation** on affected contests after the fix (pure eval-time
   re-classification, no client redeploy) to clear historical false positives
   (a candidate included).
4. **Regression fixtures:** add a candidate's occupations + challenge-8 event slices as
   test inputs asserting the reconstruction matches ground truth AND the pastes are
   NOT foreign; plus a genuine-external paste fixture that MUST stay foreign.

## Layer B — info-level activity log + filter chip (`LOG-1`)
**Design pending a code-map** of the activity log below the recording
(`frontend/src/RecordingReview.tsx`, `notableEditorMarkers.ts`, alerts/submissions
lanes). Intended shape:
- Classify activity entries into **info** (neutral: the normal paste marker, focus/
  blur, cursor bursts, etc.) vs **notable** (alerts, confirmed-foreign paste, …).
- Surface the info entries in the same activity log, alongside existing info.
- Add a **"Show info activities"** filter chip, **default OFF** → info entries hidden
  on load; toggling reveals them. Match existing filter-chip styling in that view.
- Raw telemetry stays logged (forensics reads it); only the *prominence/severity*
  changes.

## Open questions / decisions
- Confirmed-foreign pastes: stay notable (NOT info) once the detector is correct.
- Long pastes (>2000-char editor-stream cap) reconstruct only partially — acceptable?
- Re-eval scope: just this contest, or all historical contests with the FP pattern?

## Build plan (orchestrated; owner verifies each phase)
- **P0 design-harden:** map Layer B UI (sub-agent); 1 adversarial code-grounding pass
  over this spec.
- **P1 (EVAL-2 core):** line-model reconstruction + tests (a candidate regression) → backend green.
- **P2 (EVAL-2 sources):** statement/sample on-page + markdown-strip + tests.
- **P3 (LOG-1):** info/notable classification + "Show info activities" chip (default off);
  browser-verify on :9222.
- **P4:** triple-lens review → staged deploy (backend + frontend) → re-run eval on the
  contest → confirm a candidate clears.

Verification artifacts: reproduction harness + ground-truth reconstruction already in hand.

## Hardening (P0 critique, folded 2026-06-26)
Code-grounding critique + my own verification against the tree changed the design:

- **`glitches` is a tamper safety valve.** `evalRules/rules/replayTamper.mjs:61-62`:
  a submit-snapshot↔submission mismatch is only `telemetry_tampered` when the problem
  is **glitch-free**; a glitchy problem degrades to `coverage_gap` (`replay_base_unreliable`).
  Tested: `evaluationMetrics.test.mjs` "GLITCH GATE (D16b/D16c)", `evaluationReplay.test.mjs`
  "glitch detection counts per problem". So I must NOT casually drop `glitches`.
- **Measured (a candidate):** flat→line glitch counts: occupations 60→**0**, weather 42→**0**,
  challenge-7 45→4, 15-days 167→25. The flat model's glitches are mostly **spurious
  offset-drift**; the line model reconstructs his real, valid SQL. Genuine inconsistent
  events (deletedLen ≠ range) STILL glitch in the line model — so the existing glitch
  tests keep passing, and **a faithful reconstruction makes tamper detection MORE
  correct too** (snapshots now match → fewer false mismatches), not less.
- **Refined fix:**
  1. **Faithful line/column reconstruction** in `replaySession`'s buffer (core). Keep the
     `glitch` flag firing on genuine deletedLen-vs-range mismatches (preserves the tamper
     gate). Keep `applyChange`/`lineColToOffset` exported but make them faithful; UPDATE
     the tests that assert the OLD clamping (they encode the bug) — and KEEP the
     genuine-mismatch glitch tests (they must still pass; verify).
  2. **Also gate `foreign_paste` on `glitchFree`** (mirror the tamper valve): never assert
     a paste foreign on a glitchy/unreliable problem — degrade to inconclusive. Belt-and-
     suspenders for any residual reconstruction noise.
  3. **on-page sources + markdown strip** for `isForeign` — thread `onPageTexts` through
     `replaySession`→`isForeign` (new `collapsedOnPage` param) as the spec's Layer A.2.
- **Ripple to re-check on re-eval (diff scorecards before/after):** `foreign_pastes` (D2),
  `premeditatedClipboard` (D15), `pasted_chars`/`typed_chars` (D1), burst cadence,
  `submit_snapshots` tamper. Re-run eval on the contest and DIFF every candidate's
  verdict; investigate any flip before promoting.
- **Performance:** keep within the `evaluationReplay.test.mjs` 200k-events/<10s budget;
  guard against pathological line growth.

### Layer B correction
The normal `editor_paste` marker **is in scope as info** (owner: "including the normal
paste event") — not deferred. Classify info = neutral proctor events (window_blur/focus,
clipboard_activity, fullscreen enter/exit, …) **AND** non-foreign / sub-burst editor
pastes & keystroke markers; notable = alerts + confirmed-foreign pastes + error events.
UI mapped: `RecordingReview.tsx` `ActivityLogPanel` (≈2078-2377), entries
`TimelineLogEntry[]` filtered by `filterTimelineLog` (`recordingTimeline.ts:384-417`);
add `showInfoActivities:false` to `TimelineLogFilters`/`DEFAULT_LOG_FILTERS`, a
`NEUTRAL`/info classifier, and a `LogFilterChip` "Show info activities" (default OFF)
after the Submissions chip. No backend change (server already returns all events).

### Open decision for the owner
Re-eval scope: just `intern-hire-contest-slug`, or all historical contests
(faithful reconstruction can change past verdicts — should be net-more-correct, but it
DOES re-score already-reviewed candidates).

## Build progress + resume (for a post-compaction session)
- **P0 design-harden: DONE** (root cause proven; tamper-gate interaction verified; this spec hardened).
- **P1 (EVAL-2 reconstruction core): DISPATCHED to an Opus subagent.** On its completion,
  the orchestrator MUST verify, not rubber-stamp: `cd backend && npm test` all green, then
  run the a candidate regression harness and confirm occupations reconstructs to valid SQL with
  `glitches≈0` and the two flagged pastes come out `foreign=false`. Read the diff. Then commit.
- **Then:** P2 = thread statement + sample I/O into `isForeign` (`onPageTexts`, markdown-strip)
  + gate `foreign_paste` on `glitchFree`; P3 = Layer B "Show info activities" chip (default OFF;
  include the normal paste marker as info) per the mapped plan; then triple-review →
  staged deploy (backend + frontend) → re-run eval on the contest → confirm a candidate clears.
- **Regression data (durable):** candidate `REDACTED-ROSTER-ID` (a candidate), session
  `REDACTED-SESSION-UUID`, contest `intern-hire-contest-slug`.
  Editor-event stream cached at `…/scratchpad/editor-events.ndjson`; reconstructable from
  GCS `gs://your-gcp-project-id-evidence/contests/<slug>/sessions/<username_norm>/<sid>/editor-events/`.
  Flagged pastes: occupations @ `2026-06-25T07:15:44.576Z` (`MAX(CASE…Doctor…`), challenge-8 @
  `2026-06-25T07:01:35.393Z` (`total_painted += …`). Eval scorecard via the **eval service**
  `GET /api/admin/contest-evaluations?contest=<slug>` (x-admin-password); `integrity.foreign_pastes[]`.
- Tracking: BACKLOG `EVAL-2` + `LOG-1`; task #162.
