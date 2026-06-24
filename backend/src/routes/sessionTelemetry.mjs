// backend/src/routes/sessionTelemetry.mjs — the candidate-side session TELEMETRY
// routes as a FACTORY (decomp B12a, plan §A4 / 05-decomp-plan §1.2).
// makeSessionTelemetryRoutes(ctx) closes over the handler-built ctx (per ?buster
// instance) and returns the chunk-upload-url / events / editor-events / review-file
// / heartbeat / beacon route handlers + the beacon-body parser they own.
//
// The HEAVIEST consumer of the proctorAlerts + enforcement DOMAINS — safe to split
// only AFTER B9a + B10a, which is exactly why those domain extractions precede this
// step in the ladder. recordEvents raises sure-shots + reconciles fullscreen
// exits; recordHeartbeat raises ip_changed / recording_stopped sure-shots +
// reconciles the enforcement countdown; recordBeacon raises tab_hidden. All of that
// domain logic arrives via ctx by reference (single source) — no forbidden
// route→route import, no duplicated live-exam-critical helper.
//
// Routes (candidate-token auth — the unguessable session id, like /api/events;
// NOT admin, so outside routesAuthLint's admin*/invigilator* rule):
//   createUploadUrl    POST /api/upload-url     — mint a signed chunk-write URL
//   recordEvents       POST /api/events         — evidence batch + sure-shots
//   ingestEditorEvents POST /api/editor-events  — keystroke/editor analytics batch
//   recordReviewFile   POST /api/review-file    — clipboard/tabs/cookies snapshot
//   recordHeartbeat    POST /api/heartbeat      — liveness + enforcement live channel
//   recordBeacon       POST /api/session/beacon — sendBeacon liveness + tab_hidden
//
// No raw contest_slug equality filter here (all reads address the session doc by
// id), so scopingLint's allowlist stays {handler.mjs: 4}.
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as the other route domains: getSession/sessionRef come from the
// makeSessionStore factory and signingBucket/putJsonl are getters, so the
// fake-Firestore / fake-storage swaps propagate.
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*). Nothing is imported here — every dependency (the session-doc
// helpers + prefix builder, the http transport helpers, the sanitizers / client-ip
// reader, the storage writers, FieldValue + randomUUID, the resident
// inAdminEndGrace + personContestForSession by reference, the proctorAlerts +
// enforcement domain helpers by reference, and the env-captured chunk-kinds set /
// url-expiry / editor-events caps + collection name BY VALUE) arrives through ctx,
// so the env-capture-at-load semantics stay in handler.mjs (env-lint).

export function makeSessionTelemetryRoutes(ctx) {
  const {
    // session-doc helpers (sessionStore + resident, by reference)
    getSession,
    requireWritableSession,
    sessionRef,
    sessionPrefix,
    inAdminEndGrace,
    // B5 / LT-4 (DEC-1): bounded record-through-lock predicate (by reference,
    // resident in handler.mjs alongside inAdminEndGrace). status==="locked" AND
    // within LOCK_RECORD_GRACE_MS of locked_at. The bound is the protection on
    // this token-only path (MA-1/MA-2). A no-op fallback keeps older ctx / tests
    // that don't inject it working (treats every locked session as past-window).
    recordingThroughLock = () => false,
    personContestForSession,
    // http transport helpers
    parseBody,
    requireFields,
    badRequest,
    httpError,
    // sanitizers / client-ip (lib/sanitize)
    sanitizeObject,
    sanitizeEditorDetail,
    getClientIp,
    // storage writers (lib/clients)
    putJsonl,
    signingBucket,
    // Firestore sentinel + uuid (node/firestore imports)
    FieldValue,
    randomUUID,
    // proctorAlerts domain (src/proctorAlerts.mjs), by reference
    getAlertSettings,
    raiseSureShotAlertsFromEvents,
    alertTypeConfig,
    upsertProctorAlert,
    isRecordingStopped,
    // enforcement domain (src/enforcement.mjs), by reference
    reconcileFullscreenEnforcement,
    reconcileEnforcementCountdown,
    enforcementConfigFor,
    sanitizeExemptions,
    // env-captured constants (by value at handler load)
    uploadChunkKinds,
    urlExpirySeconds,
    editorEventsIngestLimit,
    editorEventsCollection,
    // v1.1 G3 (#4): per-session per-endpoint rate-limit check (by reference). A
    // no-op fallback keeps older ctx / tests that don't inject it working.
    telemetryCheck = () => {},
    // v1.1 G3 (#7): per-chunk signed-URL byte cap (HD headroom). A signed WRITE
    // URL carries an x-goog-content-length-range condition so a valid token
    // can't PUT an arbitrarily large object. 0/undefined → no cap (legacy).
    maxUploadChunkBytes = 0
  } = ctx;

  async function createUploadUrl(req) {
    const body = parseBody(req);
    requireFields(body, ["session_id", "kind", "chunk_index", "content_type"]);
    const fetched = await getSession(body.session_id);
    // D2: an admin-ended session may still flush its in-flight final chunk for a
    // bounded window; everything else goes through the normal status gate.
    // B5 / LT-4 (DEC-1): ALSO accept a LOCKED session within the bounded
    // record-through-lock window — keep the screen recording flowing during a lock
    // so the maintainer can see what the candidate does. The window (off locked_at)
    // is the protection on this token-only path (MA-1/MA-2): past it, a locked /
    // abandoned / leaked session is refused 403 again and can no longer mint
    // signed write URLs. exec/submit are SEPARATE handlers and stay 403 while
    // locked (requireWritableSession unchanged there).
    const session = (inAdminEndGrace(fetched) || recordingThroughLock(fetched))
      ? fetched
      : requireWritableSession(fetched);
    // v1.1 G3 (#4): per-session rate limit (after the ownership gate, before the
    // expensive v4-signing path — the live-incident path). Tuned so a real
    // chunk-upload cadence (even a reconnect backlog flush) never trips it.
    telemetryCheck("upload-url", session.session_id);
    // F10.1: only the two known chunk kinds may mint a signed write URL.
    const kind = String(body.kind || "");
    if (!uploadChunkKinds.has(kind)) {
      return badRequest("kind must be screen, camera, or screenshot");
    }
    const chunkIndex = Number(body.chunk_index);
    // Security M1 (2026-06-12 review): cap the index — unsafe-integer values (e.g. 1e21)
    // pass Number.isInteger, break the %05d key convention, and push the hwm past 2^53
    // where hwm+1 === hwm, silently re-enabling the very overwrites the guard prevents.
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 100000) {
      return badRequest("Invalid chunk_index");
    }

    // F1 (e2e finding): chunk indexes must NEVER be reused within a session — a
    // restarted recorder that re-counts from 1 would OVERWRITE the prior stint's
    // GCS objects at the same keys. The session doc tracks a per-kind index
    // high-water mark; a request at/below it (an old/stale client restarting its
    // count) is bumped to hwm+1 so every stint's chunks survive. The fixed
    // frontend resumes its count monotonically and never trips this guard.
    // Storage layout is unchanged (kind/chunk-{index:05d}.ext) — only which
    // index gets used. hwm fields are absent on pre-F1 sessions (-> 0, no bump).
    // ALERT-2: a third kind ("screenshot") carries its OWN hwm field so a
    // monotonic per-session screenshot counter never collides with — or is
    // bumped past by — the two recording series. Each kind writes a distinct
    // field, so the read-modify-write below never races across kinds.
    const hwmField = kind === "camera"
      ? "camera_chunk_index_hwm"
      : kind === "screenshot"
        ? "screenshot_chunk_index_hwm"
        : "screen_chunk_index_hwm";
    const indexHwm = Number(session[hwmField]) || 0;
    const effectiveIndex = chunkIndex <= indexHwm && indexHwm > 0 ? indexHwm + 1 : chunkIndex;

    // Extension is cosmetic (the key is opaque) but keeps GCS object inspection
    // sane: recording chunks are webm; ALERT-2 screenshots are image/jpeg|png.
    const contentType = String(body.content_type);
    const extension = contentType.includes("webm")
      ? "webm"
      : contentType.includes("image/jpeg") || contentType.includes("image/jpg")
        ? "jpg"
        : contentType.includes("image/png")
          ? "png"
          : "bin";
    const objectKey = `${sessionPrefix(session)}${kind}/chunk-${String(effectiveIndex).padStart(5, "0")}.${extension}`;
    // v1.1 G3 (#7): bind a per-chunk size cap into the signed URL. The
    // x-goog-content-length-range extension header makes the WRITE URL only
    // accept a PUT whose body is 0..maxUploadChunkBytes — so a valid token
    // can't mint a URL and PUT a multi-GB abuse object. The cap is large enough
    // (64 MiB default) that a legit HD 30 s screen+camera webm chunk (single-
    // digit MB even at high bitrate) is NEVER blocked. The candidate's uploader
    // must send the SAME header on the PUT for the signature to match.
    const signOpts = {
      version: "v4",
      action: "write",
      expires: Date.now() + urlExpirySeconds * 1000,
      contentType: body.content_type
    };
    if (maxUploadChunkBytes > 0) {
      signOpts.extensionHeaders = { "x-goog-content-length-range": `0,${maxUploadChunkBytes}` };
    }
    const [uploadUrl] = await signingBucket().file(objectKey).getSignedUrl(signOpts);

    await sessionRef(session.session_id).update({
      updated_at: new Date().toISOString(),
      // F1: per-kind hwm advances with every issued URL (uploads are serialized
      // per kind client-side; the two kinds write distinct fields, so this
      // read-modify-write never races itself).
      [hwmField]: Math.max(indexHwm, effectiveIndex),
      // F10.1: chunk_count stays the SCREEN counter — the admin UI's recording-
      // duration math (chunks × 30s) and the recordings picker both read it, so
      // camera chunks must never inflate it. The camera stream counts separately.
      // ALERT-2: a "screenshot" mint increments NEITHER recording counter — a
      // per-alert still is not a recording chunk, so it must not inflate the
      // duration math or REC-4's stored-chunk reconciliation. Only the two video
      // kinds advance a counter; the prior `non-camera → chunk_count` fallthrough
      // (which would have counted a screenshot as a screen chunk) is removed.
      ...(kind === "screen"
        ? { chunk_count: FieldValue.increment(1) }
        : kind === "camera"
          ? { camera_chunk_count: FieldValue.increment(1) }
          : {})
    });

    return {
      upload_url: uploadUrl,
      storage_key: objectKey,
      expires_in: urlExpirySeconds,
      // v1.1 G3 (#7): the cap the PUT must honor. The candidate uploader echoes
      // this as the x-goog-content-length-range header so the signature matches.
      // Absent/0 → no cap was bound (legacy).
      ...(maxUploadChunkBytes > 0 ? { max_bytes: maxUploadChunkBytes } : {})
    };
  }

  async function recordEvents(req) {
    const body = parseBody(req);
    requireFields(body, ["session_id", "events"]);
    const session = requireWritableSession(await getSession(body.session_id));
    telemetryCheck("events", session.session_id); // v1.1 G3 (#4)
    if (!Array.isArray(body.events)) return badRequest("events must be an array");

    const cleanedEvents = body.events.slice(0, 100).map((item) => ({
      type: String(item.type || "unknown"),
      timestamp: item.timestamp || new Date().toISOString(),
      visibility_state: item.visibility_state || "",
      detail: sanitizeObject(item.detail || {})
    }));

    const eventKey = `${sessionPrefix(session)}events/events-${Date.now()}-${randomUUID()}.jsonl`;
    await putJsonl(eventKey, cleanedEvents);

    const clipboardCount = cleanedEvents.filter((item) => item.type === "clipboard_activity").length;
    const focusCount = cleanedEvents.filter((item) => ["visibility_change", "window_blur", "window_focus", "page_hide", "before_unload"].includes(item.type)).length;
    const uploadErrorCount = cleanedEvents.filter((item) => item.type.includes("upload_error")).length;

    await sessionRef(session.session_id).update({
      updated_at: new Date().toISOString(),
      last_event_at: new Date().toISOString(),
      event_count: FieldValue.increment(cleanedEvents.length),
      clipboard_event_count: FieldValue.increment(clipboardCount),
      focus_event_count: FieldValue.increment(focusCount),
      upload_error_count: FieldValue.increment(uploadErrorCount)
    });

    // Phase 2 (2.3): surface only the SURE-SHOT signals as proctor alerts so the
    // admin console deep-links to them. Noisy events (focus/blur/visibility/
    // clipboard) are intentionally NOT surfaced. One settings read per request is
    // threaded into the upsert so a disabled type is skipped and a configured
    // severity overrides the default.
    const alertSettings = await getAlertSettings();
    await raiseSureShotAlertsFromEvents(session, cleanedEvents, alertSettings);

    // F5.3 wave-2 fix: server-side fullscreen enforcement — derive the exit
    // counter (and the exit-limit escalation) from the event stream itself, so a
    // client that blocks the enforcement-violation URL still gets locked/alerted.
    await reconcileFullscreenEnforcement(session, cleanedEvents, alertSettings);

    return { ok: true, storage_key: eventKey };
  }

  async function ingestEditorEvents(req) {
    const body = parseBody(req);
    const sessionId = String(body.session_id || "");
    // Ownership gate (same as /api/events): unknown → 404; ended/locked/pending → 409/403.
    const session = requireWritableSession(await getSession(sessionId));
    telemetryCheck("editor-events", session.session_id); // v1.1 G3 (#4)
    const events = Array.isArray(body.events) ? body.events : null;
    if (!events) return badRequest("events[] required");
    if (events.length > editorEventsIngestLimit) return badRequest(`max ${editorEventsIngestLimit} events per batch`);
    // Security hardening: NEVER spread raw client objects into storage. Build a
    // NEW allow-listed record per event — capped type/timestamp + sanitizeObject'd
    // detail (mirrors recordEvents) — so unexpected keys are dropped by
    // construction and oversized strings are truncated.
    // problem_id is coerced to a bounded string (or null) — never stored verbatim,
    // so an object/array from the client can't land in storage.
    const problemId = String(body.problem_id || "").slice(0, 64) || null;
    const stamped = events.map((e) => ({
      type: String(e.type || "").slice(0, 64),
      timestamp: String(e.timestamp || "").slice(0, 40),
      detail: sanitizeEditorDetail(e.detail),
      session_id: sessionId,
      problem_id: problemId
    }));

    // Per-batch timestamped object under the session prefix (avoids read-modify-
    // write races; the analytics slice concatenates them). Build the key with the
    // existing sessionPrefix() + the same inline ISO-timestamp + randomUUID()
    // pattern recordEvents uses — randomUUID is already imported at the top.
    const key = `${sessionPrefix(session)}${editorEventsCollection}/${new Date().toISOString()}-${randomUUID()}.ndjson`;
    await putJsonl(key, stamped); // putJsonl already serializes records -> NDJSON via bucket().file(key).save(...)

    return { ok: true, stored: events.length };
  }

  async function recordReviewFile(req) {
    const body = parseBody(req);
    requireFields(body, ["session_id", "nature", "records"]);
    const session = requireWritableSession(await getSession(body.session_id));
    telemetryCheck("review-file", session.session_id); // v1.1 G3 (#4)
    if (!["clipboard", "tabs", "cookies"].includes(body.nature)) return badRequest("nature must be clipboard, tabs, or cookies");
    if (!Array.isArray(body.records)) return badRequest("records must be an array");

    const now = new Date().toISOString();
    const records = body.records.slice(0, 50).map((record) => sanitizeObject({
      ...record,
      server_received_at: now
    }));
    const key = `${sessionPrefix(session)}review/${body.nature}.jsonl`;
    await putJsonl(key, records);

    await sessionRef(session.session_id).update({
      updated_at: now,
      last_review_file_at: now,
      review_file_count: FieldValue.increment(1)
    });

    return { ok: true, storage_key: key };
  }

  async function recordHeartbeat(req) {
    const body = parseBody(req);
    requireFields(body, ["session_id", "recording_state", "visibility_state"]);
    // B5 / LT-4 (DEC-1): the heartbeat is the recorder's liveness + live channel.
    // A LOCKED session keeps heartbeating within the bounded record-through-lock
    // window so the upload loop stays alive during a lock (same bound + same
    // token-only-path reasoning as createUploadUrl above). Past the window it goes
    // back through the normal writable gate → 403. The response `status` below
    // stays honest (reconciledStatus || session.status, still "locked"), so the
    // client still KNOWS it is locked even while the heartbeat is accepted.
    const fetched = await getSession(body.session_id);
    const session = recordingThroughLock(fetched) ? fetched : requireWritableSession(fetched);
    telemetryCheck("heartbeat", session.session_id); // v1.1 G3 (#4)
    const now = new Date().toISOString();
    const currentIp = getClientIp(req);
    const startIp = session.start_ip || currentIp;
    const ipChanged = Boolean(startIp && currentIp && currentIp !== startIp);
    const previousIp = session.current_ip || startIp;
    const newlyChanged = ipChanged && previousIp !== currentIp;

    await sessionRef(session.session_id).update({
      updated_at: now,
      last_heartbeat_at: now,
      recording_state: String(body.recording_state),
      visibility_state: String(body.visibility_state),
      start_ip: startIp,
      current_ip: currentIp,
      last_ip_change_at: newlyChanged ? now : session.last_ip_change_at || null,
      upload_queue_depth: Number(body.upload_queue_depth || 0),
      // Tier-1 chunk buffer: pending-upload depth + bytes persisted for post-exam
      // telemetry (no admin UI yet; Tier-2 renders the per-candidate indicator).
      // Defensive Number() — absent on older clients reads as 0.
      buffer_pending_chunks: Number(body.buffer_pending_chunks || 0),
      buffer_pending_bytes: Number(body.buffer_pending_bytes || 0),
      network_online: Boolean(body.network_online),
      last_seen_at: now,
      heartbeat_count: FieldValue.increment(1),
      ip_change_count: FieldValue.increment(newlyChanged ? 1 : 0)
    });

    // One settings read per request; thread it into both sure-shot upsert sites so
    // a disabled type is skipped and a configured severity overrides the default.
    const alertSettings = await getAlertSettings();

    if (newlyChanged) {
      await putJsonl(`${sessionPrefix(session)}events/ip-change-${Date.now()}-${randomUUID()}.jsonl`, [{
        type: "ip_address_changed",
        timestamp: now,
        detail: {
          hackerrank_username: session.hackerrank_username,
          start_ip: startIp,
          previous_ip: previousIp,
          current_ip: currentIp
        }
      }]);
      // Phase 2 (2.3): server-derived sure-shot — IP changed mid-session.
      const ipConfig = alertTypeConfig(alertSettings, "ip_changed", "warning");
      if (ipConfig.enabled) {
        await upsertProctorAlert(session, {
          type: "ip_changed",
          severity: ipConfig.severity,
          timestamp: now,
          title: "IP address changed",
          detail: `IP changed from ${previousIp} to ${currentIp}`,
          dedupe: currentIp,
          data: { start_ip: startIp, previous_ip: previousIp, current_ip: currentIp }
        });
      }
    }

    // Phase 2 (2.3): a heartbeat reporting the recorder is no longer recording is
    // a sure-shot critical. Deduped per-day so a sustained-stopped state collapses
    // to one alert per session rather than one per heartbeat.
    if (isRecordingStopped(body.recording_state)) {
      const recConfig = alertTypeConfig(alertSettings, "recording_stopped", "critical");
      if (recConfig.enabled) {
        await upsertProctorAlert(session, {
          type: "recording_stopped",
          severity: recConfig.severity,
          timestamp: now,
          title: "Recording stopped",
          detail: `recording_state=${String(body.recording_state)}`,
          dedupe: now.slice(0, 10),
          data: { recording_state: String(body.recording_state) }
        });
      }
    }

    // B1: surface the session lifecycle status so the recorder can self-stop if a
    // proctor locked/ended the session (requireWritableSession already 403/409s a
    // non-active session, but an active heartbeat returns the live status too).
    // S5: ALSO surface the current exam end time + server clock. The heartbeat is
    // the student's only live channel (15 s interval), so an admin's end-time
    // change reaches every student within one interval — no reload.
    // Person-contest sessions source end_at AND enforcement from THEIR contest
    // doc (S-I snapshot fields), matching startResponse; an orphaned session doc
    // (no current person contest) degrades to the normalized defaults.
    const contest = await personContestForSession(session);
    const enforcement = enforcementConfigFor(contest);

    // F5.3 wave-2 fix: the heartbeat closes the server-side fullscreen countdown
    // (events set fullscreen_out_since; the heartbeat's `fullscreen` field is
    // corrective truth). A lock applied HERE is reported on this very response so
    // the recorder self-stops within the same interval.
    const reconciledStatus = await reconcileEnforcementCountdown(session, body, enforcement, alertSettings);
    return {
      ok: true,
      status: reconciledStatus || session.status || "active",
      start_ip: startIp,
      current_ip: currentIp,
      ip_changed: ipChanged,
      newly_changed: newlyChanged,
      end_at: contest?.end_at || "",
      // Take-home: the live channel also refreshes the official T0 + remote flag +
      // proctor phone, so the in-session countdown + phone stay skew-safe and
      // current. Optional chaining is orphaned-session safe (contest may be null),
      // matching the contest?.end_at pattern; all three default falsy off take-home.
      start_at: contest?.start_at || null,
      take_home: Boolean(contest?.take_home_enabled),
      proctor_contact_phone: contest?.proctor_contact_phone || "",
      // F5.3/F5.5: the heartbeat is the live channel for enforcement config AND
      // per-session exemptions, so an admin/invigilator exemption (or a settings
      // change) reaches the candidate within one interval — no reload.
      enforcement,
      enforcement_exemptions: sanitizeExemptions(session.enforcement_exemptions),
      server_now: now
    };
  }

  // Liveness beacon (Phase 2). Designed for navigator.sendBeacon(), which fires on
  // page hide/unload and may deliver the body as text/plain rather than JSON, with
  // NO custom headers — so this endpoint is gated ONLY by session_id ownership
  // (the unguessable session token), never by admin auth. It accepts either a JSON
  // object body or a raw text/plain JSON string.
  //
  //   kind:'hidden'  → the proctor tab was hidden (visibilitychange)
  //   kind:'closing' → the page is unloading (pagehide/beforeunload)
  //   kind:'visible' → the tab returned to the foreground
  //
  // On 'hidden'/'closing' we stamp last_seen_at and (if the tab_hidden alert type
  // is enabled in settings) upsert a warning tab_hidden proctor alert carrying
  // video_key/room/session_id, using the same idempotent id convention. 'visible'
  // only refreshes last_seen_at. The beacon NEVER goes through
  // requireWritableSession: a locked/ended/pending session can still emit liveness
  // without being rejected (sendBeacon ignores the response anyway).
  async function recordBeacon(req) {
    const body = parseBeaconBody(req);
    requireFields(body, ["session_id"]);
    const kind = String(body.kind || "hidden").toLowerCase();
    if (!["hidden", "visible", "closing"].includes(kind)) {
      return badRequest("kind must be hidden, visible, or closing");
    }

    // Ownership gate: an unknown session_id is a 404 (no admin auth involved). The
    // session token is the only credential, matching sendBeacon's constraints.
    const session = await getSession(body.session_id);
    // v1.1 G3 (#4): rate-limit the beacon too. sendBeacon ignores the response,
    // so a throttled beacon simply isn't recorded — fine under a flood; the
    // generous cap (60 burst, 1/s) never trips on real visibility flapping.
    telemetryCheck("beacon", session.session_id);
    const now = new Date().toISOString();

    await sessionRef(session.session_id).update({
      updated_at: now,
      last_seen_at: now,
      last_beacon_kind: kind
    });

    // Only the away signals (hidden/closing) raise an alert; visible is liveness
    // only. Respect the tab_hidden enable toggle and configured severity.
    if (kind === "hidden" || kind === "closing") {
      const settings = await getAlertSettings();
      const config = alertTypeConfig(settings, "tab_hidden", "warning");
      if (config.enabled) {
        await upsertProctorAlert(session, {
          type: "tab_hidden",
          severity: config.severity,
          timestamp: now,
          title: "Proctor tab hidden",
          detail: `Proctor tab ${kind === "closing" ? "closing/unloading" : "hidden"}`,
          // Per-day dedupe so a flurry of hide/show events collapses to one alert
          // per session per day, matching the other sure-shots.
          dedupe: now.slice(0, 10),
          data: { kind }
        });
      }
    }

    return { ok: true, kind, last_seen_at: now };
  }

  // sendBeacon may deliver a text/plain string body; parse it leniently as JSON.
  // A non-string body (some runtimes parse JSON for us) is returned as-is. A blank
  // body becomes {} so requireFields surfaces the missing session_id cleanly.
  function parseBeaconBody(req) {
    const raw = req.body;
    if (raw === undefined || raw === null || raw === "") return {};
    if (typeof raw !== "string") return raw;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      throw httpError(400, "invalid_json");
    }
  }

  return {
    // route handlers — names match the dispatch table exactly so handler.mjs's
    // dispatch lines stay byte-identical (canaryIsolation). Candidate-token auth
    // (not admin), so outside routesAuthLint's admin*/invigilator* scope.
    createUploadUrl,
    recordEvents,
    ingestEditorEvents,
    recordReviewFile,
    recordHeartbeat,
    recordBeacon
  };
}
