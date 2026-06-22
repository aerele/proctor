// backend/src/routes/exec.mjs — the candidate code-execution ROUTES as a FACTORY
// (decomp B12b, plan §1.2). makeExecRoutes(ctx) closes over the handler-built ctx
// (per ?buster instance) and returns execRun + execSubmit + the helpers/state they
// own + the test seams that handler.mjs RE-EXPORTS.
//
// The per-session exec rate limiter — the execLimiter Map + the _execClock seam +
// checkExecRunLimit/checkExecSubmitLimit + the cooldown/in-flight machinery — moves
// WITH the routes (it is read AND mutated by exactly these two endpoints). It is a
// per-process singleton; one instance per ?buster module evaluation, exactly as
// before (the Map was module-level in handler.mjs; now it is factory-closure-level,
// one per factory instance — same lifetime, since handler instantiates the factory
// once per module load).
//
// TEST SEAM CARRY (constraint #3): __setExecClockForTest was a top-level export of
// handler.mjs that ~exec tests import via handler.mjs?<buster>. The clock state +
// setter move INTO this factory and are RETURNED; handler.mjs RE-EXPORTS the
// returned __setExecClockForTest so those imports still resolve.
//
// SHARED helpers RETURNED for single-source reuse by still-resident handler code
// (never forked):
//   rateLimited        — also used by the public/roster rate limiters (B12c) — the
//                        429 rate_limited error builder.
//   contestForSession  — also used by startResponse (session lifecycle, B13).
//
// No raw contest_slug equality filter here (contestForSession reads the contest doc
// by id), so scopingLint's allowlist stays {handler.mjs: 4}.
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as the other route domains: getFirestore is a GETTER and judge0
// arrives as a getter so the fake-Firestore / fake-judge0 swaps propagate.
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*). Nothing is imported here — every dependency (the live Firestore
// getter, the http transport helpers, the session-doc helpers, the resident
// requireExamStarted gate + candidateOf adapter, the problem/contest domain fns,
// the judge0 engine getter + the process-wide execQueue, randomUUID, and the
// env-captured collection names / caps / cooldowns BY VALUE) arrives through ctx, so
// the env-capture-at-load semantics stay in handler.mjs (env-lint).

export function makeExecRoutes(ctx) {
  const {
    getFirestore,
    parseBody,
    badRequest,
    httpError,
    // session-doc helpers (sessionStore + resident, by reference)
    getSession,
    requireWritableSession,
    requireExamStarted,
    candidateOf,
    // problem/contest domain fns
    contestProblemEntries,
    getProblem,
    effectivePoints,
    languageIds,
    composeSqlExecSource,
    scoreSubmission,
    // engine + queue (by reference / getter)
    judge0,
    execQueue,
    // v1.1 G3 (#3): distributed Judge0 submit limiter gate (by reference). Caps
    // GLOBAL submit throughput across instances; composes with the execQueue
    // lane. gate(key, fn) acquires a shared token then runs fn. A no-op fallback
    // (fn) => fn() keeps tests/older ctx that don't inject it working unchanged.
    judge0SubmitGate = (_key, fn) => fn(),
    randomUUID,
    // env-captured collection names / caps / cooldowns (by value at handler load)
    contestsCollection,
    runEventsCollection,
    submissionsCollection,
    maxSourceCodeLength,
    execRunCooldownSeconds,
    execSubmitCooldownSeconds,
    execMaxSubmissionsPerSession
  } = ctx;

  // Injectable epoch-ms clock so cooldown tests are deterministic. Production
  // always uses the real clock; pass null/undefined to restore it. Carried here
  // from handler.mjs (decomp B12b) and re-exported via the factory return.
  let _execClock = () => Date.now();
  function __setExecClockForTest(fn) {
    _execClock = fn || (() => Date.now());
  }

  // ---- Per-session exec rate limiting (security review + S-I §3.1) ------------
  // The metered Judge0 key must not be drainable by a looping/scripted session
  // token. In-memory, factory-closure state — fine for the current SINGLE-INSTANCE
  // Cloud Run deploy; with N instances each enforces its own window, so the
  // effective limit is up to N× looser. Move to Firestore/Redis if we scale out.
  // Entries are only created for sessions that passed the ownership gate (real
  // session tokens), and the idle sweep below bounds the Map regardless.
  //
  // S-I: cooldowns are PER (session, problem) — submitting problem A never
  // blocks problem B — and a per-session IN-FLIGHT guard serializes exec calls
  // so the per-problem windows can't multiply concurrent engine batches.
  // Worst-case engine cost per session ≈ 1 concurrent batch + 1 submit/20s per
  // problem (≤20 problems) — bounded.
  const EXEC_LIMITER_PRUNE_MS = 60 * 60 * 1000;
  const EXEC_IN_FLIGHT_RETRY_SECONDS = 2;
  // session_id -> { problems: Map(problem_id -> { lastRunMs, lastSubmitMs, submitCount }),
  //                 inFlight, lastSeenMs }
  const execLimiter = new Map();

  function execLimiterEntry(sessionId) {
    const nowMs = _execClock();
    // Cheap sweep on every call: drop sessions idle for over an hour so the Map
    // never grows unboundedly on a long-lived instance. (The submit cap resets
    // with a pruned entry; contest sessions are far shorter than the 1 h idle
    // horizon, so that is acceptable.)
    for (const [key, entry] of execLimiter) {
      if (nowMs - entry.lastSeenMs > EXEC_LIMITER_PRUNE_MS) execLimiter.delete(key);
    }
    let entry = execLimiter.get(sessionId);
    if (!entry) {
      entry = { problems: new Map(), inFlight: false, lastSeenMs: nowMs };
      execLimiter.set(sessionId, entry);
    }
    entry.lastSeenMs = nowMs;
    return entry;
  }

  // Read-only view for the CHECK phase: no record is created for an id that may
  // still fail validation, so a scripted session can't grow the per-problem map
  // with garbage ids between sweeps. Records materialize at STAMP time only.
  const EMPTY_PROBLEM_LIMITS = Object.freeze({ lastRunMs: -Infinity, lastSubmitMs: -Infinity, submitCount: 0 });

  function problemLimiterView(entry, problemId) {
    return entry.problems.get(problemId) || EMPTY_PROBLEM_LIMITS;
  }

  function problemLimiterRecord(entry, problemId) {
    let record = entry.problems.get(problemId);
    if (!record) {
      record = { lastRunMs: -Infinity, lastSubmitMs: -Infinity, submitCount: 0 };
      entry.problems.set(problemId, record);
    }
    return record;
  }

  // 429 carrying the machine-readable retry hint the api() catch block forwards
  // into the JSON body (mirrors how every other intentional error is sent).
  function rateLimited(retryAfterSeconds) {
    const error = httpError(429, "rate_limited");
    error.retry_after_seconds = retryAfterSeconds;
    return error;
  }

  // Exec-queue overflow -> intentional 429 (same statusCode mapping as
  // httpError/badRequest). "queue_full" is distinguishable from the limiter's
  // "rate_limited": the server is busy, the candidate did nothing wrong — the
  // retry hint just says "back off briefly and try again".
  const QUEUE_FULL_RETRY_SECONDS = 2;
  function queueFull() {
    const error = httpError(429, "queue_full");
    error.retry_after_seconds = QUEUE_FULL_RETRY_SECONDS;
    return error;
  }

  // Engine failure -> intentional 503 (review defect 2). Adapter errors carry
  // .status (HTTP failures toward Judge0, including retry exhaustion in the
  // queue or the adapter's poll budget); they must never surface as a bare 500.
  // "judge_unavailable" mirrors queue_full/rate_limited: machine-readable error
  // + retry hint in the standard JSON body. Errors WITHOUT .status are genuine
  // programming errors and keep propagating as 500.
  const JUDGE_UNAVAILABLE_RETRY_SECONDS = 10;
  function judgeUnavailable() {
    const error = httpError(503, "judge_unavailable");
    error.retry_after_seconds = JUDGE_UNAVAILABLE_RETRY_SECONDS;
    return error;
  }

  // Cooldown CHECKS run right after the ownership gate (always before any judge0
  // work); the cooldown timestamps are RECORDED only when a request is accepted
  // into the exec queue (validation fully passed), so a validation-rejected
  // request (400) never consumes a slot — and a queue-full rejection RESTORES
  // the slot (server busy, not the candidate's fault).
  //
  // S-I §3.1: both checks take problemId — the windows apply per (session,
  // problem). The IN-FLIGHT guard (any problem, run or submit) rejects first so
  // per-problem windows can't stack concurrent engine batches for one session.
  function checkExecRunLimit(sessionId, problemId) {
    const entry = execLimiterEntry(sessionId);
    if (entry.inFlight) throw rateLimited(EXEC_IN_FLIGHT_RETRY_SECONDS);
    const limits = problemLimiterView(entry, problemId);
    const waitMs = execRunCooldownSeconds * 1000 - (_execClock() - limits.lastRunMs);
    if (waitMs > 0) throw rateLimited(Math.ceil(waitMs / 1000));
    return entry;
  }

  function checkExecSubmitLimit(sessionId, problemId) {
    const entry = execLimiterEntry(sessionId);
    if (entry.inFlight) throw rateLimited(EXEC_IN_FLIGHT_RETRY_SECONDS);
    const limits = problemLimiterView(entry, problemId);
    const waitMs = execSubmitCooldownSeconds * 1000 - (_execClock() - limits.lastSubmitMs);
    if (waitMs > 0) throw rateLimited(Math.ceil(waitMs / 1000));
    // Hard per-(session, problem) budget on STORED submissions. Only a
    // successful store increments the count, so invalid problem ids can never
    // grow the map. The budget resets only when the idle sweep prunes the whole
    // entry — report that horizon as the retry hint.
    if (limits.submitCount >= execMaxSubmissionsPerSession) {
      throw rateLimited(Math.ceil(EXEC_LIMITER_PRUNE_MS / 1000));
    }
    return entry;
  }

  // ---- S-I §3.2: contest membership for exec ----------------------------------
  // Scope comes from the SESSION (no client `contest` param). A session bound to
  // a REAL contest doc may exec ONLY that contest's problems[], scored with the
  // entry's effective points. Every other shape — contest_slug "" or a slug with
  // no doc — takes the global path: bank read only, bank/seed points.
  async function contestForSession(session) {
    const slug = String(session?.contest_slug || "");
    if (!slug) return null;
    const doc = await getFirestore().collection(contestsCollection).doc(slug).get();
    return doc.exists ? doc.data() : null;
  }

  async function resolveExecProblem(session, problemIdRaw) {
    const contest = await contestForSession(session);
    if (contest) {
      const entry = contestProblemEntries(contest).find((item) => item.problem_id === problemIdRaw);
      if (!entry) throw httpError(400, "problem_not_in_contest");
      const problem = await getProblem(entry.problem_id);
      if (!problem) return null; // unpublished mid-exam — guard makes this near-impossible
      // Merged effective-points view: scoreSubmission stays untouched (§1.3).
      return { ...problem, points: effectivePoints(entry, problem) };
    }
    return getProblem(problemIdRaw);
  }

  // Build the per-test Judge0 batch items for BOTH exec endpoints. Every
  // language but SQL runs the candidate's source as-is with the test's input on
  // stdin — that path stays byte-identical to the pre-SQL shape (pinned by
  // test). For SQL (language 82) the stdin field is DEAD on the engine, so each
  // test ships the composed script (format prelude + the test's seed SQL +
  // the candidate's query) as source_code with an empty stdin — see
  // composeSqlExecSource in problems.mjs (the single source of truth shared
  // with authoring tooling).
  function buildExecItems(problem, tests, language, source) {
    const languageId = languageIds[language];
    return tests.map((t) => ({
      languageId,
      source: language === "sql" ? composeSqlExecSource(t.input, source) : source,
      stdin: language === "sql" ? "" : t.input,
      expectedOutput: t.expected,
      cpuTimeLimit: problem.cpuTimeLimit, memoryLimit: problem.memoryLimit
    }));
  }

  async function execRun(req) {
    const body = parseBody(req);
    const sessionId = String(body.session_id || "");
    // Ownership gate: unknown session → 404; ended/locked/pending → 409/403.
    const session = requireWritableSession(await getSession(sessionId));
    await requireExamStarted(session); // S3 room gate
    // Rate-limit check BEFORE any judge0 work (metered key — see the limiter).
    const limiter = checkExecRunLimit(sessionId, String(body.problem_id || ""));
    // S-I §3.2: contest-membership-aware problem resolution (legacy = bank read).
    const problem = await resolveExecProblem(session, String(body.problem_id || ""));
    if (!problem) return badRequest("unknown problem_id");
    // Own-key check first: a prototype key like "constructor" must not pass the
    // truthiness test and reach the executor (security review).
    const language = String(body.language || "");
    if (!Object.hasOwn(languageIds, language)) return badRequest("unsupported language");
    const languageId = languageIds[language];
    if (!languageId) return badRequest("unsupported language");
    const source = String(body.source_code || "");
    if (source.length > maxSourceCodeLength) return badRequest(`source_code too large (max ${maxSourceCodeLength} chars)`);
    const items = buildExecItems(problem, problem.sampleTests, language, source);
    // Start the cooldown at ENQUEUE time, once validation has fully passed — a
    // validation-rejected request never consumes the slot, and consuming it on
    // queue ACCEPTANCE (not dispatch) stops a session from stacking queued runs
    // while one is parked in the lane. The in-flight flag is taken at the same
    // point and cleared in finally (S-I §3.1 serialization guard).
    const record = problemLimiterRecord(limiter, problem.id);
    const prevLastRunMs = record.lastRunMs;
    const runStampMs = _execClock();
    record.lastRunMs = runStampMs;
    limiter.inFlight = true;
    let results;
    try {
      // The exec-queue lanes gate the engine phases (design §11 item 2): the
      // run lane bounds (and retries) the submit POSTs, the poll lane bounds
      // each status GET — no slot is parked across the inter-poll waits.
      results = await judge0().runBatch(items, {
        // v1.1 G3: the distributed limiter acquires a GLOBAL token FIRST (a 429
        // here never reaches Judge0), then the run lane bounds the submit POST.
        submitGate: (fn) => judge0SubmitGate(sessionId, () => execQueue.enqueueRun(fn)),
        pollGate: (fn) => execQueue.enqueuePoll(fn)
      });
    } catch (error) {
      // ANY failure here is the SERVER's side, never the candidate's: give the
      // cooldown slot back before mapping the error — but ONLY if the limiter
      // still holds the stamp THIS request wrote. A slow failing request must
      // never clobber a newer stamp another request legitimately recorded.
      if (record.lastRunMs === runStampMs) record.lastRunMs = prevLastRunMs;
      if (error?.name === "QueueFullError") throw queueFull();
      if (typeof error?.status === "number") throw judgeUnavailable();
      throw error; // genuine programming error -> bare 500
    } finally {
      limiter.inFlight = false;
    }
    // P3 SIGNAL — persist a RUN event (server-authoritative; a client can't fake
    // the verdict). Mirrors execSubmit's derivation + denormalized-identity store
    // EXACTLY, and its resilient posture: a store failure must NEVER fail the run
    // (the candidate already has their sample results). The run RESPONSE is
    // unchanged — this is a side-channel write placed BEFORE the return.
    const passedCount = results.filter((r) => r.passed).length;
    const verdict = passedCount === results.length
      ? "accepted"
      : (results.some((r) => r.status === "judging_timeout") ? "error" : "wrong_answer");
    // SAMPLE-test per-result detail (no inputs/expected — parallel to submit).
    const tests = results.map((r, i) => ({ index: i, passed: r.passed, status: r.status, timeSec: r.timeSec }));
    try {
      await getFirestore().collection(runEventsCollection).doc(randomUUID()).set({
        // M7: store the VALIDATED language variable (checked against LANGUAGE_IDS),
        // never the raw client body.language.
        session_id: sessionId, problem_id: problem.id, language,
        // Denormalized identity on every NEW doc (same as SUBMISSIONS_COLLECTION).
        contest_slug: session.contest_slug || "",
        username_norm: session.username_norm || "",
        candidate_id: candidateOf(session).id,
        person_id: session.person_id ?? null,
        // The code AT RUN TIME — the P3 progression/debugging-trajectory signal.
        source_code: source,
        kind: "run", // discriminator vs submit
        passed_count: passedCount, total: results.length, verdict,
        tests, // [{index, passed, status, timeSec}] over the SAMPLE tests
        created_at: new Date().toISOString()
      });
    } catch (error) {
      // Await-with-catch (not fire-and-forget) so a cold-start teardown doesn't
      // lose the write, but a store failure is swallowed — the run NEVER fails.
      console.error(`Failed to store run event for session ${sessionId}: ${error?.message || error}`);
    }
    // echo sample input/expected for display (samples are NOT secret)
    return { results: results.map((r, i) => ({ ...r, input: problem.sampleTests[i].input, expected: problem.sampleTests[i].expected })) };
  }

  async function execSubmit(req) {
    const body = parseBody(req);
    const sessionId = String(body.session_id || "");
    // Ownership gate (same as /api/events): unknown → 404; ended/locked/pending → 409/403.
    const session = requireWritableSession(await getSession(sessionId));
    await requireExamStarted(session); // S3 room gate
    // Rate-limit check BEFORE any judge0 work (metered key — see the limiter).
    // The cap is keyed on the raw problem_id string; only stored submissions
    // increment it, so invalid ids can never grow the per-session count map.
    const limiter = checkExecSubmitLimit(sessionId, String(body.problem_id || ""));
    // S-I §3.2: contest-membership-aware problem resolution (legacy = bank read).
    const problem = await resolveExecProblem(session, String(body.problem_id || ""));
    if (!problem) return badRequest("unknown problem_id");
    // Own-key check first: a prototype key like "constructor" must not pass the
    // truthiness test and reach the executor (security review).
    const language = String(body.language || "");
    if (!Object.hasOwn(languageIds, language)) return badRequest("unsupported language");
    const languageId = languageIds[language];
    if (!languageId) return badRequest("unsupported language");
    const source = String(body.source_code || "");
    if (source.length > maxSourceCodeLength) return badRequest(`source_code too large (max ${maxSourceCodeLength} chars)`);

    const items = buildExecItems(problem, problem.hiddenTests, language, source);
    // Start the cooldown at ENQUEUE time, once validation has fully passed — a
    // validation-rejected request never consumes the slot, and consuming it on
    // queue ACCEPTANCE (not dispatch) stops a session from stacking queued
    // submits while one is parked in the lane. The in-flight flag is taken at
    // the same point and cleared in finally (S-I §3.1 serialization guard).
    const record = problemLimiterRecord(limiter, problem.id);
    const prevLastSubmitMs = record.lastSubmitMs;
    const submitStampMs = _execClock();
    record.lastSubmitMs = submitStampMs;
    limiter.inFlight = true;
    let results;
    try {
      // The submit lane (its own lane, so a submit storm never starves the
      // quick sample-run lane) gates the submit POSTs; the shared poll lane
      // bounds each status GET — no slot is parked across inter-poll waits.
      results = await judge0().runBatch(items, {
        // v1.1 G3: the distributed limiter acquires a GLOBAL token FIRST (a 429
        // here never reaches Judge0), then the submit lane bounds the submit POST.
        submitGate: (fn) => judge0SubmitGate(sessionId, () => execQueue.enqueueSubmit(fn)),
        pollGate: (fn) => execQueue.enqueuePoll(fn)
      });
    } catch (error) {
      // ANY failure here is the SERVER's side, never the candidate's: give the
      // cooldown slot back before mapping the error — but ONLY if the limiter
      // still holds the stamp THIS request wrote. A slow failing request must
      // never clobber a newer stamp another request legitimately recorded.
      if (record.lastSubmitMs === submitStampMs) record.lastSubmitMs = prevLastSubmitMs;
      if (error?.name === "QueueFullError") throw queueFull();
      if (typeof error?.status === "number") throw judgeUnavailable();
      throw error; // genuine programming error -> bare 500
    } finally {
      limiter.inFlight = false;
    }
    const passedCount = results.filter((r) => r.passed).length;
    // Verdict rule: a judging_timeout is an INFRA failure (poll budget exhausted),
    // not the candidate's fault — it must never collapse into "wrong_answer".
    //   all passed            → accepted
    //   any judging_timeout   → error
    //   otherwise             → wrong_answer
    const verdict = passedCount === results.length
      ? "accepted"
      : (results.some((r) => r.status === "judging_timeout") ? "error" : "wrong_answer");

    // S4: submit-time scoring from the problem's points + scoring mode. Derived
    // from counts only, so returning it leaks nothing about hidden tests.
    const score = scoreSubmission(problem, passedCount, results.length);
    const maxPoints = problem.points ?? 100;

    // Per-test results WITHOUT hidden inputs/expected (don't leak the test cases).
    // STORED only — never returned to the candidate (§9 lock below).
    const tests = results.map((r, i) => ({ index: i, passed: r.passed, status: r.status, timeSec: r.timeSec }));

    // Store the submission (low volume -> Firestore). handler.mjs uses inline
    // new Date().toISOString() for timestamps everywhere — match that (no helper).
    // Doc id is a randomUUID — NOT composed from the client-supplied session_id
    // (injection-shaped); session_id/problem_id/created_at stay as FIELDS.
    const createdAt = new Date().toISOString();
    const submissionId = randomUUID();
    try {
      await getFirestore().collection(submissionsCollection).doc(submissionId).set({
        // M7: store the VALIDATED language variable (already checked against
        // LANGUAGE_IDS), never the raw client body.language — a body shaped to
        // coerce to a valid key (e.g. ["python"]) must not land verbatim.
        session_id: sessionId, problem_id: problem.id, language,
        // S-C (F9 D7 + vision §2.11): denormalized identity on every NEW doc at
        // submit time — export/purge/results select by contest_slug directly;
        // OLD docs keep resolving via the session_id join. Doubles as the S-I
        // §3.3 write-time denorm so the scoreboard rollup needs NO joins.
        contest_slug: session.contest_slug || "",
        username_norm: session.username_norm || "",
        candidate_id: candidateOf(session).id,
        person_id: session.person_id ?? null,
        source_code: source, verdict, passed_count: passedCount, total: results.length,
        // max_points is the EFFECTIVE points (contest entry override applied) —
        // the rollup needs no contest join.
        tests, score, max_points: maxPoints, scoring: problem.scoring || "per_test",
        created_at: createdAt
      });
    } catch (error) {
      // The engine run already happened (and was BILLED) — a store failure must
      // not discard the verdict with a 500. Surface it flagged as un-stored (no
      // submission_id), keep the cooldown consumed (the run was real), and do
      // NOT charge the stored-submissions budget (nothing was stored).
      console.error(`Failed to store submission ${submissionId} for session ${sessionId}: ${error?.message || error}`);
      return { verdict, passed_count: passedCount, total: results.length, stored: false };
    }

    // Count the STORED submission against the per-(session, problem) budget
    // (problem.id === the validated problem_id string the cap was checked with).
    record.submitCount += 1;

    // §9 lock: candidates see ONLY pass/fail counts on hidden tests. The stored
    // doc keeps the per-test detail for admin-side analysis; the response doesn't.
    return { verdict, passed_count: passedCount, total: results.length, score, max_points: maxPoints, submission_id: submissionId };
  }

  return {
    // route handlers — names match the dispatch table exactly so handler.mjs's
    // dispatch lines stay byte-identical (canaryIsolation). Candidate-token auth
    // (not admin), so outside routesAuthLint's admin*/invigilator* scope.
    execRun,
    execSubmit,
    // test seam RE-EXPORTED from handler.mjs so handler.mjs?<buster> imports resolve
    __setExecClockForTest,
    // shared helpers RETURNED for single-source reuse by resident handler code:
    // rateLimited (public/roster rate limiters, B12c) + contestForSession
    // (startResponse session lifecycle, B13). Never forked.
    rateLimited,
    contestForSession
  };
}
