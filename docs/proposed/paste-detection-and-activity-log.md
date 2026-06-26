# Foreign-paste detector correctness + info-level activity log

**Status:** BUILT 2026-06-26 (P1+P2+LOG-1 implemented, reviewed, tests green) ·
pending staged deploy + re-evaluation · **Raised:** 2026-06-26 (owner, after a
live-test re-review of one candidate) · **Backlog:** `EVAL-2`, `LOG-1`

> De-identified for the public repo. The specific candidate / session / contest /
> bucket that triggered this work are kept in a gitignored local note, not here.

## The ask (owner, 2026-06-26)
1. **Fix the foreign-paste detector permanently** — it must flag genuine *external*
   pastes and never flag the candidate's own / on-page content. "Detect the right
   one, not the wrong one, period."
2. **Activity log below the recording** — surface neutral signals (the normal paste
   marker and other relevant events) as **info**, hidden by default, with a **"Show
   info activities"** filter chip that is **OFF by default** so trivial entries don't
   show on load.

## Root cause (PROVEN, not hypothesised)
A live-test candidate was flagged with two `foreign_paste` integrity signals; both
were **false positives — his own code** (he typed a line by hand, then pasted copies
of his own line and relabelled them; on another problem he re-pasted his own
accumulation line + return while refactoring). Reproduced through the real eval
(`replaySession`) against his ~8.4k-event editor stream. The cause is **broken
document reconstruction**, not a missing source list:

- The eval reconstructed the editor doc with a **flat-offset** model
  (`lineColToOffset` + `applyChange` + `TextBuffer.apply`, `backend/src/evaluationReplay.mjs`).
  On a real edit stream (heavy auto-paired brackets/quotes, mid-token cursor edits)
  it produced **garbage** — e.g. occupations reconstructed as
  `"SLECT … MAX()()CASE WHEN oOOccupation = ""Docttoror'' … aAS Doctor,"`.
- A **line/column-model** replay of the *same events in the same order* reconstructs
  the candidate's **real, valid SQL** (ground truth).
- `isForeign` then asks "is the pasted text already in the doc?" — with the **garbled**
  beforeContent the answer is wrongly **no** → flagged foreign. With the **faithful**
  reconstruction the answer is **yes** → not foreign.

The flat-offset model **clamped** out-of-range positions to line-end / content-end;
once any edit drifted, every later offset compounded the error. The line model grows
to the referenced line and never collapses, staying aligned with Monaco's actual
model. **This is a general detector bug (any candidate with this editing pattern
false-positives), not specific to one person.**

## Layer A — detector correctness (`EVAL-2`) — BUILT
1. **Faithful line/column reconstruction** in `replaySession`'s per-problem buffer
   (Monaco edit semantics: apply each insert/replace/delete by (startLine,startCol)-
   (endLine,endCol), growing to the referenced line, never clamping to content-end).
   Keeps the gap buffer as the storage engine for the perf budget. Proven correct
   against the real stream (occupations glitches 60→0; both flagged pastes → not foreign).
   *(P1 — commit `31d8101`)*
2. **Statement + sample I/O on-page sources** — `buildProblemContext`
   (`backend/src/evaluation.mjs`) threads `problem.statement` (raw + a
   markdown-stripped prose variant) and `problem.sampleTests[].input/expected` into
   `replaySession` as `onPageTexts`; `isForeign` checks them next to the stub sources.
   Kept separate from `extraSelfTexts` (the self-submission caveat does not apply to
   fixed contest content). *(P2 — commit `8d52031`)*
3. **Re-run evaluation** on affected contests after the fix (pure eval-time
   re-classification, no client redeploy) to clear historical false positives.
   *(deploy-time step — pending; scope is an owner decision, see below.)*
4. **Regression fixtures** — sanitized real-stream slices asserting the reconstruction
   matches ground truth AND the pastes are NOT foreign; plus genuine-external paste
   fixtures that MUST stay foreign, and on-page/self fixtures that must not.

