# Night Audit Report — Consolidated

- **Pinned range:** `acdba86..84b1c24` (48 commits — own-editor night run: keystroke capture, exec/Judge0, roster login, invigilator gate) plus working tree where noted
- **Audit time:** 2026-06-10 06:07 IST (00:37 UTC)
- **Auditors:** Secrets, PII/Privacy, Backend code review, Frontend review, Security
- **Scope note:** Commits after `84b1c24` (S3 invigilator portal UI, room dashboard, waiting room — `8257b95..19fb2f0`) are **not** covered here; they get a **delta-audit later**.
- **Totals (deduped):** 0 blocker / 11 major / 18 minor / 14 nit — 43 findings (44 raw; 1 cross-auditor duplicate merged)

---

## Blockers

None.

---

## Major

### M1. Real candidate identities + cheating verdicts tracked in repo — will leak on the planned morning push
- **File:** `/home/karthi/arogara/proctor/night-run/archive-2026-06-05-sshgate-v12/verdict-queue/`
- **Raised by:** PII/Privacy
- Archived contest-eval verdict JSONs (e.g. `verdict-queue/done/contest-eval_recurring_pair_tejukarthikeyan_...json`, `..._cemikshasherlin_...json`, plus `peer_copy_cluster` files for 727623bit112/116, gayu06072005, ghemachandaran) contain real students' HackerRank usernames coupled to adverse judgments ("conclusive per the rubric", "REAL (worth a supervised desk-check)"). Added at base commit `acdba86`, present at `84b1c24`. MORNING-NOTES.md records that "Karthi pushes one-shot in the morning" — pushing this history publishes accusatory inferences about identifiable third parties. **Purge these files (and ideally the history) before any push**, or keep the repo strictly private with that constraint documented.

### M2. Keystroke-level editor capture is not disclosed anywhere in the candidate-facing consent/disclosure UI
- **File:** `/home/karthi/arogara/proctor/frontend/src/studentCopy.ts` (also `App.tsx`, `MonacoEditor.tsx`, `editorEvents.ts`)
- **Raised by:** PII/Privacy
- Slice 1 captures every editor insert/delete with full inserted text (up to 2000 chars/event), plus cursor, selection, paste, focus, timestamped per keystroke, streamed to GCS NDJSON (`MonacoEditor.tsx` + `editorEvents.ts` → POST `/api/editor-events` → `ingestEditorEvents`, `backend/src/handler.mjs:860`). MORNING-NOTES proves byte-for-byte reconstruction of typed text. Yet the consent checkbox (`App.tsx:963`) covers only screen/camera/mic; `WhatIsRecordedPanel` (`App.tsx:~3410`) omits editor keystroke telemetry; `testRules()`/`integrityNotices()` never mention it. Per-keystroke timing is keystroke-dynamics (biometric-adjacent) data. Add an explicit "everything you type in the coding editor, including timing, is recorded" item to the panel, the rules, and the consent sentence.

### M3. Unauthenticated `/api/roster/lookup` is enumerable with no rate limiting — bulk PII harvest of up to 5000 students
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs` (~line 1380)
- **Raised by:** PII/Privacy + Security (merged duplicate)
- `rosterLookup` is public by design and returns full name, roll number, room, HackerRank username, and masked email for any matching unique ID. Roll numbers are sequential/guessable (the spec itself says so), `normalizeUniqueId` makes guessing easier (case/whitespace-insensitive), no per-IP/per-fingerprint throttle (exec limiter does not apply), no CAPTCHA/lockout, and distinct 404 codes (`not_on_roster` vs `roster_not_configured`) give a clean oracle. `publicExamConfig` additionally leaks `roster_required` and `unique_id_label`. The S2 spec (`docs/superpowers/specs/2026-06-09-s2-roster-login-design.md` §7) documents this as an accepted limitation and explicitly asked the audit to flag it — flagged: a script can harvest a college's roster from the public internet during a live event. Mitigations that preserve self-serve UX: Cloud Armor / LB rate limit on the path, coarse per-IP Firestore-counter throttle, a second weak factor (name initial / DOB), collapsing the two 404 codes, alerting on high miss rates. Exposure is otherwise well-minimized (masked email; unmapped columns like phone never returned — DOM-asserted in MORNING-NOTES).

### M4. Unauthenticated session start + enumerable unique-id allows impersonation and live-slot pre-emption
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs` (`startSession`, line 253; `acquireLiveSlot`, line 461)
- **Raised by:** Security
- `startSession` requires only the time window, a consent flag, and (with a roster) a `roster_unique_id`; no per-candidate credential exists since the entry passcode was removed. When the matched roster entry has `hackerrank_username` mapped and filled, the server forces that victim username (line 291) plus name/email/roll. Since unique-ids are enumerable, an attacker can start a session as any victim, and `acquireLiveSlot` claims the victim's live slot — forcing the real candidate into `pending_approval` until an admin manually approves or bypasses mid-exam. Consider binding start to a per-candidate secret or a short-lived server-issued token from the roster lookup.

