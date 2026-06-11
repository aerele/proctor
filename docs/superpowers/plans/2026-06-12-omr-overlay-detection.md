# OMR screen markers + overlay-occlusion detection (2026-06-12) — DESIGN

> **Status: DESIGN ONLY — nothing built.** Owner spec: `TODO-admin-polish.md` F2 + F2.1;
> distilled in `PRODUCT-BACKLOG.md` § "Maybe-soon" (task #62). Karthi: candidate for the
> next stretch goal, **only after the live flow is verified rock-solid**. Feature flag
> default **OFF** — a deployment with the flag off must behave byte-identically to today.

## 1. Summary

Render small, visually quiet OMR-style fiducial markers at the edges (+ a few interior
points) of the candidate's exam screen. They ride into the screen recording for free.
A **local, dependency-free CV pass over the recorded webm chunks** — running in the
**admin review browser** (primary home) — checks each sampled frame for the expected
markers. Markers missing at known positions while the exam view is otherwise on screen
= something is **drawn over the exam** (helper window, AI-assistant overlay, PiP video,
notes window). Findings become timestamped, jump-to-able episodes; correlation with the
session's focus/visibility telemetry splits them into the high-signal
**"occlusion with no focus change" critical alert** vs. a low-severity
**"occlusion around a focus excursion" review tag**.

Three phases, each independently shippable: P1 markers-only (recorded, zero detection),
P2 detection + review surfacing, P3 correlation + severity.

## 2. Threat model — what this honestly catches and doesn't

The recording is a capture of the **entire monitor** (the recorder refuses tab/window
surfaces — `InvalidShareSurfaceError` in `frontend/src/useProctorRecorder.ts`), and
fullscreen is enforced, so during a healthy exam the page edge ≈ the screen edge and
**anything stacked above the exam window appears in the recording and occludes markers**.

**CATCHES (the design target):**
- **An ordinary window placed over part of the exam without taking focus** — a browser
  window with ChatGPT arranged over a corner, a notes app, a messenger, a floating
  video/PiP player. The candidate *reads* it without clicking → **no blur/visibility
  event fires** → today this is completely invisible to telemetry. Marker occlusion is
  the only screen-side signal for it. This is the F2.1 "overlay tool for sure" case.
- **Always-on-top helper/overlay tools that render normally** (screen annotators,
  sticky-note widgets, most "answer overlay" tools that do not use capture exclusion).
- **Partial covers hugging the edges** — the owner's observation that cheat tools are
  small and hug edges is why the edge ring is dense (§4).
- **Focus-switch covers** too (window opened over the exam *with* a click) — caught and
  classified lower severity because focus telemetry already saw it (P3 rules, §7.5).

**DOES NOT CATCH (say it plainly):**
- **Capture-excluded overlays.** Windows `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`
  and macOS `sharingType = .none` let a window draw on the physical screen while being
  invisible to `getDisplayMedia`. Purpose-built "invisible to proctoring" AI overlays use
  exactly this. **Markers stay visible in the recording; this feature is blind to them.**
  Counter-signals are behavioral: the F10.1 camera recording (gaze repeatedly parked on
  one screen region with no corresponding screen activity), keystroke/editor analytics
  (paste-shaped bursts with no clipboard event). Document this in the reviewer UI copy so
  nobody treats "no occlusion findings" as exoneration.
- **A second device** (phone/tablet/second laptop). Out of scope — IP report, camera
  recording and the 2nd-device session flow are the existing counters.
- **A second monitor.** The share is one monitor; an overlay parked on a non-shared
  display never appears. (Existing platform limitation, unchanged by this feature.)
- **Small overlays threaded between markers.** Detection samples discrete points; a
  ~200×120 px window positioned wholly inside a marker-free gap evades. Edge spacing
  (§4) keeps such gaps small along the borders, but the interior is sparsely covered —
  the interior-marker density/visibility trade-off is Open Question 1.
- **Alt-tab "flash" cheating** (switch to helper app, switch back). Markers vanish
  *entirely* (the exam isn't on screen at all) — that is a frame-level "unanchored"
  state, not an occlusion, and is already covered by visibility/blur telemetry + the
  switch-away alert ladder. Detection must not double-report it (§7.4).

**Built-in false-positive sources the pipeline must absorb** (§7.4): OS notification
toasts over a corner; the cursor parking on a marker; Chrome's own "you are sharing your
screen" pill (can sit over a bottom-center marker for the whole session); the candidate's
camera **PiP pop-out** (a real OS always-on-top window — our own feature); Monaco
suggest/parameter-hint popups reaching an interior marker; first-frame-of-chunk keyframe
quality; recording gaps.

## 3. Current-system facts the design builds on (verified in code)

- **Recorder** (`frontend/src/useProctorRecorder.ts` + `backend/src/handler.mjs`
  `uploadConfig`): entire-monitor share, `max_width: 960`, `max_frame_rate: 4`,
  `video_bits_per_second: 400_000` (+180k media, +32k audio), 30 s chunks, fresh
  MediaRecorder per chunk (→ every chunk starts on a keyframe), VP9 → VP8 → webm
  fallback (`getSupportedMimeType`). Mostly-static screens converge to high quality
  within a few inter frames at this bitrate.
- **Telemetry**: client events (`window_blur/focus`, `visibility_change`,
  `switch_away_episode`, fullscreen state via heartbeat…) batch to `/api/events`,
  stored as JSONL under `…/events/` in GCS; the review UI reads them via
  `GET /api/admin/session-events` (`adminSessionEvents`, handler.mjs ~3184).
- **Alert taxonomy** (handler.mjs ~5190–5520): catalog `DEFAULT_PROCTOR_ALERT_SETTINGS`
  (per-type `enabled`/`severity`/`show_to_invigilator`), severities
  `critical|warning|info`, idempotent upsert id
  `proctor:<type>:<username_norm>:<contest_slug>:<dedupe>` via `upsertProctorAlert`,
  deep-link through `video_key`. Verdict workflow on alert docs already exists.
- **Review UI** (`frontend/src/RecordingReview.tsx` + `recordingPlaylist.ts` +
  `recordingTimeline.ts`): chunk playlist from signed URLs, scrubber with **alert
  severity dots on the track**, a subdued **event lane**, the F6.7 **activity log**
  with click-to-jump. New alert types surface on the timeline with zero UI work once
  the alert docs exist.
- **Flag plumbing precedent**: `camera_recording` — settings-doc normalizer
  (`normalizeCameraRecording`) + contest-snapshot override
  (`cameraRecordingConfigFor(contest, settings)`) + ride-along on exam-config/start/
  heartbeat. `screen_markers` mirrors this shape exactly.
- **Guards that bind this design**: `routesAuthLint.test.mjs` (admin route ⇒
  `requireAdmin(req)` is statement #1), `scopingLint` (no new raw
  `.where("contest_slug")` — use `scopedQuery`/doc-id reads), canary test pins the
  no-param `/api/exam-config` key set, `uiStrings.test.ts` bans rendered "username".

## 4. Marker design

### 4.1 Pattern

A **luminance-only 2×2 checkerboard fiducial** ("X-corner") inside a 1-cell quiet
border. No ArUco/AprilTag library — because every marker's position is **known a
priori**, detection is *verification at fixed ROIs*, not *search*, so a full fiducial
dictionary buys nothing. (Wrapper-over-fork rule is moot: the recommendation is **no
third-party CV dependency at all**; the detector is ~150 lines of pure TS over
`ImageData`. If we ever needed pose/search, js-aruco2 would be wrapped, never forked.)

Why this pattern survives VP8/VP9 at our settings:
- **Luma, not chroma.** 4:2:0 subsampling halves color resolution; the checker is
  grayscale so it lives entirely in the luma plane.
- **Quadrant-mean test, not edge test.** The deblocking filter smears edges; comparing
  the *mean* luminance of each quadrant (≥5×5 captured px each) is robust to blur and
  ringing.
- **Static content converges.** At 400–580 kbps / 960 px / 4 fps, inter frames of a
  static region quickly reach near-lossless quality; the worst frame is the first
  (keyframe) of each 30 s chunk — sampling prefers mid-chunk frames (§7.2).
- **Polarity signature.** The checker's diagonal-pair relationship
  (`q00≈q11`, `q01≈q10`, `mean(q00,q11) − mean(q01,q10) ≥ threshold`) is rare in UI
  content at an exact known position, so present/absent classification is reliable
  without template correlation. (Optionally alternate polarity by marker parity as an
  orientation sanity check.)

### 4.2 Size + contrast math (the detectability budget)

Capture scale `s = track_width / screen_device_width` (track width ≤ 960):

| Screen (device px) | dpr | s | 24 CSS-px marker → captured px |
|---|---|---|---|
| 1366×768 | 1 | 0.70 | 17 px |
| 1920×1080 | 1 | 0.50 | 12 px |
| 2880×1800 (Mac) | 2 | 0.33 | 16 px (24 CSS = 48 device px) |
| 3840×2160 | 1 | 0.25 | 6 px — **too small** |

Target: **≥ 10 captured px per marker side** (≥ 5 px per quadrant). So marker CSS size
is **adaptive**: `sizeCss = max(24, ceil(10 / (s × dpr)) )` computed at mount from
`window.screen.width × devicePixelRatio` and the configured track width. The candidate
reports the *actual* `track.getSettings()` + layout in a telemetry event (§5.3) so the
detector never guesses.

Contrast: quantization at high QP can erase ΔY ≲ 15/255. Floor: **ΔY ≥ 40** between
checker quadrant means as rendered. Acceptance threshold detector-side is adaptive
(≥ 0.35 × expected ΔY) to tolerate encoder loss, gamma and font-smoothing variance.

Unobtrusiveness (W1: the workspace IS the page — do not pollute it):
- Markers are **tone-on-tone**, matched to what they sit on: dark-on-dark variants over
  the slim `ExamTopBar` strip and the page's dark chrome (e.g. `#161616`/`#3c3c3c`),
  light-on-light over light page margins (`#ffffff`/`#d4d4d4`). ΔY ≈ 40 reads as a
  faint decorative dot pattern, similar to a subtle texture; at 24 px it is smaller
  than a favicon.
- Edge/corner markers sit in viewport margins/chrome, not over content. Interior
  markers are the only ones that touch the workspace area — kept to 2–3, lowest
  acceptable contrast, positions chosen over stable chrome (§4.3). Their visibility
  is **Open Question 1**.

### 4.3 Placement map (16 markers: 12 edge + 1 strip + 3 interior)

Viewport-fixed (`position: fixed`), so in fullscreen they are screen positions:

```
TL ───── T⅓ ───── T⅔ ───── TR          ← y: 0-edge (over/in the ExamTopBar strip)
│                            │
L⅓                          R⅓
│          C-mid             │          ← interior: x 50% / y 45% (over workspace)
L⅔        (S-bar)           R⅔          ← interior: x 50% / y ~88% (status-bar zone)
│                            │
BL ───── B⅓ ───── B⅔ ───── BR          ← y: bottom-edge
                + STRIP-C (x 50%, inside the top strip)
```

- **4 corners** (TL/TR/BL/BR) — these are the **anchors** (§7.3). Inset 4 px from the
  viewport edge so encoder edge artefacts don't clip them.
- **8 edge points** at ⅓ and ⅔ along each edge — max marker-free run along any edge
  ≈ ⅓ of that edge (~640 CSS px on 1920), so any edge-hugging helper window wider than
  that must hit one. (Owner: "cover ALL edges — overlay tools are small and hug edges".)
- **1 in the top strip center** (`STRIP-C`) — the strip is always-rendered chrome; a
  marker there is invisible-by-design and covers the top-center interior band.
- **3 interior**: viewport center, lower-center (≈ status-bar line of the workspace),
  and `STRIP-C` counts as upper-center. Center markers are where Monaco popups can
  legitimately appear — the episode logic absorbs that (§7.4); their contrast/count is
  the Karthi call (Open Question 1).
- **Bottom-center caveat**: Chrome's "sharing your screen" pill often parks exactly at
  bottom-center. `B⅓`/`B⅔` are placed at 30/70 % (not 50 %) for this reason, and the
  baseline-calibration step (§7.4) excludes any marker that was never visible.

### 4.4 Stacking + self-occlusion rule

The marker layer renders at **maximum z-index, `pointer-events: none`, `aria-hidden`**,
above *everything we own* — including `EnforcementOverlay`, `EndTestPanel`, the
proctoring panel and the `CameraDock`. Rationale: if our own modals could cover markers,
every enforcement overlay would manufacture an "occlusion" in the recording. With
markers on top, **any marker absence in an anchored frame is caused by something outside
our page** (OS/browser/native window) — which is exactly the signal. The fiducials are
24 px dots; riding above our overlays does not impair them. Browser-native UI
(permission prompts, download shelf, PiP window) still occludes — by design, that's
detectable foreign occlusion, filtered by duration + correlation rules.

## 5. Render integration

### 5.1 Component

New `frontend/src/markers/`:
- `markerLayout.ts` — **pure**: `computeMarkerLayout({ viewportW, viewportH, dpr, screenW, trackWidth })`
  → `{ version, sizeCss, markers: [{ id, xCss, yCss, tone }] }` + capture-coordinate
  projection helpers. Vitest-covered, shared verbatim with the detector (one source of
  truth for positions).
- `MarkerLayer.tsx` — renders the fixed-position fiducials from the layout. Returns
  `null` when the flag is off (**zero DOM impact, flag-off render tree is identical**).
  Re-computes on resize/fullscreenchange (layout is cheap), and re-emits the layout
  event when it changes.

Mount point: inside `Shell` in **both** candidate branches of `App.tsx` that can be
on-screen while `status === "recording"` — the W1 exam view (next to
`<ExamShellChrome…>`/`{enforcementOverlay}`) and the classic fallback branch. It must
stay mounted across the whole exam exactly like the other always-mounted capture hosts
(the W1 branch already guarantees "every collapse is CSS-only"). Markers render only
while a session is recording — pre-session screens never show them.

### 5.2 Feature flag (exam-config-driven, default OFF)

Mirror `camera_recording` end-to-end:
- Settings doc: `screen_markers: { enabled: false }` (v1 keeps it boolean-only;
  size/contrast are code constants — Open Question 4). Normalizer
  `normalizeScreenMarkers` with the same "garbage → default" rule; contest snapshot
  override `screenMarkersConfigFor(contest, settings)` like
  `cameraRecordingConfigFor`; admin Settings UI toggle + per-template field.
- **Carrier: the session start/resume response only** (`SessionStartResponse` gains
  optional `screen_markers`), and the key is **emitted only when enabled**. Two reasons:
  markers are meaningless before recording, and the no-param `/api/exam-config` payload
  is canary-pinned — *not* touching it keeps flag-off responses **byte-identical**, not
  merely behavior-identical. (If pre-session rendering is ever wanted, add to the
  `?contest=` exam-config branch then.)
- Older backend / flag off → `screen_markers` absent → `MarkerLayer` renders null →
  today's live build is bit-for-bit unaffected.

### 5.3 Telemetry additions (additive only; candidate telemetry stays sacred)

- `marker_layout` event at recorder start and on any layout change: layout version,
  marker positions (CSS + projected capture px), `sizeCss`, screen dims, dpr, the
  screen track's `getSettings()` width/height. This is the detector's ground truth —
  it never reverse-engineers geometry from pixels alone.
- `camera_pip` event on PiP enter/leave (`requestCameraPictureInPicture` in `App.tsx`
  currently emits nothing): the camera pop-out is an OS always-on-top window that
  *will* occlude markers; P3 correlation needs to know PiP was active to downgrade.
  (Tiny, useful even without this feature.)
- Nothing existing is renamed, re-ordered, or re-timed. Event pipeline untouched.

## 6. Detection pass — where it runs (the home decision)

| Home | Cost | Trust of verdict | Latency to verdict | Notes |
|---|---|---|---|---|
| **Admin review browser (PRIMARY)** | zero infra, zero cloud | **High — runs on the uploaded evidence chunks** the reviewer is looking at | minutes after opening the session (on-demand scan) | Chunks already stream via signed URLs in `RecordingReview`; seek-decode via hidden `<video>` + canvas |
| Offline Node script (ALTERNATE, P4) | local CPU only (ffmpeg decode) | High — same evidence | batch, post-exam | Reuses the same pure detector module on ffmpeg-extracted RGBA frames; the whole-contest (700-session) sweep tool. `monitoring/` download scripts already exist |
| Candidate browser, real-time (ALTERNATE, P4) | zero | **Telemetry-grade** — runs on the suspect's machine; suppressible like any client event | real-time (live invigilator ping) | Must sample the **display MediaStream** (`grabFrame` on the screen track — this *is* the recorded content). DOM/canvas sampling of our own rendered markers is useless: it can never see other windows. |

**Recommendation: admin review browser is the primary home.** The verdict must be
derivable from the evidence the reviewer will act on — chunks already uploaded to GCS —
not from an agent on the candidate's machine; it ships zero extra code/CPU to candidates
during a live exam (the rock-solid-live-flow constraint); and it needs no new infra or
billing. Its real cost is verdict latency and per-session scan time, mitigated by the
coarse→fine strategy below and, at fleet scale, by the P4 Node batch scanner sharing the
same detector core. Candidate-side real-time is a genuinely attractive *addition*
(invigilator can walk over mid-exam) but is a different trust tier and a different
product decision — Open Question 2, not v1.

## 7. Detection pipeline (P2/P3)

### 7.1 Shared pure core

`frontend/src/markers/markerDetection.ts` — no React, no IO (vitest target, Node-reusable):
- `detectMarkersInFrame(imageData, layout, opts)` → per-marker
  `{ id, state: present|absent, score }` + frame state `anchored|unanchored`.
- `foldFramesIntoEpisodes(frameResults[], params)` → occlusion episodes (§7.4).

### 7.2 Frame sampling (review browser)

Two-pass, coarse→fine, over the existing `TimelineChunk[]` playlist:
1. **Coarse pass**: 1 frame per chunk at the 15 s midpoint (avoids the chunk-start
   keyframe at its worst quality). 2 h session = 240 chunks → ~240 seek+samples; at
   ~50–100 ms per seek-decode ≈ **20–30 s scan**.
2. **Fine pass**: for any chunk whose coarse frame is suspicious (any non-baseline
   marker absent, or anchored→unanchored transitions), re-sample that chunk and its
   neighbors at one frame / 2 s (15 frames per chunk). Worst case (everything
   suspicious) ≈ 3 600 samples ≈ 3–6 min; typical clean session stays ≈ 30 s.

Mechanics: hidden `<video preload="auto">` per chunk (sequential, one at a time),
`seeked` → `drawImage` onto an `OffscreenCanvas` at native track size →
`getImageData` of marker ROIs only (16 ROIs × ~30×30 px — trivially cheap). Runs in
the review tab; a progress bar in the panel. (A worker is unnecessary at this volume;
keep main-thread with `requestIdleCallback` batching.)

### 7.3 Per-frame algorithm (dependency-free)

1. **Anchor check**: for each corner anchor, search a ±8 captured-px window around its
   expected position (absorbs minor letterbox/crop offsets); score = quadrant-polarity
   test (§4.1) on the best window offset.
2. `< 3` anchors found → frame is **`unanchored`** — the exam view is not (fully) on
   screen: tab switch, fullscreen exit, lock screen. **No occlusion claims from
   unanchored frames**; they are recorded as state (correlated later, §7.5) — this is
   what stops double-reporting alt-tabs as occlusions.
3. ≥ 3 anchors → least-squares scale+offset fit → project the remaining 12+ marker
   positions → quadrant-polarity test each → `present|absent` + score.

### 7.4 Episode logic (K consecutive frames, M markers, hysteresis + baseline)

- **Baseline calibration**: a marker absent in ≥ 90 % of the first 10 anchored frames is
  `never_visible` (e.g. under the Chrome share pill or an unexpected OS bar) — excluded
  from occlusion logic, reported once informationally.
- **Open** an episode when ≥ M markers (default **M = 1**) are `absent` in **K = 3
  consecutive anchored samples** with stable membership (same marker set ± adjacency) —
  at coarse 30 s sampling that is ≳ 60–90 s of cover; the fine pass refines onset/end to
  ±2 s. **Close** after 2 consecutive fully-present samples (hysteresis).
- Single-marker episodes require longer persistence (K = 5) — absorbs the
  cursor-parked-on-a-marker and notification-toast cases.
- Interior-only single-marker episodes additionally tolerate Monaco popup zones
  (center markers): require K = 5 *and* flag as `low_confidence`.
- Episode record: `{ start, end, marker_ids, region (convex hull, capture px), max_consecutive, confidence, sample_offsets[] }`.
- Recording gaps and unanchored spans never extend or merge episodes across themselves.

### 7.5 Correlation + severity (P3 — server-side, the F2.1 rules)

Lives in the backend findings endpoint (one place owns policy; the client only reports
pixels). Join each episode against the session's event stream (same GCS JSONL the
existing `adminSessionEvents` reads) within a ±10 s onset window:

| Episode context | Output | Severity |
|---|---|---|
| Anchored throughout, **no** `window_blur` / `visibility_change` / fullscreen-exit / `switch_away_episode` overlapping onset | **`overlay_occlusion` alert — "the real, must-see alert"** (invisible-overlay signature: something covered the exam and the candidate never left it) | `critical` (default; admin-tunable via alert settings) |
| Overlaps a focus excursion with quick return (matches an existing `switch_away_episode` or blur→focus < tab_away threshold) | `overlay_occlusion` **review tag** ("occlusion during a focus excursion — review the clip") | `info` |
| Overlaps `camera_pip` active | downgrade to `info`, detail says "camera PiP active" | `info` |
| Unanchored span | **no occlusion output** (existing tab_away / fullscreen_enforcement own it) | — |

Alert creation reuses the existing machinery: catalog entry
`overlay_occlusion: { enabled: true, severity: "critical", show_to_invigilator: false }`
in `DEFAULT_PROCTOR_ALERT_SETTINGS` (additive; admin can re-tune/disable; invigilator
sharing stays opt-in per F9.3), upserted with id
`proctor:overlay_occlusion:<username_norm>:<contest_slug>:<episode_start_iso>` —
idempotent across re-scans — `data` carries marker ids/region/correlation verdict,
`video_key` via the existing `sureShotVideoKey` convention so deep-link/jump-to works
like every other alert.

### 7.6 Persistence + API (new, small)

- **Scan doc**: collection `occlusion_scans`, **doc id = `session_id`** (pure doc-id
  get/set — no new where-clauses, scopingLint untouched). Holds
  `{ session_id, contest_slug, scanned_at, detector_version, params, layout_version, episodes[≤200], baseline, coverage: {chunks_scanned, frames_sampled} }`.
  Re-scan overwrites (idempotent).
- **Routes** (dispatch lines in `handler.mjs` per the canary contract; bodies follow the
  current route conventions):
  - `POST /api/admin/occlusion-scan` — body = scan doc payload; `requireAdmin(req)` is
    **statement #1** (routesAuthLint). Validates + stores the scan doc, runs the §7.5
    correlation (reads the session's events), upserts/refreshes `overlay_occlusion`
    alerts. Returns the classified episodes.
  - `GET /api/admin/occlusion-scan?session_id=` — `requireAdmin` first; returns the
    stored scan (review panel re-open without re-scanning).
- P2 ships the endpoint with a degenerate classifier (everything `warning`); P3 swaps in
  the correlation table — the API shape doesn't change.

## 8. Review UI surfacing

In `RecordingReview.tsx` (session player view), gated on the session having a
`marker_layout` event (i.e. markers were on):
- **"Scan for overlay occlusion" button** + progress (`scanned m/n chunks`); auto-load
  of a stored prior scan. (Auto-scan-on-open vs explicit button: default explicit —
  part of Open Question 3.)
- **Timeline**: episodes appear as the existing **alert severity dots** automatically
  (they are alert docs) — click jumps the player, exactly like today's alerts. Episode
  *spans* additionally render as a thin tinted band on the track between start/end
  (same offset math as recording gaps).
- **Occlusion panel** (below the activity log): one row per episode — time range,
  duration, which markers vanished (by name: "top-right corner, right-edge ⅓"),
  correlation verdict ("no focus change — high signal" / "during a switch-away"),
  confidence, and a **frame thumbnail with the missing-marker region highlighted**:
  the panel seeks the already-loaded chunk to a sample offset, draws the frame to a
  canvas, and overlays the expected-marker rectangles (green = found, red = missing)
  from the layout manifest. Thumbnails are derived on demand from the chunks — nothing
  stored, no Firestore bloat.
- Reviewer copy must carry the §2 honesty note: *"No findings ≠ no overlay — capture-
  excluded tools are invisible to the recording. Check camera + editor analytics."*
- Episodes also land in the F6.7 activity log (kind "alert", existing filter chips).

## 9. Phasing (each phase independently shippable + testable)

**P1 — markers rendered behind the flag, recorded, zero detection.** *Size: S (~1 day).*
`markerLayout.ts` + `MarkerLayer.tsx` + flag plumbing (settings normalizer, contest
snapshot, session-start carrier, admin toggle) + `marker_layout`/`camera_pip` events.
Flag OFF = byte-identical responses, identical DOM. Provable immediately: turn the flag
on in dev, record a session, download a chunk, eyeball markers at all 16 positions —
chunks recorded today become the P2 detector's test corpus. Zero risk to the live exam.

**P2 — detection pass + review surfacing.** *Size: M–L (~2–3 days).*
`markerDetection.ts` (pure core + episode fold), review-tab scan controller
(coarse→fine sampling), `occlusion_scans` doc + the two admin routes (degenerate
severity: all `warning`), occlusion panel + timeline spans + thumbnails. Ships value on
its own: timestamped, jump-to-able occlusion findings.

**P3 — correlation + severity (F2.1).** *Size: S–M (~1 day).*
Server-side event join + the §7.5 severity table, `overlay_occlusion` catalog entry
finalized (critical default), review-tag vs must-see-alert split, PiP downgrade,
reviewer copy. Pure-logic heavy; the API shape is already in place from P2.

**P4 (optional, separately decidable):** (a) offline Node batch scanner
(`scripts/scan-occlusion.mjs`, ffmpeg + the same detector core) for whole-contest
sweeps; (b) candidate-side real-time sampling of the display stream emitting
telemetry-grade `marker_check` events (Open Question 2).

## 10. Test strategy

**P1**
- Pure units: `markerLayout` positions/adaptive sizing across viewport×dpr×track-width
  matrices (the §4.2 table as fixtures); layout stability under resize.
- Backend units: `normalizeScreenMarkers` garbage-in defaults; flag-off session-start
  payload has **no** `screen_markers` key (assert key-set equality with a pre-change
  fixture); contest-snapshot override precedence; no-param exam-config canary untouched.
- Frontend: `MarkerLayer` flag-off renders null (snapshot equality), flag-on renders 16
  positioned nodes with `pointer-events:none`/`aria-hidden`.
- **Not unit-testable, done manually/persona-E2E** (per the E2E mandate): markers
  actually visible in a *real recorded chunk* on real hardware (incl. one high-dpr
  machine); visual unobtrusiveness judgment (screenshot for Karthi — and validate the
  screenshot before sending).

**P2**
- Pure units on **synthetic frames**: build `ImageData` fixtures — markers drawn from
  the real layout, then degraded (box blur radius 1–2, contrast ×0.4, ±8 px offset,
  luma noise) to bracket compression; occluded variants (rectangles over marker
  subsets); unanchored frames (fewer than 3 corners). Assert per-marker
  present/absent + anchor fitting.
- Episode-fold units: K/M hysteresis, baseline exclusion (`never_visible`), single-
  marker long-persistence rule, gap/unanchored non-merging — table-driven.
- Backend route tests: auth-first (routesAuthLint covers it structurally), scan-doc
  idempotent overwrite, alert upsert id stability across re-scans, payload validation
  bounds (≤200 episodes).
- **Not honestly unit-testable**: real VP8/VP9 survival (verify against the P1-recorded
  corpus — keep 2–3 real chunks as repo-external fixtures and run the detector over
  ffmpeg-extracted frames in a manual script); browser seek-decode timing/scan duration;
  real overlay tools (manual: notepad-over-exam, PiP video, an actual capture-excluded
  tool to *confirm the documented blind spot*); cross-platform rendering variance.

**P3**
- Pure units: correlation join over synthetic event streams × episode sets — every row
  of the §7.5 table, boundary cases (event exactly at ±10 s, PiP spanning episode,
  blur with no focus return).
- Backend: severity flows into the alert doc; alert-settings override respected;
  re-scan after events arrive late re-classifies (idempotent ids keep one doc).
- **Not unit-testable**: ground-truth severity quality (needs labeled real sessions —
  run the contest-eval-style review loop on the first live use).

## 11. Repo-discipline compliance

- **Behavior-preserving outside the flag**: flag default OFF everywhere; OFF ⇒ no new
  response keys (start/resume omit `screen_markers`; exam-config untouched), no DOM
  nodes, no new events, no recorder changes at all (markers are page content — the
  recorder pipeline is not modified in any phase).
- **Tests green at every commit**: each phase lands as small commits with its units;
  P1 backend payload-equality tests pin the OFF path.
- **Candidate telemetry sacred**: additive events only (`marker_layout`, `camera_pip`);
  no changes to existing event emission, batching, or flush behavior.
- **No new raw Firestore where-clauses**: `occlusion_scans` is doc-id keyed; alerts go
  through `upsertProctorAlert`/`alertRef`; any listing need goes through `scopedQuery`.
- **routesAuthLint**: both new routes are `admin*`-prefixed with `requireAdmin(req)` as
  the first statement; dispatch lines added verbatim-style to the handler table.
- **uiStrings**: reviewer-facing copy says "candidate", never "username".

## 12. Open questions for Karthi

1. **Interior-marker visibility trade-off.** Edge/strip markers can be effectively
   invisible (tone-on-tone in chrome). Interior coverage requires faint dots *over the
   workspace*. Options: (a) none — interior blind spots, edges only; (b) 2–3 along the
   vertical midline at ΔY≈40 (slightly perceptible up close — recommended); (c) more/
   stronger interior markers — better coverage, visibly textured workspace. Which bar?
2. **Review-time only, or also candidate-side real-time?** v1 recommendation is
   review-time (evidence-derived, zero live-exam risk). Real-time sampling of the
   display stream would let an invigilator walk over *during* the exam but runs on the
   candidate's machine (telemetry-grade trust, extra CPU on weak laptops). Want it as a
   P4, or never?
3. **Can occlusion alone ever hard-alert / page live?** P3 marks the no-focus-change
   case `critical` in the review flow. Should it additionally (a) auto-scan after each
   session ends, (b) ever feed the invigilator dashboard live, or (c) stay a
   reviewer-triggered, post-hoc signal? (Recommendation: (c) for v1.)
4. **Admin-tunable marker knobs or fixed constants?** v1 proposes only
   `enabled: on/off` per contest; size/contrast/count as code constants until real-world
   recordings justify knobs. OK?
