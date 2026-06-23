# Admin upload telemetry — REC-4 (truthful stored-chunk count) + REC-5 (pending-upload count)

Status: PROPOSED. Read-only research; cite-grounded against the live tree.
Scope: backend `routes/sessionTelemetry.mjs` + `routes/adminSessions.mjs`,
frontend admin `SessionDetailCard.tsx` + `sessionDetail.ts` + `types.ts`, plus
tests. Behaviour-preserving everywhere except the two corrected/new signals.

---

## 1. Confirmed root cause (REC-4)

### The bug, end to end

The admin "Chunks" metric counts **upload-URL mints, not stored objects.**

`createUploadUrl` in
`backend/src/routes/sessionTelemetry.mjs:90-169` does the following on **every**
POST `/api/upload-url`:

1. Mints a v4 signed WRITE URL — `signingBucket().file(objectKey).getSignedUrl(...)`
   (`sessionTelemetry.mjs:144`).
2. **Unconditionally** increments the per-kind counter on the session doc
   (`sessionTelemetry.mjs:146-158`):

   ```js
   await sessionRef(session.session_id).update({
     updated_at: ...,
     [hwmField]: Math.max(indexHwm, effectiveIndex),
     ...(kind === "camera"
       ? { camera_chunk_count: FieldValue.increment(1) }   // line 156
       : { chunk_count:        FieldValue.increment(1) })   // line 157
   });
   ```

3. Returns the signed URL to the client (`sessionTelemetry.mjs:160-168`).

The increment happens **before the client PUTs anything to GCS, and regardless
of whether the PUT ever succeeds.** The backend has no knowledge of the PUT
outcome — the PUT goes browser → GCS directly (`frontend/src/api.ts:619-627`,
`uploadBlob` does `fetch(uploadUrl, {method:"PUT", ...})`), never back through
the backend.

### Why this over-counts (every path that mints without storing)

The client mints a fresh signed URL on **every upload attempt**, including
retries and drains:

- **Bounded transient retry** — `runUploadWithRetry`
  (`frontend/src/chunkUploadRetry.ts:86-104`) re-runs the attempt up to 5 extra
  times; each attempt calls `getUploadUrl` again
  (`frontend/src/useProctorRecorder.ts:486-498`, the closure at lines 487-493
  re-requests a FRESH URL for the SAME index). N attempts ⇒ N increments, 1
  stored object (or 0 if all fail).
- **Background drainer** — re-mints for buffered chunks
  (`frontend/src/useProctorRecorder.ts:761`, inside `drainRecord`), so a chunk
  uploaded live-then-also-drained, or drained across multiple wakeups, mints
  multiple URLs.
- **Outright failures** — a mint whose PUT then 403s on an expired signature, or
  dies on `net::ERR_CONNECTION_CLOSED` (the documented rev-00008 failure mode,
  `chunkUploadRetry.ts:1-6`), still incremented the counter. Zero bytes stored.
- **hwm re-key** — when a restarted recorder re-requests a low index, the backend
  bumps it to `hwm+1` (`sessionTelemetry.mjs:122-124`) and STILL increments — so
  even the re-keyed mint inflates the count.

Net effect: `chunk_count` is an **upper bound on mint requests**, systematically
≥ the number of objects actually in GCS. On flaky college-hall Wi-Fi (where
retries are the norm — see `chunkUploadRetry.ts:1-6`) the inflation is large,
and the admin's recording-duration estimate (`chunk_count × 30s`,
`frontend/src/admin/sessionDetail.ts:11-19`) is correspondingly inflated.

### Where the wrong number is consumed

- Admin session-detail API returns it verbatim from the doc:
  `backend/src/routes/adminSessions.mjs:329` (`chunk_count`) and `:330`
  (`camera_chunk_count`), inside `adminSessionDetail` (lines 301-344).
