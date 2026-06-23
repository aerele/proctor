# EVID-1 — Notable paste/keystroke timeline markers (clickable seek)

Status: **proposed** (spec for a build agent). Backlog: `BACKLOG.md:89` (EVID-1, F10).

> Filter NOTABLE paste/keystroke events and surface them as **clickable timeline
> markers** in the recording Evidence tab; clicking a marker seeks the recording
> to that moment.

## 0. TL;DR — what to build

A **new "paste/keystroke" marker lane** on the existing recording scrubber in
`frontend/src/RecordingReview.tsx`, fed by **editor events** that the Evidence
tab does not fetch today. The lane reuses the *exact* time-mapping
(`offsetSecFor`) and seek wiring (`seekToTestTime`) the existing alert /
submission / event lanes already use. "Notable" is decided **client-side** from
fields already stored per editor event (`len`, `insertedLen`, single-char
keystroke timing), using the **same threshold constants the eval engine uses**
(`REPLAY.MIN_FOREIGN_PASTE_LEN`, `REPLAY.BURST_*`, `THRESHOLDS.SUPERHUMAN_*`),
copied into one shared client config so the marker definition tracks the
detectors.

Three pieces:

1. **Backend** — a new admin read endpoint that lists the per-session
   **editor-events** (the `editor-events/` GCS prefix), mirroring the existing
   `adminSessionEvents` reader for the `events/` prefix.
2. **Pure logic** — a new `notableEditorMarkers.ts` module (vitest-covered, no
   React/IO) that classifies an editor-event stream into notable
   paste/keystroke-burst markers and maps them to test-relative offsets.
3. **UI** — fetch the editor events in `RecordingReview.tsx`, build the markers,
   render them as a new clickable lane + fold them into the activity log, all
   reusing existing seek/scale code.

This is intentionally **client-side classification over the raw editor-event
stream**, NOT a call into the heavy server-side eval engine — see §6 for why.

---

## 1. How events are captured + stored today (grounding)

There are **two independent client event streams**, both timestamped with ISO
strings on the candidate's machine:

### 1a. Editor events (the richer paste/keystroke signal — THIS is what EVID-1 needs)

- **Captured** in Monaco: `frontend/src/coding/MonacoEditor.tsx:3` maps changes
  via `mapContentChange` / `mapPaste` in `frontend/src/coding/editorEvents.ts:17,37`.
  - `editor_paste` carries `detail.len` (paste char count) — `editorEvents.ts:37-39`.
  - `editor_insert`/`editor_replace`/`editor_delete` carry `detail.insertedLen`,
    `detail.deletedLen`, `detail.text` (capped 2000 chars,
    `MAX_STORED_TEXT_CHARS` — `editorEvents.ts:15,27`), `detail.truncated`.
- **Type union**: `EditorEventType` / `EditorEvent` — `frontend/src/types.ts:784-800`.
- **Batched + sent**: `ProblemBatchers` (`editorEvents.ts:87`) →
  `sendEditorEvents(sessionId, problemId, events)` — wired in
  `frontend/src/coding/MultiProblemWorkspace.tsx:143`, API in
  `frontend/src/api.ts:3538`.
- **Ingested**: `ingestEditorEvents` —
  `backend/src/routes/sessionTelemetry.mjs:217-249`. Each event is re-built
  allow-listed (`sanitizeEditorDetail` keeps `len`/`insertedLen`/`text`/… —
  `backend/src/lib/sanitize.mjs` `sanitizeEditorDetail`), stamped with
  `session_id` + `problem_id`, and written as **NDJSON** under
  `` `${sessionPrefix(session)}${editorEventsCollection}/<ISO>-<uuid>.ndjson` ``
  (`sessionTelemetry.mjs:245-246`).
