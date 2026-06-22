// backend/src/proctorAlerts.mjs — the proctor ALERTS DOMAIN as a FACTORY
// (decomp B9a, plan §A4 / 05-decomp-plan §1.2). makeProctorAlerts(ctx) joins the
// EXISTING domain layer (next to contests.mjs / identity.mjs / enforcement.mjs) —
// it is a DOMAIN module, NOT a route module and NOT lib/ (lib = infra only).
//
// THE LINCHPIN of the backend remainder: this alerts logic is shared by THREE
// route groups — session-telemetry (recordEvents / heartbeat), the alerts routes,
// and the session-gate routes (enforcement raises alerts). Extracting it as a
// flat domain factory BEFORE any of those route groups split is what lets each
// route file consume the SAME single-source helpers via ctx, instead of forcing a
// forbidden route→route import or a duplicated live-exam-critical helper.
//
// This step is a pure SAME-FILE → MODULE lift: NO routes move yet. handler.mjs
// instantiates the factory at module scope and destructures the returns into the
// SAME names its resident code (telemetry / heartbeat / invigilator ctx / the
// still-resident alert routes) already calls, so the call sites stay
// byte-identical and the dispatch table is untouched (canaryIsolation).
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as the other domains: alerts tests import the handler with a
// ?buster and swap the fake Firestore via __setClientsForTest — getFirestore is
// therefore a GETTER so the swap propagates (the live handle is never captured by
// value).
//
// upsertProctorAlert / alertRef use scopedQuery? NO — they address ALERTS docs by
// deterministic id (alertRef(id)); the alerts reads that DO scope live in the
// alert ROUTES (B9) and go through scopedQuery. Nothing here is a raw contest_slug
// equality filter, so scopingLint's allowlist stays {handler.mjs: 4}.
//
// CROSS-DOMAIN helpers from ENFORCEMENT (src/enforcement.mjs after B10a; resident
// in handler.mjs at B9a) arrive BY REFERENCE through ctx — single source, never
// forked:
//   sanitizeExemptions — raiseSwitchAwayAlerts honours the per-session switch_away
//                        exemption.
//   intOrZero          — parses switch-away episode duration/count.
//
// Dependency direction (conventions): handler.mjs → (src domain modules incl.
// proctorAlerts.mjs, lib/*). Nothing is imported here — every dependency (the live
// Firestore getter, the http transport helper, the sanitizers / iso clock /
// session identity adapter, the cross-domain enforcement helpers by reference, and
// the env-captured settings + alerts collection names BY VALUE) arrives through
// ctx, so the env-capture-at-load semantics stay in handler.mjs (env-lint).