- Recording picker + drill-down: `adminSessions.mjs:211-212`, `:282-283`.
- Sessions table cell: `frontend/src/admin/views/SessionsView.tsx:134`.
- Detail card "Chunks" + "Recorded" metrics:
  `frontend/src/admin/views/SessionDetailCard.tsx:73`, `:239-240`,
  via `approxRecordingSeconds` (`sessionDetail.ts:16-19`).

### What the truthful signals ARE (already in the tree)

There are three signals that DO reflect storage reality, none currently surfaced
as the count:

1. **GCS object listing** — the authoritative ground truth. `adminSessions`
   already lists objects under the session prefix
   (`adminSessions.mjs:140-141`, `bucket().getFiles({ prefix })`) for the
   recordings-evidence view. Counting `screen/chunk-*.webm` and
   `camera/chunk-*.webm` keys under the prefix = exactly the stored objects.
2. **`uploaded_manifest_count`** — written at session end
   (`backend/src/routes/session.mjs:710,721`) from the client manifest, which the
   client only appends to on a CONFIRMED 2xx PUT
   (`useProctorRecorder.ts:525-535` screen, `:566-575` camera,
   `:650-656` drain). This is a truthful stored count, but ONLY exists after
   `endSession`, and lumps screen+camera together.
3. **`chunk_uploaded` evidence events** — emitted by the client only after a
   confirmed PUT (`useProctorRecorder.ts:535,575,656`), stored as evidence JSONL
   via `/api/events`. Truthful, but the count requires reading + parsing every
   events object (`adminSessionEvents`, `adminSessions.mjs:370-413`) — expensive
   and noisy.

---

## 2. The correct way to count stored chunks — decision + trade-offs

### Option A — client confirms each store; backend increments only on confirm

Add a tiny `POST /api/chunk-stored` the client calls after a confirmed 2xx PUT
(it already has the success site + storage_key); backend increments a NEW
`stored_chunk_count` / `stored_camera_chunk_count`.

- Pros: live (updates during the exam), per-kind, cheap reads.
- Cons: a NEW write per chunk (doubles telemetry writes), a new round trip the
  recorder must not let block recording, and it's still client-asserted (a
  client that stores but never confirms under-counts). Adds surface area to the
  hot recording path — risky on the exact flaky networks REC-4 is about.

### Option B — derive from GCS object listing on read (CHOSEN for the admin count)