### M5. "Clear roster" and re-uploads never delete roster PII — Firestore retains every roster version indefinitely
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs` (`adminSaveRoster` clear path ~1220; `rosterEntryId` comment ~1183)
- **Raised by:** PII/Privacy
- The clear path only writes `{configured:false}` on the meta doc; per-student entry docs (name, email, roll, room, plus ALL unmapped CSV columns — phone numbers etc.) remain in `proctor_roster` forever. Each re-upload writes a fresh versioned copy and "Old-version docs are left behind ... cleanup deliberately deferred". The admin button is labelled "Clear roster", implying deletion. A one-day exam accretes multiple full copies of up to 5000 students' PII with no deletion path and no Firestore TTL. Add a real delete (batched purge of cleared/stale versions, or TTL field on entries) and/or rename the control to reflect deactivation.

### M6. Initial clipboard snapshot captures pre-session clipboard content — outside the disclosed scope
- **File:** `/home/karthi/arogara/proctor/frontend/src/App.tsx` (lines 693–707; display-back at 3312–3328)
- **Raised by:** PII/Privacy
- At recording start the app calls `navigator.clipboard.readText()` and uploads the candidate's entire current clipboard verbatim as `initial_clipboard_snapshot` (→ POST `/api/review-file` → `recordReviewFile`, server-capped at 500 chars). Whatever the candidate last copied **before** the exam — a password, a personal message — is collected into the evidence bucket. Disclosure copy says "Copy/cut/paste **inside the session** is part of the integrity record"; a pre-session content snapshot is not that. Mitigations present: browser permission prompt gates the read, captured text is shown back to the candidate (`EntryReviewPanel`), 3-day GCS lifecycle bounds retention. Pre-existing code (initial commit, not tonight's range), but it is the named clipboard-entry-review surface: either disclose the snapshot explicitly pre-consent or replace content capture with length/hash only.

### M7. `execSubmit` stores raw client `body.language` instead of the validated string
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs` (line 838 at `84b1c24`)
- **Raised by:** Backend code review
- `session_id: sessionId, problem_id: problem.id, language: body.language,` — the endpoint validates `String(body.language || "")` via `Object.hasOwn(LANGUAGE_IDS, ...)` but persists the RAW client value into the Firestore submission doc. `["python"]` (or any value whose stringification equals a valid language) passes validation and lands verbatim in storage. This is exactly the store-raw-client-value bug class this same range fixed twice elsewhere (`3a8a688`; the adjacent `problem_id: problem.id`). One-word fix: store the validated `language` local. Worst case is contaminated admin-side analysis data, not RCE — but it violates the file's own stated invariant.

### M8. CSV formula injection in admin candidate-details and reviews exports
- **File:** `/home/karthi/arogara/proctor/frontend/src/App.tsx` (`csvField` 2311–2314; `buildDetailsCsv` 2327–2339; `buildReviewsCsv` 2318–2322)
- **Raised by:** Security
- `csvField` does RFC-4180 quote/comma/newline escaping only, not formula-injection neutralization. Exported name/email/roll_number/room are candidate-typed when no roster is active (`identityOf` only trims, `handler.mjs:297`), and `reviewer_name` is self-entered with no auth. A cell starting with `=`, `+`, `-`, `@`, tab, or CR is written verbatim into the CSV the admin opens in Excel/Sheets, executing the formula. Fix: prefix such cells with a leading apostrophe before RFC-4180 quoting.

