// backend/src/routes/healthCheck.mjs — the admin "pre-flight health check"
// route domain as a FACTORY (mirrors makeAdminStatsRoutes / makeAdminPeopleRoutes).
// makeHealthCheckRoutes(ctx) closes over the handler-built ctx (per ?buster
// instance) and returns the single POST /api/admin/health-check handler.
//
// WHAT IT IS: a one-button, admin-only end-to-end probe an operator runs RIGHT
// BEFORE (or mid-) an exam to prove every load-bearing dependency actually works
// from THIS deployment's runtime — the exact paths that broke on exam morning
// (local v4 signing, chunk upload, recordings read, telemetry write, bundle
// hash-gate, Judge0 reachability). It is NOT a contest-scoped read: it stands up
// its OWN ephemeral, fully-namespaced canary contest + session, runs the probes
// against THAT canary, and tears the canary down ALWAYS — so it never touches or
// leaks any real contest's data (canaryIsolation EXEMPT_GETS reason).
//
// CONTRACT (frontend + this handler agree):
//   POST /api/admin/health-check  (requireAdmin, header x-admin-password)
//   body { mode: "light" | "full" }  (default "light")
//   200 { overall, mode, ran_at, duration_ms, checks[], cleanup }
//   overall = "red" if ANY non-skip check is red, else "green".
//   On internal/probe error: still 200, offending check(s) red, cleanup attempted.
//   4xx/5xx ONLY for auth failure or a malformed body.
//
// LIGHT mode is SAFE TO RUN MID-EXAM: it mints NO Judge0 execution (no billing).
// FULL mode adds 2 metered Judge0 submissions (one seed 'sum-two' 2-case batch).
//
// EVERYTHING stateful/env-captured arrives through ctx (the live-client getters,
// the auth guard, the http helpers, the contest/session/exec domain fns, the
// env-captured collection names + bucket + origins) — nothing is imported here,
// so the env-capture-at-load + ?buster isolation semantics stay in handler.mjs.
// fetchImpl is injected (default globalThis.fetch) so the bundle/GCS-PUT/Judge0
// probes are deterministically testable without real network.

const NAMESPACE_PREFIX = "__healthcheck-";