In `adminSessionDetail`, list objects under the session prefix and count the
real `screen/chunk-*` / `camera/chunk-*` keys. Return them as
`stored_chunk_count` / `stored_camera_chunk_count` ALONGSIDE the legacy
`chunk_count` (kept for back-compat + the picker's cheap filter).

- Pros: **ground truth** — counts bytes that exist, immune to mint/retry/drain
  inflation; no new write path; no change to the hot recording path; reuses the
  exact listing already proven in `adminSessions.mjs:140-141`.
- Cons: one `getFiles` call per detail open (today the detail endpoint does zero
  GCS reads by design, `adminSessions.mjs:297-300`). Mitigated: it's a single
  admin-initiated, on-open call (not a poll), uses `maxResults: 1000` like the
  sibling, and the prefix is small (one session). For a session over 1000
  objects the listing must paginate (see build B1 note) — `adminSessions` today
  caps at 1000 and accepts that; a >1000-chunk session is ~8h, so cap + a
  `truncated`-style flag is acceptable, but the count should follow the
  `nextQuery` paging that `listAllUnder` already implements
  (`backend/src/handler.mjs:2070-2092`) to stay exact.

### Option C — stop incrementing on mint; keep a doc counter the client confirms

Combination of A's confirm-write but reusing the existing `chunk_count` field
instead of a new one. Rejected: silently changes the meaning of an existing
field that the picker filter (`adminSessions.mjs:193`) and legacy docs depend
on, and still client-asserted.

### Decision

- **REC-4 admin count → Option B (GCS listing) in `adminSessionDetail`.** It is
  the only ground-truth source and needs no hot-path change. The duration
  estimate in the card switches to the stored count.
- **Keep `chunk_count` / `camera_chunk_count` mint counters AS-IS** but rename
  their *meaning* in the UI to "URL requests"/drop them from the headline. They
  remain useful as a cheap, index-free "has this session ever tried to record"
  signal for the picker filter (`adminSessions.mjs:193`) and must NOT be removed
  (legacy docs + the picker depend on them).
- Do NOT add the per-chunk confirm write (Option A) — it loads the hot path for
  marginal benefit over the listing.

The mint-time increment at `sessionTelemetry.mjs:146-158` is therefore **left
functionally intact** (it's load-bearing for the hwm update and the picker
filter); the fix is to stop *presenting* it as "stored chunks" and present the
GCS-derived count instead.

---

## 3. Pending-upload count (REC-5) — derivation + surfacing

### The data already exists on the doc

The heartbeat persists the client's live buffer depth every interval
(`backend/src/routes/sessionTelemetry.mjs:296-302`):

```js
upload_queue_depth:    Number(body.upload_queue_depth || 0),     // line 296
buffer_pending_chunks: Number(body.buffer_pending_chunks || 0),  // line 300
buffer_pending_bytes:  Number(body.buffer_pending_bytes || 0),   // line 301
```

The comment at `:297-299` literally says these are persisted "for post-exam
telemetry (no admin UI yet; Tier-2 renders the per-candidate indicator)" — REC-5
is that Tier-2 surfacing. `buffer_pending_chunks` is the count of chunks the
client has produced but NOT yet confirmed-stored (the IndexedDB `pending` store,
`frontend/src/chunkBuffer.ts:26-28`); `upload_queue_depth` is the in-flight live
chain depth. Both are reported by the recorder
(`useProctorRecorder.ts` sets `buffer_pending_chunks`/`buffer_pending_bytes` on
the heartbeat body; the doc fields are written at `sessionTelemetry.mjs:296-302`).

### Derivation

"Pending" = chunks produced but not yet provably in GCS, as last reported by the
candidate's heartbeat. Surface the doc fields directly:

- `buffer_pending_chunks` (durable IndexedDB backlog) — the primary REC-5 number.
- `upload_queue_depth` (in-flight live chain) — secondary, shown together.
- `last_heartbeat_at` (already on the doc, returned nowhere in detail today) —
  so a STALE pending count (candidate disconnected mid-flush) is visible, not
  mistaken for live.

A pending count > 0 on a session whose `last_heartbeat_at` is recent and status
`active` = "recording is buffering / not flushing" — exactly the proctor signal
REC-5 asks for. A pending count > 0 with a stale heartbeat = "candidate dropped
with unflushed video" (even louder).

### Surface in the admin session-details API

`adminSessionDetail` (`backend/src/routes/adminSessions.mjs:301-344`) is the
endpoint. Add to the returned `session` object (after line 334, alongside the
other counters):

```js
// REC-4: ground-truth stored chunk counts (GCS listing), not the mint counter.
stored_chunk_count:        storedScreen,
stored_camera_chunk_count: storedCamera,
// REC-5: last-reported client upload backlog (pending = produced-but-not-stored).
buffer_pending_chunks: Number(session.buffer_pending_chunks || 0),
buffer_pending_bytes:  Number(session.buffer_pending_bytes  || 0),
upload_queue_depth:    Number(session.upload_queue_depth    || 0),
last_heartbeat_at:     session.last_heartbeat_at || "",
```

Where `storedScreen`/`storedCamera` come from the new GCS-listing helper (B1).
All fields are least-privilege (counts + a timestamp; no keys, no PII) —
consistent with the endpoint's stated contract (`adminSessions.mjs:297-300`).

### Surface in the admin UI

In `frontend/src/admin/views/SessionDetailCard.tsx`:

- Switch the headline count to stored: `chunkCount` at `:73` becomes
  `detail?.stored_chunk_count ?? detail?.chunk_count ?? session.chunk_count`
  (back-compat fallback for an older backend that doesn't send the stored field),
  and the camera count at `:76` likewise. The "Chunks"/"Recorded" metrics
  (`:239-240`) then reflect stored reality.
- Add a **Pending** metric in the STATS row (after line 246), shown only when
  `detail` is loaded and `buffer_pending_chunks > 0`:
  a `<Metric>` with an `AlertTriangle`/`UploadCloud` icon, label "Pending
  upload", value `${buffer_pending_chunks} chunk(s)` — styled warning when the
  session is `active` and the heartbeat is recent, muted when ended. Reuse the
  existing `Metric` component (`frontend/src/ui/Metric.tsx`, imported at
  `SessionDetailCard.tsx:11`) and the same `lucide-react` icon import line (`:5`).
- Optionally a one-line warning banner (mirroring the IP-change banner pattern at
  `SessionDetailCard.tsx:193-197`) when `buffer_pending_chunks > 0 && status ===
  "active"`: "N chunk(s) not yet uploaded — recording may not be flushing."

### Types

In `frontend/src/types.ts`, extend `SessionCardDetail` (lines 365-394) with the
new OPTIONAL fields so an older backend response still type-checks:

```ts
/** REC-4: ground-truth stored chunk count (GCS listing). */
stored_chunk_count?: number;
stored_camera_chunk_count?: number;
/** REC-5: last-reported client upload backlog. */
buffer_pending_chunks?: number;
buffer_pending_bytes?: number;
upload_queue_depth?: number;
last_heartbeat_at?: string;
```

And update the demo/derived branch of `fetchSessionCardDetail`
(`frontend/src/api.ts:935-979`) so demo mode returns plausible values (e.g.
`stored_chunk_count: row.chunk_count`, `buffer_pending_chunks: 0`).

---

## 4. Build units (right-sized, independently verifiable)

### B1 — backend: GCS-derived stored counts in `adminSessionDetail`
- File: `backend/src/routes/adminSessions.mjs` (route at 301-344).
- Add a helper `countStoredChunks(session)` that lists under
  `sessionPrefix(session)` (reuse the `bucket().getFiles` pattern from lines
  140-141; page via `nextQuery` like `handler.mjs:2070-2092` for >1000 objects)
  and returns `{ screen, camera }` by matching keys
  `…/screen/chunk-*` and `…/camera/chunk-*`.
- In `adminSessionDetail`, `await` it and add `stored_chunk_count`,
  `stored_camera_chunk_count` to the response (after line 334). Keep existing
  `chunk_count`/`camera_chunk_count` lines 329-330 unchanged.
- Verify: extend `backend/test/cameraRecording.test.mjs` ("admin session-detail"
  group at lines 420-442). New test: mint 3 screen URLs but only PUT 1 (use the
  fake storage `.save()` directly to place ONE `screen/chunk-00000.webm` under
  the prefix, then call detail) → assert `chunk_count === 3` (mint counter
  unchanged) AND `stored_chunk_count === 1`. This is the regression that proves
  REC-4. The fake `getFiles` (`cameraRecording.test.mjs:161-171`) already filters
  by prefix from `_saved`, so a test must `.save()` the objects it wants counted.

### B2 — backend: surface pending fields in `adminSessionDetail`
- File: `backend/src/routes/adminSessions.mjs`, same route.
- Add `buffer_pending_chunks`, `buffer_pending_bytes`, `upload_queue_depth`,
  `last_heartbeat_at` to the response (Number()/string-default coerced, matching
  the existing `Number(session.x || 0)` style at lines 328-334).
- Verify: new test in `cameraRecording.test.mjs` — seed a session with
  `buffer_pending_chunks: 4, upload_queue_depth: 2, last_heartbeat_at: <iso>`,
  call detail, assert the four fields round-trip. A legacy doc (fields absent)
  → asserts 0/0/0/"".

### B3 — frontend types + api
- File: `frontend/src/types.ts` — extend `SessionCardDetail` (B-spec §3 Types).
- File: `frontend/src/api.ts` — add the fields to the real-response mapping in
  `fetchSessionCardDetail` (around `:957-964`) and to the demo branch.
- Verify: `tsc` (frontend typecheck) is green; no behaviour test needed (pure
  shape).

### B4 — frontend UI: stored count + pending metric
- File: `frontend/src/admin/views/SessionDetailCard.tsx`.
- Repoint `chunkCount`/`cameraChunkCount` (`:73`,`:76`) to the stored fields with
  fallback; add the "Pending upload" `<Metric>` + optional warning banner (§3 UI).
- Verify: add `frontend/src/admin/sessionDetailCard.test.tsx` (or extend
  `sessionDetail.test.ts` for pure-logic helpers) — render the card with a detail
  carrying `stored_chunk_count: 1, chunk_count: 3, buffer_pending_chunks: 4` and
  assert the headline shows the stored 1 (not 3) and the Pending metric shows 4;
  render with `buffer_pending_chunks: 0` and assert no Pending metric. If the
  repo has no component-render harness for admin views, instead factor a pure
  `pendingUploadAffordance(detail)` helper into `sessionDetail.ts` (mirrors
  `viewRecordingAffordance`, `:150`) and unit-test that in
  `sessionDetail.test.ts`.

### B5 — verify no consumer of the mint counter regressed
- Grep `chunk_count` consumers (SessionsView `:134`, picker `adminSessions.mjs`
  `:193`,`:211`,`:282`) stay on the legacy field — they MUST NOT switch to the
  stored count (the picker filter is intentionally cheap/index-free). Confirm the
  full backend suite + frontend suite are green.

---

## 5. Tests to add (summary)

| Test | File | Asserts |
|---|---|---|
| REC-4 regression: 3 mints, 1 stored | `backend/test/cameraRecording.test.mjs` | `chunk_count===3` AND `stored_chunk_count===1` |
| stored camera count | `backend/test/cameraRecording.test.mjs` | `stored_camera_chunk_count` matches saved camera objects |
| listing pagination (>1000) | `backend/test/cameraRecording.test.mjs` | count is exact across pages (if B1 paginates) |
| REC-5 pending round-trip | `backend/test/cameraRecording.test.mjs` | `buffer_pending_chunks/upload_queue_depth/last_heartbeat_at` returned |
| REC-5 legacy doc defaults | `backend/test/cameraRecording.test.mjs` | absent fields → 0/0/"" |
| UI: stored count wins, pending shows | `frontend` admin test (B4) | headline = stored; Pending metric gated on >0 |

---

## 6. Risks / notes

- **Extra GCS read on detail open.** `adminSessionDetail` is documented as
  zero-GCS (`adminSessions.mjs:297-300`); B1 changes that. It is one
  admin-initiated, prefix-scoped `getFiles` per open (not a poll). Acceptable,
  but note it in the route comment. If detail is ever auto-polled, add a short
  cache or gate the listing behind a query flag.
- **>1000-object sessions** must paginate the listing or the stored count
  under-reports — B1 must follow `nextQuery` (`handler.mjs:2070-2075`) rather
  than the bare `maxResults:1000` of `adminSessions.mjs:141`.
- **Do not remove the mint-time increment** (`sessionTelemetry.mjs:146-158`) —
  it also advances the per-kind hwm (`:151`) and feeds the picker filter
  (`adminSessions.mjs:193`). REC-4 is a *presentation* fix (truthful source for
  the count shown), not a removal.
- **Pending is candidate-asserted + last-known.** A disconnected candidate's
  pending count freezes at its last heartbeat; surfacing `last_heartbeat_at`
  alongside is what makes it honest. The GCS stored count is the only fully
  server-authoritative number.
- **`uploaded_manifest_count`** (`session.mjs:721`) is an alternative truthful
  count but only exists post-end and is screen+camera combined; the GCS listing
  is preferred for live + per-kind. Could be shown for ended sessions as a
  cross-check, out of scope here.