### M9. Run/Submit API failures are swallowed — candidate gets zero feedback
- **File:** `/home/karthi/arogara/proctor/frontend/src/coding/CodingWorkspace.tsx` (`doRun`/`doSubmit`)
- **Raised by:** Frontend review
- `try { setRun(await execRun(...)); } finally { setBusy(""); }` — no catch. `api.ts request()` throws `ApiError` on any non-OK response, so the rejection becomes an unhandled promise rejection and the UI silently resets the button while showing stale prior results. This range added exactly the responses that hit this path: 429 `queue_full` (`0fe384c`), per-session rate limits (`4518755`), Judge0 engine-failure mapping (`9609a06`), 403 `exec_blocked_until_exam_started` (`84b1c24`). In an exam this guarantees hand-raises and invigilator load. Needs a catch rendering an inline neutral/retry banner (the `SUBMIT_TONE_CLASSES` "neutral" tone exists for exactly this framing).

### M10. FullscreenGate overlay is visual-only: background stays keyboard-operable, no modal semantics or focus management
- **File:** `/home/karthi/arogara/proctor/frontend/src/shell/FullscreenGate.tsx`
- **Raised by:** Frontend review
- The overlay is a fixed z-40 div; the form underneath stays mounted (intentionally) but is NOT inert. A keyboard user can Tab into the obscured controls and activate "Start proctoring" without ever entering fullscreen — `canStart` has no fullscreen condition, and since no `fullscreen_exit` event ever fires for someone who never entered, **no anomaly is recorded** (only the stage-1 bar betrays it to an in-room invigilator). Also missing: `role="dialog"`/`aria-modal`, initial focus on the Enter-fullscreen button, `aria-live` on the inline error. Fix: `inert` on covered content (or focus trap) + dialog semantics + initial focus.

### M11. AnomalyPanel appearance is not announced to assistive tech
- **File:** `/home/karthi/arogara/proctor/frontend/src/shell/AnomalyPanel.tsx`
- **Raised by:** Frontend review
- The panel is the critical mid-exam interruption surface — appears dynamically when the top bar vanishes — but the container has no `role="alert"`/`aria-live`, so screen-reader candidates are never notified that action is required before restore. The `fsError` message after a failed re-enter click is likewise unannounced; the lucide AlertTriangle is exposed without `aria-hidden`. Add `role="alert"` (or `aria-live="assertive"`) on the panel root, `aria-hidden` on the icon; consider moving focus to the panel on mount.

---

## Minor

### m1. No retention story for Firestore candidate data — asymmetric with the 3-day GCS lifecycle
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs` — **PII/Privacy**
- GCS evidence has a clean bucket-wide 3-day auto-delete (`backend/gcs-lifecycle.json`, `deploy-gcp.sh:55`). Firestore has none: `proctor_sessions` (name, email, roll, room, start_ip/current_ip, UA), `proctor_submissions` (full `source_code` + per-test results, `handler.mjs:837`), `proctor_alerts`, `proctor_roster` all persist indefinitely. Inverse wrinkle: keystroke-forensics NDJSON auto-deletes after 3 days, possibly shorter than the expected review window. Decide retention per collection; add Firestore TTL fields.

### m2. `getClientIp` trusts the FIRST x-forwarded-for hop — captured IPs are client-spoofable
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs:3207` — **PII/Privacy**
- Cloud Run's proxy appends the real client IP last; earlier XFF entries arrive from the client. A candidate can plant an arbitrary string (≤80 chars post-`normalizeIp`) as their recorded IP across the session doc, GCS ip-change events, and admin alerts — undermining forensics and defeating the planned S7 same-IP clustering. The in-range S7 spec (`docs/superpowers/specs/2026-06-09-s7-ip-report-design.md` §2–3) already locks a take-the-LAST-hop fix; not applied at `84b1c24`. Apply before relying on any IP report.

### m3. `requireAdmin` still uses a non-timing-safe password compare while guarding all candidate PII
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs:3080-3085` — **PII/Privacy**
- Compares `x-admin-password` with plain `!==`, while tonight's `requireInvigilator` and OTP paths correctly use `safeEqual` (3095–3106). The admin password gates signed recording URLs, raw emails, IPs, roster upload, submission source. Pre-existing; two-line fix.

### m4. Room-gate OTP brute-force budget is per-session and multipliable
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs:2864` — **Security**
- `GATE_ATTEMPT_LIMIT` of 20 is per session-doc; with no roster an attacker spins up many distinct-username sessions, each getting 20 attempts against the shared 6-digit room OTP. Impact low (only lets a candidate start slightly early; OTP is a plaintext coordination code by design). Consider a per-room global attempt counter as well.

