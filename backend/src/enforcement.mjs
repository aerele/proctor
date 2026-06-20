// backend/src/enforcement.mjs — the fullscreen-enforcement DOMAIN (decomp B10a,
// plan §A4 / 05-decomp-plan §1.2). Joins the EXISTING domain layer (next to
// contests.mjs / identity.mjs / proctorAlerts.mjs) — a DOMAIN module, NOT a route
// module and NOT lib/.
//
// Shared by THREE route groups: session-telemetry (recordEvents derives exit-limit
// violations, heartbeat closes the countdown), the session-gate routes (the
// candidate enforcement-violation self-report + unlock-gate), and start/resume
// (config snapshots). Extracting it as a flat domain factory BEFORE those route
// groups split is what lets each route file consume the SAME single-source
// enforcement logic via ctx instead of a forbidden route→route import or a
// duplicated live-exam-critical helper.
//
// DEPENDS ON proctorAlerts (enforcement RAISES the fullscreen_enforcement alert):
// alertTypeConfig + upsertProctorAlert arrive through ctx BY REFERENCE. To break
// the proctorAlerts ⇄ enforcement reference cycle cleanly, the two PURE helpers
// proctorAlerts needs back (sanitizeExemptions, intOrZero) are STANDALONE named
// exports of THIS module (no ctx, no I/O) — handler.mjs imports them at module
// scope and threads them into makeProctorAlerts, while makeEnforcement is
// instantiated AFTER makeProctorAlerts so it can receive that factory's returns.
// Single source either way; no duplication.
//
// Nothing here is a raw contest_slug equality filter, so scopingLint's allowlist
// stays {handler.mjs: 4}.
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as the other domains: getFirestore is taken indirectly via the
// sessionRef getter so the fake-Firestore swap propagates.
//
// Dependency direction (conventions): handler.mjs → (src domain modules incl.
// enforcement.mjs, lib/*). The factory imports nothing — every dependency (the
// session-doc ref + read, the room-gate read + key, the resident
// personContestForSession resolver, the proctorAlerts raisers, the template config
// normalizers, the http/sanitize helpers + FieldValue + iso clock, and the
// env-captured lock-reason / gate-attempt-limit BY VALUE) arrives through ctx, so
// the env-capture-at-load semantics stay in handler.mjs (env-lint).

// Per-session enforcement exemptions (F5.5): ONLY the known keys, ONLY real
// booleans — everything else is dropped so client/admin payloads can never
// stash arbitrary data on the session doc.
const ENFORCEMENT_EXEMPTION_KEYS = ["fullscreen", "switch_away"];

// STANDALONE pure exports (no ctx) — see the cycle-break note above. proctorAlerts
// (raiseSwitchAwayAlerts) imports these through handler.mjs's ctx; the enforcement
// factory and the resident handler code reuse the SAME bindings.
export function sanitizeExemptions(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const key of ENFORCEMENT_EXEMPTION_KEYS) {
    if (typeof input[key] === "boolean") out[key] = input[key];
  }
  return out;
}

