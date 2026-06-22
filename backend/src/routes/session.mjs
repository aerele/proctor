// backend/src/routes/session.mjs — the candidate SESSION-LIFECYCLE routes
// (start / resume / validate-end / end) + the live-slot lock machinery, as a
// FACTORY (decomp B13, plan §1.2). makeSessionRoutes(ctx) closes over the
// handler-built ctx (per ?buster instance) and returns the route handlers + the
// live-slot helpers resident/other-factory code reuses (releaseLiveSlot /
// takeOverLiveSlot — single source, never forked).
//
// RAW-WHERE SITE #1 (scopingLint): findLiveSessionFor carries the lone raw
// contest_slug equality filter this module owns — the start-path lock check
// whose slug comes from the session context (defaulting "" only when missing),
// NOT a resolved contest doc. The scopingLint allowlist is re-pinned to
// { "routes/session.mjs": 1 } in the SAME commit as this move (the count bump IS
// the review flag).
//
// SHARED helpers RETURNED for single-source reuse by code outside this module
// (never forked):
//   releaseLiveSlot   — also used by the canary teardown (makeHealthCheckRoutes
//                       ctx) and the admin end/approve paths (adminSessions, B14).
//   takeOverLiveSlot  — also used by the admin approve/bypass paths (B14).
//
// CROSS-FACTORY helpers kept RESIDENT in handler.mjs (hoisted, single-source) and
// passed in BY REFERENCE here, because EARLIER factories (enforcement /
// sessionGates / sessionTelemetry, instantiated before this one) already consume
// them and a const-destructured return would land in their temporal dead zone:
//   personContestForSession — resumeSession + startResponse use it.
//   inAdminEndGrace          — endSession uses it.
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as the other route domains: getFirestore is a GETTER so the
// fake-Firestore swap propagates.
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*). Nothing is imported here — every dependency (the live Firestore
// getter, the http transport helpers, the neutral session-store helpers, the
// client-ip reader + room/email sanitizers, the storage writers, the
// contest/identity/roster domain fns, the exec factory's contestForSession by
// reference, the enforcement config readers by reference, the resident
// personContestForSession + inAdminEndGrace by reference, randomUUID, and the
// env-captured collection names / caps / upload config BY VALUE) arrives through
// ctx, so the env-capture-at-load semantics stay in handler.mjs (env-lint).

export function makeSessionRoutes(ctx) {
  const {
    getFirestore,
    // http transport helpers (lib/http)
    parseBody,
    requireFields,
    badRequest,
    httpError,
    // neutral session store (lib/sessionStore, by reference)
    sessionRef,
    getSession,
    getSessionOrNull,
    requireWritableSession,
    buildStoragePrefix,
    sessionPrefix,
    // sanitizers / client-ip / email validation (lib/*)
    getClientIp,
    sanitizeRoom,
    requireValidEmail,
    normalizeUsername,
    // storage writers (lib/clients, by reference)
    bucket,
    putJsonl,
    randomUUID,
    // contest / identity / roster domain fns (src/*)
    resolveContest,
    getContestRosterMeta,
    findContestRosterEntries,
    listColleges,
    identityNorm,
    resolveEnrollmentSpineMatches,
    contestProblemEntries,
    effectivePoints,
    getProblem,
    languageIds,
    computeSessionSummary,
    // exec factory return (by reference) — startResponse resolves the contest
    // membership for the problems[] payload.
    contestForSession,
    // enforcement domain config readers (src/enforcement.mjs, by reference)
    enforcementConfigFor,
    cameraRecordingConfigFor,
    screenMarkersConfigFor,
    sanitizeExemptions,
    // resident cross-factory helpers kept hoisted in handler.mjs (by reference)
    personContestForSession,
    inAdminEndGrace,
    // generic Firestore ALREADY_EXISTS detector — kept resident (single source)
    // because adminTemplates / review also consume it via their (earlier) ctxs.
    isAlreadyExists,
    // env-captured collection names / caps / upload config (by value at load)
    sessionCollection,
    liveLockCollection,
    submissionsCollection,
    uploadConfig,
    execMaxSubmissionsPerSession
  } = ctx;

async function startSession(req) {
  const body = parseBody(req);
  // Every start now REQUIRES a resolvable person contest (the candidate app
  // always pins ?contest=). resolvePersonContestForStart 400s an absent param
  // (unknown_contest), 400s an unknown slug, and 403s a not-open contest;
  // startPersonSession owns the window gate + identity resolution.
  const personContest = await resolvePersonContestForStart(body);
  return startPersonSession(req, body, personContest);
}

// ---- candidateOf — THE dual-read identity adapter (F9 §1.2) ----------------
// ONE function used by every DTO/export; never writes. Renders whichever
// identity a doc carries, preferring the new candidate_id, then the roster id
// the candidate verified against, then the legacy HR username. Label falls
// back to the S-A interim "Candidate ID" (F9 §4.3 — the word "username" is
// banned from rendered UI, so the F9 §1.2 literal "Username" fallback is
// deliberately not used).
// candidateOf moved to the makeSessionStore factory in lib/sessionStore.mjs
// (decomp B0); destructured at module scope.

// ---- S-C person-mode start (vision §2.4; F9 D2/D4/D6) ----------------------
//
// The identity chain for identity_mode:"person" contests:
//   candidate types unique_id → server resolves college from the CONTEST
//   roster (picker ONLY on genuine ambiguity) → person_id =
//   "{college_norm}~{identityNorm(unique_id)}" (PERSON_ID_SEPARATOR) →
//   session.username_norm = person_id. Everything keyed on (username_norm,
//   contest_slug) — live locks, alert ids, GCS paths — works unchanged; the
//   norm simply gains its college prefix.

// The person contest a start MUST name. An absent param is unknown_contest
// (the candidate app always pins ?contest=); a present-but-bogus slug is the
// same 400, and a not-open contest is 403 (F9 §2.3.1: mandatory resolution
// kills the shared-empty-slug bleed hazard).
async function resolvePersonContestForStart(body) {
  const contest = await resolveContest(String(body?.contest ?? "").trim()); // 400 unknown_contest / 403 contest_not_open
  if (contest.identity_mode !== "person") throw httpError(400, "unknown_contest");
  return contest;
}

// Gate on the CONTEST window (S5 semantics moved per-contest for person
// contests).
function validateContestWindow(contest) {
  if (!contest?.start_at || !contest?.end_at) {
    throw httpError(403, "Proctoring is not configured yet.");
  }
  const now = Date.now();
  const startAt = Date.parse(contest.start_at);
  const endAt = Date.parse(contest.end_at);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt >= endAt) {
    throw httpError(403, "Proctoring schedule is invalid.");
  }
  // Take-home (D1): recording starts ~10 min early; the candidate-side waiting
  // room holds them until T0. Do NOT 403 before start_at for remote contests —
  // but KEEP the ended/invalid/unconfigured guards.
  if (now < startAt && !contest.take_home_enabled) {
    throw httpError(403, "Proctoring has not started yet.");
  }
  if (now > endAt) throw httpError(403, "Proctoring has ended.");
}

// Resolve the typed unique id against the contest roster: 0 matches → 403,
// 1 → that person, 2+ colleges → body.college picks or 409 college_choices
// (the candidate-side picker payload). Mapped profile fields are server-
// overridden from the roster.
async function resolvePersonRosterIdentity(meta, body) {
  const typed = String(body.roster_unique_id ?? body.candidate_id ?? body.hackerrank_username ?? "").trim();
  if (!typed) throw httpError(403, "roster_id_required");
  const entries = await findContestRosterEntries(meta, typed);
  if (!entries.length) throw httpError(403, "not_on_roster");
  let entry = entries[0];
  if (entries.length > 1) {
    const college = String(body.college ?? "").trim().toLowerCase();
    entry = college ? entries.find((e) => e.college_norm === college) : undefined;
    if (!entry) {
      const names = new Map((await listColleges()).map((c) => [c.college_norm, c.name]));
      throw httpError(409, "college_choices", {
        college_choices: entries.map((e) => ({
          college_norm: e.college_norm,
          name: names.get(e.college_norm) || e.college,
          college: e.college
        }))
      });
    }
  }
  const mapping = meta.column_mapping || {};
  const fromRoster = (field) => (mapping[field] ? String(entry.fields?.[mapping[field]] || "") : "");
  // A MAPPED field is authoritative even when blank (same rule as the legacy
  // roster path); unmapped fields keep the typed value.
  const mappedOrTyped = (field) => (mapping[field] ? fromRoster(field) : String(body[field] ?? "").trim());
  return {
    person_id: entry.person_id,
    college_norm: entry.college_norm,
    candidate_id: entry.unique_id, // display form — the roster is the source of truth
    username_norm: entry.person_id,
    roster_unique_id: entry.unique_id,
    roster_verified: true,
    name: mappedOrTyped("name"),
    email: mappedOrTyped("email"),
    roll_number: mappedOrTyped("roll_number")
  };
}

async function startPersonSession(req, body, contest) {
  if (body.consent_accepted !== true) {
    return badRequest("Consent is required");
  }
  validateContestWindow(contest);

  const meta = await getContestRosterMeta(contest);
  let identity;
  if (meta) {
    identity = await resolvePersonRosterIdentity(meta, body);
  } else {
    // No-roster person contest (vision §2.4): the candidate types id + name +
    // email (F9 §1.4).
    requireFields(body, ["name", "email"]);
    requireValidEmail(body);
    const typed = String(body.candidate_id ?? body.hackerrank_username ?? "").trim();
    if (!typed) return badRequest("candidate_id is required");

    // F-C (real-data hardening): roster meta absent but the contest HAS an
    // enrollment spine (roster uploaded then cleared) → EXACT normalized match
    // of the typed id against the enrolled persons' unique ids keys the
    // session to the person anyway (username_norm = person_id), so Results
    // and multi-round linking stay correct. No fuzzy matching. body.college
    // disambiguates a multi-college hit exactly like the roster path's picker.
    const { spine, matches } = await resolveEnrollmentSpineMatches(contest, typed);
    let chosen = matches;
    const collegePick = String(body.college ?? "").trim().toLowerCase();
    if (chosen.length > 1 && collegePick) {
      chosen = chosen.filter((match) => match.college_norm === collegePick);
    }
    if (chosen.length === 1) {
      const match = chosen[0];
      identity = {
        person_id: match.person_id,
        college_norm: match.college_norm,
        candidate_id: String(match.person?.unique_id || typed),
        username_norm: match.person_id,
        roster_unique_id: "",
        roster_verified: false, // no ACTIVE roster was consulted — spine match, not roster match
        name: String(match.person?.name || body.name || "").trim(),
        email: String(match.person?.email || body.email || "").trim(),
        roll_number: String(body.roll_number ?? "").trim(),
        identity_source: "enrollment_spine"
      };
    } else {
      // person_id:null — these sessions never participate in multi-round
      // linking (documented limitation). When a spine EXISTS but the typed id
      // didn't match it (or matched ambiguously), flag the session LOUDLY so
      // the admin Sessions list shows the identity never resolved — being
      // unknowingly wrong is not acceptable (real-data hardening).
      identity = {
        person_id: null,
        college_norm: "",
        candidate_id: typed,
        username_norm: identityNorm(typed),
        roster_unique_id: "",
        roster_verified: false,
        name: String(body.name ?? "").trim(),
        email: String(body.email ?? "").trim(),
        roll_number: String(body.roll_number ?? "").trim(),
        ...(spine ? { identity_unresolved: true } : {})
      };
    }
  }

  const now = new Date().toISOString();
  const clientIp = getClientIp(req);
  const contestSlug = contest.slug;

  // H1 replay/lock mechanics (F9 D6).
  const existingActive = await findLiveSessionFor(identity.username_norm, contestSlug);
  if (body.session_id) {
    const replay = await getSessionOrNull(body.session_id);
    if (replay && replay.username_norm === identity.username_norm && replay.contest_slug === contestSlug) {
      return startResponse(replay, contest);
    }
  }

  const sessionId = randomUUID();
  const room = body.room !== undefined && body.room !== null ? sanitizeRoom(body.room) : "";
  const slot = await acquireLiveSlot(identity.username_norm, contestSlug, sessionId);
  const status = slot.acquired ? "active" : "pending_approval";
  const blockedBy = slot.acquired
    ? null
    : (slot.ownerSessionId || (existingActive && existingActive.session_id) || null);

  const item = {
    session_id: sessionId,
    candidate_id: identity.candidate_id,        // F9 D2: ONE identity field (display form);
    username_norm: identity.username_norm,      //   hackerrank_username is never written here
    person_id: identity.person_id,              // components stored as fields, never parsed
    college_norm: identity.college_norm,
    identity_label: contest.identity_label || "Candidate ID", // F9 D4: denormalized at start
    name: identity.name,
    roll_number: identity.roll_number,
    email: identity.email,
    roster_unique_id: identity.roster_unique_id,
    roster_verified: identity.roster_verified,
    room,
    contest_slug: contestSlug,
    storage_prefix: buildStoragePrefix(contestSlug, identity.username_norm, sessionId),
    start_ip: clientIp,
    current_ip: clientIp,
    ip_change_count: 0,
    consent_accepted: true,
    status,
    blocked_by_session_id: blockedBy,
    created_at: now,
    updated_at: now,
    event_count: 0,
    clipboard_event_count: 0,
    focus_event_count: 0,
    upload_error_count: 0,
    heartbeat_count: 0,
    chunk_count: 0,
    camera_chunk_count: 0,
    enforcement_exemptions: {},
    // F-C (real-data hardening): conditional keys only — legacy/no-spine session
    // docs keep their exact key set. identity_unresolved marks an anonymous
    // session on a contest that HAS an enrollment spine (typed id matched
    // nothing); identity_source records a spine-resolved keying for forensics.
    ...(identity.identity_unresolved ? { identity_unresolved: true } : {}),
    ...(identity.identity_source ? { identity_source: identity.identity_source } : {})
  };

  await sessionRef(sessionId).create(item);
  await putJsonl(`${item.storage_prefix}events/session.jsonl`, [{
    type: "session_started",
    timestamp: now,
    detail: { user_agent: req.get?.("user-agent") || req.headers?.["user-agent"] || "", start_ip: clientIp }
  }]);

  return startResponse(item, contest);
}

// Resume an existing session by its stored token without re-collecting details.
// Used by a browser reload (Epic 2.1/2.2). 404 when the token is unknown or
// does not belong to the supplied username.
//
// S-C (F9 D8): resume is CONTEST-PINNED when the client names a contest (the
// S-D frontend always will; absence is tolerated for legacy clients + one
// transitional release), and the identity check is DUAL-NORM — the legacy
// normalizeUsername leg keeps old norms resuming, identityNorm covers F9-style
// norms, and the candidate_id leg covers person sessions whose username_norm
// is the college-prefixed person_id.
async function resumeSession(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id"]);
  const session = await getSessionOrNull(body.session_id);
  if (!session) throw httpError(404, "Session not found");
  if (body.contest !== undefined && body.contest !== null && String(body.contest).trim() !== "") {
    if ((session.contest_slug || "") !== String(body.contest).trim()) {
      throw httpError(404, "Session not found");
    }
  }
  const idValue = body.candidate_id ?? body.hackerrank_username;
  if (idValue !== undefined && idValue !== null && String(idValue) !== "") {
    const value = String(idValue);
    const matches =
      session.username_norm === normalizeUsername(value) ||  // legacy leg (today's check)
      session.username_norm === identityNorm(value) ||       // F9 identity leg
      (session.candidate_id !== undefined
        && identityNorm(String(session.candidate_id)) === identityNorm(value)); // person leg
    if (!matches) throw httpError(404, "Session not found");
  }
  const contest = await personContestForSession(session);
  return startResponse(session, contest);
}

// Shared start/resume payload so the browser always gets the same shape whether
// it just started, replayed a token, or resumed after reload. S4: async because
// it resolves the assigned problem's candidate-facing view from the bank.
// S-C: the session's PERSON-MODE contest sources the window/gate fields from
// the contest doc. contest = null (an orphaned/old session doc that no longer
// resolves to a current person contest) degrades to the normalized DEFAULTS.
// S-I §3.4: serves the ORDERED problems[] (the real contest doc the session
// belongs to), the per-problem submissions summary (resume restores chips/
// totals) and the submit budget. `problem` stays as a one-release
// compatibility alias = problems[0] minus `order`.
async function startResponse(session, contest = null) {
  const problemSource = contest || await contestForSession(session);
  const problems = await contestProblemsPublic(problemSource);
  let problemAlias = null;
  if (problems.length) {
    const { order: _order, ...alias } = problems[0];
    problemAlias = alias;
  }
  return {
    session_id: session.session_id,
    status: session.status,
    hackerrank_username: session.hackerrank_username !== undefined ? session.hackerrank_username : (session.candidate_id || ""),
    candidate_id: session.candidate_id || session.roster_unique_id || session.hackerrank_username || "",
    identity_label: session.identity_label || "Candidate ID",
    name: session.name,
    room: session.room || "",
    contest_slug: session.contest_slug || "",
    storage_prefix: session.storage_prefix || buildStoragePrefix(session.contest_slug, session.username_norm, session.session_id),
    blocked_by_session_id: session.blocked_by_session_id || null,
    start_ip: session.start_ip || session.current_ip || "",
    // S3: tells the candidate client whether to hold at the room-code screen.
    room_gate_enabled: Boolean(contest?.room_gate_enabled),
    // F5.3/F5.5: enforcement knobs + this session's exemptions + why a locked
    // session is locked (the candidate unlock-code UI keys off the reason).
    // Person contests serve their OWN snapshot enforcement.
    enforcement: enforcementConfigFor(contest),
    enforcement_exemptions: sanitizeExemptions(session.enforcement_exemptions),
    locked_reason: session.locked_reason || null,
    // S-I: the contest serves its OWN problems[] (problemSource above);
    // `problem` is the one-release alias, problems[] the real payload.
    problem: problemAlias,
    problems,
    submissions_summary: await sessionSubmissionsSummary(session.session_id),
    submit_budget: execMaxSubmissionsPerSession,
    // F1 (e2e finding): chunk-index continuation — the recorder resumes its
    // per-kind chunk count from the server's knowledge so a restarted stint
    // (share-drop recovery, refresh-resume, even a new tab after a crash)
    // never reuses indexes and never overwrites the prior stint's GCS objects.
    // counts = issued upload URLs (always >= the highest index with a
    // surviving object); hwm = exact highest issued index (absent on pre-F1
    // sessions). Read-side additions only — older clients ignore them.
    chunk_count: Number(session.chunk_count) || 0,
    camera_chunk_count: Number(session.camera_chunk_count) || 0,
    screen_chunk_index_hwm: Number(session.screen_chunk_index_hwm) || 0,
    camera_chunk_index_hwm: Number(session.camera_chunk_index_hwm) || 0,
    // F7 (e2e finding): the candidate ELAPSED counter anchors on the session's
    // server-side start, not the recorder stint start, so it survives restarts.
    created_at: session.created_at || "",
    // F10.1: the camera-recording knobs ride the same upload_config object the
    // screen constraints use, so the recorder reads ONE authoritative config.
    // Person contests serve their OWN snapshot camera config.
    upload_config: { ...uploadConfig, camera: cameraRecordingConfigFor(contest) },
    // OMR P1 (design §5.2): the start/resume response is the ONLY candidate
    // carrier for the screen-marker flag, and the key rides ONLY when enabled —
    // flag off (the default) keeps this payload byte-identical to today.
    ...(screenMarkersConfigFor(contest).enabled ? { screen_markers: { enabled: true } } : {}),
    heartbeat_interval_seconds: 15,
    // S5: authoritative exam end time + the server clock at response time, so
    // the client shows a skew-corrected countdown from the very first response.
    // Person contests read their OWN window (S5 semantics moved per-contest).
    end_at: contest?.end_at || "",
    // Take-home: the official T0 + remote flag + proctor phone, so the in-session
    // waiting-room countdown and phone display are skew-safe against server_now.
    // Optional chaining is orphaned-session safe (contest may be null), matching
    // the contest?.end_at pattern; all three default falsy off take-home.
    start_at: contest?.start_at || null,
    take_home: Boolean(contest?.take_home_enabled),
    proctor_contact_phone: contest?.proctor_contact_phone || "",
    server_now: new Date().toISOString()
  };
}

// The candidate-facing view of a contest's problems (S-I §3.4): the shim's
// ordered entries mapped to the public per-problem view — statement, samples
// (non-secret — /api/exec/run echoes them anyway), limits, EFFECTIVE points,
// plus `order`. NEVER hiddenTests, never the lifecycle status. Unpublished/
// missing entries are skipped (the guard prevents; degrade gracefully).
async function contestProblemsPublic(contestOrSettings) {
  const contestLanguages = Array.isArray(contestOrSettings?.languages) && contestOrSettings.languages.length
    ? contestOrSettings.languages
    : null;
  const problems = [];
  for (const entry of contestProblemEntries(contestOrSettings)) {
    const problem = await getProblem(entry.problem_id);
    if (!problem) continue;
    // §1.1: the contest's language allow-list intersects each problem's own
    // languages at serve time; an empty intersection degrades to the
    // problem's list (never serve a problem with zero languages).
    const ownLanguages = problem.languages || [];
    const intersected = contestLanguages
      ? ownLanguages.filter((language) => contestLanguages.includes(language))
      : ownLanguages;
    const stubs = publicStubsFor(problem);
    problems.push({
      id: problem.id,
      title: problem.title,
      statement: problem.statement,
      // W6: the statement's render format rides ONLY when markdown — plain
      // problems (and every pre-W6 doc) keep today's payload byte-for-byte.
      ...(problem.statement_format === "markdown" ? { statement_format: "markdown" } : {}),
      languages: intersected.length ? intersected : ownLanguages,
      points: effectivePoints(entry, problem),
      cpuTimeLimit: problem.cpuTimeLimit,
      memoryLimit: problem.memoryLimit,
      sampleTests: (problem.sampleTests || []).map((t) => ({ input: t.input, expected: t.expected })),
      // F12.2: per-language starter stubs ride the candidate payload (omitted
      // when the problem has none — back-compat for stub-less problems).
      ...(stubs ? { stubs } : {}),
      order: entry.order
    });
  }
  return problems;
}

// F12.2: project a stored problem's stubs into the candidate-safe map — own
// keys only, allow-listed languages, string values. Returns a fresh object or
// null when there's nothing to serve (legacy/stub-less problems → null, so the
// `stubs` field is omitted and the payload stays byte-identical to today).
function publicStubsFor(problem) {
  const raw = problem?.stubs;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const stubs = {};
  for (const language of Object.keys(languageIds)) {
    if (Object.hasOwn(raw, language) && typeof raw[language] === "string") {
      stubs[language] = raw[language];
    }
  }
  return Object.keys(stubs).length ? stubs : null;
}

// This session's stored submissions -> per-problem summary (≤50×n docs, fine).
const SESSION_SUBMISSIONS_QUERY_LIMIT = 2000;
async function sessionSubmissionsSummary(sessionId) {
  const snapshot = await getFirestore()
    .collection(submissionsCollection)
    .where("session_id", "==", String(sessionId))
    .limit(SESSION_SUBMISSIONS_QUERY_LIMIT)
    .get();
  return computeSessionSummary(snapshot.docs.map((doc) => doc.data()));
}

// Find the session that currently holds the live slot for (username, contest):
// any non-ended session blocks a new active start. active wins over
// locked/pending for the conflict pointer when more than one exists.
async function findLiveSessionFor(usernameNorm, contestSlug) {
  const snapshot = await getFirestore()
    .collection(sessionCollection)
    .where("username_norm", "==", usernameNorm)
    .where("contest_slug", "==", contestSlug || "")
    .limit(50)
    .get();
  const live = snapshot.docs
    .map((doc) => doc.data())
    .filter((doc) => doc.status && doc.status !== "ended");
  if (!live.length) return null;
  return live.find((doc) => doc.status === "active") || live[0];
}

// H1: deterministic id for the per-(username, contest) live-slot lock.
function liveLockId(usernameNorm, contestSlug) {
  return `live:${usernameNorm}:${contestSlug || "_"}`;
}

function liveLockRef(usernameNorm, contestSlug) {
  return getFirestore().collection(liveLockCollection).doc(liveLockId(usernameNorm, contestSlug));
}

// H1 — atomically acquire the live slot for (username_norm, contest_slug).
//
// The slot is owned by a lock doc whose id is deterministic, so two
// near-simultaneous starts contend on the SAME doc. `.create()` is atomic in
// Firestore: exactly one concurrent writer succeeds; the rest get ALREADY_EXISTS
// and become pending_approval. The decision is NEVER derived from the racy
// `existingActive` pre-read.
//
// On a create-collision we read the LOCK DOC (not a session collection query,
// which would race with a concurrent winner whose session doc is not yet
// written) to find the current owner, and consult the owner's session by id:
//   - owner session is genuinely live (not ended)  → real conflict → pending.
//   - owner session does not exist yet              → a concurrent winner is
//                                                     mid-flight → yield, pending.
//   - owner session exists and is already `ended`   → stale lock (crash / the
//                                                     previous taker finished) →
//                                                     take the slot over → active.
//
// Returns { acquired: true } on win, or
// { acquired: false, ownerSessionId } when another live session holds the slot.
async function acquireLiveSlot(usernameNorm, contestSlug, sessionId) {
  const ref = liveLockRef(usernameNorm, contestSlug);
  const now = new Date().toISOString();
  const lockBody = { username_norm: usernameNorm, contest_slug: contestSlug || "", session_id: sessionId, acquired_at: now };

  try {
    await ref.create(lockBody);
    return { acquired: true };
  } catch (error) {
    // Anything other than an already-exists collision is unexpected; rethrow.
    if (!isAlreadyExists(error)) throw error;
  }

  // Lock is held — read it to find the current owner.
  const lockDoc = await ref.get();
  const ownerSessionId = lockDoc.exists ? lockDoc.data()?.session_id : null;

  // No owner recorded (shouldn't happen, but be safe): treat the lock as stale.
  if (!ownerSessionId || ownerSessionId === sessionId) {
    await ref.set(lockBody);
    return { acquired: true };
  }

  // Only an OWNER session that already ended makes the lock stale. A missing
  // owner doc means a concurrent winner hasn't persisted yet — we must yield.
  const owner = await getSessionOrNull(ownerSessionId);
  if (owner && owner.status === "ended") {
    await ref.set(lockBody);
    return { acquired: true };
  }

  return { acquired: false, ownerSessionId };
}

// H1 — release the live slot when its owning session is no longer live, so a
// later legitimate start for the same (username, contest) can re-acquire it.
// Best-effort: a failure here must never break the end/lock flow, and we only
// clear the lock when it still points at THIS session (avoid stomping a lock a
// newer winner already took over).
async function releaseLiveSlot(session) {
  if (!session?.username_norm) return;
  try {
    const ref = liveLockRef(session.username_norm, session.contest_slug);
    const doc = await ref.get();
    if (doc.exists && doc.data()?.session_id === session.session_id) {
      await ref.delete();
    }
  } catch (error) {
    console.warn(`Failed to release live slot for ${session.session_id}: ${error?.message || error}`);
  }
}

// H1 — make `session` the owner of its (username, contest) live slot. Used when
// an admin action (approve/bypass) promotes a session to live outside the
// normal acquire path. Best-effort; overwrites any prior owner.
async function takeOverLiveSlot(session) {
  if (!session?.username_norm) return;
  try {
    await liveLockRef(session.username_norm, session.contest_slug).set({
      username_norm: session.username_norm,
      contest_slug: session.contest_slug || "",
      session_id: session.session_id,
      acquired_at: new Date().toISOString()
    });
  } catch (error) {
    console.warn(`Failed to take over live slot for ${session.session_id}: ${error?.message || error}`);
  }
}

async function validateEndSession(req) {
  // Phase 2 (0.1): the exit passcode is gone. Ending only requires the integrity
  // assurance checkbox. `end_proctor_code`/`end_code` are no longer required.
  const body = parseBody(req);
  requireFields(body, ["session_id"]);
  if (body.assurance_accepted !== true) return badRequest("Integrity assurance is required before ending the test.");
  requireWritableSession(await getSession(body.session_id));
  return { ok: true };
}

async function endSession(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id"]);
  if (body.assurance_accepted !== true) return badRequest("Integrity assurance is required before ending the test.");
  // H3: a locked or pending session cannot be self-ended by the client; only an
  // already-ended session is rejected (idempotency handled below via 409). An
  // active session ends normally (the happy path). D2 exception: for a bounded
  // window after an ADMIN end the client's own end still lands so the manifest
  // isn't lost — accepted WITHOUT touching status/ended_at/ended_reason (the
  // admin's end stays authoritative; nothing reopens).
  const fetched = await getSession(body.session_id);
  const adminEndGrace = inAdminEndGrace(fetched);
  const session = adminEndGrace ? fetched : requireWritableSession(fetched);
  const manifest = Array.isArray(body.manifest) ? body.manifest : [];
  const now = new Date().toISOString();
  const manifestKey = `${sessionPrefix(session)}manifest.json`;

  await bucket().file(manifestKey).save(JSON.stringify({ session_id: session.session_id, ended_at: now, manifest }, null, 2), {
    contentType: "application/json"
  });

  await sessionRef(session.session_id).update({
    updated_at: now,
    manifest_key: manifestKey,
    uploaded_manifest_count: manifest.length,
    // Grace path: the session is ALREADY ended by the admin — keep that
    // ended_at/status; only the manifest bookkeeping above is new.
    ...(adminEndGrace ? {} : { ended_at: now, status: "ended" })
  });

  // H1: the session is over — free its live slot so a later legitimate start for
  // the same (username, contest) can re-acquire it instead of being parked.
  await releaseLiveSlot(session);

  return { ok: true, manifest_key: manifestKey };
}

  return {
    // route handlers — names match the dispatch table exactly so handler.mjs's
    // dispatch lines stay byte-identical (canaryIsolation). The candidate-facing
    // session routes are not admin/invigilator endpoints, so they are outside the
    // routesAuthLint require*-guard rule.
    startSession,
    resumeSession,
    validateEndSession,
    endSession,
    // shared live-slot helpers RETURNED for single-source reuse by code outside
    // this module: releaseLiveSlot (canary teardown ctx + admin end/approve
    // paths, B14) + takeOverLiveSlot (admin approve/bypass, B14). Never forked.
    releaseLiveSlot,
    takeOverLiveSlot
  };
}