### m5. `hackerrank_username` override relaxation weakens evidence-to-submission binding
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs:287-292` — **Security**
- The username keeps the candidate-typed value when the roster column is mapped-but-blank, and always when unmapped. Since it is the key joining proctoring evidence to contest submissions and the live-slot lock, a roster-verified candidate can attach their session to an arbitrary handle whenever their HR cell is blank/unmapped. Documented deliberate exception, already on the morning-review list — weigh requiring the HR-username mapping be populated when a roster is active.

### m6. exec endpoints duplicate ~30 lines of validation + error-mapping that can drift
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs` — **Backend code review**
- `execRun`/`execSubmit` repeat ownership gate → `requireExamStarted` → limiter → problem/language/source validation → enqueue → identical catch (cooldown restore, `QueueFullError`→`queueFull()`, `.status`→`judgeUnavailable()`), differing only by `lastRunMs` vs `lastSubmitMs`. A shared `validateExecBody(body)` + gated-run wrapper removes the drift risk.

### m7. Fake Firestore/Storage/req/res copy-pasted into 4 new test files; drift has already started
- **File:** `/home/karthi/arogara/proctor/backend/test/` — **Backend code review**
- `editorEvents.test.mjs`, `exec.test.mjs`, `invigilator.test.mjs`, `roster.test.mjs` each carry a ~160-line verbatim copy of the fakes (~6 copies repo-wide); exec/editorEvents copies carry comments the invigilator/roster copies lack. The "(NO helpers.mjs)" convention is deliberate — surface for morning list rather than auto-fix.

### m8. Empty `events:[]` batch on `/api/editor-events` writes a junk one-newline GCS object
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs` — **Backend code review**
- `ingestEditorEvents` rejects only non-arrays; an empty array passes and `putJsonl` writes a single `"\n"` object under the session prefix, returning `{ok:true, stored:0}`. Reject zero-length batches with the existing 400 or return early.

### m9. Missing JUDGE0_API_KEY/AUTH_TOKEN is silent — inconsistent with the file's closed-by-default warn pattern
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs` — **Backend code review**
- With the credential unset, every exec request surfaces only as a generic 503 `judge_unavailable`. The same file warns once for analogous misconfigurations (`warnedMissingApiKey`, `warnedMissingInvigilatorPassword`). Add a one-time `console.warn` (or fail fast in `judge0()`).

### m10. Active-contest-slug derivation triplicated across the three invigilator endpoints
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs` — **Backend code review**
- `settings?.contest_slug || contestSlugFromUrl(settings?.contest_url) || ""` is inlined at four sites with the WHY comment at only one. Extract `activeContestSlug(settings)`.

### m11. `invigilatorOverview` ignores admin-configured `settings.rooms` and reads full session docs
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs` — **Backend code review**
- Room picker is built solely from up to 2000 full session-doc reads; a room with zero sessions is invisible — which matters for the release-code-on-the-board-before-login flow. A `.select("room")` projection would also cut read cost. Possibly a deliberate scope cut — morning-review item.

### m12. EventBatcher has no unmount/identity cleanup — last-seconds editor events ride a dangling setTimeout
- **File:** `/home/karthi/arogara/proctor/frontend/src/coding/CodingWorkspace.tsx` — **Frontend review**
- Nothing calls `dispose()`. On End-test unmount, up to 4s/40 events of final editor forensics sit in a buffer whose only flush path fires after unmount — by which time the session may be ended server-side (POST rejected); on tab close they are lost outright. Add `useEffect(() => () => batcher.dispose(), [batcher])` with a synchronous final flush.

### m13. `examReleased` hardcoded `true` while `84b1c24` backend blocks exec until exam_started
- **File:** `/home/karthi/arogara/proctor/frontend/src/App.tsx` — **Frontend review**
- With `room_gate_enabled`, `/api/exec/run|submit` 403s until `exam_started_at` (handler.mjs ~2907) and the candidate poll/unlock endpoints have no frontend caller at this commit. A gated candidate sees stage "4 IN EXAM", the full workspace, and silently failing Run/Submit (compounded by M9). Acceptable only while `room_gate_enabled` stays off until the S3 frontend lands (note: S3 commits exist post-pin — verify in delta-audit).

