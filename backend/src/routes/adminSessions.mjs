// backend/src/routes/adminSessions.mjs — the ADMIN session-management routes
// (sessions search / recording-sessions picker / sessions-list drill-down /
// session-detail / session-events / ip-report / attendance / session-action /
// session-details bulk lookup), as a FACTORY (decomp B14, plan §1.2).
// makeAdminSessionsRoutes(ctx) closes over the handler-built ctx (per ?buster
// instance) and returns the route handlers + the end-now sweep handler.mjs
// passes by reference into the adminContests ctx.
//
// RAW-WHERE SITES #2/#3/#4 (scopingLint): this module owns the remaining three
// grandfathered raw contest_slug equality filters —
//   #2 endAllLiveSessions   end-now sweep, per-session slug semantics (the slug
//                           comes from the request, paginated by document id)
//   #3 resolveActionTargets bulk POST body where the slug comes straight from the
//                           request, not a resolved contest doc
//   #4 adminSessionDetails  same request-supplied slug contract
// The scopingLint allowlist is re-pinned to { "routes/session.mjs": 1,
// "routes/adminSessions.mjs": 3 } in the SAME commit as this move (the count bump
// IS the review flag). These stay RAW deliberately (move-with-pin) — migrating
// them through scopedQuery to an empty allowlist is a separate, operator-gated
// decision, not part of this behavior-preserving move.
//
// SHARED helper RETURNED for single-source reuse by code outside this module
// (never forked): endAllLiveSessions — the adminContests end_now path (B4 ctx)
// reuses it; makeAdminSessionsRoutes is instantiated BEFORE makeAdminContestsRoutes
// so the const return is available for that ctx (passed BY REFERENCE).
//
// CROSS-FACTORY helpers kept RESIDENT in handler.mjs (single source) and passed in
// BY REFERENCE here, because EARLIER factories / still-resident code already
// consume them and a const return would land in their temporal dead zone or fork
// the single source:
//   normalizeRoomFilter      — alerts / healthCheck ctxs
//   isStaleSession           — invigilator / healthCheck ctxs
//   contestScopeOf           — many resident admin GETs + this module
//   personContestForFilter   — the resultsRoutes ctx + the resident selection /
//                              selection-done / export cluster (B8 note)
//   candidateOf / parseCaptureState / getRosterMeta / releaseLiveSlot /
//   takeOverLiveSlot         — single-sourced from their owning factories.
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as the other route domains: getFirestore is a GETTER so the
// fake-Firestore swap propagates.
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*). Nothing is imported here — every dependency (the live Firestore
// getter + FieldPath, the http transport helpers, the admin auth guard, the
// neutral session-store helpers, the storage clients, the sanitizers / client
// helpers, the identity adapter + capture-state parser, the contest/identity/roster
// domain fns, the ip-report builder, the resident room/staleness/scope/person-filter
// helpers + the session-lifecycle factory's releaseLiveSlot/takeOverLiveSlot BY
// REFERENCE, and the env-captured collection names / caps BY VALUE) arrives through
// ctx, so the env-capture-at-load semantics stay in handler.mjs (env-lint).

export function makeAdminSessionsRoutes(ctx) {
  const {
    getFirestore,
    FieldPath,
    // http transport helpers (lib/http)
    parseBody,
    badRequest,
    httpError,
    // admin auth guard (lib/auth)
    requireAdmin,
    // neutral session store (lib/sessionStore, by reference)
    sessionRef,
    getSessionOrNull,
    sessionPrefix,
    candidateOf,
    // storage clients (lib/clients, by reference)
    bucket,
    signingBucket,
    // sanitizers / concurrency / client helpers (lib/sanitize, by reference)
    mapWithConcurrency,
    normalizeUsername,
    normalizeUniqueId,
    // domain fns (src/*) by reference
    scopedQuery,
    resolveContest,
    getRosterMeta,
    getContestRosterMeta,
    listEnrollments,
    getPersonsByIds,
    getCollegeNameMap,
    buildIpReport,
    // proctorAlerts / enforcement domain helpers (by reference)
    parseCaptureState,
    sanitizeExemptions,
    // session-lifecycle factory returns (by reference) — admin actions release /
    // take over the live slot exactly like the candidate end path.
    releaseLiveSlot,
    takeOverLiveSlot,
    // resident cross-factory helpers kept hoisted in handler.mjs (by reference)
    contestScopeOf,
    normalizeRoomFilter,
    isStaleSession,
    personContestForFilter,
    // env-captured collection names / caps (by value at load)
    sessionCollection,
    rosterCollection,
    sessionsQueryLimit,
    sessionsListPageLimit,
    rosterLimit,
    reviewRosterLimit,
    // EVID-1: the editor-events GCS sub-prefix label (default "editor-events",
    // backend/src/config.mjs:53) — the prefix adminSessionEditorEvents lists.
    editorEventsLabel
  } = ctx;

async function adminSessions(req) {
  requireAdmin(req);
  // FIX-B1: the recording-review player resolves a session by its STORED key.
  // An EXACT `username_norm` (no re-normalization) is the authoritative lookup —
  // it matches BOTH legacy docs (username_norm = normalized candidate) AND
  // person-mode docs (username_norm = person_id = "{college_norm}~{uid_norm}").
  // The legacy `username` param re-normalizes the value and is kept for full
  // back-compat (older callers, manual candidate-id entry). When both are sent,
  // the exact `username_norm` wins. A normalized `username` can NEVER equal a
  // college-prefixed person_id, which is exactly why person sessions were dead.
  const usernameNormExact = req.query?.username_norm;
  const username = req.query?.username;
  if (!usernameNormExact && !username) return badRequest("username is required");

  // S-D (A1: "selector scopes every tab"): the review search honours the
  // OPTIONAL global contest filter like every other admin GET. Under person
  // identity the same person_id recurs across rounds BY DESIGN, so an unscoped
  // username search would interleave Round-1 sessions into a Round-2 review.
  const scope = await contestScopeOf(req.query?.contest_slug);
  const usernameNorm = usernameNormExact
    ? String(usernameNormExact)
    : normalizeUsername(username);
  const snapshot = await scopedQuery(getFirestore().collection(sessionCollection), scope)
    .where("username_norm", "==", usernameNorm)
    .limit(50)
    .get();

  const sessions = await Promise.all(snapshot.docs
    .map((doc) => doc.data())
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, 20)
    .map(async (item) => {
      // Admin-evidence listing MUST use the same prefix the upload sites wrote
      // to, or it lists nothing. sessionPrefix() reads the persisted
      // storage_prefix (legacy docs fall back to the reconstructed legacy path).
      const prefix = sessionPrefix(item);
      const [files] = await bucket().getFiles({ prefix, maxResults: 1000 });
      // Sign read URLs with BOUNDED concurrency and WITHOUT a redundant per-file
      // getMetadata() call — getFiles already populates file.metadata. Heavy
      // recordings have 200+ chunk files; the previous code fired 2 calls per file
      // (getMetadata + getSignedUrl) all at once, so a single request fanned out
      // into ~400 simultaneous GCS/IAM calls and 500'd on the small Cloud Run
      // instance. Capping concurrency keeps a heavy session well under the timeout.
      const evidence = await mapWithConcurrency(files, 12, async (file) => {
        // Listing fanned out via the main client above (getFiles); sign each
        // chunk's read URL through the signing client (local crypto off the key,
        // no token) so playback URLs don't hit the flaky external token endpoint.
        const [downloadUrl] = await signingBucket().file(file.name).getSignedUrl({
          version: "v4",
          action: "read",
          expires: Date.now() + 3600 * 1000
        });
        const meta = file.metadata || {};
        return {
          key: file.name,
          size: Number(meta.size || 0),
          last_modified: meta.updated,
          download_url: downloadUrl
        };
      });
      // F6.6: structured per-source capture state so the recordings-review
      // header can say what the loaded recording contains (screen video +
      // mic audio? camera live-monitor only?) without re-parsing the raw
      // composite recording_state client-side.
      return { ...item, evidence, capture_state: parseCaptureState(item.recording_state) };
    }));

  return { sessions };
}

// Screen-recording playback picker (admin): a LIGHTWEIGHT list of sessions that
// actually have recorded chunks, so the console can present a username/session
// picker WITHOUT a GCS listing or any signed URLs (those are resolved lazily via
// adminSessions when one is chosen). We query the session collection, prefer docs
// with chunk_count > 0, optionally scope to a contest, sort newest-first, and cap
// the result. If the chunk_count filter would return nothing (e.g. legacy docs
// that never tracked chunk_count), we fall back to ALL sessions so the picker is
// never empty against older data.
async function adminRecordingSessions(req) {
  requireAdmin(req);
  const scope = await contestScopeOf(req.query?.contest_slug);
  const snapshot = await scopedQuery(getFirestore().collection(sessionCollection), scope)
    .limit(sessionsQueryLimit)
    .get();
  const allDocs = snapshot.docs.map((doc) => doc.data());

  // Prefer sessions with recorded chunks; fall back to ALL when none report a
  // positive chunk_count (legacy docs) so the picker still lists something.
  const withChunks = allDocs.filter((doc) => Number(doc.chunk_count || 0) > 0);
  const source = withChunks.length ? withChunks : allDocs;

  const sessions = source
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, 500)
    .map((doc) => ({
      session_id: doc.session_id,
      hackerrank_username: doc.hackerrank_username || "",
      candidate_id: candidateOf(doc).id, // S-C dual-read adapter (F9 §1.2)
      // FIX-B1: the EXACT stored lookup key. The player keys loadUser on this
      // (NOT candidate_id) so person-mode rows — username_norm = person_id =
      // "{college_norm}~{uid_norm}" — resolve via adminSessions; candidate_id
      // remains the human display label only.
      username_norm: doc.username_norm || "",
      name: doc.name || "",
      room: doc.room || "",
      contest_slug: doc.contest_slug || "",
      chunk_count: Number(doc.chunk_count || 0),
      camera_chunk_count: Number(doc.camera_chunk_count || 0),
      created_at: doc.created_at || "",
      status: doc.status || ""
    }));

  return { sessions };
}

