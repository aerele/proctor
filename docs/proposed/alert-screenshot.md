# ALERT-2 — Per-alert screenshot (last video frame, incl. recording-stopped)

**Status:** proposed (build now — BACKLOG.md ALERT-2 / F6).
**Author:** research sub-agent, code-grounded against the live tree (2026-06-23).

## 1. Goal (from BACKLOG.md)

> Per-alert screenshot — capture the last frame (incl. when recording has
> stopped); jump-to-chunk already exists. **Build now.**

Capture the last screen-capture frame at the moment a proctoring alert is
raised — *especially* the critical alerts that fire **because** the screen
recording / share has just stopped — store it as evidence, and show it inline
on the admin Live alerts console alongside the existing "Open evidence clip"
deep-link.

## 2. How alerts work today (grounded)

Alerts are NOT posted by the client as "alerts". The client emits **proctor
events**; the backend derives a small set of "sure-shot" alerts from them.

### 2.1 Client → event pipeline
- The recorder's `emit(type, detail)` builds a `ProctorEvent`
  (`frontend/src/useProctorRecorder.ts:435-439`, type at
  `frontend/src/types.ts:184-189` — `{ type, timestamp, detail?, visibility_state? }`)
  and pushes it to `eventBuffer`, also calling `options.onEvent`.
- `eventBuffer` is flushed on every heartbeat via `flushEvents()` →
  `sendEvents(sessionId, batch)` (`useProctorRecorder.ts:451-462`).
- `sendEvents` POSTs `{ session_id, events }` to `/api/events`
  (`frontend/src/api.ts:630-641`).
- The host `StudentApp` wires `onEvent: addEvent`
  (`frontend/src/candidate/StudentApp.tsx:1114`); `addEvent` funnels every event
  to the shell/enforcement taps and local state
  (`StudentApp.tsx:295-299`).

### 2.2 Server: events → sure-shot alerts
- `recordEvents` (POST `/api/events`,
  `backend/src/routes/sessionTelemetry.mjs:171-215`) sanitizes each event,
  writes the batch JSONL to GCS, then calls
  `raiseSureShotAlertsFromEvents(session, cleanedEvents, alertSettings)`
  (`sessionTelemetry.mjs:206-207`).
- `raiseSureShotAlertsFromEvents`
  (`backend/src/proctorAlerts.mjs:274-302`) matches the event `type` against
  `SURE_SHOT_EVENT_TYPES` (`proctorAlerts.mjs:74-83`:
  `recording_stopped`, `screen_share_stopped`, `recording_error`), and for each
  match calls `upsertProctorAlert(session, {...})` passing
  `data: event.detail` (`proctorAlerts.mjs:290-298`).
- `upsertProctorAlert` (`proctorAlerts.mjs:350-383`) builds the alert doc, and
  if `sureShotVideoKey(session)` returns a key it sets `item.video_key`
  (`proctorAlerts.mjs:378-379`). It already persists `item.data =
  sanitizeObject(data)` when `data` is an object (`proctorAlerts.mjs:376`).
- The **heartbeat** path *also* raises `recording_stopped` directly when
  `isRecordingStopped(recording_state)` (`sessionTelemetry.mjs:341-354`) — this
  is server-derived and carries **no client detail / no frame**.

### 2.3 The two "recording stopped" triggers (both must attach a frame)
1. **`screen_share_stopped`** — the screen track fires `ended` (user clicked the
   browser "Stop sharing" chrome). Emitted at
   `useProctorRecorder.ts:1042-1047` inside the `screenTrack ... "ended"`
   listener; this also calls `options.onFatalError(...)`.
2. **`recording_error`** — `MediaRecorder` error
   (`useProctorRecorder.ts:1266-1269`).
3. **Heartbeat `recording_stopped`** — server sees a stopped `recording_state`
   (`sessionTelemetry.mjs:341-354`). This fires when no client event arrived
   (e.g. the tab is throttled / the event POST failed). It cannot carry a frame
   and is out of scope for capture — see §6 fallback.

### 2.4 Admin read + display
- `adminAlerts` (GET `/api/admin/alerts`,
  `backend/src/routes/alerts.mjs:90-145`) resolves a signed read URL **only for
  `alert.video_key`** into `download_url`
  (`alerts.mjs:133-137`) via `resolveSignedReadUrl`
  (`backend/src/lib/clients.mjs:215-230`).