### m14. Top-bar status indicators lack accessible names
- **File:** `/home/karthi/arogara/proctor/frontend/src/shell/ExamTopBar.tsx` — **Frontend review**
- The flag chip reads "black flag 2" to screen readers with no context (needs e.g. aria-label "2 anomaly episodes this session"); the pulsing REC dot spans aren't `aria-hidden`; the bar could carry `role="status"` so stage transitions are perceivable non-visually.

### m15. RoomField: "Other" input programmatically unlabeled; async rooms arrival can desync select display from `form.room`
- **File:** `/home/karthi/arogara/proctor/frontend/src/App.tsx` — **Frontend review**
- A single `<label>` wraps both controls (associates only with the first), leaving the free-text input placeholder-only for AT. And `otherMode` is initialized once from mount-time props: if rooms arrive after the candidate typed a room, the select displays the placeholder while `form.room` silently holds the typed text. Derive `otherMode` from `value !== "" && !rooms.includes(value)` per render.

### m16. IdentityLookupPanel: Enter key does nothing on the unique-ID step; lookup error not announced
- **File:** `/home/karthi/arogara/proctor/frontend/src/App.tsx` — **Frontend review**
- No `<form>` wrapper or onKeyDown — Enter in the ID field is a no-op; the not-found error div has no `aria-live`. Same pattern worth applying to the details form's Start flow.

### m17. Admin Settings: saving without "Load current" silently wipes configured rooms
- **File:** `/home/karthi/arogara/proctor/frontend/src/App.tsx` — **Frontend review**
- Settings are not auto-loaded on tab open; `saveSettings` always sends `rooms: parseRosterInput(roomsText)` where `roomsText` initializes to `""`. A time-tweak save clears the room list (and the student dropdown). Blind-save hazard pre-exists for contest_url/start/end; the rooms field joins it. Auto-load on tab open, or disable Save until loaded.

### m18. Test gap: the useExamShell hook layer is untested; EventBatcher time-based flush untested
- **File:** `/home/karthi/arogara/proctor/frontend/src/shell/useExamShell.ts` — **Frontend review**
- Pure-logic coverage is exemplary, but the hook carries real logic with none under test: once-per-session rehydration ordering, stage-5 expected-exit + `clearStoredShellState` sequencing, buffer flush on sessionId arrival, listener cleanup — browser-verified only. `editorEvents.test.ts` covers maxSize but not the maxMs timer flush or `dispose()`. A small renderHook + fake-timers suite would lock the StrictMode/cleanup claims the comments make.

---

## Nit

### n1. Dev Cloud Run URLs + GCP project number committed in night-run docs (informational, not a secret)
- **File:** `/home/karthi/arogara/proctor/night-run/NIGHT-LOG.md` — **Secrets**
- Live dev backend/frontend URLs and project number are committed; the backend has the metered Judge0 key baked as env. URLs/project numbers are not secrets, and the metered-key burn risk is already mitigated in-range (rate limiting, queue_full 429, no-retry-after-submit, phase-gated lanes — `4518755`, `0fe384c`, `dcebd0a`, `9609a06`, `13a15a1`). No action required.

### n2. Cookie/storage audit uploads `document.cookie` verbatim to the evidence store
- **File:** `/home/karthi/arogara/proctor/frontend/src/App.tsx:731-741` — **PII/Privacy**
- Benign today (no sensitive cookies on the origin), but a future token cookie would be exfiltrated into GCS evidence readable via admin signed URLs. Prefer cookie names/length only. Pre-existing code.

### n3. Invigilator surface is least-privilege at `84b1c24`; two accepted risks correctly queued for morning review
- **File:** `/home/karthi/arogara/proctor/docs/superpowers/specs/2026-06-09-s3-invigilator-portal-design.md` — **PII/Privacy** (positive with caveats)
- Implemented endpoints (`handler.mjs:2731-2840`) expose only room labels, gate state, room OTP — no names/emails/IPs/media — separate password, timing-safe compares, closed-by-default, allow-list tested (`backend/test/invigilator.test.mjs`). To ratify in morning review: (1) room OTP stored/re-displayed in PLAINTEXT (documented, bounded by the 20-attempt cap); (2) the planned room dashboard will show roll numbers to invigilators (spec §11.4 asks for confirmation).

### n4. Dead `if (!languageId)` re-check after `Object.hasOwn`, in both exec endpoints
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs` — **Backend code review**
- Every `LANGUAGE_IDS` value is a truthy number, so the second check is unreachable. Delete or fold.

### n5. `requireGateEnabledSettings` calls `badRequest()` as a bare statement
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs` — **Backend code review**
- Works only because `badRequest` throws; it's the sole bare-call site and reads like a forgotten `throw`. Use the established `return badRequest(...)` idiom or `throw httpError(400, ...)`.

