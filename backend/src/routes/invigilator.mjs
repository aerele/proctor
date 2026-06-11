// backend/src/routes/invigilator.mjs — the invigilator route domain as a
// FACTORY (decomp B1, plan §A2/§A4/§A8). makeInvigilatorRoutes(ctx) closes over
// the ctx the handler builds per ?buster instance and returns the seven
// invigilator route handlers + the room-gate helpers it OWNS. handler.mjs
// instantiates this at module scope and destructures the result, so the
// dispatch lines stay byte-identical (canaryIsolation) and the still-resident
// session routes (sessionRoomGate / sessionUnlockGate) reuse the returned
// gateRoomKey / getRoomGate.
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as makeAuth / makeSessionStore: invigilator.test.mjs imports
// the handler 3× in one process with different env and keeps using the first
// instance — a shared mutable singleton would let a later instance's config leak
// back into an earlier one.
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*). This module imports ONLY stateless leaves (lib/http,
// lib/sanitize) + the contests domain chokepoint; everything stateful (the live
// Firestore handle, credentials, collection names, caps, and the handler-resident
// helper functions it still needs) arrives through ctx.
import { randomInt } from "node:crypto";
import { badRequest, httpError, parseBody, requireFields } from "../lib/http.mjs";
import { normalizeUsername, safeEqual, sanitizeRoom } from "../lib/sanitize.mjs";
import { ALL_CONTESTS, resolveContest, scopedQuery } from "../contests.mjs";

export function makeInvigilatorRoutes(ctx) {
  const {
    getFirestore,
    requireInvigilatorFor,
    getSettings,
    sessionRef,
    candidateOf,
    contestSlugFromUrl,
    // collection names (captured at handler load, per ?buster instance)
    sessionCollection,
    alertsCollection,
    roomGatesCollection,
    // caps
    sessionsQueryLimit,
    alertsQueryLimit,
    invigilatorSessionsLimit,
    invigilatorAlertsLimit,
    disconnectedStalenessMs,
    // const token reused across the enforcement-lock surface
    enforcementLockReason,
    // handler-resident helpers (keep their own handler-scope closures)
    contestScopeOf,
    normalizeRooms,
    distinctRooms,
    isStaleSession,
    getAlertSettings,
    isAlertShownToInvigilator,
    anyAlertSharedWithInvigilator,
    sanitizeExemptions
  } = ctx;

  // Room-scoped console (NO signed-QR verification — deferred by design). Auth =
  // requireInvigilator. Scope is ALWAYS the active contest from the settings doc;
  // invigilators never pick a contest. Least privilege: these endpoints expose NO
  // emails, NO IP addresses, NO signed media URLs.

  // GET /api/invigilator/overview — room-picker bootstrap: distinct room labels
  // (same helper the admin dropdowns use), whether blank-room sessions exist
  // (the "_" pseudo-room), and whether the room start gate is enabled.
  async function invigilatorOverview(req) {
    const contest = await invigilatorContestOf(req);
    requireInvigilatorFor(req, contest);
    const settings = contest ? null : await getSettings();
    const contestSlug = invigilatorContestSlug(contest, settings);
    const scope = contest || await contestScopeOf(contestSlug);
    const snapshot = await scopedQuery(getFirestore().collection(sessionCollection), scope)
      .limit(sessionsQueryLimit)
      .get();
    const docs = snapshot.docs.map((doc) => doc.data());
    // Contest mode: the CONFIGURED rooms (contest doc) union the rooms sessions
    // actually carry — invigilators can pick their room before any session exists.
    const rooms = contest
      ? [...new Set([...normalizeRooms(contest.rooms), ...distinctRooms(docs)])].sort((a, b) => a.localeCompare(b))
      : distinctRooms(docs);
    return {
      contest_slug: contestSlug || null,
      room_gate_enabled: contest ? Boolean(contest.room_gate_enabled) : Boolean(settings?.room_gate_enabled),
      rooms,
      has_unassigned: docs.some((doc) => !String(doc.room || "").trim())
    };
  }

  // Room start gate (S3). ONE doc per (contest, room); deterministic id so
  // re-releases upsert (mirrors the live-lock id pattern). The OTP is stored in
  // PLAINTEXT deliberately: it is a short-lived room-coordination code the
  // invigilator must be able to RE-DISPLAY (portal reload, board rewrite), not a
  // credential guarding data; online guessing is bounded by the per-session
  // attempt cap in sessionRoomGate.
  function gateRoomKey(room) {
    const cleaned = sanitizeRoom(room === undefined || room === null ? "" : room);
    return cleaned || "_";
  }

  function roomGateRef(contestSlug, roomKey) {
    return getFirestore().collection(roomGatesCollection).doc(`gate:${contestSlug || "_"}:${roomKey}`);
  }

  async function getRoomGate(contestSlug, roomKey) {
    const doc = await roomGateRef(contestSlug, roomKey).get();
    return doc.exists ? doc.data() : null;
  }

  function generateRoomOtp() {
    return String(randomInt(0, 1000000)).padStart(6, "0");
  }

  // Public projection of a gate doc — exactly what invigilator endpoints return.
  function publicRoomGate(gate) {
    if (!gate) return null;
    return {
      room: gate.room || "",
      room_key: gate.room_key,
      mode: gate.mode,
      otp: gate.otp || "",
      released_at: gate.released_at || null,
      released_by: gate.released_by || "",
      opened_at: gate.opened_at || null,
      opened_by: gate.opened_by || "",
      // F5.6 wave-2 fix: the ENFORCEMENT-UNLOCK code lives in its own namespace —
      // never the start OTP, which every candidate in an OTP-gated room typed.
      unlock_otp: gate.unlock_otp || "",
      unlock_released_at: gate.unlock_released_at || null,
      unlock_released_by: gate.unlock_released_by || "",
      updated_at: gate.updated_at || ""
    };
  }

  // Gate mutations require the admin to have ENABLED the room gate (the admin
  // checkbox is also the admin-side master bypass: turning it off releases
  // everyone on their next poll).
  async function requireGateEnabledSettings() {
    const settings = await getSettings();
    if (!settings?.room_gate_enabled) badRequest("room_gate_disabled");
    return settings;
  }

  // POST /api/invigilator/release-code — mint (or re-display) the room's 6-digit
  // start OTP. Idempotent by default: an existing OTP is returned unchanged so a
  // portal reload never silently invalidates the code already on the board; pass
  // regenerate:true for a fresh one. Calling this on an OPEN room re-arms the
  // OTP gate (late arrivals) — already-released candidates keep exam_started_at.
  async function invigilatorReleaseCode(req) {
    const contest = await invigilatorContestOf(req);
    requireInvigilatorFor(req, contest);
    const body = parseBody(req);
    requireFields(body, ["room"]);
    const settings = await requireGateEnabledFor(contest);
    const contestSlug = invigilatorContestSlug(contest, settings);
    const roomKey = gateRoomKey(body.room);
    const existing = await getRoomGate(contestSlug, roomKey);
    if (existing && existing.mode === "otp" && existing.otp && body.regenerate !== true) {
      return { ok: true, contest_slug: contestSlug || null, gate: publicRoomGate(existing) };
    }
    const now = new Date().toISOString();
    const item = {
      contest_slug: contestSlug,
      room: roomKey === "_" ? "" : sanitizeRoom(body.room),
      room_key: roomKey,
      mode: "otp",
      otp: generateRoomOtp(),
      released_at: now,
      released_by: String(body.invigilator_name || "").slice(0, 120),
      opened_at: existing?.opened_at || null,
      opened_by: existing?.opened_by || "",
      // Full-doc rewrite must never clobber the separately-minted unlock code.
      unlock_otp: existing?.unlock_otp || "",
      unlock_released_at: existing?.unlock_released_at || null,
      unlock_released_by: existing?.unlock_released_by || "",
      updated_at: now
    };
    await roomGateRef(contestSlug, roomKey).set(item);
    return { ok: true, contest_slug: contestSlug || null, gate: publicRoomGate(item) };
  }

  // POST /api/invigilator/open-room — start-now / allow-all: marks the room OPEN
  // so every waiting candidate's next gate poll admits them without a code. This
  // is the room-scoped parallel of the admin's master switch (room_gate_enabled).
  async function invigilatorOpenRoom(req) {
    const contest = await invigilatorContestOf(req);
    requireInvigilatorFor(req, contest);
    const body = parseBody(req);
    requireFields(body, ["room"]);
    const settings = await requireGateEnabledFor(contest);
    const contestSlug = invigilatorContestSlug(contest, settings);
    const roomKey = gateRoomKey(body.room);
    const existing = await getRoomGate(contestSlug, roomKey);
    const now = new Date().toISOString();
    const item = {
      contest_slug: contestSlug,
      room: roomKey === "_" ? "" : sanitizeRoom(body.room),
      room_key: roomKey,
      mode: "open",
      otp: existing?.otp || "",
      released_at: existing?.released_at || null,
      released_by: existing?.released_by || "",
      opened_at: now,
      opened_by: String(body.invigilator_name || "").slice(0, 120),
      // Full-doc rewrite must never clobber the separately-minted unlock code.
      unlock_otp: existing?.unlock_otp || "",
      unlock_released_at: existing?.unlock_released_at || null,
      unlock_released_by: existing?.unlock_released_by || "",
      updated_at: now
    };
    await roomGateRef(contestSlug, roomKey).set(item);
    return { ok: true, contest_slug: contestSlug || null, gate: publicRoomGate(item) };
  }

  // POST /api/invigilator/unlock-code — mint (or re-display) the room's 6-digit
  // ENFORCEMENT-UNLOCK code (F5.6, wave-2 review fix). This is a SEPARATE
  // namespace from the start OTP: in an OTP-gated room every candidate personally
  // typed the start code, so accepting it for unlocks made the L2 lock
  // self-serve. Idempotent like release-code (reload re-displays the same code;
  // regenerate:true mints fresh). Deliberately NOT behind
  // requireGateEnabledSettings — with the default config (enforcement "block",
  // start gate off) this is the room proctor's ONLY code path, and an unlock
  // code must always be mintable.
  async function invigilatorUnlockCode(req) {
    const contest = await invigilatorContestOf(req);
    requireInvigilatorFor(req, contest);
    const body = parseBody(req);
    requireFields(body, ["room"]);
    const settings = contest ? null : await getSettings();
    const contestSlug = invigilatorContestSlug(contest, settings);
    const roomKey = gateRoomKey(body.room);
    const existing = await getRoomGate(contestSlug, roomKey);
    if (existing && existing.unlock_otp && body.regenerate !== true) {
      return { ok: true, contest_slug: contestSlug || null, gate: publicRoomGate(existing) };
    }
    const now = new Date().toISOString();
    const item = {
      contest_slug: contestSlug,
      room: roomKey === "_" ? "" : sanitizeRoom(body.room),
      room_key: roomKey,
      // Preserve the start-gate state untouched; a doc created purely for an
      // unlock code carries mode "none" (sessionRoomGate admits on "open"/"otp"
      // only, so this can never release a start gate).
      mode: existing?.mode || "none",
      otp: existing?.otp || "",
      released_at: existing?.released_at || null,
      released_by: existing?.released_by || "",
      opened_at: existing?.opened_at || null,
      opened_by: existing?.opened_by || "",
      unlock_otp: generateRoomOtp(),
      unlock_released_at: now,
      unlock_released_by: String(body.invigilator_name || "").slice(0, 120),
      updated_at: now
    };
    await roomGateRef(contestSlug, roomKey).set(item);
    return { ok: true, contest_slug: contestSlug || null, gate: publicRoomGate(item) };
  }

  // F2 (E2E live): resolve the stored session key the row actions match on.
  // An EXACT `username_norm` from the row payload is authoritative — it matches
  // BOTH legacy docs (username_norm = normalized candidate) AND person-mode
  // docs (username_norm = person_id "{college_norm}~{uid_norm}", whose "~"
  // normalizeUsername mangles to "_", so a display id can NEVER match them).
  // The display `username` stays as the legacy fallback for older portals —
  // the same exact-key-first precedence as adminSessions (FIX-B1).
  function rowUsernameNorm(body) {
    const exact = typeof body.username_norm === "string" ? body.username_norm.trim() : "";
    return exact || normalizeUsername(body.username);
  }

  // POST /api/invigilator/unlock — release one student's ENFORCEMENT lock from
  // the room dashboard (F5.6, wave-2 review fix: the locked screen promises
  // "unlock you from their console", which previously required ADMIN
  // credentials). Same least-privilege addressing as /api/invigilator/exempt
  // (room + username/username_norm, never session_id). Admin locks (no/
  // different locked_reason) stay admin-only — an invigilator must not undo a
  // deliberate admin lock. Independent of the room start gate.
  async function invigilatorUnlock(req) {
    const contest = await invigilatorContestOf(req);
    requireInvigilatorFor(req, contest);
    const body = parseBody(req);
    requireFields(body, ["room", "username"]);
    const settings = contest ? null : await getSettings();
    const contestSlug = invigilatorContestSlug(contest, settings);
    const roomKey = gateRoomKey(body.room);
    const roomLabel = roomKey === "_" ? "" : sanitizeRoom(body.room);
    const usernameNorm = rowUsernameNorm(body);

    const snapshot = await scopedQuery(
      getFirestore().collection(sessionCollection).where("username_norm", "==", usernameNorm),
      contest || await contestScopeOf(contestSlug)
    ).limit(50).get();
    const locked = snapshot.docs
      .map((doc) => doc.data())
      .filter((doc) => doc.status === "locked")
      .filter((doc) => String(doc.room || "") === roomLabel)
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    if (!locked.length) throw httpError(404, "no_locked_session_in_room");

    const session = locked[0];
    if (session.locked_reason !== enforcementLockReason) {
      throw httpError(403, "not_enforcement_locked");
    }
    const now = new Date().toISOString();
    await sessionRef(session.session_id).update({
      status: "active",
      unlocked_at: now,
      locked_reason: null,
      unlock_method: "invigilator",
      // Wave-2: reset the server-side exit ladder (mirrors the client's
      // post-release reset — a later accident is L1 again, not an instant relock).
      fullscreen_exit_count: 0,
      fullscreen_out_since: null,
      updated_at: now
    });
    return { ok: true, username: session.hackerrank_username || "", status: "active" };
  }

  // POST /api/invigilator/exempt — F5.5: per-student enforcement exemption from
  // the room dashboard. Least privilege preserved: the invigilator addresses the
  // candidate by room + username/username_norm (rows never expose session_id —
  // it is the candidate's write-endpoint bearer token), the backend resolves the
  // LIVE session in that room, and the response never echoes the token either.
  // Deliberately NOT behind requireGateEnabledSettings — exemptions are an
  // enforcement tool, independent of the room start gate.
  async function invigilatorExempt(req) {
    const contest = await invigilatorContestOf(req);
    requireInvigilatorFor(req, contest);
    const body = parseBody(req);
    requireFields(body, ["room", "username", "exemptions"]);
    const settings = contest ? null : await getSettings();
    const contestSlug = invigilatorContestSlug(contest, settings);
    const roomKey = gateRoomKey(body.room);
    const roomLabel = roomKey === "_" ? "" : sanitizeRoom(body.room);
    const usernameNorm = rowUsernameNorm(body);

    const snapshot = await scopedQuery(
      getFirestore().collection(sessionCollection).where("username_norm", "==", usernameNorm),
      contest || await contestScopeOf(contestSlug)
    ).limit(50).get();
    const live = snapshot.docs
      .map((doc) => doc.data())
      .filter((doc) => doc.status && doc.status !== "ended")
      .filter((doc) => String(doc.room || "") === roomLabel)
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    if (!live.length) throw httpError(404, "no_live_session_in_room");

    const session = live[0];
    const merged = { ...sanitizeExemptions(session.enforcement_exemptions), ...sanitizeExemptions(body.exemptions) };
    const now = new Date().toISOString();
    await sessionRef(session.session_id).update({ enforcement_exemptions: merged, updated_at: now });
    return { ok: true, username: session.hackerrank_username || "", enforcement_exemptions: merged };
  }

  // GET /api/invigilator/room?room=<label> — the ONE-CALL room dashboard the
  // portal polls every ~5 s: counts (same classification rules as adminStats,
  // incl. the derived disconnected signal) + a lightweight per-student list + the
  // room gate + the room's OPEN alerts. The special label "_" selects sessions
  // with NO room. Least privilege: rows carry NO email and NO IPs; alerts carry
  // NO video/download fields — invigilators read presence, not recordings.
  async function invigilatorRoom(req) {
    const contest = await invigilatorContestOf(req);
    requireInvigilatorFor(req, contest);
    const roomParam = req.query?.room;
    if (roomParam === undefined || roomParam === null || roomParam === "") {
      return badRequest("room is required");
    }
    const settings = contest ? null : await getSettings();
    const contestSlug = invigilatorContestSlug(contest, settings);
    const contestScope = contest || await contestScopeOf(contestSlug);
    const roomKey = gateRoomKey(roomParam);
    const roomLabel = roomKey === "_" ? "" : sanitizeRoom(roomParam);

    const snapshot = await scopedQuery(getFirestore().collection(sessionCollection), contestScope)
      .limit(sessionsQueryLimit)
      .get();
    const docs = snapshot.docs.map((doc) => doc.data())
      .filter((doc) => String(doc.room || "") === roomLabel);

    const nowMs = Date.now();
    const stats = { live: 0, locked: 0, pending_approval: 0, finished: 0, disconnected: 0, started: 0, total: 0 };
    for (const doc of docs) {
      stats.total += 1;
      if (doc.exam_started_at) stats.started += 1;
      if (doc.status === "active") {
        stats.live += 1;
        if (isStaleSession(doc, nowMs)) stats.disconnected += 1;
      } else if (doc.status === "locked") stats.locked += 1;
      else if (doc.status === "pending_approval") stats.pending_approval += 1;
      else if (doc.status === "ended") stats.finished += 1;
    }

    const sessions = docs
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
      .slice(0, invigilatorSessionsLimit)
      .map((doc) => ({
        // M13: NO session_id — it is the SOLE bearer credential for candidate write
        // endpoints (/api/session/end etc.), so leaking it would let an invigilator
        // end a candidate's exam. Invigilators identify candidates by name/roll/
        // username, not session_id.
        name: doc.name || "",
        hackerrank_username: doc.hackerrank_username || "",
        candidate_id: candidateOf(doc).id, // S-C dual-read adapter (F9 §1.2)
        // F2 (E2E live): the EXACT stored session key the row actions (Unlock /
        // Exempt) post back as `username_norm` — person-mode rows (username_norm
        // = person_id "{college}~{uid}") are only addressable by it. Identity
        // lookup data like roster_unique_id, NOT a credential (the session_id
        // bearer token stays M13-removed).
        username_norm: doc.username_norm || "",
        roll_number: doc.roll_number || "",
        // F9.4: the roster's unique id — alert-detail expansion joins on username
        // and shows this alongside the roll number. Identity data, not a credential.
        roster_unique_id: doc.roster_unique_id || "",
        status: doc.status || "",
        stale: doc.status === "active" ? isStaleSession(doc, nowMs) : false,
        exam_started_at: doc.exam_started_at || null,
        // F5.5: drives the per-student exemption toggles on the room dashboard.
        enforcement_exemptions: sanitizeExemptions(doc.enforcement_exemptions),
        // F5.6 wave-2 fix: lets the portal offer per-student Unlock ONLY on
        // enforcement locks (admin locks stay admin-released). Not PII — a fixed
        // reason token, never free text.
        locked_reason: doc.status === "locked" && doc.locked_reason === enforcementLockReason
          ? enforcementLockReason
          : null,
        created_at: doc.created_at || ""
      }));

    const gate = publicRoomGate(await getRoomGate(contestSlug, roomKey));

    // Same index-free pattern as adminAlerts: at most ONE equality filter
    // (contest_slug) pushed to Firestore; room/archive filtering in memory.
    // F9.3: the feed additionally honours the per-type show_to_invigilator config —
    // filtered SERVER-SIDE so hidden alert types never leave the backend.
    const alertSettings = await getAlertSettings();
    let alertQuery = getFirestore().collection(alertsCollection);
    if (contestScope !== ALL_CONTESTS) {
      alertQuery = scopedQuery(alertQuery, contestScope);
    } else {
      // Same zero-alerts scan-window fix as adminAlerts: newest-first so an
      // archived doc-id-sorted pile cannot crowd live alerts out of the window
      // (archived filter stays in memory — legacy docs omit the field).
      alertQuery = alertQuery.orderBy("timestamp", "desc");
    }
    const alertSnapshot = await alertQuery.limit(alertsQueryLimit).get();
    const alerts = alertSnapshot.docs
      .map((doc) => doc.data())
      .filter((alert) => String(alert.room || "") === roomLabel)
      .filter((alert) => !alert.archived)
      .filter((alert) => isAlertShownToInvigilator(alertSettings, alert))
      .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
      .slice(0, invigilatorAlertsLimit)
      .map((alert) => ({
        // M12/M13: keep ONLY type/severity/title/timestamp/hackerrank_username.
        //   - drop `detail`: the ip_changed alert embeds "IP changed from X to Y",
        //     leaking candidate IPs the invigilator has no need to see.
        //   - drop `session_id`: it is the candidate's write-endpoint bearer token.
        id: alert.id,
        type: alert.type,
        severity: alert.severity,
        timestamp: alert.timestamp,
        title: alert.title,
        hackerrank_username: alert.hackerrank_username || ""
      }));

    return {
      contest_slug: contestSlug || null,
      room: roomLabel || null,
      room_key: roomKey,
      room_gate_enabled: contest ? Boolean(contest.room_gate_enabled) : Boolean(settings?.room_gate_enabled),
      stats,
      sessions,
      gate,
      alerts,
      // FIX-B3 #6: lets the portal tell "empty because nothing fired" apart from
      // "empty because the admin shares no alert types with invigilators".
      alerts_shared: anyAlertSharedWithInvigilator(alertSettings),
      disconnected_staleness_ms: disconnectedStalenessMs
    };
  }

  // S-D: the OPTIONAL ?contest=/body.contest param on invigilator endpoints.
  // Absent -> null (the legacy settings-driven portal, bit-for-bit). Present ->
  // the resolved contest doc (or 400 unknown_contest). requireOpen:false —
  // invigilators set rooms up before the window opens and stay on after close.
  async function invigilatorContestOf(req) {
    let slug = String(req.query?.contest ?? "").trim();
    if (!slug) slug = String(parseBody(req)?.contest ?? "").trim();
    if (!slug) return null;
    return await resolveContest(slug, { requireOpen: false });
  }

  // The contest_slug value gate docs / session scoping use for this portal view:
  // contest-mode -> the contest's slug ("" for an empty-slug legacy deployment,
  // matching what its sessions were stamped with); legacy-mode -> the settings
  // derivation used since S3.
  function invigilatorContestSlug(contest, settings) {
    if (contest) return contest.legacy_empty_slug ? "" : contest.slug;
    return settings?.contest_slug || contestSlugFromUrl(settings?.contest_url) || "";
  }

  // Contest-mode gate-enable check (the contest OWNS room_gate_enabled, S-I
  // snapshot field); legacy mode keeps requireGateEnabledSettings. Returns the
  // settings doc only in legacy mode (contest mode never needs it).
  async function requireGateEnabledFor(contest) {
    if (contest) {
      if (!contest.room_gate_enabled) badRequest("room_gate_disabled");
      return null;
    }
    return await requireGateEnabledSettings();
  }

  return {
    // route handlers (auth-first — routesAuthLint guards this)
    invigilatorOverview,
    invigilatorRoom,
    invigilatorReleaseCode,
    invigilatorOpenRoom,
    invigilatorExempt,
    invigilatorUnlockCode,
    invigilatorUnlock,
    // room-gate helpers it owns (the still-resident session routes reuse
    // gateRoomKey + getRoomGate)
    gateRoomKey,
    roomGateRef,
    getRoomGate,
    generateRoomOtp,
    publicRoomGate,
    requireGateEnabledSettings,
    requireGateEnabledFor,
    invigilatorContestOf,
    invigilatorContestSlug
  };
}