- **Storage label**: `EDITOR_EVENTS_COLLECTION` default `"editor-events"` —
  `backend/src/config.mjs:53`; threaded as `editorEventsCollection`
  (`backend/src/handler.mjs:683`) and `editorEventsLabel`
  (`backend/src/handler.mjs:898`). So objects live at
  `` `${storage_prefix}editor-events/…ndjson` ``.
- **Read today only by the eval engine**: `gatherSessionEvidence` reads
  `` `${prefix}${editorEventsLabel}/` `` — `backend/src/evaluation.mjs:169`. **No
  admin/Evidence-tab read path exists** for editor events. (See §2 for the gap.)

### 1b. Session events (the coarse stream the Evidence tab already shows)

- **Captured** in the recorder: `document.addEventListener("paste"/"copy"/"cut", onClipboard)`
  — `frontend/src/useProctorRecorder.ts:843-845`. `onClipboard` emits
  `clipboard_activity` with `detail.action`, `detail.text_length`,
  `detail.text_preview` (80 chars) — `useProctorRecorder.ts:856-870` region.
- **Sent** via `sendEvents` → `POST /api/events` (`frontend/src/api.ts:630`).
- **Ingested**: `recordEvents` — `backend/src/routes/sessionTelemetry.mjs:171-215`;
  written as JSONL under `` `${sessionPrefix(session)}events/events-…jsonl` ``
  (`sessionTelemetry.mjs:185-186`).
- **Read by the Evidence tab**: `adminSessionEvents` (GET
  `/api/admin/session-events`) reads the `events/` prefix only —
  `backend/src/routes/adminSessions.mjs:370-413`; frontend `fetchSessionEvents`
  (`frontend/src/api.ts:1173`) → `sessionEvents` state in
  `RecordingReview.tsx:219,453-456`. `clipboard_activity` already flows into the
  generic **event lane** (`EVENT_LABELS` has `clipboard_activity: "Clipboard activity"`
  — `frontend/src/recordingTimeline.ts:130`).

**Why editor events, not the session `clipboard_activity`, for EVID-1:** the
session `clipboard_activity` fires on `copy`/`cut`/`paste` at the *document*
level and reports `text_length` of the clipboard, but it does **not** tell you
whether the paste actually landed in the editor, where, or how big the inserted
blob was; it also lacks the per-keystroke burst signal. The **editor** stream is
exactly what the eval detectors (D1 paste-ratio, D2 foreign-paste, D4/cadence
bursts) run on, so EVID-1's "reuse existing detector signals" maps cleanly onto
it. We keep the existing coarse `clipboard_activity` event lane untouched; the
new lane is the *editor* paste/keystroke lane.

---

## 2. The gap to close

The Evidence tab fetches only the `events/` prefix. To surface editor pastes /
keystroke bursts as markers we must (a) expose the `editor-events/` prefix to
admin, and (b) classify + render. Both are additive; nothing existing changes
behavior.

---

## 3. What makes an event "NOTABLE" (reuse detector signals)

Decide notability **client-side** from fields already present on each editor
event, using thresholds **copied from the eval engine** so the markers track the
detectors:

| Marker kind | Condition | Source signal (server detector parity) |
|---|---|---|
| `large_paste` | `editor_paste.detail.len ≥ FOREIGN_PASTE_LEN` **OR** an `editor_insert`/`editor_replace` with `detail.insertedLen ≥ FOREIGN_PASTE_LEN` | mirrors `REPLAY.MIN_FOREIGN_PASTE_LEN = 30` (`backend/src/evaluationReplay.mjs:21`), the same floor D2/foreign-paste uses |
| `paste` | any `editor_paste` below the large-paste floor (still worth a tick, smaller) | the `editor_paste` marker the replay pairs at `evaluationReplay.mjs:396-420` |
| `keystroke_burst` | within a sliding `BURST_WINDOW_MS = 2000` window, summed inserted chars from single-char `editor_insert`s `≥ BURST_MIN_CHARS = 80` (a sudden flood of typed chars) | `REPLAY.BURST_WINDOW_MS = 2000`, `REPLAY.BURST_MIN_CHARS = 80` (`evaluationReplay.mjs:24-25`) |