- `Alert` type: `frontend/src/types.ts:579-616` — has `video_key?`,
  `download_url?`, `data?`.
- `AlertRow` (`frontend/src/admin/views/AlertsConsole.tsx:300-420`) renders
  `alert.download_url` as an "Open evidence clip" `<a>`
  (`AlertsConsole.tsx:355-366`) else "No recording attached.", and dumps
  `alert.data` JSON behind a "Show details" toggle
  (`AlertsConsole.tsx:367-371, 415-417`).

> **"Jump-to-chunk already exists"** refers to the recording playback in
> `frontend/src/RecordingReview.tsx` (chunk-based playlist). ALERT-2 does NOT
> touch that; it adds a still image to the alert row.

## 3. Where the screen frame lives at alert time (grounded feasibility)

The screen capture is a **direct `getDisplayMedia` stream** held in the recorder
closure as `screenStream` (`useProctorRecorder.ts:326`, acquired at
`:1016-1035`). There is **no `<video>` element** for the screen anywhere in the
tree (only `CameraSelfView` shows the camera — grep for `<video` finds only the
camera dock). A grep for `drawImage|toBlob|toDataURL|ImageCapture|grabFrame|
createImageBitmap|getContext` over `frontend/src` returns **nothing** — frame
capture is greenfield.

Capture must therefore read the frame off the **screen video track** directly:

- **Normal alert (track still live):** `recording_error` and any future
  per-alert capture happen while `screenStream.getVideoTracks()[0].readyState
  === "live"`. Use `ImageCapture(track).grabFrame()` → draw to an
  `OffscreenCanvas`/`canvas` → `toBlob('image/jpeg')`. Fallback when
  `ImageCapture` is unavailable (Firefox): draw a hidden `<video srcObject>` to a
  canvas. (Project targets Chrome/Edge — `acquireScreenShareStream` error copy
  at `useProctorRecorder.ts:195` says "Use latest Chrome or Edge" — so
  `ImageCapture` is the primary path.)

- **Recording-stopped (`screen_share_stopped`, track `ended`):** THIS is the
  hard case the goal calls out. When the user stops sharing, the track fires
  `ended` and its `readyState` becomes `"ended"` — `grabFrame()` then rejects
  and the pixels are gone. **You cannot grab a frame after `ended`.** The only
  correct mechanism is to keep the **most-recent frame already captured** in a
  rolling cache and use it when the track ends.

  Decision (drives §5): **maintain a periodically-refreshed "last good frame"**
  (a single in-memory JPEG `Blob`, refreshed every N seconds while the track is
  live). On `screen_share_stopped` / any track-`ended` path, attach the cached
  frame (captured moments before the stop). On `recording_error` with a still-
  live track, grab fresh; if that fails, fall back to the cache.

  Note: in the recorder's `stop()` path the tracks are explicitly stopped
  (`useProctorRecorder.ts:1092-1094`); the cache is the only frame source there
  too, but `stop()` is a deliberate end-of-exam teardown, not an alert, so no
  capture is needed there.

## 4. Storage decision (grounded — do NOT inline the image)

`sanitizeObject` truncates **every string to 500 chars**
(`backend/src/lib/sanitize.mjs:70-72`). `recordEvents` runs `sanitizeObject` on
each event `detail` (`sessionTelemetry.mjs:182`) and `upsertProctorAlert` runs
it again on `data` (`proctorAlerts.mjs:376`). A base64 data-URL screenshot
(tens of KB) would be **destroyed** by either pass. **Inline storage is not
viable.** The screenshot must be a binary GCS object referenced by key.

Reuse the **proven signed-PUT upload path** — no new route, minimal surface:

- Client mints a signed write URL via the existing `getUploadUrl`
  (`api.ts:578-597` → `/api/upload-url`), then PUTs the JPEG blob via the
  existing `uploadBlob` (`api.ts:599+`, honours the `x-goog-content-length-range`
  cap header). The server's `createUploadUrl`
  (`sessionTelemetry.mjs:90-169`) already signs a write URL under
  `sessionPrefix(session)` and returns `{ upload_url, storage_key, max_bytes }`.