### n6. Room-gate helpers: verbose null-guard and duplicated gate-doc construction
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs` — **Backend code review**
- `gateRoomKey`'s ternary is just `room ?? ""`; release/open endpoints `sanitizeRoom` twice per request and build near-identical ~10-line gate docs — a small shared builder prevents drift.

### n7. `EDITOR_EVENTS_COLLECTION` is named "collection" but is a GCS path segment
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs` — **Backend code review**
- Reads like a Firestore collection; `EDITOR_EVENTS_PREFIX` would not need the inline disclaimer.

### n8. `execQueue.stats()` has no production caller
- **File:** `/home/karthi/arogara/proctor/backend/src/execQueue.mjs` — **Backend code review**
- Test-only export today (YAGNI). Keep only if observability wiring is imminent; otherwise drop or wire into a debug endpoint.

### n9. `sessionRoomGate` response shape drifts across branches
- **File:** `/home/karthi/arogara/proctor/backend/src/handler.mjs` — **Backend code review**
- Waiting branch returns `{gate_enabled, exam_started:false, room}`; started/disabled branches return `{gate_enabled, exam_started, exam_started_at}`. Uniform null-filled shape is cheaper for clients.

### n10. Ref writes during render (`shellTapRef`, useExamShell's statusRef/sessionIdRef/addEventRef)
- **File:** `/home/karthi/arogara/proctor/frontend/src/App.tsx` / `useExamShell.ts` — **Frontend review**
- Latest-ref pattern is benign here but violates render purity; move assignments into `useEffect`/`useLayoutEffect`.

### n11. `stageHint`'s locked branch is unreachable from the UI
- **File:** `/home/karthi/arogara/proctor/frontend/src/shell/examShell.ts` — **Frontend review**
- `ExamShellChrome` only renders the hint when `topBarVisible()` is true, which is false whenever gate === "locked"; the branch exists only to satisfy its own unit test. Delete or document. Related edge: during status "ending", a manual fullscreen exit isn't an anomaly, so the gate overlay covers the upload-progress UI with "Enter fullscreen to begin" copy.

### n12. `lastCursor` is a render-scope mutable variable
- **File:** `/home/karthi/arogara/proctor/frontend/src/coding/MonacoEditor.tsx` — **Frontend review**
- Works only because Monaco's onMount fires once and listeners close over the first render's binding. Use a `useRef` (or a local inside `handleMount`). Same mount-time capture applies to the `onEvent` prop.

### n13. Demo `startSession` roster override drifts from the spec-2.5 blank-cell rule; `studentCopy.test.ts` misplaced
- **File:** `/home/karthi/arogara/proctor/frontend/src/api.ts` — **Frontend review**
- Demo-mode parity uses `rosterName || form.name.trim()` and never overrides roll_number/email, disagreeing with prod exactly on the fidelity case `59432e4` targeted. Demo-only, cosmetic. Also: `studentCopy.test.ts` lives in `src/coding/` while the module is `src/studentCopy.ts` — colocate.

### n14. Admin password may be baked into the client bundle via the build env var
- **File:** `/home/karthi/arogara/proctor/frontend/src/api.ts:60` — **Security**
- `VITE_ADMIN_PASSWORD` is compiled into shipped JS; if set to the backend `ADMIN_PASSWORD` it is readable by anyone loading the admin page. Real authz is server-side (`requireAdmin`) and a hash-only unlock mode exists (`VITE_ADMIN_PASSWORD_HASH`, `App.tsx:1388`). Deployment guidance: use the hash mode. Pre-existing, outside the pinned diff.

---

## Clean areas — what was checked and found fine

