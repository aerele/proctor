# Deployed-product E2E checklist — pre-live-test (2026-06-12)

Run against the DEPLOYED dev stack via Chromium :9222 AFTER the walkthrough fixes deploy.
Web `https://proctor-web-ej4cpz43iq-el.a.run.app` · API `https://proctor-api-ej4cpz43iq-el.a.run.app`
Existing test contest: `e2e-test-round-1` (access code 2V6CIQ — may change if W4 testing alters it; invigilator link in RESUME-ANCHOR §3).
Evidence: screenshots → `night-run/evidence/e2e-live/`. Every ✗ → fix → commit → redeploy → re-run the FULL candidate pass.

## A. Candidate (above all — must be flawless)
- [ ] Landing via `?contest=` + access code; bad code rejected cleanly
- [ ] Onboarding: details form, permissions-first stages, email validation
- [ ] Fullscreen gate: enforced BEFORE test starts; W5 — exit/re-enter cycles N times: alert shows on exit, clears on re-enter, NO looping/stuck/double overlays
- [ ] W1 layout: problems list front-and-center → click → editor IS the page; proctoring chrome collapsed; no distractions
- [ ] W2 cue: subtle indicator when normal; big bar ONLY on real issue (kill screen-share/camera to trigger; restore clears it)
- [ ] Editor: Monaco typing, language switch, stubs, autocomplete sane
- [ ] Run (visible tests) + Submit (hidden tests): verdicts correct, cooldown respected
- [ ] Multi-problem: switch problems, per-problem state survives
- [ ] **Keystroke/event data lands in backend**: after the session, pull session events via admin API — keystrokes, focus changes, fullscreen exits, paste events all present + timestamped
- [ ] Recording: screen chunks + camera stream uploaded; admin can play them back
- [ ] Timer + end-of-window behavior; finish/lock flow
- [ ] Refresh mid-test → resumes cleanly (no data loss, no re-onboarding)

## B. Admin (sanity + new features)
- [ ] W3 nav: contest filter ABOVE screen buttons; reorganized header reads clean; every screen reachable
- [ ] W4: set custom test code (happy path); clash vs active contest rejected with clear error; activation blocked on clash; regenerate works
- [ ] M0: datetime picker accepts typed entry
- [ ] Live stats reflect the candidate session in real time; live alerts fired for fullscreen exits
- [ ] Results: rank/per-problem/integrity for the test session
- [ ] Recording review: play the just-recorded session

## C. Invigilator (sanity)
- [ ] Tokenized portal loads; room stats; shared alerts visible per share-config; OTP/start-now path

## D. Cross-cutting
- [ ] No console errors on any page during the passes
- [ ] One FULL clean candidate pass (A top-to-bottom, zero ✗) before declaring done