export function makeProctorAlerts(ctx) {
  const {
    getFirestore,
    httpError,
    // sanitizers / clock / identity adapter (lib + sessionStore, by reference)
    sanitizeObject,
    normalizeUsername,
    isoOrNow,
    candidateOf,
    // cross-domain enforcement helpers (resident at B9a; src/enforcement.mjs after
    // B10a) — by reference, single source
    sanitizeExemptions,
    intOrZero,
    // env-captured collection names / settings id (by value at handler load)
    settingsCollection,
    alertsCollection,
    alertSettingsId,
    // v1.1 G3 (#5): optional hot-path read cache for the alert-settings doc
    // (read on every heartbeat/events/beacon/room-gate). A single shared key.
    // Null when disabled → every read hits Firestore (prior behavior). The
    // alert-settings WRITE path (routes/alerts.mjs) invalidates it.
    alertSettingsCache = null
  } = ctx;
  const ALERT_SETTINGS_CACHE_KEY = "proctor_alert_settings";

  // ---- Sure-shot proctor alerts (Phase 2, 2.3 / Epic 4) ---------------------

  // SURE-SHOT client event types: when one of these arrives via /api/events we
  // raise an idempotent proctor alert. Everything else (focus/blur/visibility/
  // clipboard) is intentionally NOT surfaced — it is noisy.
  const SURE_SHOT_EVENT_TYPES = {
    recording_stopped: { severity: "critical", title: "Recording stopped" },
    screen_share_stopped: { severity: "critical", title: "Screen sharing stopped" },
    // invalid_share_surface is intentionally absent: the recorder now REFUSES to
    // record on a non-monitor share surface (tab/window), so this event can never
    // fire. Removed from the catalog so it is no longer raised or configurable.
    // Existing stored alerts of this type still DISPLAY (see ALLOWED_ALERT_TYPES /
    // alert normalization) for backward compatibility.
    recording_error: { severity: "critical", title: "Recording error" }
  };

  // ---- Proctor alert settings (enabled + severity per sure-shot type) --------
  //
  // The admin console can disable a sure-shot type or override its severity. The
  // full set of proctor-controllable types and their DEFAULTS live here; the
  // settings doc only stores deltas, but adminGetAlertSettings always returns the
  // full set (defaults merged with any stored overrides) so the console renders a
  // complete toggle list.
  //
  // recording_stopped / screen_share_stopped / recording_error  → critical
  // ip_changed / tab_hidden / tab_away / disconnected → warning
  // NOTE: invalid_share_surface was REMOVED from the catalog — the recorder now
  // refuses to record on an invalid share surface, so the event can never fire.
  // tab_away additionally carries a numeric threshold_seconds (default 12): the
  // minimum continuous "HackerRank not visible" span the monitoring tab-away
  // detector must observe before raising an alert. This is the source of truth for
  // the detector's --min-gap-seconds.
  // F9.3 (product-owner decision, Wave6): show_to_invigilator gates each type's appearance
  // on the INVIGILATOR room dashboard's alert feed (server-side filter in
  // invigilatorRoom; the admin console always sees everything). The admin OPTS IN
  // per type — DEFAULT ALL OFF: nothing is shared with invigilators until the admin
  // explicitly ticks "Share with invigilator" for a type. An empty/absent stored
  // config therefore shares NOTHING (back-compat: a doc saved before this flag
  // existed had no show_to_invigilator, which merges to the default → false → not
  // shared, so no historical doc silently leaks alerts to invigilators).
  const TAB_AWAY_DEFAULT_THRESHOLD_SECONDS = 12;
  const DEFAULT_PROCTOR_ALERT_SETTINGS = {
    recording_stopped: { enabled: true, severity: "critical", show_to_invigilator: false },
    screen_share_stopped: { enabled: true, severity: "critical", show_to_invigilator: false },
    recording_error: { enabled: true, severity: "critical", show_to_invigilator: false },
    // F5.3: the fullscreen enforcement ladder tripped (countdown expired / exit
    // limit exceeded). Disabling this hides the ALERT only — the block-mode lock
    // itself is policy, not alerting, and is governed by enforcement_mode.
    fullscreen_enforcement: { enabled: true, severity: "critical", show_to_invigilator: false },
    ip_changed: { enabled: true, severity: "warning", show_to_invigilator: false },
    tab_hidden: { enabled: true, severity: "warning", show_to_invigilator: false },
    tab_away: { enabled: true, severity: "warning", show_to_invigilator: false, threshold_seconds: TAB_AWAY_DEFAULT_THRESHOLD_SECONDS },
    disconnected: { enabled: true, severity: "warning", show_to_invigilator: false }
  };

  const ALERT_SOURCES = ["proctor", "contest-eval"];
  const ALERT_SEVERITIES = ["critical", "warning", "info"];
  const ALERT_VERDICT_STATUSES = ["pending", "real", "false_positive", "inconclusive"];
  const ALERT_REQUIRED_FIELDS = ["source", "type", "severity", "timestamp", "hackerrank_username", "title"];

  // Read the stored alert-settings doc and merge it over the defaults so callers
  // always see a complete, well-formed per-type config. One Firestore read; call
  // once per request and thread the result into the sure-shot upsert sites so a
  // single request never re-reads it.
  async function getAlertSettings() {
    // v1.1 G3 (#5): read through the TTL cache. The merged result is cached (it
    // is a pure function of the stored doc); a settings write invalidates the
    // cache, and the TTL bounds cross-instance staleness. Caches the MERGED
    // object so the per-request merge is also skipped on a hit.
    if (alertSettingsCache) {
      const hit = alertSettingsCache.get(ALERT_SETTINGS_CACHE_KEY);
      if (hit !== undefined) return hit;
    }
    const doc = await getFirestore().collection(settingsCollection).doc(alertSettingsId).get();
    const stored = doc.exists ? (doc.data()?.proctor || {}) : {};
    const merged = mergeAlertSettings(stored);
    if (alertSettingsCache) alertSettingsCache.set(ALERT_SETTINGS_CACHE_KEY, merged);
    return merged;
  }

  function mergeAlertSettings(stored) {
    const proctor = {};
    for (const [type, def] of Object.entries(DEFAULT_PROCTOR_ALERT_SETTINGS)) {
      const override = stored && typeof stored === "object" ? stored[type] : undefined;
      const entry = {
        enabled: override && typeof override.enabled === "boolean" ? override.enabled : def.enabled,
        severity: override && ALERT_SEVERITIES.includes(override.severity) ? override.severity : def.severity,
        // F9.3: invigilator visibility — only an explicit boolean overrides the default.
        show_to_invigilator: override && typeof override.show_to_invigilator === "boolean"
          ? override.show_to_invigilator
          : def.show_to_invigilator
      };
      // tab_away alone carries a numeric threshold_seconds (minimum continuous
      // absence the tab-away detector flags). Validate it's a positive finite
      // number; otherwise fall back to the default (12). Other types don't have it.
      if ("threshold_seconds" in def) {
        const raw = override ? override.threshold_seconds : undefined;
        const num = typeof raw === "number" ? raw : Number(raw);
        entry.threshold_seconds = Number.isFinite(num) && num > 0 ? num : def.threshold_seconds;
      }
      proctor[type] = entry;
    }
    return { proctor };
  }

  // Resolve the effective config for one alert type from a (already-read)
  // settings object. Falls back to a default-enabled/configured-severity entry for
  // any type not present in DEFAULT_PROCTOR_ALERT_SETTINGS (defensive).
  function alertTypeConfig(settings, type, fallbackSeverity) {
    const entry = settings?.proctor?.[type];
    if (entry) return entry;
    return { enabled: true, severity: fallbackSeverity };
  }

  // F9.3 (product-owner decision, Wave6): does this STORED alert appear on the invigilator
  // room dashboard? Catalog types follow their explicit show_to_invigilator config;
  // catalog-UNKNOWN types (legacy invalid_share_surface, future ingest types) are
  // NOT shared — the admin can only opt in types the catalog actually exposes, so
  // an unknown type has no opt-in switch and stays admin-only (matches the new
  // default-all-off contract: nothing is surfaced to invigilators unless an
  // explicit boolean flag says so).
  function isAlertShownToInvigilator(settings, alert) {
    const entry = settings?.proctor?.[alert?.type];
    if (entry) return entry.show_to_invigilator === true;
    return false;
  }

  // FIX-B3 #6: does ANY proctor alert type have show_to_invigilator on? Drives the
  // invigilator empty-feed copy: when nothing is shared, the empty alerts panel
  // says so explicitly ("No alert types are shared…") instead of a bare "No open
  // alerts" that reads as broken. Pure projection over the merged alert settings.
  function anyAlertSharedWithInvigilator(settings) {
    const proctor = settings?.proctor || {};
    return Object.values(proctor).some((entry) => entry && entry.show_to_invigilator === true);
  }

  // Recorder states that mean "not recording" for the heartbeat sure-shot.
  const STOPPED_RECORDING_STATES = new Set(["stopped", "inactive", "ended", "error"]);

  // B2: the recorder sends a COMPOSITE recording_state like
  //   "combined:inactive;screen:stopped;camera:recording;microphone:stopped"
  // (one segment per media track). The sure-shot fires when the CORE capture
  // (the combined MediaRecorder or the screen track) is not recording — a stopped
  // camera/microphone alone is not a recording_stopped signal. A bare legacy
  // string ("stopped") is still honoured for backward compatibility.
  function isRecordingStopped(recordingState) {
    const raw = String(recordingState || "").toLowerCase().trim();
    if (!raw) return false;
    if (raw.includes(":")) {
      const segments = parseRecordingStateSegments(raw);
      // Only the core capture tracks gate the sure-shot. If the payload doesn't
      // name them (unexpected shape), fall back to "any segment stopped".
      const core = ["combined", "screen"].filter((key) => key in segments);
      const gates = core.length ? core.map((key) => segments[key]) : Object.values(segments);
      return gates.some((state) => STOPPED_RECORDING_STATES.has(state));
    }
    return STOPPED_RECORDING_STATES.has(raw);
  }

  function parseRecordingStateSegments(raw) {
    const segments = {};
    for (const part of raw.split(";")) {
      const [key, value] = part.split(":");
      if (key && value !== undefined) segments[key.trim()] = value.trim();
    }
    return segments;
  }

  // F6.6: project the persisted composite recording_state (the heartbeat already
  // stores the recorder's "combined:X;screen:Y;camera:Z;microphone:W" on the
  // session doc) into a STRUCTURED per-source capture state for the admin
  // surfaces — the session detail card and the recordings-review header. Camera
  // and microphone matter here because the recorded webm is the DIRECT screen
  // stream + mixed mic audio; the camera is live-monitor only and is never part
  // of the recorded video, so the admin needs the per-source truth to know what
  // a recording contains. Returns null for legacy bare strings ("recording") or
  // missing state; an unexpected segment value projects as "unknown" so raw
  // client input never leaks through.
  const CAPTURE_SOURCES = ["screen", "camera", "microphone"];
  const CAPTURE_SOURCE_STATES = new Set(["inactive", "recording", "stopped", "error", "permission_denied", "unavailable"]);

  function parseCaptureState(recordingState) {
    const raw = String(recordingState || "").toLowerCase().trim();
    if (!raw.includes(":")) return null;
    const segments = parseRecordingStateSegments(raw);
    if (!CAPTURE_SOURCES.some((source) => source in segments)) return null;
    const state = {};
    for (const source of CAPTURE_SOURCES) {
      const value = segments[source];
      state[source] = CAPTURE_SOURCE_STATES.has(value) ? value : "unknown";
    }
    return state;
  }

  // F5.4: a debounced switch-away episode is alert-worthy when it is LONG
  // (>= the admin-configurable tab_away threshold) or FREQUENT (this many
  // distinct switch-away excursions inside one rolling episode window — the
  // client reducer counts not-away → away transitions, so one tab switch's
  // blur+hidden signal pair is ONE, wave-3 fix).
  const SWITCH_AWAY_FREQUENT_COUNT = 3;

  async function raiseSureShotAlertsFromEvents(session, events, settings) {
    // Collapse repeats within this single batch: one alert per sure-shot type per
    // batch (the per-day dedupe in upsertProctorAlert keeps it stable across
    // batches too). Walk in order so we keep the latest timestamp for the type.
    const seen = new Map();
    for (const event of events) {
      const spec = SURE_SHOT_EVENT_TYPES[event.type];
      if (!spec) continue;
      seen.set(event.type, { event, spec });
    }
    for (const { event, spec } of seen.values()) {
      // Consult the per-type proctor alert settings: skip a disabled type and use
      // the configured severity (default = the spec's built-in severity).
      const config = alertTypeConfig(settings, event.type, spec.severity);
      if (!config.enabled) continue;
      const timestamp = isoOrNow(event.timestamp);
      await upsertProctorAlert(session, {
        type: event.type,
        severity: config.severity,
        timestamp,
        title: spec.title,
        detail: detailFromEvent(event),
        dedupe: timestamp.slice(0, 10),
        data: event.detail && typeof event.detail === "object" ? event.detail : undefined
      });
    }

    await raiseSwitchAwayAlerts(session, events, settings);
  }

  // F5.4: switch_away_episode events (the client's debounced window_blur /
  // visibility runs) surface through the EXISTING threshold-based tab_away alert
  // so proctors review the video and decide — switch-away NEVER auto-blocks.
  // The per-session switch_away exemption suppresses the alert only; the raw
  // episode event still lands in evidence storage (recordEvents already wrote it).
  async function raiseSwitchAwayAlerts(session, events, settings) {
    if (sanitizeExemptions(session.enforcement_exemptions).switch_away === true) return;
    const config = alertTypeConfig(settings, "tab_away", "warning");
    if (!config.enabled) return;
    const thresholdMs = (config.threshold_seconds || TAB_AWAY_DEFAULT_THRESHOLD_SECONDS) * 1000;
    for (const event of events) {
      if (event.type !== "switch_away_episode") continue;
      const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
      const durationMs = Math.max(0, intOrZero(detail.duration_ms));
      const count = Math.max(0, intOrZero(detail.count));
      if (durationMs < thresholdMs && count < SWITCH_AWAY_FREQUENT_COUNT) continue;
      await upsertProctorAlert(session, {
        type: "tab_away",
        severity: config.severity,
        timestamp: isoOrNow(event.timestamp),
        title: "Switched away from the exam",
        detail: `Away ~${Math.round(durationMs / 1000)}s across ${count} switch(es)`,
        // Per-minute dedupe (not per-day): distinct long episodes should each be
        // visible; same-minute retries still collapse. Wave-3 fix: keyed on
        // SERVER time — the event timestamp is client-supplied, so a pinned
        // stamp could silence every future episode (or spoofed ones could fan
        // a single batch into many alerts).
        dedupe: new Date().toISOString().slice(0, 16),
        data: { count, duration_ms: durationMs }
      });
    }
  }

  function detailFromEvent(event) {
    if (event.detail && typeof event.detail === "object") {
      const reason = event.detail.reason || event.detail.message || event.detail.surface;
      if (reason) return String(reason).slice(0, 2000);
    }
    return undefined;
  }

  // Upsert a source:'proctor' alert into ALERTS_COLLECTION using the same
  // idempotent id convention as Phase-1 ingest:
  //   <source>:<type>:<username_norm>:<contest_slug>:<dedupe>
  // so retries / repeated heartbeats collapse to one document. Attaches video_key
  // (merged output if present, else the raw screen chunk prefix) for deep-linking.
  async function upsertProctorAlert(session, { type, severity, timestamp, title, detail, dedupe, data }) {
    const usernameNorm = session.username_norm;
    const contestSlug = session.contest_slug || "_";
    const id = `proctor:${type}:${usernameNorm}:${contestSlug}:${dedupe}`;
    const now = new Date().toISOString();

    // S-C: person-path sessions carry candidate_id instead of
    // hackerrank_username — the dual-read adapter keeps the frozen field
    // populated with the display id either way (never undefined).
    const displayId = candidateOf(session).id;
    const item = {
      id,
      source: "proctor",
      type,
      severity,
      timestamp: isoOrNow(timestamp),
      hackerrank_username: session.hackerrank_username !== undefined ? session.hackerrank_username : displayId,
      candidate_id: displayId,
      username_norm: usernameNorm,
      title,
      session_id: session.session_id,
      received_at: now
    };
    if (session.contest_slug) item.contest_slug = session.contest_slug;
    if (session.room) item.room = session.room;
    if (detail) item.detail = String(detail).slice(0, 2000);
    if (data && typeof data === "object") item.data = sanitizeObject(data);

    const videoKey = sureShotVideoKey(session);
    if (videoKey) item.video_key = videoKey;

    await alertRef(id).set(item, { merge: true });
    return item;
  }

  // Deep-link target for a sure-shot alert: the merged review video the worker
  // wrote back onto the session doc (merged_video_key) once a merge succeeded.
  // B4: if no merged video exists yet, return null rather than a `…/screen/`
  // FOLDER prefix — a folder prefix signs a nonexistent object and renders a
  // broken link. With null, the console simply hides the link until the merge
  // runs and merged_video_key is populated.
  function sureShotVideoKey(session) {
    return session.merged_video_key || null;
  }

  function normalizeAlert(alert, index, receivedAt) {
    if (!alert || typeof alert !== "object" || Array.isArray(alert)) {
      throw httpError(400, `alerts[${index}] must be an object`);
    }
    // S-C (F9 §1.2): ingest accepts candidate_id as an alias for the frozen
    // hackerrank_username field FOREVER — the poller fleet upgrades lazily.
    if ((alert.hackerrank_username === undefined || alert.hackerrank_username === null || alert.hackerrank_username === "")
        && alert.candidate_id !== undefined && alert.candidate_id !== null && alert.candidate_id !== "") {
      alert = { ...alert, hackerrank_username: alert.candidate_id };
    }
    for (const field of ALERT_REQUIRED_FIELDS) {
      const value = alert[field];
      if (value === undefined || value === null || value === "") {
        throw httpError(400, `alerts[${index}].${field} is required`);
      }
    }
    if (!ALERT_SOURCES.includes(alert.source)) {
      throw httpError(400, `alerts[${index}].source must be one of ${ALERT_SOURCES.join(", ")}`);
    }
    if (!ALERT_SEVERITIES.includes(alert.severity)) {
      throw httpError(400, `alerts[${index}].severity must be one of ${ALERT_SEVERITIES.join(", ")}`);
    }
    if (Number.isNaN(Date.parse(alert.timestamp))) {
      throw httpError(400, `alerts[${index}].timestamp must be a valid ISO 8601 date`);
    }

    const username = String(alert.hackerrank_username).trim();
    const usernameNorm = alert.username_norm ? normalizeUsername(alert.username_norm) : normalizeUsername(username);
    // Derive a stable, deterministic id when the client did not supply one so the
    // doc id stays idempotent across retries instead of minting a random UUID.
    const id = alert.id !== undefined && alert.id !== null && alert.id !== ""
      ? String(alert.id)
      : `${alert.source}:${alert.type}:${usernameNorm}:${alert.contest_slug || "_"}:${alert.timestamp}`;

    const item = {
      id,
      source: String(alert.source),
      type: String(alert.type),
      severity: String(alert.severity),
      timestamp: String(alert.timestamp),
      hackerrank_username: username,
      candidate_id: username, // S-C dual-field: same display id under both names
      username_norm: usernameNorm,
      title: String(alert.title),
      received_at: receivedAt
    };

    if (alert.contest_slug) item.contest_slug = String(alert.contest_slug);
    if (alert.session_id) item.session_id = String(alert.session_id);
    if (alert.room) item.room = String(alert.room);
    if (alert.detail) item.detail = String(alert.detail);
    if (alert.data && typeof alert.data === "object") item.data = sanitizeObject(alert.data);
    if (alert.video_key) item.video_key = String(alert.video_key);
    if (alert.verdict && typeof alert.verdict === "object") {
      item.verdict = normalizeVerdict(alert.verdict);
    }

    // download_url is resolved on read and never persisted.
    return item;
  }

  function normalizeVerdict(verdict) {
    const status = ALERT_VERDICT_STATUSES.includes(verdict.status) ? verdict.status : "pending";
    const out = { status };
    if (verdict.reason) out.reason = String(verdict.reason).slice(0, 2000);
    if (verdict.by) out.by = String(verdict.by).slice(0, 200);
    return out;
  }

  function alertRef(alertId) {
    // Sanitize before use as a Firestore doc id: a `/` in a doc id is a
    // resource-path separator (even-segment counts throw; odd-segment counts
    // write to a nested subcollection), so an ingest-supplied id could error or
    // land a doc off the alerts collection. Well-formed ids are already within
    // this charset, so this is a no-op for them. Defense-in-depth on the
    // API-key-gated ingest surface and the admin verdict/archive paths.
    const safeId = String(alertId).replace(/[^A-Za-z0-9:._-]/g, "_");
    return getFirestore().collection(alertsCollection).doc(safeId);
  }

  return {
    // catalogs / constants (consumed by telemetry, invigilator ctx, and the
    // still-resident alert routes; the alert routes move to routes/alerts.mjs at B9
    // and will receive these via ctx instead)
    SURE_SHOT_EVENT_TYPES,
    DEFAULT_PROCTOR_ALERT_SETTINGS,
    TAB_AWAY_DEFAULT_THRESHOLD_SECONDS,
    ALERT_SOURCES,
    ALERT_SEVERITIES,
    ALERT_VERDICT_STATUSES,
    ALERT_REQUIRED_FIELDS,
    // settings + projection helpers
    getAlertSettings,
    mergeAlertSettings,
    alertTypeConfig,
    isAlertShownToInvigilator,
    anyAlertSharedWithInvigilator,
    // recording-state / capture-state parsers
    isRecordingStopped,
    parseRecordingStateSegments,
    parseCaptureState,
    // sure-shot raising + upsert
    raiseSureShotAlertsFromEvents,
    raiseSwitchAwayAlerts,
    upsertProctorAlert,
    sureShotVideoKey,
    // ingest normalization + the alerts doc ref (used by the resident alert routes
    // until B9 moves them)
    normalizeAlert,
    normalizeVerdict,
    alertRef
  };
}