- The only change needed server-side is to allow a new `kind` value
  `"screenshot"`:
  - `UPLOAD_CHUNK_KINDS` set: `backend/src/handler.mjs:338`
    (`new Set(["screen", "camera"])` → add `"screenshot"`).
  - Object key becomes `${sessionPrefix(session)}screenshot/chunk-NNNNN.<ext>`
    via the existing line `sessionTelemetry.mjs:127`. **Decision:** the
    screenshot path uses a DISTINCT prefix segment, not `screen/`, so it never
    collides with screen video chunks and never inflates `chunk_count`. With
    `kind === "screenshot"` neither the `camera_chunk_count` nor `chunk_count`
    increment branch (`sessionTelemetry.mjs:155-157`) runs — **but** that branch
    today is `kind === "camera" ? ... : chunk_count++`, i.e. a non-camera kind
    falls into the `chunk_count` increment. **This must be fixed**: change the
    increment to only run for the two video kinds so a screenshot upload does not
    inflate the recording-duration math (admin reads `chunk_count × 30s`,
    documented at `sessionTelemetry.mjs:152-154`). See BU-2.
  - The hwm guard (`sessionTelemetry.mjs:122-124`) keys on
    `camera_chunk_index_hwm` / `screen_chunk_index_hwm`. For `screenshot`, add a
    `screenshot_chunk_index_hwm` field so re-keys never overwrite — OR (simpler,
    preferred) the client always supplies a **unique** `chunk_index` per
    screenshot (e.g. a monotonic counter) and we add `screenshot_chunk_index_hwm`
    to the `hwmField` map. Use the hwm map for consistency with the existing
    overwrite-protection invariant. See BU-2.
- The content extension: `createUploadUrl` derives `extension` from
  `content_type.includes("webm") ? "webm" : "bin"` (`sessionTelemetry.mjs:126`).
  A `image/jpeg` content-type would store as `.bin`. **Fix:** extend the
  extension derivation to map `image/jpeg`→`jpg`, `image/png`→`png` (cosmetic —
  the key is opaque, but a correct extension keeps GCS object inspection sane).
  See BU-2.

**GCS object-count note (archival cost is driven by object count, not bytes):** one screenshot
object per critical alert. At one screenshot per recording-stop, volume is tiny
(bounded by per-day dedupe on the alert). No tar-bundling needed. The evidence
object-count classifier `gcsKindOf` (`handler.mjs:2095-2113`) will label the
`screenshot/` prefix as `"other"` — acceptable; optionally add a
`case "screenshot": return "screenshot";` for clean admin storage breakdowns
(non-blocking, BU-2 optional).

## 5. Capture mechanism (client) — design

New module `frontend/src/frameCapture.ts` (pure, unit-testable) + wiring inside
`createProctorRecorder`.

### 5.1 `frameCapture.ts` (new, pure)
```ts
// Grab a JPEG blob from a live video track. Rejects if the track is not live
// or the browser lacks a capture path. Quality/scale kept low (evidence, not
// fidelity): max width ~960 (matches SETUP_SCREEN_CONSTRAINTS), jpeg q~0.6.
export async function grabTrackFrame(
  track: MediaStreamVideoTrack,
  deps?: FrameCaptureDeps   // injectable ImageCapture / canvas for tests
): Promise<Blob>;
```
- Primary: `new ImageCapture(track).grabFrame()` → `ImageBitmap` → draw to
  `OffscreenCanvas` (or a detached `<canvas>`) → `convertToBlob`/`toBlob` at
  `image/jpeg`, q≈0.6.
- Guard: if `track.readyState !== "live"` reject immediately (`ended` track has
  no pixels — this is what makes the recording-stopped case require the cache).
- `deps` lets tests inject a fake `ImageCapture` returning a fake bitmap and a
  fake canvas-to-blob, with no real DOM. Mirrors the recorder's existing
  dependency-injection style (`bufferDeps`, `ChunkBufferDeps`).

### 5.2 Recorder integration (`useProctorRecorder.ts`)
Add to the recorder closure (near `screenStream`, `:326`):
- `let lastScreenFrame: Blob | null = null;`
- `let frameRefreshTimer: number | undefined;`
- `let screenshotChunkIndex = 0;`

