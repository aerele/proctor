# Morning summary — overnight run for the 2026-06-12 live test

**TL;DR: GO.** The product is deployed, exhaustively browser-tested, retested after fixes, and passed a
triple review (code **GO** · UX **GO** · security/PII **GO**). Both services run **rev 00010** with
`min-instances=1` already set. Keystroke/event capture is proven with hard numbers. Zero blockers.

**Stack:** web `https://proctor-web-ej4cpz43iq-el.a.run.app` · api `https://proctor-api-ej4cpz43iq-el.a.run.app`
**Ops 1-pager:** `docs/EXAM-DAY-OPS.md` (updated tonight). **All work committed locally — NOT pushed (PII scrub gate).**

---

## 1. What happened tonight (in your /goal order)

1. **Walkthrough fixes (M0, W1–W5)** — all shipped (`b43fd5a`, `2fbe4f8`):
   - W1 the coding workspace IS the page — slim 40px strip, collapsible proctoring panel, floating camera dock
   - W2 flipped cue — subtle when healthy, big red banner only on a real issue
   - W5 fullscreen-alert machine fixed — the real "looping" trap was a stale ack-phrase that made restore impossible; plus the overlay now tells live truth
   - W3 admin nav — 6 grouped tabs + contest scope picker top-right; W4 custom test code with open-contest uniqueness; M0 typed datetime entry
2. **Deployed** and **3. browser-E2E'd the deployed product** (Chromium :9222), twice:
   - Full pass on rev 00007 → verdict SHIP-WITH-NOTES, 10 findings (3 HIGH) → all fixed same night (`5ef8f9a`) → **retest on rev 00008: ALL SIX ITEMS PASS** including a clean end-to-end candidate run (100/100, zero unexpected anything)
   - **Keystroke deliverable proven:** 1,094 editor events (504 per-char inserts w/ ms timestamps), 183 shell events, 97 heartbeats on the first run; 551/98/55 on the retest run — all verified landing in the backend
   - Biggest catch: **recording chunks were being OVERWRITTEN on every recording restart** (F1) — fixed with three independent guards; retest showed zero overwrites across 4 stints. Then two deeper recorder hazards found & fixed: no upload retry (RT-1) and a chain-poison where one hard failure silently killed all later screen uploads (RT-4)
4. **Triple review** — three independent reviewers, three **GO**s:
   - **Security/PII:** no blockers/highs; its one MED (unbounded chunk_index could corrupt own evidence) fixed + deployed (`8349d4c`)
   - **Code:** no blockers; its one HIGH (access-code resolver `limit(2)` could 404 the live code after W4) fixed + deployed (`4c565f9`); pre-flight verified: `2V6CIQ` resolves
   - **UX:** no blockers; its three pre-doors-open HIGHs fixed + deployed (`b17e8bf`): the details page was still showing **HackerRank-era rules and a consent that omitted keystroke recording** (now own-editor copy + full consent), the camera dock covered submit verdicts, and the share-drop recovery copy was contradictory
   - All MEDs/LOWs triaged into `PRODUCT-BACKLOG.md` (code/UX/security post-exam waves)
5. **Docs** — all feature pages + README + deploy + ops runbook refreshed to tonight's UI, with fresh screenshots (`639d65e`)

**Revisions tonight:** 00006 → 00010 (api: walkthrough → fix-wave → M1 cap → H1 resolver; web: walkthrough → fix-wave → RT-1+RT-4 → UX batch). Suites at HEAD: backend **724/724**, frontend **687/687**, builds clean, bundle leak-checked every deploy.

## 2. ⚠️ Decide before doors open (5 minutes)

1. **Set the real contest's `fullscreen_reentry_seconds` to 45–60** (default 20s). The 38-char phrase + re-enter
   within 20s is near-impossible — compliant students WILL get locked. This is a per-contest setting; E2E
   verified everything else about the ladder works. *(The one config item I deliberately left for you — changing
   the default alters when violations report server-side.)*
2. **Distribute full `?contest=<slug>` links** — not the bare domain (legacy shell can swallow the code box).
3. **Invigilators must hard-refresh** their portals once (stale bundles send the old unlock payload).
4. **Pick the invigilator alert-sharing set** (admin → alerts → "Share with invigilator", default ALL OFF).
5. Custom test codes are constrained to 6 chars A-Z/2-9 (`KEC226` ✓, `KEC2026` ✗ — has a 0). Slash-dates parse
   day-first. Draft contests may share a code — activation re-checks.

## 3. Things you may notice (all by design / on the morning list)

- 3rd fullscreen exit escalates instantly with no countdown (designed ladder, reads abrupt); after an unlock,
  one "I have fixed this" click is still needed once healthy (preserves the episode telemetry)
- ELAPSED counts from session registration (includes room-gate waiting); invigilator EXAM column shows "—"
  when the room gate is off; locked screen no longer stacks the red banner
- Anchor §1b has the full judgment-call list (W3 nav grouping, scoped exam-time chips, etc.)
- Not deployed/not created (unchanged from before): video-worker (raw-chunk playback works), Cloud Scheduler
  retention job (manual sweep works), CORS still `*`

## 4. State of the test stack

- Contest `e2e-test-round-1` (code `2V6CIQ`) window ends **today 21:30 IST**; TEC002/TEC003 sessions ended
  clean; TEC001 has 2 stale pending-approval rows (cosmetic); W4 test drafts archived
- `min-instances=1` set on both services (cold-start protection — remember to drop to 0 after the exam)
- Usage windows survived: rode block 1 to 93%, slept through the reset, block 2 at ~45% with everything done

## 5. Pointers

- **Ledger of your walkthrough comments:** `night-run/WALKTHROUGH-FIXES.md` (all ✅)
- **E2E evidence:** `night-run/evidence/e2e-live/` (46 screenshots + FINDINGS.md with the retest section)
- **Backlog (incl. tonight's triaged review items):** `PRODUCT-BACKLOG.md`
- **Paused:** architecture decomposition at B2 (untouched tonight, still green underneath)
- **OMR stretch (F2/F2.1): design + P1 BUILT** (after everything above was locked):
  - Design doc `docs/superpowers/plans/2026-06-12-omr-overlay-detection.md` — 16 fiducial markers,
    review-time local CV (no cloud billing), focus-correlation severity, honest threat model (catches
    ordinary overlay windows incl. no-focus-change; does NOT catch capture-excluded tools)
  - **P1 committed (`4e0b89c`), NOT deployed**: marker layer behind a contest flag (default OFF —
    flag-off responses pinned BYTE-identical in tests) + `marker_layout`/`camera_pip` events.
    Backend 740/740, frontend 708/708.
  - **P2 (detection) + P3 (correlation) wait on your 4 calls** — design doc §12: interior-marker
    visibility, review-time vs real-time, alert vs review-tag severity, flag-only v1. Markers not yet
    eyeballed visually (unit-verified only) — flag it on in demo/local and judge OQ1 when you're up.