Notes:
- **Thresholds live in one shared constant block** in the new client module
  (`NOTABLE = { FOREIGN_PASTE_LEN: 30, BURST_WINDOW_MS: 2000, BURST_MIN_CHARS: 80 }`),
  with a code comment citing `backend/src/evaluationReplay.mjs:19-25` so a future
  retune keeps both sides aligned. (We are **not** importing across the
  frontend/backend boundary — they don't share a module graph; the constants are
  duplicated with a citation, the same pattern `CHUNK_SECONDS` etc. already use.)
- **"Foreign" vs merely "large" is a server-replay decision** (it diffs against
  the candidate's own prior content + clipboard history —
  `evaluationReplay.mjs` foreign logic) and is **out of scope for the
  client-side marker**: we surface *large* paste, which is the visible,
  reviewer-actionable fact ("a big blob appeared here — watch the recording").
  The eval card's confirmed foreign-paste verdict stays where it is. If a future
  iteration wants the authoritative foreign flag on the marker, see §6 (endpoint
  option B).
- **Cap the marker count** defensively (e.g. keep the largest/most-notable N=300
  after classification) so a pathological session can't render thousands of DOM
  ticks. Mirrors the `SESSION_EVENTS_LIMIT` discipline in
  `adminSessions.mjs:410`.

---

## 4. Time mapping (markers → recording position)

Editor-event timestamps are ISO strings on the same wall clock as session
events. The eval replay already parses them with `Date.parse(ev.timestamp)`
(`backend/src/evaluationReplay.mjs:333`) → epoch ms, so they share the basis the
Evidence tab's `offsetSecFor(timestamp, testStartMs)` uses
(`frontend/src/recordingTimeline.ts:offsetSecFor`).

- Each marker's `offsetSec = offsetSecFor(event.timestamp, testStartMs)` — the
  **identical** mapping the alert/submission/event lanes use
  (`recordingTimeline.ts` `buildTimelineLog`).
- `testStartMs` is the existing test-start anchor in `RecordingReview.tsx`
  (`testStartMs`, derived from `testStartInput`; markers recompute on anchor
  edits exactly like `markers`/`logEntries` do — `RecordingReview.tsx:414,484`).
- A marker whose offset lands in a recording gap is tagged via the existing
  `isDuringGap(offsetSec, gaps)` (`recordingTimeline.ts`), so the tooltip can say
  "during blackout" like the others (`RecordingReview.tsx:1639`).

Clicking a marker calls the **already-built** `seekToTestTime(offsetSec, wantPlaying())`
(`RecordingReview.tsx:830-841`), which binary-searches the chunk
(`chunkPosForTestTime`, `:110`) and loads it at the within-chunk offset. **No new
seek logic is required** — this is the same call the submission markers make at
`RecordingReview.tsx:1617` and alert markers at `:1649`.

---

## 5. Marker data shape

New exported types in `frontend/src/notableEditorMarkers.ts`:

```ts
export type NotableMarkerKind = "large_paste" | "paste" | "keystroke_burst";

// One classified, time-placed editor marker for the recording timeline.
export type NotableEditorMarker = {
  kind: NotableMarkerKind;
  id: string;            // stable React key: `${kind}:${problemId}:${index}@${timestamp}`
  timestamp: string;     // ISO of the underlying editor event (window start for bursts)
  offsetSec: number;     // test-relative seconds (offsetSecFor result)
  chars: number;         // pasted/inserted char count (for label + sizing)
  problemId: string | null;
  duringGap: boolean;
  label: string;         // e.g. "Large paste · 412 chars" / "Typing burst · 140 chars"
};
```

Raw input type (what the new endpoint returns, what the classifier consumes):