Refresh loop (start it inside `startDirectScreenRecordingStream`, `:1223`, after
`updateMediaState("screen","recording")`):
- Every `FRAME_REFRESH_SECONDS` (e.g. 5s) while the screen track is live, call
  `grabTrackFrame(screenTrack)` and store into `lastScreenFrame` (best-effort,
  swallow errors). Clear the timer in `stop()` (`:1081-1090`, alongside the
  other `clearTimeout`s) and when the track ends.

New helper `captureAlertScreenshot(reason): Promise<string | null>`:
1. Determine the frame:
   - If the screen track is live: `await grabTrackFrame(screenTrack)`, falling
     back to `lastScreenFrame` on failure.
   - If the track is **not** live (recording-stopped / share-stopped): use
     `lastScreenFrame`.
2. If no frame at all → return `null` (no screenshot; alert still raised).
3. Upload via the signed-PUT path (reuse `uploadChunkWithRetry`-style flow or a
   direct `getUploadUrl({ kind:"screenshot", chunk_index: ++screenshotChunkIndex,
   content_type:"image/jpeg" })` + `uploadBlob`). On success return
   `upload.storage_key`. On failure emit `screenshot_upload_failed` and return
   `null` (never block the alert).

Wire into the two capture-worthy emit sites so the **key rides the same event
that becomes the alert**:
- `screen_share_stopped` (`:1042-1047`): make the `ended` listener `async` —
  `const key = await captureAlertScreenshot("track_ended");` then
  `emit("screen_share_stopped", { reason: "track_ended", ...(key ? {
  screenshot_key: key } : {}) });`. **Order matters:** because the track is
  already `ended` here, capture relies on `lastScreenFrame`. Keep the
  `onFatalError(...)` call after the emit (unchanged behavior).
- `recording_error` (`:1266-1269`): same pattern; here the track is usually
  still live so a fresh grab works, cache is the fallback.

> **Why attach the key to the event, not raise the alert client-side:** alerts
> are exclusively server-derived from events (§2.2). Threading
> `detail.screenshot_key` through the existing event keeps the single source of
> truth and needs zero new client→server contract beyond one extra `detail` key.

### 5.3 Server: promote `screenshot_key` from event detail onto the alert
`detail.screenshot_key` survives `sanitizeObject` (it's a short opaque key < 500
chars). Two minimal changes in `backend/src/proctorAlerts.mjs`:

- In `raiseSureShotAlertsFromEvents` (`:284-298`), extract the key from the
  event detail and pass it to `upsertProctorAlert`:
  ```js
  const screenshotKey = event.detail && typeof event.detail === "object"
    ? event.detail.screenshot_key : undefined;
  await upsertProctorAlert(session, { ...existing, screenshotKey });
  ```
- In `upsertProctorAlert` (`:350-383`), persist it (validate it is a string
  under this session's prefix to prevent a malicious client pointing the key at
  an arbitrary object):
  ```js
  if (screenshotKey && typeof screenshotKey === "string"
      && screenshotKey.startsWith(sessionPrefix(session))) {
    item.screenshot_key = screenshotKey.slice(0, 300);
  }
  ```
  `sessionPrefix` is already available in this domain's `ctx`/sessionStore
  (`backend/src/lib/sessionStore.mjs:67`); thread it into `makeProctorAlerts`
  ctx if not already present (it is not currently destructured at
  `proctorAlerts.mjs:44-66` — **add `sessionPrefix` to the ctx**, supplied from
  handler.mjs where the sessionStore helpers are wired). See BU-3.

> **Security:** the prefix check is mandatory — without it a candidate could set
> `screenshot_key` to another session's video object and the admin read would
> sign a download URL for it. Grounded in the same defensive posture as
> `alertRef`'s id sanitization (`proctorAlerts.mjs:467-476`) and
> `normalizeAlert`'s field discipline.

### 5.4 Server read: sign the screenshot URL
In `adminAlerts` (`backend/src/routes/alerts.mjs:133-137`), extend the per-alert
URL resolution to also resolve `screenshot_key`:
```js
const withUrls = await Promise.all(alerts.map(async (alert) => {
  const video_url = alert.video_key ? await resolveSignedReadUrl(alert.video_key) : null;
  const screenshot_url = alert.screenshot_key ? await resolveSignedReadUrl(alert.screenshot_key) : null;
  return { ...alert, download_url: video_url, screenshot_url };
}));
```
`resolveSignedReadUrl` already degrades to `null` on any failure
(`clients.mjs:215-230`). See BU-3.

