// backend/src/routes/alerts.mjs — the proctor-alert ROUTES as a FACTORY
// (decomp B9, plan §1.2). makeAlertRoutes(ctx) closes over the handler-built ctx
// (per ?buster instance) and returns the five alert route handlers + the
// alerts-only listSessionRooms helper.
//
// Safe to split NOW (after B9a): the alerts DOMAIN logic these routes consume —
// normalizeAlert / alertRef / getAlertSettings / mergeAlertSettings — lives in
// src/proctorAlerts.mjs and arrives via ctx by reference (single source). Splitting
// before B9a would have forced this file to share those helpers with telemetry /
// gate routes through a forbidden route→route import.
//
// Routes:
//   ingestAlerts          POST /api/alerts            — poller ingest; auth =
//                         requireApiKey (the x-api-key mechanism, NOT admin auth).
//   adminAlerts           GET  /api/admin/alerts      — admin feed (auth-first).
//   adminAlertAction      POST /api/admin/alert-action — archive/unarchive batch.
//   adminGetAlertSettings GET  /api/admin/alert-settings — per-type config.
//   adminSaveAlertSettings POST /api/admin/alert-settings — upsert config.
//
// adminAlerts pushes AT MOST ONE equality filter (contest_slug) through the
// scopedQuery chokepoint and filters the rest in memory — no raw contest_slug
// .where outside the chokepoint, so scopingLint's allowlist stays {handler.mjs: 4}.
// adminAlerts/adminAlertAction/adminGet/SaveAlertSettings are auth-first with
// requireAdmin (routesAuthLint); ingestAlerts uses requireApiKey (the sanctioned
// non-admin ingest guard, like submissionEvents ingest).
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as the other route domains: getFirestore is a GETTER so the
// fake-Firestore swap propagates.
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*). Nothing is imported here — every dependency (the live Firestore
// getter, the auth guards, the http transport helpers, the contest-scope resolver
// + chokepoint, the shared room helpers, the signed-url resolver, the proctorAlerts
// domain helpers by reference, the ALL_CONTESTS sentinel by reference, and the
// env-captured collection names + caps + settings id BY VALUE) arrives through ctx,
// so the env-capture-at-load semantics stay in handler.mjs (env-lint).

export function makeAlertRoutes(ctx) {
  const {
    getFirestore,
    requireApiKey,
    requireAdmin,
    parseBody,
    badRequest,
    isTruthyParam,
    // contest-scope resolver + chokepoint
    contestScopeOf,
    scopedQuery,
    // shared room helpers (owned by + resident in handler.mjs), by reference
    normalizeRoomFilter,
    distinctRooms,
    // signed-url resolver (lib/clients.mjs)
    resolveSignedReadUrl,
    // proctorAlerts domain helpers (src/proctorAlerts.mjs), by reference
    normalizeAlert,
    alertRef,
    getAlertSettings,
    mergeAlertSettings,
    // identity sentinel from contests.mjs (by reference — === comparison)
    allContests,
    // env-captured collection names / caps / settings id (by value at handler load)
    alertsCollection,
    alertsQueryLimit,
    sessionCollection,
    sessionsQueryLimit,
    settingsCollection,
    alertSettingsId,
    // v1.1 G3 (#5): invalidate the hot-path alert-settings read cache after a
    // settings write (by reference). No-op fallback when no cache is configured.
    invalidateAlertSettingsCache = () => {}
  } = ctx;

  async function ingestAlerts(req) {
    requireApiKey(req);
    const body = parseBody(req);
    const rawAlerts = Array.isArray(body?.alerts) ? body.alerts : [body];
    if (!rawAlerts.length) return badRequest("No alerts provided");
    if (rawAlerts.length > 500) return badRequest("Too many alerts in one request (max 500)");

    const now = new Date().toISOString();
    const normalized = rawAlerts.map((alert, index) => normalizeAlert(alert, index, now));

    // Idempotent merge keyed on alert.id so retried deliveries do not duplicate.
    await Promise.all(normalized.map((alert) => alertRef(alert.id).set(alert, { merge: true })));

    return { ok: true, ingested: normalized.length, ids: normalized.map((alert) => alert.id) };
  }

  async function adminAlerts(req) {
    requireAdmin(req);
    const scope = await contestScopeOf(req.query?.contest_slug);
    const severity = req.query?.severity;
    const source = req.query?.source;
    const room = normalizeRoomFilter(req.query?.room);
    const includeArchived = isTruthyParam(req.query?.include_archived);

    // B6: applying ALL THREE equality filters server-side (contest_slug + severity
    // + source) would need a composite Firestore index that doesn't exist. To stay
    // index-free (lower risk than relying on a deployed composite index), we push
    // AT MOST ONE equality filter to Firestore — the most selective, contest_slug —
    // and filter the remaining fields in memory. ALERTS_QUERY_LIMIT bounds the scan.
    let query = getFirestore().collection(alertsCollection);
    if (scope !== allContests) {
      query = scopedQuery(query, scope);
    } else {
      // Zero-alerts bug (2026-06-10 investigation, root cause #1): without an
      // orderBy, Firestore fills the limit() window in DOC-ID order, so a
      // bulk-archived pile whose ids sort first (contest-eval:first_attempt_solve:*)
      // crowds every live alert out of the scan BEFORE the in-memory archived
      // filter runs. Order newest-first so the window always holds the most
      // recent docs. The archived filter STAYS in memory: legacy docs omit the
      // field, so an `archived == false` equality would drop live legacy alerts.
      // Single-field orderBy rides the automatic index; combining it with the
      // contest_slug equality filter above WOULD need a composite index, so the
      // contest-scoped branch keeps the bare (index-free) scan.
      query = query.orderBy("timestamp", "desc");
    }

    const snapshot = await query.limit(alertsQueryLimit).get();
    const alerts = snapshot.docs
      .map((doc) => doc.data())
      .filter((alert) => !severity || alert.severity === String(severity))
      .filter((alert) => !source || alert.source === String(source))
      .filter((alert) => !room || String(alert.room || "") === room)
      // Archive: exclude archived alerts by default; include them only when the
      // caller opts in with include_archived=true. A missing `archived` field on a
      // legacy doc is treated as not-archived.
      .filter((alert) => includeArchived || !alert.archived)
      .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
      .slice(0, alertsQueryLimit);

    const withUrls = await Promise.all(alerts.map(async (alert) => {
      if (!alert.video_key) return { ...alert, download_url: null };
      const downloadUrl = await resolveSignedReadUrl(alert.video_key);
      return { ...alert, download_url: downloadUrl };
    }));

    // Distinct rooms come from the SESSION docs (capped) so the console dropdown
    // lists every room, not just rooms that happen to have an alert. Scoped to the
    // same contest as the alerts query.
    const rooms = await listSessionRooms(scope);

    return { alerts: withUrls, rooms };
  }

  // Distinct room labels across session docs in the given RESOLVED contest scope
  // (ALL_CONTESTS for unscoped), capped. Shared by adminAlerts so its room
  // dropdown matches adminStats'.
  async function listSessionRooms(scope) {
    const snapshot = await scopedQuery(getFirestore().collection(sessionCollection), scope)
      .limit(sessionsQueryLimit)
      .get();
    return distinctRooms(snapshot.docs.map((doc) => doc.data()));
  }

  // ---- Alert archive (admin) -------------------------------------------------
  //
  // Toggle the `archived` flag on a set of alert docs. The frontend calls this
  // after a session approve to also-archive that session's alerts, and from a
  // manual archive/unarchive control. archived alerts are hidden from
  // GET /api/admin/alerts unless include_archived=true.
  async function adminAlertAction(req) {
    requireAdmin(req);
    const body = parseBody(req);
    const action = String(body.action || "");
    if (!["archive", "unarchive"].includes(action)) {
      return badRequest("action must be archive or unarchive");
    }
    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => id !== undefined && id !== null && id !== "") : [];
    if (!ids.length) return badRequest("ids[] must be a non-empty array of alert ids");

    const archived = action === "archive";
    const now = new Date().toISOString();
    const updated = [];
    const missing = [];
    for (const rawId of ids) {
      const id = String(rawId);
      // merge:true so we only touch the archive fields and never clobber the rest
      // of the alert doc. Skip ids that don't exist so a stale id can't 500 the
      // whole batch — report them back so the console can surface it.
      const ref = alertRef(id);
      const doc = await ref.get();
      if (!doc.exists) {
        missing.push(id);
        continue;
      }
      await ref.set({ archived, archived_at: archived ? now : null }, { merge: true });
      updated.push(id);
    }

    return { ok: true, action, archived, updated, missing };
  }

  // ---- Proctor alert settings (admin) ----------------------------------------
  //
  // GET returns the full per-type config (defaults merged with stored overrides)
  // so the console can render a complete toggle list. POST upserts the doc; only
  // known types and valid severities are persisted, and a missing/blank `enabled`
  // falls back to the default so a partial payload can't corrupt the config.
  async function adminGetAlertSettings(req) {
    requireAdmin(req);
    return await getAlertSettings();
  }

  async function adminSaveAlertSettings(req) {
    requireAdmin(req);
    const body = parseBody(req);
    const incoming = body && typeof body.proctor === "object" && body.proctor !== null ? body.proctor : {};

    // Normalize against the known type set + defaults so a bad/partial payload
    // can never persist an unknown type or an invalid severity.
    const merged = mergeAlertSettings(incoming);
    const now = new Date().toISOString();
    await getFirestore().collection(settingsCollection).doc(alertSettingsId).set({
      proctor: merged.proctor,
      updated_at: now
    });
    invalidateAlertSettingsCache(); // v1.1 G3 (#5): settings write invalidates the read cache
    return merged;
  }

  return {
    // route handlers — names match the dispatch table exactly so handler.mjs's
    // dispatch lines stay byte-identical (canaryIsolation). adminAlerts /
    // adminAlertAction / adminGet/SaveAlertSettings are auth-first (routesAuthLint);
    // ingestAlerts uses requireApiKey (sanctioned non-admin ingest guard).
    ingestAlerts,
    adminAlerts,
    adminAlertAction,
    adminGetAlertSettings,
    adminSaveAlertSettings
  };
}