```ts
// frontend/src/types.ts — mirrors EditorEvent + the backend-stamped fields.
export type EditorEventItem = {
  type: string;          // EditorEventType, but open string (storage is open)
  timestamp: string;     // ISO
  problem_id?: string | null;
  detail?: Record<string, string | number | boolean>;
};
export type EditorEventsResponse = { events: EditorEventItem[]; truncated?: boolean };
```

Classifier signature:

```ts
export function buildNotableEditorMarkers(params: {
  events: EditorEventItem[];
  testStartMs: number;
  gaps: TimelineGapSpan[];   // reuse the type from recordingTimeline.ts
}): NotableEditorMarker[];
```

Behaviour: sort by timestamp; emit a `large_paste`/`paste` marker per qualifying
paste/insert; run the sliding-window burst accumulator for single-char inserts
and emit one `keystroke_burst` per window that crosses `BURST_MIN_CHARS`; drop
events with unparseable timestamps or no test-start anchor (return [] if
`!Number.isFinite(testStartMs)`); cap to N; return sorted by `offsetSec`.

---

## 6. Why client-side classification, not the eval engine

The eval engine (`backend/src/evaluation.mjs` / `evaluationMetrics.mjs` /
`evaluationReplay.mjs`) is a **batch scorecard job** keyed by contest, not a
per-session query, and its `foreign_pastes`/`bursts` arrays (with `ts`) are
**not exposed to the frontend** — the scorecard the Evidence drawer reads
(`frontend/src/api.ts:1696` region) carries only aggregates (`paste_ratio`,
tiers), never per-paste timestamps. Surfacing the authoritative server markers
would require either running an eval job (heavy, contest-wide, may not exist for
a live/un-evaluated session) or a new server endpoint that re-runs
`replaySession` per session.

**Chosen (option A):** classify client-side over the raw editor-event stream
using the same threshold constants. Cheap, works for any session with editor
telemetry regardless of eval state, and the "large paste / typing burst" facts
it surfaces are exactly the reviewer-actionable signals. The endpoint in §7 just
exposes the raw stream.

**Deferred (option B), noted for completeness:** a future endpoint could call
`replaySession(editorEvents)` (`backend/src/evaluationReplay.mjs:266`) server-side
and return the `pastes`/`foreign_pastes`/`bursts` arrays with `ts`, giving the
marker the *authoritative foreign-paste* flag. Not needed for EVID-1; recorded
here so the build agent doesn't reinvent it.

---

## 7. Backend — new admin editor-events read endpoint

Add `adminSessionEditorEvents` to `backend/src/routes/adminSessions.mjs`,
**modeled exactly on `adminSessionEvents` (`adminSessions.mjs:370-413`)** but
reading the editor-events prefix.

- **Route**: `GET /api/admin/session-editor-events?session_id=…` (admin auth).
- **Prefix**: `` `${sessionPrefix(session)}${editorEventsLabel}/` `` — note the
  label must be threaded into this route's ctx the same way `adminSessionEvents`
  gets its collaborators. Confirm `editorEventsLabel`/`editorEventsCollection`
  ("editor-events", `backend/src/config.mjs:53`) is reachable where the route is
  built; `adminSessions.mjs` routes are assembled in the handler — pass the label
  in alongside the existing ctx fields (`backend/src/handler.mjs:898` already has
  `editorEventsLabel`). The objects are **`.ndjson`** but parse identically
  line-by-line to the `.jsonl` reader.
- **Body**: reuse the same download + bounded-concurrency + per-line `JSON.parse`
  pattern (`adminSessions.mjs:378-398`, `mapWithConcurrency(files, 12, …)`).
- **Projection**: keep `type`, `timestamp`, `problem_id`, and a **scalar-only**
  `detail` (reuse `projectSessionEventDetail`, `adminSessions.mjs:355`, which
  already keeps `len`/`insertedLen` and drops nested/over-long values). Do **not**
  return `detail.text` blobs to the lane (the marker only needs counts) — either
  exclude `text`/`text_preview` via `SESSION_EVENT_DETAIL_EXCLUDED_KEYS` or rely
  on the existing string cap; prefer excluding `text` to keep the payload small.
