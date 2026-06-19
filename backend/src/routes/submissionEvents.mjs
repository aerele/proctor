// backend/src/routes/submissionEvents.mjs — the poller-sourced submission-time
// markers route domain as a FACTORY (decomp B5, plan §A2/§A8).
// makeSubmissionEventsRoutes(ctx) closes over the handler-built ctx (per ?buster
// instance) and returns the two submission-events route handlers + the helpers
// it OWNS (submissionEventsDocId / submissionEventsRef / normalizeSubmissionEvent
// / mergeSubmissionEvents, with the SUBMISSION_EVENTS_INGEST_LIMIT cap).
// handler.mjs instantiates this at module scope and destructures the route
// handlers into the SAME names the dispatch table calls, so the dispatch lines
// stay byte-identical (canaryIsolation text-scans them).
//
// EACH ROUTE KEEPS ITS OWN AUTH GUARD — they are deliberately DIFFERENT:
//   ingestSubmissionEvents (POST /api/submission-events) is the poller ingest,
//     authenticated with requireApiKey (the SAME x-api-key mechanism as the
//     alerts ingest) — NOT an admin/invigilator credential, so routesAuthLint
//     (which only checks admin*/invigilator*-named handlers) leaves it alone.
//   adminSubmissionEvents (GET /api/admin/submission-events) is the admin
//     recording-review read, auth-first with requireAdmin (routesAuthLint pins
//     this); it is a SCOPED GET in canaryIsolation's SCOPED_GET_REQUESTS.
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as makeAuth / makeSessionStore / makeAdminProblemsRoutes:
// phase2.test.mjs / dtoIdentity.test.mjs import the handler with a ?buster and
// swap the fake Firestore via __setClientsForTest — getFirestore is therefore
// taken as a GETTER so the swap propagates (the live handle is never captured by
// value).
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*). Everything stateful or env-captured (the live Firestore
// getter, the submission-events collection name, the ingest cap, the auth guards
// each route uses, the username normalizer, and the http transport helpers)
// arrives through ctx — nothing is imported here, so the env-capture-at-load
// semantics stay in handler.mjs (env-lint).

export function makeSubmissionEventsRoutes(ctx) {
  const {
    getFirestore,
    requireApiKey,
    requireAdmin,
    parseBody,
    badRequest,
    httpError,
    normalizeUsername,
    // The ONE contest_slug-filter chokepoint (src/contests.mjs scopedQuery) —
    // the native-submission fallback scopes through it, so no raw contest_slug
    // where-filter is added in this file (scopingLint pins the chokepoint).
    scopedQuery,
    // collection names (captured at handler load, per ?buster instance)
    submissionEventsCollection,
    // FALLBACK store: the proctor's OWN in-app submissions (proctor_submissions),
    // populated by the exam app on each candidate submit. Used to feed the
    // recording-review timeline for proctor-NATIVE contests, which never populate
    // the HackerRank-poller proctor_submission_events store.
    submissionsCollection
  } = ctx;

  // Cap the native-submission fallback scan (a contest has up to ~50 submissions
  // per candidate per EXEC_MAX_SUBMISSIONS_PER_SESSION; a generous ceiling keeps
  // a pathological user from streaming thousands of docs into one timeline).
  const SUBMISSION_EVENTS_FALLBACK_LIMIT = 2000;

  // ---- Submission-time markers (poller-sourced) -----------------------------
  //
  // The contest-eval poller POSTs every code submission a student made (valid =
  // Accepted, invalid = a terminal failure; transient Processing/Queued are
  // skipped poller-side). They are stored as ONE doc per (username_norm,
  // contest_slug) holding a merged, de-duped-by-submission_id events array so a
  // re-post is idempotent. The admin recording-review timeline reads them back to
  // overlay GREEN (valid) / RED (invalid) markers at each submission's real time.

  const SUBMISSION_EVENTS_INGEST_LIMIT = 5000;

  // Deterministic doc id for a (username_norm, contest_slug) submission-events doc.
  function submissionEventsDocId(usernameNorm, contestSlug) {
    return `${usernameNorm}:${contestSlug || "_"}`;
  }

  function submissionEventsRef(usernameNorm, contestSlug) {
    return getFirestore().collection(submissionEventsCollection).doc(submissionEventsDocId(usernameNorm, contestSlug));
  }

  // Validate + normalize one inbound submission event. submission_id is coerced to
  // a string so it is a stable de-dupe key whether the poller sends an int or str.
  function normalizeSubmissionEvent(event, index) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw httpError(400, `events[${index}] must be an object`);
    }
    // S-C (F9 §1.2): candidate_id accepted as an alias FOREVER (lazy poller fleet).
    if ((event.hackerrank_username === undefined || event.hackerrank_username === null || event.hackerrank_username === "")
        && event.candidate_id !== undefined && event.candidate_id !== null && event.candidate_id !== "") {
      event = { ...event, hackerrank_username: event.candidate_id };
    }
    for (const field of ["hackerrank_username", "submission_id", "submitted_at"]) {
      const value = event[field];
      if (value === undefined || value === null || value === "") {
        throw httpError(400, `events[${index}].${field} is required`);
      }
    }
    if (Number.isNaN(Date.parse(event.submitted_at))) {
      throw httpError(400, `events[${index}].submitted_at must be a valid ISO 8601 date`);
    }
    const item = {
      submission_id: String(event.submission_id),
      hackerrank_username: String(event.hackerrank_username),
      valid: event.valid === true,
      submitted_at: new Date(event.submitted_at).toISOString()
    };
    if (event.contest_slug) item.contest_slug = String(event.contest_slug);
    if (event.challenge_slug) item.challenge_slug = String(event.challenge_slug);
    if (event.challenge_name) item.challenge_name = String(event.challenge_name);
    if (event.lang) item.lang = String(event.lang);
    if (event.status) item.status = String(event.status);
    return item;
  }

  // Merge new events into an existing array, de-duping by submission_id (a later
  // post for the same id overwrites — e.g. a Processing→Accepted re-classification),
  // and keep the result sorted by submitted_at ascending.
  function mergeSubmissionEvents(existing, incoming) {
    const byId = new Map();
    for (const event of existing || []) {
      if (event && event.submission_id !== undefined) byId.set(String(event.submission_id), event);
    }
    for (const event of incoming) byId.set(event.submission_id, event);
    return [...byId.values()].sort((a, b) =>
      String(a.submitted_at || "").localeCompare(String(b.submitted_at || ""))
    );
  }

  // POST /api/submission-events — poller ingest, authenticated with the SAME
  // x-api-key mechanism as the alerts ingest. Groups the inbound events by
  // (username_norm, contest_slug) and upserts each group's doc with the merged,
  // de-duped array. Returns { ok, stored } = the count of events accepted.
  async function ingestSubmissionEvents(req) {
    requireApiKey(req);
    const body = parseBody(req);
    const rawEvents = Array.isArray(body?.events) ? body.events : [];
    if (!rawEvents.length) return badRequest("No events provided");
    if (rawEvents.length > SUBMISSION_EVENTS_INGEST_LIMIT) {
      return badRequest(`Too many events in one request (max ${SUBMISSION_EVENTS_INGEST_LIMIT})`);
    }

    const normalized = rawEvents.map((event, index) => normalizeSubmissionEvent(event, index));

    // Group by the doc key so each (username_norm, contest_slug) doc is read +
    // upserted exactly once even when a batch spans many users.
    const groups = new Map();
    for (const event of normalized) {
      const usernameNorm = normalizeUsername(event.hackerrank_username);
      const contestSlug = event.contest_slug || "";
      const key = submissionEventsDocId(usernameNorm, contestSlug);
      if (!groups.has(key)) groups.set(key, { usernameNorm, contestSlug, events: [] });
      groups.get(key).events.push(event);
    }

    const now = new Date().toISOString();
    await Promise.all([...groups.values()].map(async ({ usernameNorm, contestSlug, events }) => {
      const ref = submissionEventsRef(usernameNorm, contestSlug);
      const doc = await ref.get();
      const existing = doc.exists ? (doc.data()?.events || []) : [];
      const merged = mergeSubmissionEvents(existing, events);
      await ref.set({
        username_norm: usernameNorm,
        contest_slug: contestSlug,
        events: merged,
        updated_at: now
      }, { merge: true });
    }));

    return { ok: true, stored: normalized.length };
  }

  // Map ONE native proctor_submissions doc into the SubmissionEvent shape the
  // recording-review timeline consumes (frontend src/types.ts SubmissionEvent).
  // The native doc has DIFFERENT field names — there is no submission_id (the doc
  // id IS the id), no submitted_at (it's created_at), no `valid` (it's `verdict`),
  // and the challenge is `problem_id` not `challenge_slug`:
  //   submission_id      ← doc id
  //   submitted_at       ← created_at
  //   valid              ← verdict === "accepted"
  //   challenge_slug     ← problem_id
  //   lang               ← language
  //   status             ← verdict
  //   hackerrank_username ← username_norm (the timeline only displays it; the
  //                         markers are already scoped by the query)
  // Drops docs with no usable created_at (the timeline plots on submitted_at and
  // would otherwise NaN them out anyway).
  function nativeSubmissionToEvent(docId, data) {
    const createdAt = data?.created_at;
    if (!createdAt || Number.isNaN(Date.parse(String(createdAt)))) return null;
    const verdict = data?.verdict;
    const event = {
      submission_id: String(docId),
      hackerrank_username: String(data?.username_norm || data?.candidate_id || ""),
      valid: verdict === "accepted",
      submitted_at: new Date(String(createdAt)).toISOString()
    };
    if (data?.contest_slug) event.contest_slug = String(data.contest_slug);
    if (data?.problem_id) event.challenge_slug = String(data.problem_id);
    if (data?.language) event.lang = String(data.language);
    if (verdict !== undefined && verdict !== null && verdict !== "") event.status = String(verdict);
    return event;
  }

  // FALLBACK: when proctor_submission_events has NO events for this
  // (username_norm, contest_slug), feed the timeline from the proctor's OWN
  // in-app submissions (proctor_submissions). Scoped by username_norm +
  // contest_slug (when given). Returns the mapped events sorted by submitted_at;
  // a missing submissionsCollection (older ctx) or any read failure → [].
  async function nativeSubmissionEventsFor(usernameNorm, contestSlug) {
    if (!submissionsCollection) return [];
    let query = getFirestore()
      .collection(submissionsCollection)
      .where("username_norm", "==", usernameNorm);
    // Contest scoping goes through THE scopedQuery chokepoint (no raw
    // contest_slug filter here — scopingLint). This route only has a bare
    // request slug, which scopedQuery accepts as a minimal resolved shape (it
    // reads contest.slug only) — matching the bare-slug contract the sibling
    // proctor_submission_events read already uses.
    if (contestSlug !== undefined && contestSlug !== null && contestSlug !== "") {
      query = scopedQuery(query, { slug: String(contestSlug) });
    }
    const snapshot = await query.limit(SUBMISSION_EVENTS_FALLBACK_LIMIT).get();
    const mapped = snapshot.docs
      .map((doc) => nativeSubmissionToEvent(doc.id, doc.data()))
      .filter((event) => event !== null);
    return mergeSubmissionEvents([], mapped);
  }

  // GET /api/admin/submission-events?username=<u>&contest_slug=<optional>&username_norm=<optional>
  // — admin read for the recording-review timeline. When contest_slug is omitted,
  // merges events across every contest doc for that user. Always returns the
  // events sorted by submitted_at ascending.
  //
  // username_norm (FIX-B1 parity): when the caller knows the session's EXACT
  // stored key it passes it directly so the lookup bypasses re-normalization of
  // the display candidate_id — the same fix the sibling sessions lookup already
  // got. For PERSON-mode sessions username_norm = "{college_norm}~{uid_norm}",
  // which normalizeUsername(candidate_id) would NEVER reproduce. Falls back to
  // normalizing `username` when the param is absent (legacy callers).
  async function adminSubmissionEvents(req) {
    requireAdmin(req);
    const username = req.query?.username;
    const rawNorm = req.query?.username_norm;
    const hasNorm = rawNorm !== undefined && rawNorm !== null && rawNorm !== "";
    if (!username && !hasNorm) return badRequest("username is required");
    // Trust an explicit username_norm verbatim (it is the stored key); otherwise
    // normalize the display id as before.
    const usernameNorm = hasNorm ? String(rawNorm) : normalizeUsername(username);
    const contestSlug = req.query?.contest_slug;

    let docs;
    if (contestSlug !== undefined && contestSlug !== null && contestSlug !== "") {
      const doc = await submissionEventsRef(usernameNorm, String(contestSlug)).get();
      docs = doc.exists ? [doc.data()] : [];
    } else {
      // No contest specified — gather every doc for this user and merge.
      const snapshot = await getFirestore()
        .collection(submissionEventsCollection)
        .where("username_norm", "==", usernameNorm)
        .limit(50)
        .get();
      docs = snapshot.docs.map((doc) => doc.data());
    }

    const merged = mergeSubmissionEvents([], docs.flatMap((doc) => doc?.events || []));
    // Preserve the poller-sourced path when it HAS data; only when it returns
    // NOTHING for this (username_norm, contest_slug) do we fall back to the
    // proctor's own in-app submissions (the data that actually exists for
    // proctor-native, non-HackerRank contests).
    if (merged.length) return { events: merged };
    const fallback = await nativeSubmissionEventsFor(usernameNorm, contestSlug);
    return { events: fallback };
  }

  return {
    // route handlers — names match the dispatch table exactly so handler.mjs's
    // dispatch lines stay byte-identical (canaryIsolation). adminSubmissionEvents
    // is auth-first (routesAuthLint); ingestSubmissionEvents uses requireApiKey.
    ingestSubmissionEvents,
    adminSubmissionEvents,
    // submission-events helpers it owns (currently used only by these routes;
    // kept single-source here in case future resident code needs them via ctx)
    submissionEventsDocId,
    submissionEventsRef,
    normalizeSubmissionEvent,
    mergeSubmissionEvents,
    // native-submission fallback helpers (exported for the mapper/fallback tests)
    nativeSubmissionToEvent,
    nativeSubmissionEventsFor
  };
}