// NaN-guarded attempt counter read (room-gate + unlock-gate cap pattern): a
// corrupt stored value reads as 0 — the cap can then re-accumulate, but a
// legitimate candidate is never spuriously locked out by bad data.
export function intOrZero(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export function makeEnforcement(ctx) {
  const {
    // session-doc helpers (sessionStore, by reference)
    sessionRef,
    // proctorAlerts raisers (by reference — single source)
    alertTypeConfig,
    upsertProctorAlert,
    // resident contest resolver (by reference)
    personContestForSession,
    // template config normalizers (src/templates.mjs)
    normalizeTemplateEnforcement,
    normalizeTemplateCameraRecording,
    normalizeTemplateScreenMarkers,
    // lib helpers
    httpError,
    isoOrNow,
    // env-captured non-env constant (by value)
    enforcementLockReason
  } = ctx;

  async function applyEnforcementViolation(session, { phase, exitCount, enforcement, alertSettings, derived = false }) {
    const now = new Date().toISOString();
    const alertConfig = alertTypeConfig(alertSettings, "fullscreen_enforcement", "critical");
    if (alertConfig.enabled) {
      await upsertProctorAlert(session, {
        type: "fullscreen_enforcement",
        severity: alertConfig.severity,
        timestamp: now,
        title: "Fullscreen enforcement triggered",
        detail: phase === "exit_limit"
          ? `Exceeded the fullscreen exit limit (${exitCount} exits; limit ${enforcement.fullscreen_exit_limit})`
          : `Did not re-enter fullscreen within ${enforcement.fullscreen_reentry_seconds}s`,
        dedupe: now.slice(0, 16),
        data: { phase, exit_count: exitCount, mode: enforcement.mode, ...(derived ? { derived: "server" } : {}) }
      });
    }

    if (enforcement.mode === "alert_first") {
      return { locked: false };
    }

    await sessionRef(session.session_id).update({
      status: "locked",
      locked_at: now,
      locked_reason: enforcementLockReason,
      updated_at: now
    });
    return { locked: true };
  }

  // ---- F5.3 wave-2 review fix: SERVER-SIDE enforcement reconciliation ---------
  //
  // The candidate's enforcement-violation POST is only the FAST PATH: a client
  // that blocks that single URL (or clears the localStorage ladder state) used to
  // neutralize the hard block with zero server-side signal. The server now
  // derives the same violations from evidence it already receives:
  //   - recordEvents counts unexpected fullscreen_exit events per session
  //     (fullscreen_exit_count) and tracks the open exit (fullscreen_out_since,
  //     cleared by fullscreen_enter) → exceeding the exit limit escalates here;
  //   - recordHeartbeat closes the countdown: an out-of-fullscreen span older
  //     than reentry + grace escalates even when no further events arrive. The
  //     heartbeat's `fullscreen` field is corrective truth — `true` clears a
  //     stale out_since (lost enter event), `false` starts the clock when the
  //     exit event itself was lost.
  // Exempt sessions are skipped entirely; alert_first mode alerts without
  // locking (policy parity with the self-report path).
  const ENFORCEMENT_COUNTDOWN_GRACE_SECONDS = 15;

  async function reconcileFullscreenEnforcement(session, events, alertSettings) {
    if (sanitizeExemptions(session.enforcement_exemptions).fullscreen === true) return;
    if (session.status !== "active") return;

    let unexpectedExits = 0;
    let outSince = session.fullscreen_out_since || null;
    let sawFullscreenEvent = false;
    for (const event of events) {
      if (event.type === "fullscreen_exit") {
        if (event.detail?.expected === true) continue;
        unexpectedExits += 1;
        if (!outSince) outSince = isoOrNow(event.timestamp);
        sawFullscreenEvent = true;
      } else if (event.type === "fullscreen_enter") {
        outSince = null;
        sawFullscreenEvent = true;
      }
    }
    if (!sawFullscreenEvent) return;

    const newCount = intOrZero(session.fullscreen_exit_count) + unexpectedExits;
    await sessionRef(session.session_id).update({
      fullscreen_exit_count: newCount,
      fullscreen_out_since: outSince,
      updated_at: new Date().toISOString()
    });
    if (!unexpectedExits) return;

    // Same config-source rule as the self-report path — the session's person
    // contest, or the normalized defaults for an orphaned session.
    const contest = await personContestForSession(session);
    const enforcement = enforcementConfigFor(contest);
    if (newCount > enforcement.fullscreen_exit_limit) {
      await applyEnforcementViolation(session, {
        phase: "exit_limit", exitCount: newCount, enforcement, alertSettings, derived: true
      });
    }
  }

  // Heartbeat-side countdown reconciliation. Returns "locked" when this call
  // locked the session (so the heartbeat response reports the new status and the
  // recorder self-stops on THIS interval), null otherwise. Takes the RESOLVED
  // enforcement config (wave-4: contest-sourced for person sessions; the caller
  // already resolved the session's config source).
  async function reconcileEnforcementCountdown(session, body, enforcement, alertSettings) {
    if (sanitizeExemptions(session.enforcement_exemptions).fullscreen === true) return null;
    if (session.status && session.status !== "active") return null;
    const now = new Date().toISOString();
    const outSince = session.fullscreen_out_since || null;

    if (body.fullscreen === true) {
      // Corrective truth: back in fullscreen — clear a stale open exit.
      if (outSince) await sessionRef(session.session_id).update({ fullscreen_out_since: null, updated_at: now });
      return null;
    }
    if (body.fullscreen === false && !outSince) {
      // The exit event itself was lost — start the clock from heartbeat truth.
      await sessionRef(session.session_id).update({ fullscreen_out_since: now, updated_at: now });
      return null;
    }
    if (!outSince) return null;

    const deadlineMs = Date.parse(outSince)
      + (enforcement.fullscreen_reentry_seconds + ENFORCEMENT_COUNTDOWN_GRACE_SECONDS) * 1000;
    if (!Number.isFinite(deadlineMs) || Date.now() <= deadlineMs) return null;
    const { locked } = await applyEnforcementViolation(session, {
      phase: "countdown_expired",
      exitCount: intOrZero(session.fullscreen_exit_count),
      enforcement, alertSettings, derived: true
    });
    return locked ? "locked" : null;
  }

  // S3 gate enforcement for code execution: with the gate enabled, Run/Submit are
  // blocked until the session was released (OTP / room open / admin turning the
  // gate off). Deliberately NOT inside requireWritableSession — evidence writes
  // (events, uploads, heartbeats) must keep flowing while the candidate waits.
  async function requireExamStarted(session) {
    // S3 nit: once a session has been released (exam_started_at stamped) the gate
    // can never reject it — short-circuit BEFORE any contest read.
    // A person-contest session is gated by ITS contest's room_gate_enabled (S-I
    // snapshot field); an orphaned session (no current contest) is never gated.
    if (session.exam_started_at) return;
    const contest = await personContestForSession(session);
    if (Boolean(contest?.room_gate_enabled)) {
      throw httpError(403, "exam_not_started");
    }
  }

  // ---- contest-owned enforcement/camera/screen-markers (S-I §1.4 snapshot) ----
  // A session bound to a person contest serves the CONTEST's snapshot-copied
  // enforcement/camera_recording/screen_markers fields. `contest` is the resolved
  // person contest, or null for an orphaned session doc that no longer resolves to
  // a current contest — in which case the template normalizers produce the
  // NORMALIZED DEFAULTS (their NaN guards keep a corrupt contest doc from ever
  // stranding candidates either).
  function enforcementConfigFor(contest) {
    return normalizeTemplateEnforcement(contest?.enforcement);
  }

  function cameraRecordingConfigFor(contest) {
    return normalizeTemplateCameraRecording(contest?.camera_recording);
  }

  function screenMarkersConfigFor(contest) {
    return normalizeTemplateScreenMarkers(contest?.screen_markers);
  }

  return {
    applyEnforcementViolation,
    reconcileFullscreenEnforcement,
    reconcileEnforcementCountdown,
    requireExamStarted,
    enforcementConfigFor,
    cameraRecordingConfigFor,
    screenMarkersConfigFor
  };
}