- **Cap + truncated flag**: same `slice(0, LIMIT)` + `truncated` as
  `adminSessionEvents` (`adminSessions.mjs:409-412`). Reuse `SESSION_EVENTS_LIMIT`
  or add a sibling `EDITOR_EVENTS_READ_LIMIT`.
- **Register** the handler in the route table next to `adminSessionEvents`
  (`adminSessions.mjs:919` exports it; find its handler-registration site in
  `backend/src/handler.mjs` — search `adminSessionEvents` / `/api/admin/session-events`
  and add the sibling case).

**Auth/ownership**: identical to `adminSessionEvents` — `requireAdmin(req)`,
`getSessionOrNull` → 404 if missing (`adminSessions.mjs:371-375`).

---

## 8. Frontend wiring (RecordingReview.tsx)

1. **API**: add `fetchSessionEditorEvents(password, sessionId)` to
   `frontend/src/api.ts`, **copying `fetchSessionEvents` (`api.ts:1173-1193`)**
   verbatim except the path (`/api/admin/session-editor-events`) and the response
   type (`EditorEventsResponse`). Keep the same graceful 404 → `null` (endpoint
   not deployed) so an old backend just shows no editor markers. Add a demo
   dataset entry mirroring `DEMO_SESSION_EVENTS` (`api.ts:1359`) so demo mode
   renders a couple of paste/burst markers.
2. **State**: add `const [editorEvents, setEditorEvents] = useState<EditorEventItem[]>([])`
   (+ a `truncated` flag if surfacing it) next to `sessionEvents`
   (`RecordingReview.tsx:219`).
3. **Fetch**: in the existing per-session effect
   (`RecordingReview.tsx:441-478`), add a third `try` that calls
   `fetchSessionEditorEvents` and sets `editorEvents` (degrade to `[]` on
   error/404, exactly like the `sessionEvents` block).
4. **Build markers** (memo, next to `markers`/`logEntries`,
   `RecordingReview.tsx:414,483`):
   ```ts
   const notableEditorMarkers = useMemo(
     () => buildNotableEditorMarkers({ events: editorEvents, testStartMs, gaps }),
     [editorEvents, testStartMs, gaps]
   );
   ```
   Optionally cluster dense markers with the existing `clusterMarkers`
   (`recordingTimeline.ts`) the same way `eventClusters` does
   (`RecordingReview.tsx:491`).
5. **Render a new lane**: add a marker lane modeled on the **alert-markers block**
   (`RecordingReview.tsx:1636-1661`) — a distinct shape/color (e.g. amber
   diamonds for `large_paste`, smaller ticks for `paste`, a hollow square for
   `keystroke_burst`) so it's visually separable from alert dots / submission
   ticks / the event lane. Each marker:
   - `left = ((clamp(offsetSec, span.start, span.end) - span.start) / spanDuration) * 100`
     (same formula as `:1637-1638`).
   - `title`/`aria-label` = `marker.label + " · " + formatClock(offsetSec) + (duringGap ? " · during blackout" : "")`.
   - `onClick` → `seekToTestTime(clamped, wantPlaying())` (same as `:1649`), with
     `onMouseDown` `stopPropagation` to avoid starting a scrubber drag (`:1646`).
   Gate the lane on `notableEditorMarkers.length` so it only shows when present.
6. **Activity log integration** (optional but recommended for parity): fold the
   notable editor markers into the `ActivityLogPanel` so they're searchable +
   listed. Cleanest: extend `buildTimelineLog` (`recordingTimeline.ts`) to accept
   an optional `editorMarkers` param and emit `kind: "event"` rows (so the
   existing event toggle + facets pick them up), OR add a new
   `kind: "paste"` with its own toggle. **Decide one** — adding a new kind means
   touching `TimelineLogKind`, `DEFAULT_LOG_FILTERS`, `filterTimelineLog`, the
   counts (`logCounts`, `:495`) and the panel UI. The lighter path (map them into
   existing `event` rows with friendly labels) keeps the activity-log diff near
   zero. **Recommendation: lighter path** — emit them as `event`-kind log entries
   with `type` like `notable_paste`/`notable_burst` and friendly labels, so they
   appear in the log + event filter with no new toggle. The dedicated **timeline
   lane** (step 5) is what makes them prominent; the log is secondary.