## 6. Recording-stopped fallback (heartbeat path)

The heartbeat-derived `recording_stopped`
(`sessionTelemetry.mjs:341-354`) carries no client frame and cannot. It is the
backstop for when the client never sent `screen_share_stopped` (tab killed,
event POST lost). Behavior: the alert renders with **no screenshot** (the row's
"No recording attached" equivalent). This is expected and acceptable — the
client `screen_share_stopped` event (which DOES carry the cached frame) is the
primary path for a user-initiated stop. Document this in the alert detail copy if
desired (non-blocking).

Edge case worth a test: the SAME stop can produce BOTH a client
`screen_share_stopped` (with `screenshot_key`) AND a heartbeat `recording_stopped`
(without). They are **different alert types** → **different doc ids**
(`upsertProctorAlert` id = `proctor:<type>:<user>:<contest>:<dedupe>`,
`:353`), so they don't clobber each other; the `screen_share_stopped` alert keeps
its screenshot. Good — no merge hazard. (If the build later wants the heartbeat
`recording_stopped` to also show the frame, it could read the latest
`screen_share_stopped` alert's key — out of scope, note only.)

## 7. Admin display (`AlertsConsole.tsx`)

In `AlertRow` (`frontend/src/admin/views/AlertsConsole.tsx:353-372`), add a
thumbnail next to the evidence-clip link when `alert.screenshot_url` is present:
```tsx
{alert.screenshot_url ? (
  <a href={alert.screenshot_url} target="_blank" rel="noreferrer"
     className="focus-ring inline-block rounded-md border border-line overflow-hidden hover:border-ink/40">
    <img src={alert.screenshot_url} alt="Screen at alert time"
         className="h-20 w-auto object-cover" loading="lazy" />
  </a>
) : null}
```
Place it in the actions row (`:353-372`) or in a new block under
`{alert.detail}` (`:335`). Clicking opens the full image in a new tab (same UX as
the clip link). Add `screenshot_key?` and `screenshot_url?` to the `Alert` type
(`frontend/src/types.ts:579-616`, next to `video_key`/`download_url`).

## 8. Build units (right-sized, independently verifiable)

### BU-1 — `frameCapture.ts` (client, pure)
- New `frontend/src/frameCapture.ts` with `grabTrackFrame(track, deps?)` +
  `FrameCaptureDeps`. ImageCapture-primary, canvas fallback, rejects on
  non-live track.
- **Verify:** new `frontend/src/frameCapture.test.ts` (Vitest, matches existing
  `*.test.ts` convention): fake ImageCapture returns a bitmap → resolves a JPEG
  blob; non-live track → rejects; ImageCapture-absent → canvas fallback path;
  capture throw → rejects. `npm test` in `frontend/` green.

### BU-2 — backend `screenshot` upload kind
- `handler.mjs:338` add `"screenshot"` to `UPLOAD_CHUNK_KINDS`.
- `sessionTelemetry.mjs:122` add `screenshot_chunk_index_hwm` to the `hwmField`
  map (so a 3-way kind map).
- `sessionTelemetry.mjs:126` extend extension derivation:
  `image/jpeg`→`jpg`, `image/png`→`png`, webm→webm, else bin.
- `sessionTelemetry.mjs:155-157` change the chunk-count increment so ONLY
  `screen`/`camera` increment their counters; `screenshot` increments neither
  (today a non-camera kind falls into the `chunk_count` branch — fix it).
- (Optional) `handler.mjs:2104` add `case "screenshot": return "screenshot";`.
- **Verify:** extend `backend/test/` upload-url coverage (grep shows the
  upload-url route is exercised; add a focused test): minting a `screenshot` URL
  returns a `screenshot/chunk-00001.jpg` key, does NOT bump `chunk_count` or
  `camera_chunk_count`, and an unknown kind still 400s. `npm test` in
  `backend/` green (the suite is ~1000+ tests per BACKLOG TEST-1).

### BU-3 — promote + sign + display the screenshot
- `proctorAlerts.mjs`: add `sessionPrefix` to `makeProctorAlerts` ctx
  (`:44-66`); extract `screenshot_key` in `raiseSureShotAlertsFromEvents`
  (`:284-298`); persist with prefix-validation in `upsertProctorAlert`
  (`:350-383`). Wire `sessionPrefix` into the ctx from `handler.mjs`.
- `routes/alerts.mjs:133-137`: resolve `screenshot_url` alongside `download_url`.
- `types.ts:579-616`: add `screenshot_key?`, `screenshot_url?` to `Alert`.
- `AlertsConsole.tsx:353-372`: render the `<img>` thumbnail when
  `screenshot_url` present.
- **Verify:** backend test in `backend/test/alerts.test.mjs` (the existing alert
  suite): an event with `detail.screenshot_key` pointing INSIDE the session
  prefix → alert doc gets `screenshot_key`; a key OUTSIDE the prefix → ignored;
  `adminAlerts` returns `screenshot_url` (mock `resolveSignedReadUrl`). Frontend:
  a render test or the existing AlertsConsole coverage shows the thumbnail when
  `screenshot_url` is set, nothing when absent. `npm test` both packages green.

### BU-4 — recorder wiring + last-frame cache (client)
- `useProctorRecorder.ts`: add `lastScreenFrame` cache + refresh timer (start in
  `startDirectScreenRecordingStream` `:1223`, clear in `stop()` `:1081-1090`),
  `captureAlertScreenshot(reason)` helper (signed-PUT upload of the frame), and
  wire it into the `screen_share_stopped` `ended` listener (`:1042-1047`) and
  the `recording_error` listener (`:1266-1269`) so the resulting
  `screenshot_key` rides the emitted event's `detail`.
- **Verify:** extend the recorder test suite (there are recorder-adjacent tests;
  add `useProctorRecorder` coverage or a focused harness): simulate a track
  `ended` after at least one cache refresh → the emitted `screen_share_stopped`
  event carries `detail.screenshot_key` and a `screenshot` upload was attempted;
  simulate `ended` with NO cached frame → event has no `screenshot_key` and the
  alert still emits (never blocks). Use injectable `FrameCaptureDeps` + a fake
  `getUploadUrl`/`uploadBlob`. `npm test` in `frontend/` green.

### BU-5 — manual E2E (per the project's E2E test + docs mandate)
- Browser-drive on the dev stack: start a session, stop screen sharing → confirm
  a `screen_share_stopped` alert appears in the admin Live alerts console **with
  a screenshot thumbnail** showing the screen content from just before the stop;
  click it to open full-size. Confirm a heartbeat-only `recording_stopped`
  (kill the tab) shows the alert with no thumbnail (documented fallback).
- **Verify:** screenshots of the console row with the thumbnail + the opened
  image, documented per the E2E mandate.

## 9. Tests / verification summary
- Unit (client): `frameCapture.test.ts` (BU-1), recorder capture wiring (BU-4).
- Unit (backend): upload-url `screenshot` kind (BU-2), alert
  promote/sign/validate (BU-3) in `backend/test/alerts.test.mjs`.
- Integration/E2E: BU-5 manual browser test, both the live-track and
  recording-stopped cases.
- Full `npm test` green in `frontend/` and `backend/` after each BU.

## 10. Risks / open questions
- **`ImageCapture` browser support:** primary path is Chrome/Edge (the platform
  target). The canvas-from-`<video>` fallback covers the rest; document if a
  fallback `<video>` element needs mounting (hidden) in the recorder host.
- **Frame freshness on user-stop:** the cached frame is up to
  `FRAME_REFRESH_SECONDS` old when the share is stopped. 5s is a reasonable
  default (the screen stream is 4 fps / low-res anyway —
  `SETUP_SCREEN_CONSTRAINTS` `useProctorRecorder.ts:183`). Tunable; could also
  refresh on every video chunk boundary (`dataavailable`, `:1247`) for a fresher
  cache at near-zero extra cost — **recommended** over a separate timer (one
  fewer timer to manage; piggybacks the existing 30s/chunk cadence, or grab on
  the small sub-chunk cadence). Open: choose timer vs chunk-boundary refresh.
- **Privacy/PII:** the screenshot is full-screen evidence of the candidate's
  display — same sensitivity as the existing screen recording, stored in the
  same evidence bucket under the same lifecycle. No new exposure class.
- **Out of scope:** attaching frames to the heartbeat `recording_stopped`
  backstop; jump-to-chunk (already exists); ALERT-1 dispute flow (separate spec
  `docs/proposed/alert-feedback-suppression.md`).