// Sessions drill-down (admin): the ALL-DOCS (including zero-chunk) counterpart
// to adminRecordingSessions. adminRecordingSessions intentionally lists only
// sessions that actually recorded chunks (the playback picker), so it CANNOT
// back the stat-card drill-down — a pending_approval second-device session has
// chunk_count:0 and would be filtered out, hiding the very rows the
// pending_approval Approve action needs to reach. This endpoint lists EVERY
// session doc, classifies each by the SAME rules as adminStats (so the row
// counts match the stat-card counts exactly), and supports room filtering, so
// the console's per-stat-card drill-down lands on the right sessions.
async function adminSessionsList(req) {
  requireAdmin(req);
  const scope = await contestScopeOf(req.query?.contest_slug);
  const room = normalizeRoomFilter(req.query?.room);
  const status = String(req.query?.status || "");
  const snapshot = await scopedQuery(getFirestore().collection(sessionCollection), scope)
    .limit(sessionsQueryLimit)
    .get();
  let docs = snapshot.docs.map((doc) => doc.data());
  if (room) docs = docs.filter((doc) => String(doc.room || "") === room);
  const nowMs = Date.now();
  const matchesStatus = (doc) => {
    switch (status) {
      case "": return true;
      case "active": return doc.status === "active";
      case "disconnected": return doc.status === "active" && isStaleSession(doc, nowMs);
      case "locked": return doc.status === "locked";
      case "pending_approval": return doc.status === "pending_approval";
      case "ended": return doc.status === "ended";
      default: return false;
    }
  };
  const matched = docs.filter(matchesStatus);
  const byNewest = (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""));
  // F6 review: the page is capped, but LIVE (non-ended) rows must never be
  // displaced by newer ended rows — the alerts-console status join (F6.4)
  // reads this list to decide which actions a live candidate gets, and cutting
  // a live row would silently hide their Lock/End. Select every live row first
  // (they are the actionable ones), fill the remainder with the newest ended
  // rows, then present the final page newest-first as before.
  const live = matched.filter((doc) => doc.status !== "ended").sort(byNewest);
  const ended = matched.filter((doc) => doc.status === "ended").sort(byNewest);
  const page = live.slice(0, sessionsListPageLimit)
    .concat(ended.slice(0, Math.max(0, sessionsListPageLimit - live.length)))
    .sort(byNewest);
  // truncated = live coverage may be incomplete: the raw query hit its cap (it
  // has no orderBy, so ARBITRARY docs — live ones included — may be missing
  // from the snapshot) or more live rows matched than the page holds. Status-
  // join consumers must treat a truncated list like no list at all and fall
  // back to the full action set; ended rows cut by the cap don't matter (an
  // ended session takes no session action anyway).
  const truncated = snapshot.docs.length >= sessionsQueryLimit || live.length > sessionsListPageLimit;
  const sessions = page
    .map((doc) => ({
      session_id: doc.session_id,
      hackerrank_username: doc.hackerrank_username || "",
      candidate_id: candidateOf(doc).id, // S-C dual-read adapter (F9 §1.2)
      // FIX-B1: stored lookup key so the "View recording" deep link from this
      // drill-down can resolve person-mode sessions (username_norm = person_id).
      username_norm: doc.username_norm || "",
      name: doc.name || "",
      room: doc.room || "",
      contest_slug: doc.contest_slug || "",
      chunk_count: Number(doc.chunk_count || 0),
      camera_chunk_count: Number(doc.camera_chunk_count || 0),
      created_at: doc.created_at || "",
      status: doc.status || "",
      // F-C (real-data hardening): loud admin-visible signal — this session started
      // anonymously on a contest that HAS an enrollment spine (typed id
      // resolved to no person). False/absent everywhere else.
      identity_unresolved: doc.identity_unresolved === true
    }));
  return { sessions, truncated };
}

