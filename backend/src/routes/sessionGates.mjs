// backend/src/routes/sessionGates.mjs — the candidate-side session GATE routes as
// a FACTORY (decomp B10, plan §A4 / 05-decomp-plan §1.2). makeSessionGateRoutes(ctx)
// closes over the handler-built ctx (per ?buster instance) and returns the three
// candidate gate route handlers.
//
// Safe to split NOW (after B9a + B10a): the enforcement DOMAIN
// (applyEnforcementViolation / enforcementConfigFor / sanitizeExemptions /
// intOrZero) and the proctorAlerts DOMAIN (getAlertSettings) these routes consume
// live in src/enforcement.mjs + src/proctorAlerts.mjs and arrive via ctx by
// reference (single source). The room-gate helpers (gateRoomKey / getRoomGate) are
// OWNED by routes/invigilator.mjs and returned from that factory; handler.mjs
// threads them in here by reference — they are NOT a route→route import.
//
// Routes (candidate-token auth, NOT admin — like /api/events; auth is the
// unguessable session id, so routesAuthLint's admin*/invigilator* rule does not
// apply):
//   sessionRoomGate            POST /api/session/room-gate          — gate poll/unlock
//   sessionEnforcementViolation POST /api/session/enforcement-violation — L1 self-report
//   sessionUnlockGate          POST /api/session/unlock-gate        — L2 code release
//
// No raw contest_slug equality filter here (gate docs are addressed by
// (contest_slug, room) doc id, not a .where), so scopingLint's allowlist stays
// {handler.mjs: 4}.
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as the other route domains.
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*). Nothing is imported here — every dependency (the session-doc
// helpers, the http transport helpers, the resident personContestForSession
// resolver, the invigilator-owned room-gate helpers, the enforcement + proctorAlerts
// domain helpers by reference, FieldValue + safeEqual, and the env-captured
// gate-attempt-limit + ENFORCEMENT_LOCK_REASON BY VALUE) arrives through ctx, so
// the env-capture-at-load semantics stay in handler.mjs (env-lint).

export function makeSessionGateRoutes(ctx) {
  const {
    // session-doc helpers (sessionStore + resident, by reference)
    getSession,
    requireWritableSession,
    sessionRef,
    personContestForSession,
    // room-gate helpers owned by routes/invigilator.mjs (by reference)
    gateRoomKey,
    getRoomGate,
    // http transport helpers
    parseBody,
    requireFields,
    badRequest,
    httpError,
    // lib helpers + Firestore sentinel
    safeEqual,
    FieldValue,
    // enforcement domain (src/enforcement.mjs), by reference
    sanitizeExemptions,
    intOrZero,
    enforcementConfigFor,
    applyEnforcementViolation,
    // proctorAlerts domain (src/proctorAlerts.mjs), by reference
    getAlertSettings,
    // ALERT-1: the dispute route raises a dispute_raised alert through the SAME
    // single-source upsert chokepoint + type-config resolver (by reference).
    alertTypeConfig,
    upsertProctorAlert,
    // env-captured caps / non-env const (by value at handler load)
    gateAttemptLimit,
    enforcementLockReason
  } = ctx;

  // POST /api/session/room-gate — candidate-side gate poll/unlock. Auth = the
  // unguessable session token (like /api/events), never admin auth. With no
  // `code` it is a cheap status poll (the client re-polls ~5 s, so an invigilator
  // start-now admits candidates with ZERO typing); with a `code` it attempts the
  // room OTP. Recording/events/heartbeats are deliberately NOT gated — a
  // candidate "waiting" is still recorded. The attempt cap is checked BEFORE the
  // compare so a capped session stays capped even with the right code.
  async function sessionRoomGate(req) {
    const body = parseBody(req);
    requireFields(body, ["session_id"]);
    const session = requireWritableSession(await getSession(String(body.session_id)));
    // The gate FLAG follows the session's contest (person contests own
    // room_gate_enabled as an S-I snapshot field); the gate DOC below is
    // per-(contest_slug, room). An orphaned session (no current contest) is
    // ungated.
    const contest = await personContestForSession(session);
    const gateEnabled = Boolean(contest?.room_gate_enabled);
    if (!gateEnabled) {
      return { gate_enabled: false, exam_started: true, exam_started_at: session.exam_started_at || null };
    }
    if (session.exam_started_at) {
      return { gate_enabled: true, exam_started: true, exam_started_at: session.exam_started_at };
    }
    const contestSlug = session.contest_slug || "";
    const roomKey = gateRoomKey(session.room);
    const gate = await getRoomGate(contestSlug, roomKey);
    const now = new Date().toISOString();

    if (gate && gate.mode === "open") {
      await sessionRef(session.session_id).update({ exam_started_at: now, exam_start_method: "room_open", updated_at: now });
      return { gate_enabled: true, exam_started: true, exam_started_at: now };
    }

    const code = body.code === undefined || body.code === null ? "" : String(body.code).trim();
    if (!code) {
      return { gate_enabled: true, exam_started: false, room: session.room || "" };
    }

    if (Number(session.gate_attempt_count || 0) >= gateAttemptLimit) {
      throw httpError(429, "too_many_attempts");
    }
    if (gate && gate.mode === "otp" && gate.otp && safeEqual(code, gate.otp)) {
      await sessionRef(session.session_id).update({ exam_started_at: now, exam_start_method: "otp", updated_at: now });
      return { gate_enabled: true, exam_started: true, exam_started_at: now };
    }
    await sessionRef(session.session_id).update({ gate_attempt_count: FieldValue.increment(1), updated_at: now });
    throw httpError(403, "invalid_code");
  }

  // ---- F5.3/F5.6: fullscreen enforcement violation + candidate unlock --------

  const ENFORCEMENT_VIOLATION_PHASES = ["countdown_expired", "exit_limit"];

  // POST /api/session/enforcement-violation — the candidate client reports that
  // the L1 ladder tripped (ack countdown expired, or the exit limit was
  // exceeded). Auth = the unguessable session token, like /api/events. The
  // SERVER decides the consequence from its own settings (never the client):
  //   - exempt session            → no-op (the client raced a fresh exemption)
  //   - always                    → critical fullscreen_enforcement alert
  //   - enforcement_mode "block"  → lock the session (locked_reason
  //     "fullscreen_enforcement"; release = room code via /api/session/unlock-gate
  //     or an admin/invigilator unlock)
  //   - "alert_first"             → alert only; the client holds the ack overlay.
  async function sessionEnforcementViolation(req) {
    const body = parseBody(req);
    requireFields(body, ["session_id"]);
    const phase = String(body.phase || "");
    if (!ENFORCEMENT_VIOLATION_PHASES.includes(phase)) {
      return badRequest(`phase must be one of ${ENFORCEMENT_VIOLATION_PHASES.join(", ")}`);
    }
    const session = requireWritableSession(await getSession(String(body.session_id)));

    // Server-side exemption check is authoritative — a stale client that missed
    // the heartbeat exemption update can never lock an exempted candidate.
    const exemptions = sanitizeExemptions(session.enforcement_exemptions);
    if (exemptions.fullscreen === true) {
      return { ok: true, locked: false, exempt: true };
    }

    // The consequence follows the SESSION's config source — its person contest's
    // snapshot enforcement, or the normalized defaults for an orphaned session.
    const contest = await personContestForSession(session);
    const enforcement = enforcementConfigFor(contest);
    const exitCount = Math.max(0, intOrZero(body.exit_count));
    const alertSettings = await getAlertSettings();
    const { locked } = await applyEnforcementViolation(session, { phase, exitCount, enforcement, alertSettings });
    if (!locked) {
      return { ok: true, locked: false, mode: "alert_first" };
    }
    return { ok: true, locked: true, locked_reason: enforcementLockReason, mode: "block" };
  }

  // ALERT-1: POST /api/session/dispute-alert — the candidate clicked "report a
  // problem with this alert" on an alert overlay. Auth = the unguessable session
  // token (like /api/events), never admin auth. Raises ONE info-severity
  // dispute_raised alert onto the admin console; it is idempotent per (user,
  // contest, day, disputed-type) so a double-click collapses. disputed_type is
  // the alert the candidate is disputing (e.g. "tab_away"); it is ECHOED into
  // data for the admin's one-click Suppress, but never trusted as anything but a
  // label (slice-capped, server-derived everything else). The dispute NEVER
  // unlocks or bypasses anything — it raises a flag for humans (design doc §5.2).
  async function sessionDisputeAlert(req) {
    const body = parseBody(req);
    requireFields(body, ["session_id"]);
    // B1 (correctness review): a dispute is a READ-ONLY flag for the admin, and
    // its PRIMARY case is a candidate disputing a fullscreen LOCK from the lock
    // overlay. requireWritableSession() 403s a locked session (`session_locked`),
    // the frontend swallows the error, and the overlay then falsely shows
    // "Reported" with NO dispute_raised alert ever raised. So accept any existing
    // session except an ENDED one (the test is over → nothing to dispute).
    // getSession() already 404s a missing session.
    const session = await getSession(String(body.session_id));
    if (session?.status === "ended") throw httpError(409, "session_ended");
    const disputedType = String(body.disputed_type || "").slice(0, 64);
    const note = body.note ? String(body.note).slice(0, 500) : "";
    const alertSettings = await getAlertSettings();
    const cfg = alertTypeConfig(alertSettings, "dispute_raised", "info");
    // The admin can disable the dispute_raised TYPE globally (spam control) —
    // distinct from per-user suppression. A disabled type raises nothing.
    if (!cfg.enabled) return { ok: true, raised: false };
    const raised = await upsertProctorAlert(session, {
      type: "dispute_raised",
      severity: cfg.severity,
      timestamp: new Date().toISOString(),
      title: "Candidate disputes an alert",
      detail: disputedType
        ? `Disputed: ${disputedType}${note ? ` — ${note}` : ""}`
        : (note || "Candidate flagged an alert as incorrect"),
      // Per type per day (SERVER date, not the client timestamp): a double-click
      // collapses, distinct disputed types each surface. Spam surface = one
      // dispute per type per day per candidate.
      dedupe: `${disputedType || "any"}:${new Date().toISOString().slice(0, 10)}`,
      data: { disputed_type: disputedType, note }
    });
    return { ok: true, raised: Boolean(raised) };
  }

  // POST /api/session/unlock-gate — candidate-side release of an ENFORCEMENT
  // lock using the room's dedicated UNLOCK code (gate.unlock_otp, minted via
  // /api/invigilator/unlock-code — "call your room proctor"). Wave-2 review fix:
  // NEVER the start OTP — every candidate in an OTP-gated room typed that code
  // to begin, so accepting it here made the L2 lock self-serve. Admin locks
  // (no/different locked_reason) are NOT code-releasable: they need an
  // admin/invigilator unlock. Mirrors the room-gate attempt-cap pattern:
  // NaN-guarded counter, checked BEFORE the compare so a capped session stays
  // capped even with the right code. When NO unlock code has been minted there
  // is nothing to brute-force, so the attempt does NOT burn toward the cap
  // (distinct no_unlock_code error → the candidate UI says "ask your proctor").
  // Deliberately consults the gate DOC regardless of room_gate_enabled — the
  // unlock code releases a lock, it does not gate a start.
  async function sessionUnlockGate(req) {
    const body = parseBody(req);
    requireFields(body, ["session_id", "code"]);
    const session = await getSession(String(body.session_id));
    if (session.status !== "locked" || session.locked_reason !== enforcementLockReason) {
      throw httpError(403, "not_enforcement_locked");
    }
    if (intOrZero(session.unlock_attempt_count) >= gateAttemptLimit) {
      throw httpError(429, "too_many_attempts");
    }
    const code = String(body.code).trim();
    const now = new Date().toISOString();
    const gate = await getRoomGate(session.contest_slug || "", gateRoomKey(session.room));
    if (!gate || !gate.unlock_otp) {
      throw httpError(403, "no_unlock_code");
    }
    if (code && safeEqual(code, gate.unlock_otp)) {
      await sessionRef(session.session_id).update({
        status: "active",
        unlocked_at: now,
        locked_reason: null,
        unlock_method: "room_code",
        // Wave-2: reset the server-side exit ladder (mirrors the client's
        // post-release reset — a later accident is L1 again, not an instant relock).
        fullscreen_exit_count: 0,
        fullscreen_out_since: null,
        // Wave-3: a successful unlock also clears the brute-force counter — wrong
        // tries from THIS lock must not creep a later re-lock toward the
        // permanent 429 cap (the proctor was in the loop; the slate is clean).
        unlock_attempt_count: 0,
        updated_at: now
      });
      return { ok: true, status: "active" };
    }
    await sessionRef(session.session_id).update({ unlock_attempt_count: FieldValue.increment(1), updated_at: now });
    throw httpError(403, "invalid_code");
  }

  return {
    // route handlers — names match the dispatch table exactly so handler.mjs's
    // dispatch lines stay byte-identical (canaryIsolation). Candidate-token auth
    // (not admin), so outside routesAuthLint's admin*/invigilator* scope.
    sessionRoomGate,
    sessionEnforcementViolation,
    sessionUnlockGate,
    // ALERT-1: candidate-token auth (not admin), same as the siblings above.
    sessionDisputeAlert
  };
}