---

## 9. Tests / verification

### 9a. Backend (Node test runner — see `backend/test/`)
- New test for `adminSessionEditorEvents`: stub the bucket to return two
  `.ndjson` objects under `…/editor-events/`; assert it parses, projects scalar
  detail (`len`/`insertedLen` kept, `text` excluded), sorts by timestamp, caps +
  sets `truncated`. Mirror an existing `adminSessions`/telemetry test fixture
  setup. Assert 404 on unknown session and admin-auth required.
- Confirm no regression: the existing full backend suite still green
  (`npm test` in `backend/`).

### 9b. Frontend pure logic (vitest — `frontend/src/recordingTimeline.test.ts` is the model)
Add `frontend/src/notableEditorMarkers.test.ts`:
- `large_paste` fires at `len = FOREIGN_PASTE_LEN` (boundary) and for a big
  `editor_insert.insertedLen`; small paste → `paste` kind.
- `keystroke_burst`: 80 single-char inserts inside 2000 ms → one burst; the same
  chars spread over 10 s → none.
- `offsetSec` equals `offsetSecFor(timestamp, testStartMs)`; negative offset for
  a pre-start paste is allowed (matches `buildTimelineLog`).
- `duringGap` true when the offset lands in a supplied gap span.
- empty events / non-finite testStartMs → `[]`.
- N-cap keeps the most notable and never exceeds the cap.
- If `buildTimelineLog` is extended (step 8.6 lighter path), add a case asserting
  the notable markers appear as `event`-kind entries and survive the event-type
  filter — extend `recordingTimeline.test.ts`.

### 9c. E2E (per the project's E2E mandate)
Browser-verify on the dev deploy / `:9222`: open a session with editor pastes in
the Evidence tab, confirm the new lane renders markers, hover shows the label +
time, and a click seeks the `<video>` to that chunk/offset. Screenshot-document
per the proctor E2E+docs mandate. A session known to have editor telemetry can be
found via the eval corpus (any candidate with `paste_ratio > 0`).

---

## 10. Files touched (summary)

| File | Change |
|---|---|
| `backend/src/routes/adminSessions.mjs` | NEW `adminSessionEditorEvents` handler (clone of `adminSessionEvents`, `:370`); export it (`:919`) |
| `backend/src/handler.mjs` | register `GET /api/admin/session-editor-events`; ensure `editorEventsLabel` is in the route ctx |
| `backend/test/…` | NEW test for the endpoint |
| `frontend/src/types.ts` | NEW `EditorEventItem`, `EditorEventsResponse` (near `SessionEventItem`, `:485`) |
| `frontend/src/api.ts` | NEW `fetchSessionEditorEvents` (clone of `:1173`); demo dataset entry |
| `frontend/src/notableEditorMarkers.ts` | NEW pure classifier + types + `NOTABLE` thresholds |
| `frontend/src/notableEditorMarkers.test.ts` | NEW vitest |
| `frontend/src/recordingTimeline.ts` | (lighter path) extend `buildTimelineLog` to accept editor markers as `event` rows |
| `frontend/src/recordingTimeline.test.ts` | (lighter path) add coverage |
| `frontend/src/RecordingReview.tsx` | state + fetch (`:441`), `notableEditorMarkers` memo (`:414`), NEW marker lane (model `:1636-1661`), reuse `seekToTestTime` (`:830`) |

No existing behavior changes; everything is additive and degrades to "no editor
markers" when the endpoint/data is absent.
