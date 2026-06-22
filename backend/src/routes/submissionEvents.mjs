// backend/src/routes/submissionEvents.mjs — the submission-time markers route
// domain as a FACTORY (decomp B5, plan §A2/§A8).
// makeSubmissionEventsRoutes(ctx) closes over the handler-built ctx (per ?buster
// instance) and returns the admin submission-events route handler + the helpers
// it OWNS (submissionEventsDocId / submissionEventsRef / mergeSubmissionEvents).
// handler.mjs instantiates this at module scope and destructures the route
// handler into the SAME name the dispatch table calls, so the dispatch line
// stays byte-identical (canaryIsolation text-scans it).
//
// The HackerRank contest-eval poller ingest (POST /api/submission-events,
// ingestSubmissionEvents) was REMOVED when proctor moved to its own in-app
// contest platform. proctor_submission_events is therefore no longer written;
// adminSubmissionEvents still READS any legacy docs it holds, then falls back to
// the proctor's own in-app submissions (proctor_submissions). The remaining
// route keeps its auth guard:
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
    requireAdmin,
    badRequest,
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
    submissionsCollection,
    // RUN events (proctor_run_events): execRun writes one per sample-test run.
    // Surfaced as distinct kind:"run" events merged time-ordered with submits.
    // Absent on an older ctx → run events simply don't surface (graceful).
    runEventsCollection
  } = ctx;

  // Cap the native-submission fallback scan (a contest has up to ~50 submissions
  // per candidate per EXEC_MAX_SUBMISSIONS_PER_SESSION; a generous ceiling keeps
  // a pathological user from streaming thousands of docs into one timeline).
  const SUBMISSION_EVENTS_FALLBACK_LIMIT = 2000;

  // ---- Submission-time markers (legacy poller-sourced READ) -----------------
  //
  // The HackerRank contest-eval poller (which POSTed these via the now-removed
  // POST /api/submission-events ingest) is gone. The proctor_submission_events
  // collection is therefore no longer written to; any docs it still holds are
  // legacy. adminSubmissionEvents below still READS them so historical contests
  // keep their timeline, then falls back to the proctor's own in-app submissions
  // (proctor_submissions) for proctor-native contests — the only path that gets
  // populated now.

  // Deterministic doc id for a (username_norm, contest_slug) submission-events doc.
  function submissionEventsDocId(usernameNorm, contestSlug) {
    return `${usernameNorm}:${contestSlug || "_"}`;
  }

  function submissionEventsRef(usernameNorm, contestSlug) {
    return getFirestore().collection(submissionEventsCollection).doc(submissionEventsDocId(usernameNorm, contestSlug));
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
  // SCORES (handler.mjs execSubmit writes these on every native submit doc):
  //   passed_count / total ← per-test counts (e.g. "8/10 tests")
  //   score / max_points   ← points scored / out of (e.g. "80/100")
  // Threaded through ONLY when present + numeric so the recording-review timeline
  // can render an explicit result+score; absent/non-numeric → field omitted (the
  // poller-sourced HackerRank events have no counts, and the renderer degrades).
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
      // Discriminator vs the run events merged into the same stream. Set
      // explicitly so the recording view can style submits distinctly from runs.
      kind: "submit",
      submitted_at: new Date(String(createdAt)).toISOString()
    };
    if (data?.contest_slug) event.contest_slug = String(data.contest_slug);
    if (data?.problem_id) event.challenge_slug = String(data.problem_id);
    if (data?.language) event.lang = String(data.language);
    if (verdict !== undefined && verdict !== null && verdict !== "") event.status = String(verdict);
    // Score fields: thread only the ones that are PRESENT and coerce to a finite
    // number, so a missing/null/garbled field never lands as NaN (and never as a
    // spurious 0 — Number(null) === 0, so null/""/undefined are rejected FIRST).
    for (const field of ["passed_count", "total", "score", "max_points"]) {
      const raw = data?.[field];
      if (raw === undefined || raw === null || raw === "") continue;
      const n = Number(raw);
      if (Number.isFinite(n)) event[field] = n;
    }
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

  // Map ONE proctor_run_events doc (execRun writes it) into the SubmissionEvent
  // shape so a run rides the SAME recording-review timeline as submits — sorted
  // by submitted_at, free-text searchable, type-filterable. The discriminator is
  // kind:"run" (vs submit), and `valid` mirrors the submit convention
  // (verdict === "accepted") so a run that passed every SAMPLE reads GREEN.
  //   submission_id      ← doc id
  //   submitted_at       ← created_at  (the SAME time field submits sort on)
  //   challenge_slug     ← problem_id
  //   lang               ← language
  //   status             ← verdict
  //   passed_count/total ← per-SAMPLE counts (e.g. "2/3 samples")
  // Drops docs with no usable created_at (the timeline would NaN them out).
  function nativeRunToEvent(docId, data) {
    const createdAt = data?.created_at;
    if (!createdAt || Number.isNaN(Date.parse(String(createdAt)))) return null;
    const verdict = data?.verdict;
    const event = {
      submission_id: String(docId),
      hackerrank_username: String(data?.username_norm || data?.candidate_id || ""),
      valid: verdict === "accepted",
      kind: "run",
      submitted_at: new Date(String(createdAt)).toISOString()
    };
    if (data?.contest_slug) event.contest_slug = String(data.contest_slug);
    if (data?.problem_id) event.challenge_slug = String(data.problem_id);
    if (data?.language) event.lang = String(data.language);
    if (verdict !== undefined && verdict !== null && verdict !== "") event.status = String(verdict);
    // Sample-test counts (no score/max_points — runs are unscored). Threaded
    // through only when PRESENT + finite (null/""/undefined rejected first, so
    // Number(null) === 0 never lands as a spurious 0).
    for (const field of ["passed_count", "total"]) {
      const raw = data?.[field];
      if (raw === undefined || raw === null || raw === "") continue;
      const n = Number(raw);
      if (Number.isFinite(n)) event[field] = n;
    }
    return event;
  }

  // Read this candidate's RUN events (proctor_run_events) for the recording-
  // review timeline. Scoped by username_norm (+ contest_slug via THE scopedQuery
  // chokepoint, exactly like nativeSubmissionEventsFor). A missing
  // runEventsCollection (older ctx) or any read failure → []. Returns the mapped
  // events sorted by submitted_at.
  async function nativeRunEventsFor(usernameNorm, contestSlug) {
    if (!runEventsCollection) return [];
    let query = getFirestore()
      .collection(runEventsCollection)
      .where("username_norm", "==", usernameNorm);
    if (contestSlug !== undefined && contestSlug !== null && contestSlug !== "") {
      query = scopedQuery(query, { slug: String(contestSlug) });
    }
    const snapshot = await query.limit(SUBMISSION_EVENTS_FALLBACK_LIMIT).get();
    const mapped = snapshot.docs
      .map((doc) => nativeRunToEvent(doc.id, doc.data()))
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

    const pollerSourced = mergeSubmissionEvents([], docs.flatMap((doc) => doc?.events || []));
    // The SUBMIT stream: preserve the poller-sourced path when it HAS data; only
    // when it returns NOTHING for this (username_norm, contest_slug) do we fall
    // back to the proctor's own in-app submissions (the data that actually
    // exists for proctor-native, non-HackerRank contests). Poller-sourced events
    // carry no `kind` — stamp "submit" so the recording view styles them as
    // submits (the native fallback already tags them via nativeSubmissionToEvent).
    const submitEvents = pollerSourced.length
      ? pollerSourced.map((event) => (event.kind ? event : { ...event, kind: "submit" }))
      : await nativeSubmissionEventsFor(usernameNorm, contestSlug);
    // RUN events ride the SAME timeline as a distinct kind:"run" stream — always
    // fetched (independent of the submit source) and merged time-ordered with the
    // submits. mergeSubmissionEvents de-dupes by submission_id (run docs use their
    // own randomUUIDs, so no collision) and re-sorts the whole list by submitted_at.
    const runEvents = await nativeRunEventsFor(usernameNorm, contestSlug);
    return { events: mergeSubmissionEvents(submitEvents, runEvents) };
  }

  return {
    // route handler — name matches the dispatch table exactly so handler.mjs's
    // dispatch line stays byte-identical (canaryIsolation). adminSubmissionEvents
    // is auth-first (routesAuthLint). The poller ingest (ingestSubmissionEvents)
    // was removed with the HackerRank poller.
    adminSubmissionEvents,
    // submission-events helpers it owns (currently used only by this route; kept
    // single-source here in case future resident code needs them via ctx)
    submissionEventsDocId,
    submissionEventsRef,
    mergeSubmissionEvents,
    // native-submission fallback helpers (exported for the mapper/fallback tests)
    nativeSubmissionToEvent,
    nativeSubmissionEventsFor,
    // run-event surfacing helpers (exported for the mapper/merge tests)
    nativeRunToEvent,
    nativeRunEventsFor
  };
}