- **Secrets (gitleaks v8.30.0):** full-history scan (80 commits), pinned-range scan (48 commits), and `--no-git` working-tree scan — **no leaks in anything tracked**. The 5 working-tree findings are all in gitignored, untracked, mode-0600 files (`.env.deploy.local`, `monitoring/.data/judge0.env`, `spike/proctor-extension.pem`), each confirmed via `git check-ignore -v`. The Judge0 RapidAPI key value, ADMIN_PASSWORD, ALERTS_INGEST_API_KEY, WORKER_TOKEN, and the .pem body have **never entered git history** (pickaxe across all refs: zero hits each). `.env.deploy.example` verified placeholders-only at `84b1c24`. Every credential-like string added in the range triaged: env-var references, obvious test fixtures, spec prose, or package-lock integrity hashes. Four highest-risk evidence PNGs visually checked: no credentials, synthetic roster names only.
- **PII scanner (pii-audit/scan.sh):** gitleaks clean on working tree and history; wordlist hits were mostly Karthi's own docs (the one real hit became M1). Consent is enforced server-side (`consent_accepted` required at `/api/session/start`); the pre-start "What is recorded" panel is a strong disclosure pattern (just needs the M2/M6 items added). Editor-events ingestion is well-hardened (allow-listed fields, caps, session-token gate). Roster public responses are genuinely minimal (masked email; unmapped columns never returned — DOM-asserted). Submissions source code is write-only (no read endpoint; hidden tests never echoed per §9 lock). GCS evidence has a clean 3-day lifecycle.
- **Backend quality:** all four new/changed modules read at `84b1c24`; full suite run in a throwaway worktree: **269/269 pass**. The adapter/queue split is a textbook testing seam; the billing-safety invariant (`retryable:false` once a submit POST succeeds) is enforced at three layers and proven at unit and composition level; error handling consistent (httpError + machine-readable `retry_after_seconds`); versioned-replace roster store and conditional cooldown-restore race handling both clean, with tests targeting the exact races.
- **Frontend architecture:** pure-logic modules (`examShell.ts`, `editorEvents.ts`, `parseRoster.ts`, `studentCopy.ts`, `submitVerdict.ts`) cleanly separated from one thin hook and thin components; single addEvent funnel avoids double classification; topBarReducer + per-session persistence exemplarily unit-tested (episode dedupe, restore preconditions, tamper-proof deserialization); StrictMode on and respected.
- **Invigilator endpoints at `84b1c24`:** exemplary least privilege (see n3).

---

## Recommended-fix shortlist (severity × effort)

| # | Fix | Finding | Effort |
|---|-----|---------|--------|
| 1 | **Purge `night-run/archive-2026-06-05-sshgate-v12/verdict-queue/` (files + ideally history) BEFORE the morning push** — this is the one push-blocking item | M1 | Small, urgent |
| 2 | Store validated `language` local in `execSubmit` (one word) | M7 | Trivial |
| 3 | Add `role="alert"` + `aria-hidden` to AnomalyPanel | M11 | Trivial |
| 4 | `safeEqual` in `requireAdmin` | m3 | 2 lines |
| 5 | Catch in `doRun`/`doSubmit` → inline neutral/retry banner | M9 | Small |
| 6 | Add keystroke-capture item to consent sentence, WhatIsRecordedPanel, and rules; while there, disclose the pre-session clipboard snapshot (or switch it to length/hash) | M2, M6 | Small (copy + one capture change) |
| 7 | `csvField`: apostrophe-prefix formula-leading cells | M8 | Small |
| 8 | FullscreenGate: `inert` background + dialog semantics + initial focus | M10 | Small-medium |
| 9 | `getClientIp` → last XFF hop (fix already locked in S7 spec) | m2 | Small |
| 10 | Rate-limit / second-factor / collapsed-404 on `/api/roster/lookup`; weigh token-binding session start at the same time | M3, M4 | Medium (design call — morning discussion) |
| 11 | Real roster deletion (batched purge or Firestore TTL) + rename "Clear roster"; fold into a holistic Firestore retention decision | M5, m1 | Medium |
| 12 | Small backend hygiene batch: reject empty events[], warn-once on missing Judge0 credential, `activeContestSlug()` helper, dead languageId check, bare `badRequest()` | m8, m9, m10, n4, n5 | Small batch |
| 13 | EventBatcher dispose-on-unmount + guard/track `examReleased` vs landed room gate | m12, m13 | Small |
| 14 | A11y/labeling batch: ExamTopBar names, RoomField, IdentityLookupPanel Enter+aria-live, admin auto-load settings | m14–m17 | Small-medium batch |

**Morning-discussion items (decisions, not fixes):** M3/M4 lookup hardening approach; m5 HR-username mapping requirement; m7 test-fixture no-helpers convention; m11 invigilator overview rooms source; n3 plaintext OTP + roll-number exposure ratification; m1 retention policy.