// REC-4 — GROUND-TRUTH stored chunk counts from the GCS listing, NOT the
// mint-time chunk_count counter (which over-counts: it increments on every
// signed-URL mint, including retries/drains/failed PUTs that store nothing —
// see docs/proposed/admin-upload-telemetry.md §1). We list the session prefix
// and count the real screen/chunk-* and camera/chunk-* objects that exist.
//
// Paginated MANUALLY (autoPaginate:false + follow nextQuery, mirroring the
// per-contest tally in handler.mjs:~2067-2078) so a session over the 1000-object
// page cap (~8h of recording) still counts exactly across pages rather than
// silently truncating. getFiles destructures to [files, nextQuery]; a storage
// client that returns only [files] (no nextQuery) ends the loop after one page.
// A hard page ceiling guards against a runaway listing.
async function countStoredChunks(session) {
  const prefix = sessionPrefix(session);
  const screenPrefix = `${prefix}screen/chunk-`;
  const cameraPrefix = `${prefix}camera/chunk-`;
  let screen = 0;
  let camera = 0;
  let query = { prefix, autoPaginate: false, maxResults: 1000 };
  for (let page = 0; page < 1000 && query; page++) {
    const [files, nextQuery] = await bucket().getFiles(query);
    for (const file of files || []) {
      const name = file?.name || "";
      if (name.startsWith(screenPrefix)) screen += 1;
      else if (name.startsWith(cameraPrefix)) camera += 1;
    }
    query = nextQuery || null;
  }
  return { screen, camera };
}

// Session detail (admin) — F6.3: ONE session doc for the Sessions detail card,
// projected to the least-privilege fields the card actually shows: identity
// (incl. the roster id the candidate verified against), status, the IP block
// (start/current + mid-exam change count), and the doc's own activity counters
// (events/heartbeats/chunks — all already maintained on the doc, zero extra
// reads). Deliberately NO email, NO storage_prefix/keys, NO evidence/signed
// URLs (the recordings view resolves those itself when the admin jumps there).
//
// REC-4/REC-5 EXCEPTION to "zero GCS reads": this route now does ONE
// admin-initiated, prefix-scoped getFiles per open (countStoredChunks) to
// return the ground-truth stored-chunk count. It is on-open, not a poll; if
// detail is ever auto-polled, gate the listing behind a query flag or cache it.
async function adminSessionDetail(req) {
  requireAdmin(req);
  const sessionId = String(req.query?.session_id || "");
  if (!sessionId) return badRequest("session_id required");
  const session = await getSessionOrNull(sessionId);
  if (!session) throw httpError(404, "Session not found");
  // REC-4: count the objects that actually exist in GCS (ground truth).
  const stored = await countStoredChunks(session);
  // REC-5: pending = chunks the candidate produced but hasn't provably stored,
  // from the client's last heartbeat (its durable IndexedDB backlog —
  // docs/proposed/admin-upload-telemetry.md §3). Deliberately NOT mints − stored:
  // that delta is retry/drain inflation (exactly what REC-4 exposes) and is
  // non-zero even when every chunk uploaded cleanly, so using it would
  // false-alarm "pending" on any retried session. The mint-vs-stored gap is
  // already visible to the admin as chunk_count vs stored_chunk_count.
  const reportedPending = Number(session.buffer_pending_chunks || 0);
  return {
    session: {
      session_id: session.session_id,
      hackerrank_username: session.hackerrank_username || "",
      // S-C: dual-read identity (F9 §1.2) + the person components so the card
      // can link to the person and disambiguate multi-college contests.
      candidate_id: candidateOf(session).id,
      identity_label: candidateOf(session).label,
      person_id: session.person_id ?? null,
      college_norm: session.college_norm || "",
      name: session.name || "",
      roll_number: session.roll_number || "",
      roster_unique_id: session.roster_unique_id || "",
      room: session.room || "",
      contest_slug: session.contest_slug || "",
      status: session.status || "",
      created_at: session.created_at || "",
      updated_at: session.updated_at || "",
      blocked_by_session_id: session.blocked_by_session_id || null,
      start_ip: session.start_ip || "",
      current_ip: session.current_ip || session.start_ip || "",
      ip_change_count: Number(session.ip_change_count || 0),
      // Mint counter (legacy, back-compat): increments on every signed-URL mint,
      // so it OVER-counts stored objects. Kept verbatim for the picker filter +
      // high-water-mark; the UI no longer presents it as "stored chunks".
      chunk_count: Number(session.chunk_count || 0),
      camera_chunk_count: Number(session.camera_chunk_count || 0),
      // REC-4: GROUND-TRUTH stored chunk counts from the GCS listing above.
      // These are what the card's headline + duration math should read.
      stored_chunk_count: stored.screen,
      stored_camera_chunk_count: stored.camera,
      // REC-5: pending-upload signal — chunks the candidate produced but hasn't
      // provably stored, from the client's last heartbeat (durable IndexedDB
      // backlog). The raw fields are surfaced alongside so a STALE count (see
      // last_heartbeat_at) is distinguishable from a live one.
      pending_upload_count: reportedPending,
      buffer_pending_chunks: reportedPending,
      buffer_pending_bytes: Number(session.buffer_pending_bytes || 0),
      upload_queue_depth: Number(session.upload_queue_depth || 0),
      last_heartbeat_at: session.last_heartbeat_at || "",
      event_count: Number(session.event_count || 0),
      clipboard_event_count: Number(session.clipboard_event_count || 0),
      focus_event_count: Number(session.focus_event_count || 0),
      heartbeat_count: Number(session.heartbeat_count || 0),
      // F6.6: last-reported per-source capture state (null until a composite
      // heartbeat arrives) — the card's screen/camera/mic rows.
      capture_state: parseCaptureState(session.recording_state),
      // F5.3/F5.5: why a locked session is locked (enforcement vs admin) +
      // the per-session exemption toggles the card renders.
      locked_reason: session.locked_reason || null,
      enforcement_exemptions: sanitizeExemptions(session.enforcement_exemptions)
    }
  };
}