export function makeHealthCheckRoutes(ctx) {
  const {
    getFirestore,
    requireAdmin,
    parseBody,
    badRequest,
    // session-start reuse (genuinely exercises the candidate-auth path)
    startSession,
    sessionPrefix,
    // contest/session/canary teardown reuse
    resolveContest,
    listContests,
    scopedQuery,
    releaseLiveSlot,
    deleteEvidencePrefix,
    deleteDocsByIds,
    // signing + storage clients (by reference — swap-propagating getters)
    bucket,
    signingBucket,
    putJsonl,
    judge0,
    // env-captured config (by value at handler load)
    contestsCollection,
    sessionCollection,
    submissionsCollection,
    liveLockCollection,
    evidenceBucket,
    urlExpirySeconds,
    publicAppOrigin,
    publicAppUrl,
    expectedBundleHashes = [],
    judge0BaseUrl,
    judge0Mode,
    judge0ApiKey,
    judge0AuthToken,
    languageIds,
    // injectables (mirrors __setClientsForTest seams) — default real network/clock
    fetchImpl = (...args) => fetch(...args),
    nowMs = () => Date.now(),
    randomId = () => Math.random().toString(36).slice(2, 10)
  } = ctx;

  // Run a single probe with timing; a thrown error becomes a red check carrying
  // the REAL message (this endpoint is a diagnostic — the operator NEEDS the
  // error text, unlike the M3-redacted production catch). A probe NEVER aborts
  // the run or skips teardown.
  async function runProbe(id, label, fn) {
    const startedMs = nowMs();
    try {
      const result = await fn();
      return {
        id,
        label,
        status: result?.status || "green",
        latency_ms: nowMs() - startedMs,
        detail: result?.detail || "ok"
      };
    } catch (error) {
      return {
        id,
        label,
        status: "red",
        latency_ms: nowMs() - startedMs,
        detail: String(error?.message || error)
      };
    }
  }

  // Judge0 auth headers WITHOUT a browser-UA dependency: liveness only needs the
  // auth header set, mirroring the adapter's mode fork (rapidapi vs selfhosted).
  function judge0Headers() {
    return judge0Mode === "rapidapi"
      ? {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          "X-RapidAPI-Key": judge0ApiKey || "",
          "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com"
        }
      : {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          "X-Auth-Token": judge0AuthToken || ""
        };
  }

  // ---- ORPHAN SWEEP: fully purge any leftover __healthcheck-* contests from a
  // prior crashed/aborted run (each run is self-cleaning, but a process kill
  // mid-teardown could strand one). Best-effort, bounded.
  async function purgeCanaryContest(contestDoc) {
    const detailParts = [];
    let leaked = false;
    // Resolve a scopeable contest object (legacy_empty_slug never applies — our
    // slug is always non-empty), so scopedQuery selects exactly this canary.
    const scope = { slug: contestDoc.slug };

    // Sessions first — capture their evidence prefixes for GCS teardown + release
    // each live-slot lock, then delete the GCS objects + the session docs.
    let sessions = [];
    try {
      const snap = await scopedQuery(getFirestore().collection(sessionCollection), scope).limit(500).get();
      sessions = snap.docs.map((doc) => ({ _id: doc.id, ...doc.data() }));
    } catch (error) {
      leaked = true;
      detailParts.push(`session-list failed: ${String(error?.message || error)}`);
    }

    for (const session of sessions) {
      try { await releaseLiveSlot(session); } catch { /* best-effort */ }
      const prefix = sessionPrefix(session);
      try { await deleteEvidencePrefix(prefix); } catch (error) {
        leaked = true;
        detailParts.push(`evidence ${prefix} not fully torn down: ${String(error?.message || error)}`);
      }
    }

    // Submissions scoped to the canary (FULL-mode exec writes one).
    try {
      const subSnap = await scopedQuery(getFirestore().collection(submissionsCollection), scope).limit(500).get();
      const subs = subSnap.docs.map((doc) => ({ _id: doc.id, ...doc.data() }));
      await deleteDocsByIds(submissionsCollection, subs);
    } catch (error) {
      leaked = true;
      detailParts.push(`submissions not deleted: ${String(error?.message || error)}`);
    }

    // Session docs.
    try {
      await deleteDocsByIds(sessionCollection, sessions);
    } catch (error) {
      leaked = true;
      detailParts.push(`session docs not deleted: ${String(error?.message || error)}`);
    }

    // Any stray live-lock docs for this canary (defensive: release above keyed
    // on session, but a lock whose session never persisted would linger).
    // Routed through the scopedQuery chokepoint (scopingLint) — never a raw
    // contest_slug filter; our slug is always non-empty so the no-bleed scope is
    // exactly this canary.
    try {
      const lockSnap = await scopedQuery(getFirestore().collection(liveLockCollection), scope).limit(500).get();
      const locks = lockSnap.docs.map((doc) => ({ _id: doc.id, ...doc.data() }));
      await deleteDocsByIds(liveLockCollection, locks);
    } catch { /* best-effort */ }

    // The infra_firestore reachability-probe doc (canary-namespaced into the
    // session collection). The probe deletes it inline via try/finally; this is
    // the orphan-sweep safety net for a process kill between its set and finally.
    try {
      await getFirestore().collection(sessionCollection).doc(`${contestDoc.slug}-fsprobe`).delete();
    } catch { /* best-effort */ }

    // The contest doc LAST.
    try {
      await getFirestore().collection(contestsCollection).doc(contestDoc.slug).delete();
    } catch (error) {
      leaked = true;
      detailParts.push(`contest doc ${contestDoc.slug} not deleted: ${String(error?.message || error)}`);
    }

    return { ok: !leaked, detail: detailParts.join("; ") };
  }

  async function orphanSweep() {
    // listContests is the cross-contest read (it already exists + is bounded);
    // the synthesized legacy contest never carries our namespace, so filtering by
    // the slug prefix selects exactly leftover canaries.
    let contests = [];
    try {
      contests = await listContests({ includeArchived: true });
    } catch {
      return; // a list failure shouldn't block a fresh run; this run cleans itself
    }
    const orphans = contests.filter((c) => String(c.slug || "").startsWith(NAMESPACE_PREFIX));
    for (const orphan of orphans) {
      await purgeCanaryContest(orphan).catch(() => {});
    }
  }

  // ---- the route ------------------------------------------------------------
  async function healthCheck(req) {
    requireAdmin(req);
    const body = parseBody(req);
    // Default light; any non-"full" value (incl. garbage) is treated as light —
    // the SAFE choice mid-exam. A malformed JSON body already 400'd in parseBody.
    const mode = body?.mode === "full" ? "full" : "light";

    const ranAtMs = nowMs();
    const ran_at = new Date(ranAtMs).toISOString();
    const checks = [];

    // 1) Sweep stranded canaries from prior runs BEFORE standing up a new one.
    await orphanSweep().catch(() => {});

    // 2) Stand up THIS run's ephemeral canary. Written DIRECTLY (not via
    // createContest) so the __healthcheck- namespace survives verbatim —
    // slugify would strip the leading underscores and break the orphan sweep.
    const slug = `${NAMESPACE_PREFIX}${ranAtMs}-${randomId()}`;
    const now = new Date(ranAtMs).toISOString();
    const farFuture = new Date(ranAtMs + 365 * 24 * 60 * 60 * 1000).toISOString();
    const pastStart = new Date(ranAtMs - 60 * 60 * 1000).toISOString();

    let canarySession = null;
    let canaryContestCreated = false;

    try {
      const contestDoc = {
        slug,
        name: `Health Check ${now}`,
        status: "open",
        // listed:false is a self-describing marker; the admin Contests list is
        // hidden from canaries at the adminListContests RESPONSE layer (the
        // __healthcheck- prefix filter), NOT via this field — listContests()
        // ignores `listed` and the orphan sweep relies on still seeing them.
        listed: false,
        identity_mode: "person",
        identity_label: "Candidate ID",
        access_code: null, // never resolvable via the public landing page
        invigilator_key: null,
        start_at: pastStart,
        end_at: farFuture,
        end_at_updated_at: null,
        // One published seed problem so FULL-mode exec has something to run.
        problems: [{ problem_id: "sum-two", points: 100, order: 0 }],
        template_slug: null,
        room_gate_enabled: false,
        rooms: [],
        created_at: now,
        updated_at: now,
        selection_done_at: null,
        evidence_retention_days: 1,
        evidence_purged_at: null,
        db_purged_at: null,
        evidence_prefixes: null,
        last_export: null,
        // a self-describing marker so a human spotting one in Firestore knows
        // it is an ephemeral health-check artifact (and the sweep target).
        healthcheck: true
      };
      await getFirestore().collection(contestsCollection).doc(slug).create(contestDoc);
      canaryContestCreated = true;

      // 3) Start the canary session by REUSING the real session-start path
      // (startSession → resolvePersonContestForStart → startPersonSession), so
      // the candidate-auth/identity/live-lock chain is genuinely exercised. A
      // no-roster person contest requires name + email + candidate_id.
      const startReq = {
        method: "POST",
        path: "/api/session/start",
        headers: {},
        query: {},
        body: {
          contest: slug,
          candidate_id: `healthcheck-${randomId()}`,
          name: "Health Check Canary",
          email: "healthcheck@canary.local",
          consent_accepted: true
        },
        get() { return undefined; }
      };
      // startSession → startResponse returns the start/resume payload directly:
      // { session_id, status, storage_prefix, ... } (no nested .session wrapper).
      const startResult = await startSession(startReq);
      canarySession = startResult?.session_id ? startResult : null;
    } catch (error) {
      // Canary setup itself failed — record it as a red check, then fall through
      // to run whatever probes can still run + ALWAYS attempt teardown.
      checks.push({
        id: "canary_setup",
        label: "Ephemeral canary contest + session",
        status: "red",
        latency_ms: nowMs() - ranAtMs,
        detail: String(error?.message || error)
      });
    }

    // The session-start response exposes session_id/session_token; the stored
    // doc carries storage_prefix + status. Re-read the doc so the GCS-mirror
    // probes build keys exactly like the upload sites (storage_prefix is the
    // single source of truth).
    let sessionDoc = null;
    const sessionId = canarySession?.session_id || null;
    if (sessionId) {
      try {
        const snap = await getFirestore().collection(sessionCollection).doc(sessionId).get();
        if (snap.exists) sessionDoc = { _id: snap.id, ...snap.data() };
      } catch { /* probe-level checks below surface the failure */ }
    }
    const canaryPrefix = sessionDoc ? sessionPrefix(sessionDoc) : `contests/${slug}/sessions/__healthcheck/__nosession/`;

    // ---- PROBES ---------------------------------------------------------------
    // infra_firestore: prove Firestore write+read+delete WITHOUT touching the
    // real contests collection. (1) read back the canary contest doc we already
    // created (cross-collection read against THIS deployment's datastore), and
    // (2) a write/read/delete round-trip on a canary-NAMESPACED doc in the
    // session collection (doc id ${slug}-fsprobe, contest_slug=slug) — the
    // delete is wrapped in try/finally so it ALWAYS runs even if the read-back
    // throws, and purgeCanaryContest deletes ${slug}-fsprobe too (belt + braces
    // against a process kill between set and finally).
    checks.push(await runProbe("infra_firestore", "Firestore write/read/delete", async () => {
      if (!canaryContestCreated) throw new Error("canary contest was not created to read back");
      const contestSnap = await getFirestore().collection(contestsCollection).doc(slug).get();
      if (!contestSnap.exists || contestSnap.data()?.slug !== slug) {
        throw new Error("read-back of the canary contest doc did not match");
      }
      const probeRef = getFirestore().collection(sessionCollection).doc(`${slug}-fsprobe`);
      const marker = `hc-${randomId()}`;
      try {
        await probeRef.set({ healthcheck_probe: true, marker, contest_slug: slug });
        const snap = await probeRef.get();
        if (!snap.exists || snap.data()?.marker !== marker) {
          throw new Error("read-back did not match the written marker");
        }
      } finally {
        await probeRef.delete().catch(() => {});
      }
      return { detail: "canary contest read-back + namespaced doc write/read/delete round-trip ok" };
    }));

    // infra_gcs_rw: mint a v4 signed WRITE url via signingBucket (LOCAL signing)
    // + PUT a tiny object + GET it + delete — bucket + token + signer end-to-end.
    checks.push(await runProbe("infra_gcs_rw", "GCS signed write/read (signer + bucket)", async () => {
      const key = `${canaryPrefix}healthcheck/infra-${randomId()}.txt`;
      const payload = `healthcheck ${now}`;
      const [writeUrl] = await signingBucket().file(key).getSignedUrl({
        version: "v4", action: "write",
        expires: nowMs() + urlExpirySeconds * 1000,
        contentType: "text/plain"
      });
      if (!writeUrl) throw new Error("signer returned no write URL");
      const putRes = await fetchImpl(writeUrl, {
        method: "PUT", headers: { "Content-Type": "text/plain" }, body: payload
      });
      if (!putRes.ok) throw new Error(`signed PUT failed: HTTP ${putRes.status}`);
      // Confirm it landed (list under the prefix via the token-bearing main client).
      const [files] = await bucket().getFiles({ prefix: key, maxResults: 1 });
      const present = Array.isArray(files) && files.some((f) => f.name === key);
      if (!present) throw new Error("object not found after signed PUT");
      await bucket().file(key).delete().catch(() => {});
      return { detail: "signed write URL minted, object PUT + verified + deleted" };
    }));

    // bundle_hashes: fetch the served proctor-web app and assert the gate hash
    // VALUES — sha256(admin password) / sha256(invigilator password), computed
    // in handler.mjs and injected as expectedBundleHashes (label + hash only,
    // never the raw passwords) — are baked into the served bundle. The env-var
    // NAMES (VITE_*_PASSWORD_HASH) do NOT survive the Vite build, so this is a
    // real frontend↔backend coherence check, not a name-substring scan.
    checks.push(await runProbe("bundle_hashes", "Served bundle carries password-hash gate", async () => {
      const appUrl = publicAppUrl || (publicAppOrigin && publicAppOrigin !== "*" ? publicAppOrigin : "");
      if (!appUrl) {
        return { status: "skip", detail: "PUBLIC_APP_URL not set to a concrete origin" };
      }
      if (!expectedBundleHashes.length) {
        return { status: "skip", detail: "admin/invigilator passwords not configured" };
      }
      const origin = String(appUrl).replace(/\/+$/, "");
      const indexRes = await fetchImpl(`${origin}/`, { method: "GET" });
      if (!indexRes.ok) throw new Error(`GET ${origin}/ failed: HTTP ${indexRes.status}`);
      const indexHtml = await indexRes.text();
      // Locate the built JS asset(s) referenced by the index HTML.
      const scriptKeys = [...indexHtml.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
      // Track which LABELS are still missing (never the hash/password itself).
      const missing = new Set(expectedBundleHashes.map((e) => e.label));
      const seen = (text) => {
        for (const e of expectedBundleHashes) if (text.includes(e.hash)) missing.delete(e.label);
      };
      // The hashes are inlined into the JS at build time; scan each referenced JS.
      seen(indexHtml);
      for (const rawSrc of scriptKeys) {
        if (!missing.size) break;
        const jsUrl = /^https?:\/\//.test(rawSrc)
          ? rawSrc
          : `${origin}/${String(rawSrc).replace(/^\/+/, "")}`;
        const jsRes = await fetchImpl(jsUrl, { method: "GET" });
        if (!jsRes.ok) continue;
        seen(await jsRes.text());
      }
      if (missing.size) {
        throw new Error("served bundle missing expected password hash(es): " + [...missing].join(", "));
      }
      return { detail: "served bundle carries expected admin+invigilator password hashes" };
    }));

    // auth_session_start: admin auth already confirmed; assert the canary
    // session-start succeeded (the candidate-auth path is alive).
    checks.push(await runProbe("auth_session_start", "Admin auth + candidate session-start", async () => {
      if (!sessionDoc || !sessionId) throw new Error("canary session-start did not yield a session");
      if (sessionDoc.status !== "active") {
        throw new Error(`canary session status is "${sessionDoc.status}", expected "active"`);
      }
      return { detail: `admin authed; canary session ${sessionId} started active` };
    }));

    // exam_config: GET exam-config for the canary contest -> 200 (resolveContest
    // requireOpen — proves the open contest serves its config envelope).
    checks.push(await runProbe("exam_config", "Exam-config for the canary contest", async () => {
      const contest = await resolveContest(slug, { requireOpen: true });
      if (!contest || contest.slug !== slug) throw new Error("exam-config did not resolve the canary contest");
      return { detail: `exam-config resolved (status=${contest.status})` };
    }));

    // chunk_upload_signed: mint a v4 signed WRITE url for the canary session
    // (mirror createUploadUrl) + actually PUT a small .webm + confirm it exists.
    // THE path that broke on exam morning.
    checks.push(await runProbe("chunk_upload_signed", "Chunk upload signed write (createUploadUrl path)", async () => {
      if (!sessionDoc) throw new Error("no canary session to mint a chunk URL for");
      const objectKey = `${canaryPrefix}screen/chunk-${String(0).padStart(5, "0")}.webm`;
      const [uploadUrl] = await signingBucket().file(objectKey).getSignedUrl({
        version: "v4", action: "write",
        expires: nowMs() + urlExpirySeconds * 1000,
        contentType: "video/webm"
      });
      if (!uploadUrl) throw new Error("signer returned no upload URL");
      const putRes = await fetchImpl(uploadUrl, {
        method: "PUT", headers: { "Content-Type": "video/webm" }, body: "WEBMHEALTHCHECK"
      });
      if (!putRes.ok) throw new Error(`chunk PUT failed: HTTP ${putRes.status}`);
      const [files] = await bucket().getFiles({ prefix: objectKey, maxResults: 1 });
      const present = Array.isArray(files) && files.some((f) => f.name === objectKey);
      if (!present) throw new Error("chunk object not found after signed PUT");
      return { detail: "signed chunk write URL minted, .webm PUT + verified" };
    }));

    // recordings_read: list the canary session prefix + mint a v4 signed READ
    // url + fetch it -> 200 (mirrors adminSessions recordings read).
    checks.push(await runProbe("recordings_read", "Recordings list + signed read", async () => {
      if (!sessionDoc) throw new Error("no canary session to read recordings for");
      const [files] = await bucket().getFiles({ prefix: canaryPrefix, maxResults: 1000 });
      const chunk = (Array.isArray(files) ? files : []).find((f) => /screen\/chunk-/.test(f.name));
      if (!chunk) throw new Error("no recording chunk under the canary prefix to read back");
      const [readUrl] = await signingBucket().file(chunk.name).getSignedUrl({
        version: "v4", action: "read",
        expires: nowMs() + urlExpirySeconds * 1000
      });
      if (!readUrl) throw new Error("signer returned no read URL");
      const getRes = await fetchImpl(readUrl, { method: "GET" });
      if (!getRes.ok) throw new Error(`signed READ failed: HTTP ${getRes.status}`);
      return { detail: `listed ${files.length} object(s); signed read of ${chunk.name} -> 200` };
    }));

    // telemetry_event: write a canary .jsonl event (mirror recordEvents) +
    // confirm the object exists.
    checks.push(await runProbe("telemetry_event", "Telemetry event write (putJsonl)", async () => {
      const eventKey = `${canaryPrefix}events/healthcheck-${nowMs()}-${randomId()}.jsonl`;
      await putJsonl(eventKey, [{ type: "healthcheck", timestamp: now, detail: { marker: slug } }]);
      const [files] = await bucket().getFiles({ prefix: eventKey, maxResults: 1 });
      const present = Array.isArray(files) && files.some((f) => f.name === eventKey);
      if (!present) throw new Error("telemetry .jsonl object not found after write");
      return { detail: `wrote + verified ${eventKey}` };
    }));

    // judge0_liveness: GET Judge0 /languages with auth -> reachable. NO
    // submission, NO billing. Always run in BOTH modes.
    checks.push(await runProbe("judge0_liveness", "Judge0 reachable (/languages, no billing)", async () => {
      const base = String(judge0BaseUrl || "").replace(/\/+$/, "");
      if (!base) throw new Error("JUDGE0_BASE_URL not configured");
      const res = await fetchImpl(`${base}/languages`, { method: "GET", headers: judge0Headers() });
      if (!res.ok) throw new Error(`GET ${base}/languages failed: HTTP ${res.status}`);
      // Body shape sanity (a 200 from a captive portal would still be wrong).
      let count = null;
      try {
        const data = await res.json();
        if (Array.isArray(data)) count = data.length;
      } catch { /* a non-JSON 200 still proves reachability */ }
      return { detail: count === null ? "languages endpoint reachable" : `languages endpoint reachable (${count} languages)` };
    }));

    // ---- FULL mode: one metered execution -------------------------------------
    if (mode === "full") {
      checks.push(await runProbe("judge0_exec", "Judge0 executes seed sum-two (metered)", async () => {
        if (!sessionDoc) throw new Error("no canary session to submit under");
        const languageId = languageIds?.python;
        if (!languageId) throw new Error("python language id not configured");
        // Minimal correct sum-two solution; run against the seed hidden tests.
        const source = "import sys\na,b=map(int,sys.stdin.read().split())\nprint(a+b)";
        const items = [
          { languageId, source, stdin: "0 0\n", expectedOutput: "0", cpuTimeLimit: 5, memoryLimit: 128000 },
          { languageId, source, stdin: "-5 5\n", expectedOutput: "0", cpuTimeLimit: 5, memoryLimit: 128000 }
        ];
        const results = await judge0().runBatch(items);
        const timedOut = results.some((r) => r.status === "judging_timeout");
        const allPassed = results.length > 0 && results.every((r) => r.passed);
        // Store a canary submission doc (so teardown deletion is exercised too).
        const submissionId = `${slug}-submission-${randomId()}`;
        await getFirestore().collection(submissionsCollection).doc(submissionId).set({
          session_id: sessionId,
          problem_id: "sum-two",
          contest_slug: slug,
          username_norm: sessionDoc.username_norm || "",
          verdict: allPassed ? "accepted" : (timedOut ? "error" : "wrong_answer"),
          passed_count: results.filter((r) => r.passed).length,
          total: results.length,
          score: allPassed ? 100 : 0,
          max_points: 100,
          created_at: new Date(nowMs()).toISOString(),
          healthcheck: true
        }).catch(() => {});
        // judging_timeout is slow-but-alive — distinct from engine-down (which
        // throws an HTTP error and is caught as red by runProbe). Surface it as
        // red here too (a probe must be deterministic for the operator), but the
        // message tells them the engine is reachable, just slow.
        if (timedOut) throw new Error("submission never finished judging (slow engine; reachable but over poll budget)");
        if (!allPassed) throw new Error("seed sum-two did not pass — engine returned an unexpected verdict");
        return { detail: `seed sum-two accepted (${results.length} hidden tests passed)` };
      }));
    }

    // ---- TEARDOWN (ALWAYS) ----------------------------------------------------
    // Delete ALL GCS objects under the canary contest prefix, delete canary
    // submissions, release the live-lock, delete the canary session doc, delete
    // the canary contest doc. cleanup carries {ok, detail}.
    let cleanup;
    try {
      if (canaryContestCreated || sessionDoc) {
        cleanup = await purgeCanaryContest({ slug });
        // Also sweep the whole contest GCS subtree (events/, the probe objects),
        // not just per-session prefixes — the infra_gcs_rw + telemetry probes
        // wrote under the session prefix, but be exhaustive at the contest root.
        try {
          await deleteEvidencePrefix(`contests/${slug}/`);
        } catch (error) {
          cleanup = {
            ok: false,
            detail: [cleanup.detail, `contest subtree not fully deleted: ${String(error?.message || error)}`].filter(Boolean).join("; ")
          };
        }
        if (cleanup.ok && !cleanup.detail) cleanup.detail = "canary contest, session, evidence, submissions, live-lock all torn down";
      } else {
        cleanup = { ok: true, detail: "nothing to tear down (canary was never created)" };
      }
    } catch (error) {
      cleanup = { ok: false, detail: `teardown threw: ${String(error?.message || error)}` };
    }

    const overall = checks.some((c) => c.status === "red") ? "red" : "green";
    return {
      overall,
      mode,
      ran_at,
      duration_ms: nowMs() - ranAtMs,
      checks,
      cleanup
    };
  }

  return { healthCheck };
}
