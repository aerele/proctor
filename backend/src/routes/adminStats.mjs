// backend/src/routes/adminStats.mjs — the admin live-counts dashboard route
// domain as a FACTORY (decomp B6, plan §A2/§A8). makeAdminStatsRoutes(ctx)
// closes over the handler-built ctx (per ?buster instance) and returns the
// single admin stats route handler.
//
// adminStats (GET /api/admin/stats) is the admin dashboard's live-counts read:
// it derives by-status session counts (live/locked/pending_approval/finished +
// a derived disconnected) over an optional ?contest_slug + ?room scope, and
// returns the distinct rooms list (computed over the contest scope BEFORE the
// room filter) so the console can populate its room dropdown. It is auth-first
// with requireAdmin (routesAuthLint pins this) and is a SCOPED GET in
// canaryIsolation's SCOPED_GET_REQUESTS (all session reads go through the
// scopedQuery chokepoint, so this module adds NO raw contest_slug filter —
// scopingLint's allowlist stays {handler.mjs: 4}).
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as makeAuth / makeSessionStore / makeSubmissionEventsRoutes:
// phase2b.test.mjs / canaryIsolation.test.mjs import the handler with a ?buster
// and swap the fake Firestore via __setClientsForTest — getFirestore is
// therefore taken as a GETTER so the swap propagates (the live handle is never
// captured by value).
//
// SHARED helpers stay resident in handler.mjs and arrive by reference through
// ctx — they are NOT moved here because other still-resident handler code (and,
// for the first two, routes/invigilator.mjs) reuses them:
//   normalizeRoomFilter — also used by adminSessionsList, adminIpReport, and
//                          the review-rooms helper in handler.mjs
//   distinctRooms        — also used by handler.mjs's review-rooms helper and by
//                          routes/invigilator.mjs (passed via its ctx)
//   isStaleSession       — also used by adminSessionsList's status filter in
//                          handler.mjs and by routes/invigilator.mjs (via ctx)
// Duplicating or moving any of them would either fork a single source of truth
// or break the resident call sites, so ctx-by-reference is the only correct
// wiring.
//
// ALL_CONTESTS is the IDENTITY sentinel from contests.mjs that contestScopeOf
// returns for the no-filter scope; adminStats compares `scope === ALL_CONTESTS`,
// so the SAME reference must arrive through ctx (a copy would break the ===).
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*). Everything stateful or env-captured (the live Firestore
// getter, the contest-scope resolver + scopedQuery chokepoint, the session
// collection name + query cap, the disconnected-staleness threshold, the
// ALL_CONTESTS sentinel, the settings reader, the shared room/staleness helpers,
// and the admin auth guard) arrives through ctx — nothing is imported here, so
// the env-capture-at-load semantics stay in handler.mjs (env-lint).

export function makeAdminStatsRoutes(ctx) {
  const {
    getFirestore,
    requireAdmin,
    contestScopeOf,
    scopedQuery,
    // shared helpers (owned by + kept resident in handler.mjs), by reference
    normalizeRoomFilter,
    distinctRooms,
    isStaleSession,
    // env-captured collection name / caps / threshold (by value at handler load)
    sessionCollection,
    sessionsQueryLimit,
    disconnectedStalenessMs,
    // identity sentinel from contests.mjs (by reference — === comparison)
    allContests
  } = ctx;

  // Phase 2 (2.4 / Epic 6.4 / 4.4): live counts by status for the admin dashboard.
  // Counts are derived from the session docs; an optional ?contest_slug filters to
  // one contest, and an optional ?room scopes counts to a single room. "finished"
  // == ended; "live" == active; plus locked + pending. A derived `disconnected`
  // count flags active sessions whose last liveness signal (heartbeat or beacon)
  // is older than the staleness threshold. The distinct `rooms` list (computed
  // over the contest scope, BEFORE the room filter, so the dropdown stays full) is
  // returned so the console can populate a room dropdown.
  async function adminStats(req) {
    requireAdmin(req);
    const contestSlug = req.query?.contest_slug;
    const scope = await contestScopeOf(contestSlug);
    const room = normalizeRoomFilter(req.query?.room);

    const snapshot = await scopedQuery(getFirestore().collection(sessionCollection), scope)
      .limit(sessionsQueryLimit)
      .get();
    const allDocs = snapshot.docs.map((doc) => doc.data());

    // Distinct rooms come from the full contest scope (NOT the room-filtered set)
    // so the dropdown always lists every room even while one is selected.
    const rooms = distinctRooms(allDocs);

    // Apply the room filter to the docs the counts are computed over.
    const docs = room ? allDocs.filter((doc) => String(doc.room || "") === room) : allDocs;

    const nowMs = Date.now();
    const stats = { live: 0, locked: 0, pending_approval: 0, finished: 0, disconnected: 0, total: 0 };
    for (const doc of docs) {
      stats.total += 1;
      if (doc.status === "active") {
        stats.live += 1;
        // Derived disconnected signal: an active session whose last heartbeat /
        // beacon is older than the staleness threshold (default 45s).
        if (isStaleSession(doc, nowMs)) stats.disconnected += 1;
      } else if (doc.status === "locked") stats.locked += 1;
      else if (doc.status === "pending_approval") stats.pending_approval += 1;
      else if (doc.status === "ended") stats.finished += 1;
    }
    // "not started or total": with no roster the backend can't know who hasn't
    // started, so we report total session docs as the closest defensible number
    // (the frontend can subtract the started states to estimate yet-to-start once
    // a roster exists).
    stats.not_started_or_total = stats.total;

    // S5: the console exam-time card rides on the existing 5 s stats poll, so the
    // current end time + a server clock stamp come back with every poll.
    // F3 (E2E live): a contest-scoped stats poll reports THAT contest's window;
    // ALL_CONTESTS (unscoped) and an unknown slug (contestScopeOf's literal
    // fallback carries no window) report "" → the card renders "no schedule".
    return {
      contest_slug: contestSlug ? String(contestSlug) : null,
      room: room || null,
      stats,
      rooms,
      disconnected_staleness_ms: disconnectedStalenessMs,
      end_at: scope === allContests ? "" : (scope.end_at || ""),
      server_now: new Date().toISOString()
    };
  }

  return {
    // route handler — name matches the dispatch table exactly so handler.mjs's
    // dispatch line stays byte-identical (canaryIsolation). adminStats is
    // auth-first (routesAuthLint) and a SCOPED GET (SCOPED_GET_REQUESTS).
    adminStats
  };
}