## Layer B — info-level activity log + filter chip (`LOG-1`) — BUILT
- Classify activity entries into **info** (neutral: the normal paste marker, focus/
  blur, fullscreen, clipboard, cursor/keystroke bursts) vs **notable** (alerts,
  submissions, errors). `NEUTRAL_EVENT_TYPES` + `isInfoEntry` in
  `frontend/src/recordingTimeline.ts`; the predicate matches only `kind === "event"`
  neutral types, so alerts (a confirmed-foreign paste surfaces as an alert) and
  submissions are **never** reclassified to info.
- `showInfoActivities` added to `TimelineLogFilters` / `DEFAULT_LOG_FILTERS` (default
  **false**); `filterTimelineLog` hides info entries unless the flag is on; notable
  entries always show.
- A **"Show info activities"** `LogFilterChip` (default OFF) after the Submissions chip
  in `ActivityLogPanel` (`frontend/src/RecordingReview.tsx`). Raw telemetry stays
  logged — only prominence changes. *(LOG-1 — commit `fab50e3`)*

## Hardening (folded from the design-critique passes)
- **`glitches` is a tamper safety valve.** `evalRules/rules/replayTamper.mjs`: a
  submit-snapshot↔submission mismatch is only `telemetry_tampered` when the problem is
  **glitch-free**; a glitchy problem degrades to `coverage_gap`. So the line model keeps
  `glitch` firing on a *genuine* deletedLen-vs-range mismatch (tamper gate preserved),
  while spurious offset-drift glitches vanish — a faithful reconstruction makes tamper
  detection *more* correct, not less.
- **`foreign_paste` on a glitchy/unreliable problem → flagged, but DOWNGRADED + TAGGED**
  (owner decision 2026-06-26: "flag it, but decrease the severity and add a tag to make the
  not-so-sure visible in the UI"). The paste STAYS in `foreign_pastes` (recall preserved —
  never dropped), carries a `reconstruction_unreliable` tag, and the D2 rule emits it at one
  severity lower (`foreign_paste_after_away` critical→warning; `foreign_paste` warning→info)
  with the tag on the flag; the eval UI renders an "unverified / reconstruction-unreliable"
  marker. Because severity already drives tiering (`criticalFlags`/`warningFlags` counts,
  `weak = severity!=="critical"`), the downgrade automatically lightens the verdict weight
  without dropping the signal. This also closes the induce-glitch dodge (forging a glitch
  downgrades+tags a paste, it can never hide it). D15 `premeditated_clipboard` and D6
  cross-paste stay **ungated** on purpose — their evidence (entry-clipboard match;
  peer-submission match) is reconstruction-independent, so they remain full-severity backstops.
  *(Supersedes the earlier silent `unverified_pastes` side-list approach.)*
- **DoS hardening of the line model:** the grow-to-referenced-line is bounded by a small
  total line cap (forged/pathological line references clamp + glitch instead of growing),
  and the gap-buffer grow is de-spread — a single forged editor event cannot crash or
  super-linearly slow the eval batch. *(security-review fix)*

## Re-eval scope (owner decision 2026-06-26)
**Just the one contest that surfaced this** (the live intern-hire contest — exact slug in the
gitignored local note `local-notes/paste-detector-regression-data.md`). Not re-scoring other
historical contests for now (avoids churning already-reviewed past verdicts); can widen later
on request.

## Build outcome (resume state)
- **P1 (reconstruction core):** DONE — commit `31d8101`. Fuzz-validated (18k randomized
  edit steps; `applyChange` == `TextBuffer.apply` == reference, byte-for-byte).
- **P2 (on-page sources + glitch gate):** DONE — commit `8d52031`.
- **LOG-1 (info chip):** DONE — commit `fab50e3`.
- **Triple-lens review:** DONE (correctness / spec-conformance / security). Findings folded:
  reconstruction-growth DoS fixed; glitch-suppression made non-silent; on-page/markdown
  hardening; PII removed from this doc; sanitized real-slice regression fixtures committed.
- **Remaining:** staged deploy (backend + frontend) → re-run eval on the chosen scope →
  diff scorecards before/after (foreign_pastes D2, premeditatedClipboard D15, pasted/typed
  D1, cadence, submit-snapshot tamper) → confirm the reviewed candidate's flags clear.
- Tracking: BACKLOG `EVAL-2` + `LOG-1`; task #162. Real candidate/session/contest IDs +
  reconstruction pointers are in the gitignored `local-notes/paste-detector-regression-data.md`.