const SESSION_EVENTS_LIMIT = 2000;
const SESSION_EVENT_DETAIL_STRING_MAX = 200;
const SESSION_EVENT_DETAIL_KEY_MAX = 8;
// GCS object keys inside detail (chunk_uploaded carries storage_key) stay
// server-side — the admin evidence listing is the sanctioned path to keys.
const SESSION_EVENT_DETAIL_EXCLUDED_KEYS = new Set(["storage_key"]);

// Project a stored event detail to a SMALL flat object: scalar values only
// (strings truncated), excluded keys dropped, bounded key count. Never throws.
// The excluded-keys set is a parameter (default = the session-event set) so the
// editor-events route can pass a wider set that also drops the text/text_preview
// blobs without forking this projection (EVID-1).
function projectSessionEventDetail(detail, excludedKeys = SESSION_EVENT_DETAIL_EXCLUDED_KEYS) {
  const out = {};
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return out;
  let kept = 0;
  for (const [key, value] of Object.entries(detail)) {
    if (kept >= SESSION_EVENT_DETAIL_KEY_MAX) break;
    if (excludedKeys.has(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, SESSION_EVENT_DETAIL_STRING_MAX);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else continue; // nested objects/arrays/null: dropped, scalars only
    kept += 1;
  }
  return out;
}

async function adminSessionEvents(req) {
  requireAdmin(req);
  const sessionId = String(req.query?.session_id || "");
  if (!sessionId) return badRequest("session_id required");
  const session = await getSessionOrNull(sessionId);
  if (!session) throw httpError(404, "Session not found");

  const prefix = `${sessionPrefix(session)}events/`;
  const [files] = await bucket().getFiles({ prefix, maxResults: 1000 });
  // Download + parse with bounded concurrency (same rationale as the evidence
  // listing). A malformed line or unreadable object is skipped, never fatal.
  const batches = await mapWithConcurrency(files, 12, async (file) => {
    try {
      const [contents] = await file.download();
      return String(contents)
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((record) => record && typeof record === "object");
    } catch {
      return [];
    }
  });

  const events = batches
    .flat()
    .map((record) => ({
      type: String(record.type || "unknown"),
      timestamp: String(record.timestamp || ""),
      detail: projectSessionEventDetail(record.detail)
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    events: events.slice(0, SESSION_EVENTS_LIMIT),
    truncated: events.length > SESSION_EVENTS_LIMIT
  };
}

// EVID-1: editor-event keystroke streams are far denser than the proctor event
// stream (one record per insert/paste), so they get their OWN, larger cap — the
// client classifier needs enough of the raw stream to sum keystroke bursts before
// the server clips it. Mirrors SESSION_EVENTS_LIMIT's slice + truncated discipline.
const EDITOR_EVENTS_READ_LIMIT = 8000;
// detail.text / detail.text_preview carry the actual inserted source (up to 2000
// chars, sanitizeEditorDetail). The marker lane only needs scalar counts
// (len/insertedLen), so we EXCLUDE the text blobs from this projection to keep the
// admin payload small and avoid shipping pasted source to the timeline.
const EDITOR_EVENT_DETAIL_EXCLUDED_KEYS = new Set([
  ...SESSION_EVENT_DETAIL_EXCLUDED_KEYS,
  "text",
  "text_preview"
]);

// EVID-1 — GET /api/admin/session-editor-events?session_id= : the candidate's
// per-session EDITOR event stream (paste/insert/replace/keystroke), stored as
// NDJSON under the session's `editor-events/` prefix. Modeled VERBATIM on
// adminSessionEvents (same admin auth, 404-on-missing, bounded-concurrency
// download, per-line parse, scalar-only least-privilege projection, cap +
// truncated), differing only in the prefix and the text-excluding projection.
// The recording Evidence tab classifies this stream into notable paste/keystroke
// markers client-side (docs/proposed/evidence-keystroke-markers.md).
async function adminSessionEditorEvents(req) {
  requireAdmin(req);
  const sessionId = String(req.query?.session_id || "");
  if (!sessionId) return badRequest("session_id required");
  const session = await getSessionOrNull(sessionId);
  if (!session) throw httpError(404, "Session not found");

  const prefix = `${sessionPrefix(session)}${editorEventsLabel}/`;
  // MANUAL pagination (autoPaginate:false + follow nextQuery), mirroring REC-4's
  // countStoredChunks above: editor-event streams are the densest objects in a
  // session and the most likely to exceed the 1000-object page cap, so a
  // single-page getFiles would SILENTLY drop later objects. A storage client
  // that returns only [files] (no nextQuery) ends the loop after one page; a
  // hard page ceiling guards a runaway listing.
  const files = [];
  let query = { prefix, autoPaginate: false, maxResults: 1000 };
  for (let page = 0; page < 1000 && query; page++) {
    const [pageFiles, nextQuery] = await bucket().getFiles(query);
    for (const file of pageFiles || []) files.push(file);
    query = nextQuery || null;
  }
  // Download + parse with bounded concurrency (same rationale as the evidence
  // listing). A malformed line or unreadable object is skipped, never fatal.
  const batches = await mapWithConcurrency(files, 12, async (file) => {
    try {
      const [contents] = await file.download();
      return String(contents)
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((record) => record && typeof record === "object");
    } catch {
      return [];
    }
  });

  const events = batches
    .flat()
    .map((record) => ({
      type: String(record.type || "unknown"),
      timestamp: String(record.timestamp || ""),
      // problem_id is stamped per-record on ingest (sessionTelemetry.mjs:238) —
      // surfaced so a marker can name which problem the paste/burst landed in.
      problem_id: record.problem_id == null ? null : String(record.problem_id).slice(0, 64),
      detail: projectSessionEventDetail(record.detail, EDITOR_EVENT_DETAIL_EXCLUDED_KEYS)
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    events: events.slice(0, EDITOR_EVENTS_READ_LIMIT),
    truncated: events.length > EDITOR_EVENTS_READ_LIMIT
  };
}

// S5: end every non-ended session in the given contest scope. Mirrors
// applySessionAction("end") — status:ended
// + ended_at + live-slot release — with a distinct ended_reason for the audit
// trail, applied with bounded concurrency so an 800-session end-now never fans
// out unbounded. Returns the number of sessions ended.
//
// D3: paginated by document id — a single sessionsQueryLimit-capped query
// silently stranded live sessions past the first 2000 docs (multi-day slug
// reuse). orderBy(documentId) + startAfter rides the automatic single-field
// index on contest_slug (every index ends with __name__), so no composite
// index is needed.
async function endAllLiveSessions(contestSlug, now) {
  let endedCount = 0;
  let cursor = null;
  for (;;) {
    let query = getFirestore()
      .collection(sessionCollection)
      .where("contest_slug", "==", contestSlug || "")
      .orderBy(FieldPath.documentId())
      .limit(sessionsQueryLimit);
    if (cursor !== null) query = query.startAfter(cursor);
    const snapshot = await query.get();
    const live = snapshot.docs.map((doc) => doc.data()).filter((doc) => doc.status !== "ended");
    await mapWithConcurrency(live, 12, async (session) => {
      await sessionRef(session.session_id).update({
        status: "ended", ended_at: now, updated_at: now, ended_reason: "exam_ended_by_admin"
      });
      await releaseLiveSlot(session);
    });
    endedCount += live.length;
    if (snapshot.docs.length < sessionsQueryLimit) break;
    cursor = snapshot.docs[snapshot.docs.length - 1].id;
  }
  return endedCount;
}

// S7 — IP-wise report of logged-in users (proxy-detection signal). Groups the
// contest's session docs by the IP we already capture (current_ip, refreshed by
// every heartbeat; start_ip fallback) and returns counts + a bounded candidate
// sample per IP — see backend/src/ipReport.mjs. scope=live (default) reports
// non-ended sessions ("logged-in users"); scope=all adds ended sessions for
// after-the-exam forensics. Query/filter pattern mirrors adminSessionsList.
async function adminIpReport(req) {
  requireAdmin(req);
  const contestSlug = req.query?.contest_slug;
  const contestScope = await contestScopeOf(contestSlug);
  const room = normalizeRoomFilter(req.query?.room);
  const scope = String(req.query?.scope || "live");
  if (scope !== "live" && scope !== "all") return badRequest("scope must be live or all");

  const snapshot = await scopedQuery(getFirestore().collection(sessionCollection), contestScope)
    .limit(sessionsQueryLimit)
    .get();
  let docs = snapshot.docs.map((doc) => doc.data());
  if (room) docs = docs.filter((doc) => String(doc.room || "") === room);
  if (scope === "live") docs = docs.filter((doc) => doc.status && doc.status !== "ended");

  return {
    contest_slug: contestSlug ? String(contestSlug) : null,
    room: room || null,
    scope,
    ...buildIpReport(docs)
  };
}

// GET /api/admin/attendance?contest_slug=<optional> — roster-based attendance:
// taken / not-taken counts + the absentee list. "Taken" = the roster student has
// AT LEAST ONE session doc whose roster_unique_id matches their ACTIVE-version
// roster entry (any status — pending_approval/locked still means they showed
// up); "in_progress" = any of their sessions is non-ended; "completed" = all
// ended. Sessions that can't be tied to the active roster (legacy pre-roster,
// blank id, replaced-roster ids) are surfaced as unmatched_sessions — never
// silently dropped, never counted as attendance. Absentee rows carry ONLY the
// mapped identity fields (unique_id, name, roll_number, room) — no email, no
// raw roster fields (PII minimization). Computed on demand: one version-
// filtered roster scan + one session scan, joined in memory (no new state, no
// composite index — both filters are single-field equalities). The admin UI
// loads this on tab-open + manual refresh only (NO auto-poll).
async function adminAttendance(req) {
  requireAdmin(req);
  const contestSlug = req.query?.contest_slug;
  // S-C: a contest_slug naming a real person contest reads ITS OWN roster
  // (roster_meta::{slug}) and joins sessions by person_id; any other filter
  // value keeps today's global-roster path bit-for-bit.
  const personContest = await personContestForFilter(contestSlug);
  if (personContest) return personContestAttendance(personContest);
  const meta = await getRosterMeta();
  if (!meta) return { configured: false };

  // Active-version roster entries (stale versions are invisible — S2 invariant).
  const entriesSnap = await getFirestore()
    .collection(rosterCollection)
    .where("roster_version", "==", meta.version)
    .limit(rosterLimit)
    .get();
  const entries = entriesSnap.docs.map((doc) => doc.data());

  // Session docs, optionally contest-scoped (same pattern as adminStats).
  const sessionsSnap = await scopedQuery(getFirestore().collection(sessionCollection), await contestScopeOf(contestSlug))
    .limit(sessionsQueryLimit)
    .get();
  const sessions = sessionsSnap.docs.map((doc) => doc.data());

  // norm unique id -> true when ANY of that student's sessions is still live.
  const knownNorms = new Set(entries.map((entry) => String(entry.unique_id_norm || "")));
  const liveByNorm = new Map();
  let unmatched = 0;
  for (const session of sessions) {
    const idNorm = normalizeUniqueId(String(session.roster_unique_id || ""));
    if (!idNorm || !knownNorms.has(idNorm)) {
      unmatched += 1;
      continue;
    }
    const live = session.status !== "ended";
    liveByNorm.set(idNorm, Boolean(liveByNorm.get(idNorm)) || live);
  }

  const mapping = meta.column_mapping || {};
  const mappedField = (entry, name) =>
    (mapping[name] ? String(entry.fields?.[mapping[name]] || "") : "");
  const taken = { total: 0, in_progress: 0, completed: 0 };
  const absentees = [];
  for (const entry of entries) {
    const idNorm = String(entry.unique_id_norm || "");
    if (liveByNorm.has(idNorm)) {
      taken.total += 1;
      if (liveByNorm.get(idNorm)) taken.in_progress += 1;
      else taken.completed += 1;
    } else {
      absentees.push({
        unique_id: String(entry.unique_id || ""),
        name: mappedField(entry, "name"),
        roll_number: mappedField(entry, "roll_number"),
        room: mappedField(entry, "room")
      });
    }
  }
  absentees.sort((a, b) => a.unique_id.localeCompare(b.unique_id));

  return {
    configured: true,
    contest_slug: contestSlug ? String(contestSlug) : null,
    roster_total: entries.length,
    taken,
    not_taken: absentees.length,
    absentees,
    unmatched_sessions: unmatched,
    generated_at: new Date().toISOString()
  };
}

// S-C attendance for a person contest: ITS roster (roster_meta::{slug}) joined
// to ITS sessions by person_id (the only join that survives two colleges
// sharing a roll number). Absentee rows gain the college (vision A11) — still
// PII-minimized: mapped identity fields + college, no email, no raw fields.
async function personContestAttendance(contest) {
  const meta = await getContestRosterMeta(contest);
  // Real-data hardening: a CLEARED roster used to collapse attendance to
  // "not configured" even though the enrollment spine (persons minted by the
  // last upload) survives the clear — fall back to it instead of hiding.
  if (!meta) return personEnrollmentAttendance(contest);

  const entriesSnap = await getFirestore()
    .collection(rosterCollection)
    .where("roster_version", "==", meta.version)
    .limit(rosterLimit)
    .get();
  const entries = entriesSnap.docs.map((doc) => doc.data());

  const sessionsSnap = await scopedQuery(getFirestore().collection(sessionCollection), contest)
    .limit(sessionsQueryLimit)
    .get();
  const sessions = sessionsSnap.docs.map((doc) => doc.data());

  const knownPersons = new Set(entries.map((entry) => String(entry.person_id || "")));
  const liveByPerson = new Map();
  let unmatched = 0;
  for (const session of sessions) {
    const personId = String(session.person_id || "");
    if (!personId || !knownPersons.has(personId)) {
      unmatched += 1;
      continue;
    }
    const live = session.status !== "ended";
    liveByPerson.set(personId, Boolean(liveByPerson.get(personId)) || live);
  }

  const mapping = meta.column_mapping || {};
  const mappedField = (entry, name) =>
    (mapping[name] ? String(entry.fields?.[mapping[name]] || "") : "");
  const taken = { total: 0, in_progress: 0, completed: 0 };
  const absentees = [];
  for (const entry of entries) {
    const personId = String(entry.person_id || "");
    if (liveByPerson.has(personId)) {
      taken.total += 1;
      if (liveByPerson.get(personId)) taken.in_progress += 1;
      else taken.completed += 1;
    } else {
      absentees.push({
        unique_id: String(entry.unique_id || ""),
        name: mappedField(entry, "name"),
        roll_number: mappedField(entry, "roll_number"),
        room: mappedField(entry, "room"),
        college: String(entry.college || "")
      });
    }
  }
  absentees.sort((a, b) => a.unique_id.localeCompare(b.unique_id) || a.college.localeCompare(b.college));

  return {
    configured: true,
    contest_slug: contest.slug,
    roster_total: entries.length,
    taken,
    not_taken: absentees.length,
    absentees,
    unmatched_sessions: unmatched,
    generated_at: new Date().toISOString()
  };
}

// Real-data hardening: attendance from the ENROLLMENT SPINE when the roster was
// cleared (roster_meta off) but the durable enrollments survive. Same shape as
// the roster-driven report plus source:"enrollments" + an explicit note, so
// the admin knows exactly what they are looking at — never a silent blank.
// Absentee identity comes from the person docs (unique_id + name; roster
// column mapping is gone with the meta, so roll_number/room are blank).
async function personEnrollmentAttendance(contest) {
  const enrollments = (await listEnrollments(contest)).filter((e) => e.status !== "removed");
  if (!enrollments.length) return { configured: false, contest_slug: contest.slug };

  const sessionsSnap = await scopedQuery(getFirestore().collection(sessionCollection), contest)
    .limit(sessionsQueryLimit)
    .get();
  const sessions = sessionsSnap.docs.map((doc) => doc.data());

  const knownPersons = new Set(enrollments.map((e) => String(e.person_id || "")));
  const liveByPerson = new Map();
  let unmatched = 0;
  for (const session of sessions) {
    const personId = String(session.person_id || "");
    if (!personId || !knownPersons.has(personId)) {
      unmatched += 1;
      continue;
    }
    const live = session.status !== "ended";
    liveByPerson.set(personId, Boolean(liveByPerson.get(personId)) || live);
  }

  const [persons, collegeNames] = await Promise.all([
    getPersonsByIds([...knownPersons]),
    getCollegeNameMap()
  ]);
  const taken = { total: 0, in_progress: 0, completed: 0 };
  const absentees = [];
  for (const enrollment of enrollments) {
    const personId = String(enrollment.person_id || "");
    if (liveByPerson.has(personId)) {
      taken.total += 1;
      if (liveByPerson.get(personId)) taken.in_progress += 1;
      else taken.completed += 1;
    } else {
      const person = persons.get(personId) || null;
      const collegeNorm = String(enrollment.college_norm || person?.college_norm || "");
      absentees.push({
        unique_id: String(person?.unique_id || ""),
        name: String(person?.name || ""),
        roll_number: "",
        room: "",
        college: collegeNames.get(collegeNorm) || collegeNorm
      });
    }
  }
  absentees.sort((a, b) => a.unique_id.localeCompare(b.unique_id) || a.college.localeCompare(b.college));

  return {
    configured: true,
    contest_slug: contest.slug,
    source: "enrollments",
    note: "The roster for this contest was cleared, so attendance is computed from the surviving enrollments "
      + "(the persons minted by the last roster upload). Sessions not keyed to a person are counted as unmatched, "
      + "never as attendance.",
    roster_total: enrollments.length,
    taken,
    not_taken: absentees.length,
    absentees,
    unmatched_sessions: unmatched,
    generated_at: new Date().toISOString()
  };
}

// Phase 2 (2.4 / Epic 4.3): remote admin actions, per-session (session_id) or in
// bulk (usernames[] within a contest). Returns the updated docs so the console
// can reflect the new state immediately.
async function adminSessionAction(req) {
  requireAdmin(req);
  const body = parseBody(req);
  const action = String(body.action || "");
  const VALID_ACTIONS = ["approve", "lock", "unlock", "bypass", "end", "exempt"];
  if (!VALID_ACTIONS.includes(action)) {
    return badRequest(`action must be one of ${VALID_ACTIONS.join(", ")}`);
  }

  const targets = await resolveActionTargets(body);
  if (!targets.length) return badRequest("Provide session_id or a non-empty usernames[]");

  const updated = [];
  for (const session of targets) {
    const result = await applySessionAction(action, session, { exemptions: body.exemptions });
    if (Array.isArray(result)) updated.push(...result);
    else if (result) updated.push(result);
  }
  return { ok: true, action, updated };
}

// Resolve which session docs an action applies to: a single session_id, or all
// non-ended sessions for each username in usernames[] (optionally scoped to a
// contest_slug). For bulk we operate on the live (non-ended) doc per username.
async function resolveActionTargets(body) {
  if (body.session_id) {
    const session = await getSessionOrNull(body.session_id);
    return session ? [session] : [];
  }
  if (Array.isArray(body.usernames) && body.usernames.length) {
    const contestSlug = body.contest_slug !== undefined && body.contest_slug !== null
      ? String(body.contest_slug)
      : null;
    const out = [];
    for (const username of body.usernames) {
      const usernameNorm = normalizeUsername(username);
      let query = getFirestore()
        .collection(sessionCollection)
        .where("username_norm", "==", usernameNorm);
      if (contestSlug !== null) query = query.where("contest_slug", "==", contestSlug);
      const snapshot = await query.limit(50).get();
      const live = snapshot.docs
        .map((doc) => doc.data())
        .filter((doc) => doc.status && doc.status !== "ended")
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
      if (live.length) out.push(live[0]);
    }
    return out;
  }
  return [];
}

async function applySessionAction(action, session, options = {}) {
  const now = new Date().toISOString();

  if (action === "approve") {
    // Activate a pending session and END the conflicting active one it was
    // waiting behind, so exactly one session is live afterward.
    const out = [];
    if (session.blocked_by_session_id) {
      const conflict = await getSessionOrNull(session.blocked_by_session_id);
      if (conflict && conflict.status !== "ended") {
        await sessionRef(conflict.session_id).update({ status: "ended", ended_at: now, updated_at: now, ended_reason: "superseded_by_approval" });
        // H1: the conflicting session no longer holds the live slot.
        await releaseLiveSlot(conflict);
        out.push({ ...conflict, status: "ended", ended_at: now, updated_at: now, ended_reason: "superseded_by_approval" });
      }
    }
    await sessionRef(session.session_id).update({ status: "active", blocked_by_session_id: null, approved_at: now, updated_at: now });
    // H1: the approved session now OWNS the live slot — point the lock at it.
    await takeOverLiveSlot(session);
    out.push({ ...session, status: "active", blocked_by_session_id: null, approved_at: now, updated_at: now });
    return out;
  }

  if (action === "lock") {
    await sessionRef(session.session_id).update({ status: "locked", locked_at: now, updated_at: now });
    return { ...session, status: "locked", locked_at: now, updated_at: now };
  }

  if (action === "unlock") {
    // F5.3: clearing locked_reason matters — an enforcement lock released by an
    // admin must not leave the session looking code-releasable forever.
    // Wave-2: the SERVER-SIDE exit ladder resets too (mirrors the client's
    // post-release reset) — one later accident is an L1 episode again, not an
    // instant server-side relock.
    const patch = { status: "active", unlocked_at: now, locked_reason: null, fullscreen_exit_count: 0, fullscreen_out_since: null, updated_at: now };
    await sessionRef(session.session_id).update(patch);
    return { ...session, ...patch };
  }

  if (action === "exempt") {
    // F5.5: per-session enforcement exemptions. MERGE semantics so toggling one
    // anomaly never silently clears the other; sanitize drops unknown keys and
    // non-boolean values.
    const merged = { ...sanitizeExemptions(session.enforcement_exemptions), ...sanitizeExemptions(options.exemptions) };
    await sessionRef(session.session_id).update({ enforcement_exemptions: merged, updated_at: now });
    return { ...session, enforcement_exemptions: merged, updated_at: now };
  }

  if (action === "bypass") {
    // Clear a pending/locked block: make the session live and drop the conflict
    // pointer WITHOUT ending the other session (contingency override).
    await sessionRef(session.session_id).update({ status: "active", blocked_by_session_id: null, bypassed_at: now, updated_at: now });
    // H1: this session is now live by override — point the slot lock at it so a
    // later fresh start sees a coherent owner.
    await takeOverLiveSlot(session);
    return { ...session, status: "active", blocked_by_session_id: null, bypassed_at: now, updated_at: now };
  }

  if (action === "end") {
    await sessionRef(session.session_id).update({ status: "ended", ended_at: now, updated_at: now, ended_reason: "admin_action" });
    // H1: free the live slot so a legitimate restart can re-acquire it.
    await releaseLiveSlot(session);
    return { ...session, status: "ended", ended_at: now, updated_at: now, ended_reason: "admin_action" };
  }

  return null;
}

// POST /api/admin/session-details — bulk-resolve student details for a list of
// usernames, projected STRAIGHT from the session doc with ZERO GCS access. The
// frontend roster view calls this with up to reviewRosterLimit usernames at
// once, so it MUST NOT touch the bucket: a per-username endpoint that lists or
// signs GCS objects (like adminSessions) re-creates the Cloud Run 500 fan-out.
// adminRecordingSessions is unusable here because it omits email + roll_number.
//
// Response `details` preserves the INPUT order one-to-one; each input username
// echoes back as `username` whether or not a session was found.
async function adminSessionDetails(req) {
  requireAdmin(req);
  const body = parseBody(req);
  if (!Array.isArray(body.usernames)) return badRequest("usernames must be an array");
  if (body.usernames.length > reviewRosterLimit) {
    return badRequest(`Too many usernames in one request (max ${reviewRosterLimit})`);
  }
  const contestSlug = body.contest_slug !== undefined && body.contest_slug !== null
    ? String(body.contest_slug)
    : null;

  // Bounded concurrency is SAFE here precisely because there is ZERO GCS — each
  // worker does a single Firestore query — so a 5000-username call stays a
  // reasonable fan-out of Firestore reads, never a GCS/IAM storm.
  const details = await mapWithConcurrency(body.usernames, 12, async (u) => {
    const blank = {
      username: u,
      hackerrank_username: "",
      candidate_id: "",
      name: "",
      email: "",
      roll_number: "",
      room: "",
      contest_slug: "",
      status: "",
      found: false
    };
    const norm = normalizeUsername(u);
    // A degenerate norm ('_') comes from a blank/'@'/'..'-style input that carries
    // NO real username (sanitizeSegment collapses it). Querying username_norm=='_'
    // would mass-match every such doc and project a wrong student, so don't query —
    // emit the blank found:false record for that input.
    if (norm === "_") return blank;
    // normalizeUsername does NOT strip a leading '@' (sanitizeSegment maps it to
    // '_'), so an '@alice' input normalizes to '_alice' while the student started
    // as plain 'alice'. ONLY when the RAW input begins with '@' do we ALSO query
    // the de-@ form, so '@alice' resolves to stored 'alice'. We must NOT derive the
    // alt form from norm's leading '_' (that would conflate a GENUINE '_alice'
    // username with 'alice').
    const trimmed = String(u).trim();
    const usernames = [norm];
    if (trimmed.startsWith("@")) {
      const deAt = normalizeUsername(trimmed.slice(1));
      if (deAt !== "_" && !usernames.includes(deAt)) usernames.push(deAt);
    }
    let query = getFirestore()
      .collection(sessionCollection)
      .where("username_norm", "in", usernames);
    if (contestSlug !== null) query = query.where("contest_slug", "==", contestSlug);
    const snapshot = await query.limit(50).get();
    const docs = snapshot.docs
      .map((doc) => doc.data())
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    if (!docs.length) return blank;
    const doc = docs[0];
    return {
      username: u,
      hackerrank_username: doc.hackerrank_username || "",
      candidate_id: candidateOf(doc).id, // S-C dual-read adapter (F9 §1.2)
      name: doc.name || "",
      email: doc.email || "",
      roll_number: doc.roll_number || "",
      room: doc.room || "",
      contest_slug: doc.contest_slug || "",
      status: doc.status || "",
      found: true
    };
  });

  return { details };
}

  return {
    // route handlers — names match the dispatch table exactly so handler.mjs's
    // dispatch lines stay byte-identical (canaryIsolation). Every admin* route is
    // auth-first (requireAdmin), satisfying routesAuthLint.
    adminSessions,
    adminRecordingSessions,
    adminSessionsList,
    adminSessionDetail,
    adminSessionEvents,
    adminSessionEditorEvents,
    adminIpReport,
    adminAttendance,
    adminSessionAction,
    adminSessionDetails,
    // end-now sweep RETURNED for single-source reuse by the adminContests end_now
    // path (B4 ctx) — handler.mjs passes it BY REFERENCE; never forked.
    endAllLiveSessions
  };
}
