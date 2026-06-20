// backend/src/routes/public.mjs — the PUBLIC config + access-code + roster-lookup
// routes AND the admin roster CRUD, as a FACTORY (decomp B12c, plan §1.2).
// makePublicRoutes(ctx) closes over the handler-built ctx (per ?buster instance)
// and returns the route handlers + the roster helpers resident code reuses + the
// rate-limiter test seams handler.mjs RE-EXPORTS.
//
// TWO in-memory per-IP rate-limiter Maps move WITH their owning routes (read AND
// mutated by exactly these endpoints):
//   accessCodeAttempts   — POST /api/access-code (anti-enumeration, refund-on-hit)
//   rosterLookupAttempts — POST /api/roster/lookup (anti-enumeration, refund-on-hit)
// They are per-process singletons; one instance per ?buster module evaluation,
// exactly as before (module-level → factory-closure-level, same lifetime since
// handler instantiates the factory once per load).
//
// TEST SEAM CARRY (constraint #3): __setAccessCodeClockForTest /
// __setRosterLookupClockForTest / __resetRosterLookupRateLimitForTest /
// checkRosterLookupRateLimit were top-level exports of handler.mjs imported by
// roster/examTime tests via handler.mjs?<buster>. The clock state + setters +
// reset + the exported checker move INTO this factory and are RETURNED;
// handler.mjs RE-EXPORTS them so those imports still resolve.
//
// SHARED helpers RETURNED for single-source reuse by still-resident handler code
// (never forked):
//   getRosterMeta    — also used by adminAttendance (B14).
//   findRosterEntry  — also used by resolvePersonRosterIdentity (session start, B13).
//
// adminSaveRoster's clear path uses a raw `.where("roster_version", ...)` — NOT a
// contest_slug equality filter — so scopingLint's allowlist stays {handler.mjs: 4}.
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as the other route domains: getFirestore is a GETTER so the
// fake-Firestore swap propagates.
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*). Nothing is imported here — every dependency (the live Firestore
// getter, the http transport helpers, the admin auth guard, the client-ip reader +
// sanitizers + maskEmail + mapWithConcurrency, the contest/identity/access-code
// domain fns, the resident normalizeRooms by reference, the enforcement config
// readers by reference, the exec factory's rateLimited by reference, randomUUID,
// and the env-captured collection names / ids / caps + rate-limit windows BY VALUE)
// arrives through ctx, so the env-capture-at-load semantics stay in handler.mjs
// (env-lint).

export function makePublicRoutes(ctx) {
  const {
    getFirestore,
    requireAdmin,
    parseBody,
    requireFields,
    badRequest,
    httpError,
    // sanitizers / client-ip / mask / concurrency (lib/sanitize)
    getClientIp,
    normalizeUniqueId,
    maskEmail,
    mapWithConcurrency,
    randomUUID,
    // contest / identity / access-code domain fns
    resolveContest,
    resolveAccessCode,
    saveContestRoster,
    getContestRosterSummary,
    getContestRosterMeta,
    // resident helpers (by reference)
    normalizeRooms,
    rateLimited,
    // enforcement config readers (src/enforcement.mjs), by reference
    enforcementConfigFor,
    cameraRecordingConfigFor,
    // env-captured collection names / ids / caps (by value at handler load)
    settingsCollection,
    rosterMetaId,
    rosterCollection,
    rosterLimit,
    rosterCellMax,
    rosterColumnsLimit,
    rosterMappableFields
  } = ctx;

  // ---- S2 roster store (spec: docs/superpowers/specs/2026-06-09-s2-roster-login-design.md)

  function rosterMetaRef() {
    return getFirestore().collection(settingsCollection).doc(rosterMetaId);
  }

  // The ACTIVE roster meta, or null when no roster is configured (never uploaded,
  // or cleared). Callers treat null as "roster gate off".
  async function getRosterMeta() {
    const doc = await rosterMetaRef().get();
    const meta = doc.exists ? doc.data() : null;
    return meta && meta.configured ? meta : null;
  }

  // Firestore doc id for a roster entry: roster VERSION + doc-id-safe form of the
  // normalized unique id (no "/", never empty or all-dots). The version prefix
  // means a re-upload writes onto FRESH doc ids, so ACTIVE-version entries stay
  // resolvable for the whole write window and only become invisible when the meta
  // flips. Old-version docs are left behind (storage grows by one roster per
  // upload; cleanup deliberately deferred). Distinct ids that sanitize to the
  // same doc id are detected at upload time (the upload sees every row) and
  // reported as duplicate skips; lookup-side collisions are rejected by the exact
  // unique_id_norm check in findRosterEntry.
  function rosterEntryId(version, uniqueIdNorm) {
    const cleaned = String(uniqueIdNorm).replace(/[^a-z0-9@._-]/g, "_").slice(0, 200);
    const safe = cleaned === "" || /^\.+$/.test(cleaned) ? "_" : cleaned;
    return `v${version}:${safe}`;
  }

  // POST /api/admin/roster — replace the active roster ({clear:true} disables it).
  // The client parses the CSV; this endpoint receives structured rows. Entries are
  // written first (bounded concurrency), the meta doc LAST, so a crashed upload
  // never activates a half-written version.
  async function adminSaveRoster(req) {
    requireAdmin(req);
    const body = parseBody(req);
    // S-C: an upload that names a contest goes down the PERSON-layer pipeline
    // (compulsory college column, canonicalization gate, dup hard-reject, person
    // upsert, enrollment minting — identity.mjs). Only real identity_mode:
    // "person" contests qualify; any other scope (absent contest param, or a
    // non-person contest) keeps the global-roster path below BIT-FOR-BIT.
    const personContest = await resolvePersonContestParam(body.contest);
    if (personContest) {
      return saveContestRoster(personContest, body, {
        ip: getClientIp(req),
        userAgent: req.get?.("user-agent") || req.headers?.["user-agent"] || ""
      });
    }
    if (body.clear === true) {
      // M5: a clear must PURGE the roster PII, not merely flip the meta flag.
      // Delete the CURRENT version's entry docs (each holds name/email/roll/etc.).
      // We delete only the active version's docs: orphaned docs from PRIOR
      // re-uploads (the versioned-replace design never mass-deletes them) are left
      // behind and grow storage by one roster per upload — cleanup of those
      // version-orphans is deliberately deferred (matches rosterEntryId's note).
      const currentMeta = await getRosterMeta();
      if (currentMeta?.version) {
        const snapshot = await getFirestore().collection(rosterCollection)
          .where("roster_version", "==", currentMeta.version)
          .limit(rosterLimit)
          .get();
        const ids = snapshot.docs.map((doc) => doc.data()).map((entry) => rosterEntryId(currentMeta.version, entry.unique_id_norm));
        await mapWithConcurrency(ids, 20, async (entryId) => {
          await getFirestore().collection(rosterCollection).doc(entryId).delete();
        });
      }
      await rosterMetaRef().set({ configured: false, cleared_at: new Date().toISOString() });
      return { ok: true, configured: false, count: 0, skipped: [] };
    }
    requireFields(body, ["unique_id_column", "columns", "rows"]);
    const columns = Array.isArray(body.columns)
      ? body.columns.map((c) => String(c).trim().slice(0, rosterCellMax)).filter(Boolean)
      : [];
    if (!columns.length) return badRequest("columns must be a non-empty array");
    if (columns.length > rosterColumnsLimit) return badRequest(`max ${rosterColumnsLimit} columns`);
    const uniqueIdColumn = String(body.unique_id_column).trim();
    if (!columns.includes(uniqueIdColumn)) return badRequest("unique_id_column must be one of columns");
    const rows = Array.isArray(body.rows) ? body.rows : null;
    if (!rows || !rows.length) return badRequest("rows must be a non-empty array");
    if (rows.length > rosterLimit) return badRequest(`max ${rosterLimit} roster rows`);

    // Only known identity fields may be mapped, and only onto known columns.
    const mapping = {};
    for (const [field, column] of Object.entries(body.column_mapping || {})) {
      if (!rosterMappableFields.includes(field)) continue;
      const col = String(column || "").trim();
      if (col && columns.includes(col)) mapping[field] = col;
    }

    const version = randomUUID();
    const now = new Date().toISOString();
    const seen = new Set();
    const entries = [];
    const skipped = [];
    rows.forEach((row, index) => {
      const fields = {};
      for (const column of columns) {
        fields[column] = String(row?.[column] ?? "").trim().slice(0, rosterCellMax);
      }
      const uniqueId = fields[uniqueIdColumn];
      if (!uniqueId) {
        skipped.push({ row: index, reason: "empty_unique_id" });
        return;
      }
      const entryId = rosterEntryId(version, normalizeUniqueId(uniqueId));
      if (seen.has(entryId)) {
        skipped.push({ row: index, reason: "duplicate_unique_id" });
        return;
      }
      seen.add(entryId);
      entries.push({
        entryId,
        item: {
          unique_id: uniqueId,
          unique_id_norm: normalizeUniqueId(uniqueId),
          roster_version: version,
          fields,
          created_at: now
        }
      });
    });
    if (!entries.length) return badRequest("no valid roster rows (every row was skipped)");

    await mapWithConcurrency(entries, 20, async ({ entryId, item }) => {
      await getFirestore().collection(rosterCollection).doc(entryId).set(item);
    });
    await rosterMetaRef().set({
      configured: true,
      version,
      unique_id_column: uniqueIdColumn,
      column_mapping: mapping,
      columns,
      count: entries.length,
      updated_at: now
    });
    return { ok: true, configured: true, count: entries.length, skipped };
  }

  // Resolve an OPTIONAL contest param to a real person-mode contest doc, or
  // null when the param is absent (the global roster path). A param that names
  // anything other than a real person contest is a hard 400 — uploads must never
  // silently fall back to the global roster when the admin asked for a contest.
  async function resolvePersonContestParam(contestParam) {
    if (contestParam === undefined || contestParam === null || String(contestParam).trim() === "") {
      return null;
    }
    const contest = await resolveContest(String(contestParam).trim(), { requireOpen: false });
    if (contest.identity_mode !== "person") {
      throw httpError(400, "per_contest_roster_requires_person_contest");
    }
    return contest;
  }

  // GET /api/admin/roster — meta summary ONLY (never the rows).
  async function adminGetRoster(req) {
    requireAdmin(req);
    // S-C: ?contest= reads that contest's roster meta (roster_meta::{slug}).
    const personContest = await resolvePersonContestParam(req.query?.contest);
    if (personContest) return getContestRosterSummary(personContest);
    const meta = await getRosterMeta();
    if (!meta) return { configured: false };
    return {
      configured: true,
      count: meta.count || 0,
      unique_id_column: meta.unique_id_column || "",
      column_mapping: meta.column_mapping || {},
      columns: meta.columns || [],
      updated_at: meta.updated_at || ""
    };
  }

  // GET /api/exam-config?contest=<slug> — PUBLIC (the student form renders before
  // any session exists). ?contest= is MANDATORY: an absent param is a hard 400
  // unknown_contest (the candidate app always pins it). Returns only
  // non-sensitive config: whether the roster gate is on, what to call the
  // unique-ID field, and the room labels. Fail-open client-side is safe because
  // /api/session/start re-enforces the roster gate regardless.
  async function publicExamConfig(req) {
    const contestParam = String(req?.query?.contest ?? "").trim();
    if (!contestParam) throw httpError(400, "unknown_contest");
    return contestExamConfig(contestParam);
  }

  // S-D: per-contest exam-config — 400 unknown_contest / 403 contest_not_open
  // (the candidate app turns either into the access-code landing page). Person
  // contests serve their OWN snapshot fields.
  async function contestExamConfig(slug) {
    const contest = await resolveContest(slug, { requireOpen: true });
    const meta = await getContestRosterMeta(contest);
    return {
      contest_slug: contest.slug,
      contest_name: contest.name || contest.slug,
      identity_label: contest.identity_label || "Candidate ID",
      // The pinned candidate app forks its identity UX on this — always "person".
      identity_mode: contest.identity_mode || "person",
      start_at: contest.start_at || null,
      end_at: contest.end_at || null,
      server_now: new Date().toISOString(),
      roster_required: Boolean(meta),
      // The label-driven identity prompt (F9 §1.5): person contests label the
      // unique-id field from the CONTEST doc, never a roster column name.
      unique_id_label: contest.identity_label || "Candidate ID",
      rooms: normalizeRooms(contest.rooms),
      room_gate_enabled: Boolean(contest.room_gate_enabled),
      enforcement: enforcementConfigFor(contest),
      camera_recording: cameraRecordingConfigFor(contest)
    };
  }

  // ---- S-D: PUBLIC access-code resolver (vision §10.3) -------------------------
  // POST /api/access-code {code} -> {slug, name}. Per-IP fixed-window rate limit
  // (in-memory, single-instance — same documented limitation as the exec
  // limiter). Only FAILED attempts consume the budget: a successful resolve is
  // REFUNDED, because the typed code is built for weak campus labs that NAT a
  // whole hall through ONE egress IP (the IP-report cluster detection banks on
  // exactly that), so a synchronized hall typing the CORRECT code must never be
  // throttled. Anti-enumeration only needs failures capped — at 60 failures/min
  // the 34^6 (~1.5B) space still cannot be walked.
  const ACCESS_CODE_RATE_LIMIT = 60;
  const ACCESS_CODE_RATE_WINDOW_MS = 60_000;
  const ACCESS_CODE_RATE_MAP_LIMIT = 10_000;
  let _accessCodeClock = () => Date.now();
  function __setAccessCodeClockForTest(fn) {
    _accessCodeClock = fn || (() => Date.now());
  }
  const accessCodeAttempts = new Map(); // ip -> { count, windowStartMs }

  function checkAccessCodeRateLimit(ip) {
    const nowMs = _accessCodeClock();
    // Bounded memory: when the map grows past the cap, sweep expired windows
    // (an attacker rotating spoofed IPs cannot grow it unboundedly between sweeps).
    if (accessCodeAttempts.size >= ACCESS_CODE_RATE_MAP_LIMIT) {
      for (const [key, entry] of accessCodeAttempts) {
        if (nowMs - entry.windowStartMs >= ACCESS_CODE_RATE_WINDOW_MS) accessCodeAttempts.delete(key);
      }
    }
    let entry = accessCodeAttempts.get(ip);
    if (!entry || nowMs - entry.windowStartMs >= ACCESS_CODE_RATE_WINDOW_MS) {
      entry = { count: 0, windowStartMs: nowMs };
      accessCodeAttempts.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count > ACCESS_CODE_RATE_LIMIT) {
      throw rateLimited(Math.max(1, Math.ceil((entry.windowStartMs + ACCESS_CODE_RATE_WINDOW_MS - nowMs) / 1000)));
    }
    // Refund closure: a SUCCESSFUL resolve gives the attempt back, so the cap
    // only ever bites failures. Bound to THIS entry object — if the window
    // rolled over in between, decrementing the detached entry is harmless.
    return () => { if (entry.count > 0) entry.count -= 1; };
  }

  async function publicAccessCode(req) {
    const refundAttempt = checkAccessCodeRateLimit(getClientIp(req));
    const body = parseBody(req);
    const resolved = await resolveAccessCode(body?.code);
    refundAttempt(); // valid code — only failed attempts consume the budget
    return { ok: true, ...resolved };
  }

  // The ACTIVE-version roster entry for a unique id, or null. Entries from a
  // previous upload (stale roster_version) are invisible.
  async function findRosterEntry(meta, uniqueId) {
    const norm = normalizeUniqueId(uniqueId);
    if (!norm) return null;
    const doc = await getFirestore().collection(rosterCollection).doc(rosterEntryId(meta.version, norm)).get();
    const entry = doc.exists ? doc.data() : null;
    // Doc-id sanitization can COLLAPSE distinct normalized ids onto one doc id
    // ("2021#cs#001" and "2021$cs$001" both become "2021_cs_001"), so the fetched
    // entry must also carry the EXACT normalized id that was looked up.
    if (!entry || entry.roster_version !== meta.version || entry.unique_id_norm !== norm) return null;
    return entry;
  }

  // ---- M3: roster-lookup enumeration mitigation -------------------------------
  // /api/roster/lookup is PUBLIC and ID-enumerable (s2 design §7 accepted it as a
  // documented limitation). The product owner wants it mitigated now: a BEST-EFFORT per-IP
  // fixed-window rate limiter caps how fast one client can walk the id space, so a
  // scraper can no longer harvest the masked confirmation set (name/roll/masked
  // email) at machine speed.
  //
  // SHARED-NAT SAFETY (Wave-6 review fix). Roster lookup is the FIRST step EVERY
  // candidate performs (the unique-id-confirm login), and a campus lab NATs the
  // whole hall through ONE egress IP — exactly the property the IP-report cluster
  // detection banks on, and exactly the hazard the sibling access-code limiter
  // (above) was designed around. So this limiter MIRRORS that design instead of
  // charging every attempt:
  //   1. A SUCCESSFUL (found-id) lookup is REFUNDED — a legitimate candidate's
  //      single confirm never accrues budget, so a synchronized hall of 30-60+
  //      real logins behind one NAT IP is never throttled. Only 404 MISSES (the
  //      enumeration signal) consume the budget.
  //   2. The cap is hall-sized (matches the access-code limiter's 60/min for the
  //      same shared-IP population) with headroom, so even the brief pre-refund
  //      window of a concurrent-login burst on one instance's bucket stays clear.
  // Anti-enumeration is still achieved: one attacker walking the id space from one
  // IP sees mostly misses, and 60 misses/min cannot meaningfully harvest a roster.
  //
  // BEST-EFFORT, PER-INSTANCE: the counter lives in this process's memory. Cloud
  // Run runs MANY instances and does NOT share memory across them, so an attacker
  // whose requests fan out across instances gets a higher effective ceiling, and a
  // cold start resets the map. This is an acceptable mitigation that raises the
  // cost of bulk enumeration — NOT a global guarantee. A hard guarantee would need
  // a shared store (Firestore/Redis counter) or fronting WAF, which is out of
  // scope for this slice.
  const ROSTER_LOOKUP_RATE_LIMIT = 60;
  const ROSTER_LOOKUP_RATE_WINDOW_MS = 60_000;
  const ROSTER_LOOKUP_RATE_MAP_LIMIT = 10_000;
  let _rosterLookupClock = () => Date.now();
  function __setRosterLookupClockForTest(fn) {
    _rosterLookupClock = fn || (() => Date.now());
  }
  const rosterLookupAttempts = new Map(); // ip -> { count, windowStartMs }
  // Test seam: the limiter map is module-global (it survives across tests in a
  // suite). Clear it between tests so unrelated lookups don't accumulate toward
  // the cap. Production never calls this.
  function __resetRosterLookupRateLimitForTest() {
    rosterLookupAttempts.clear();
  }

  // Pure decision: record one attempt for `ip` and throw a 429 (rate_limited, with
  // a retry_after_seconds hint the api() catch forwards) once the per-window cap is
  // exceeded. Bounded memory: a full map is swept of expired windows before insert
  // so spoofed-IP rotation cannot grow it without bound.
  //
  // Returns a REFUND closure (mirrors checkAccessCodeRateLimit): the caller invokes
  // it on a SUCCESSFUL (found-id) lookup to give the attempt back, so a legitimate
  // candidate's single confirm never accrues budget and a NAT'd hall is never
  // throttled. Only 404 misses (the enumeration signal) end up consuming budget.
  function checkRosterLookupRateLimit(ip) {
    const nowMs = _rosterLookupClock();
    if (rosterLookupAttempts.size >= ROSTER_LOOKUP_RATE_MAP_LIMIT) {
      for (const [key, entry] of rosterLookupAttempts) {
        if (nowMs - entry.windowStartMs >= ROSTER_LOOKUP_RATE_WINDOW_MS) rosterLookupAttempts.delete(key);
      }
    }
    let entry = rosterLookupAttempts.get(ip);
    if (!entry || nowMs - entry.windowStartMs >= ROSTER_LOOKUP_RATE_WINDOW_MS) {
      entry = { count: 0, windowStartMs: nowMs };
      rosterLookupAttempts.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count > ROSTER_LOOKUP_RATE_LIMIT) {
      throw rateLimited(Math.max(1, Math.ceil((entry.windowStartMs + ROSTER_LOOKUP_RATE_WINDOW_MS - nowMs) / 1000)));
    }
    // Refund closure bound to THIS entry: a found-id lookup gives the attempt back.
    // If the window rolled over before the refund fires, decrementing the detached
    // entry is harmless.
    return () => { if (entry.count > 0) entry.count -= 1; };
  }

  // POST /api/roster/lookup — PUBLIC unique-ID-confirm login, step 1. Returns the
  // MINIMUM confirmation set: mapped name/roll/room/username + MASKED email.
  // Unmapped extra columns (phone numbers, ...) and the raw email NEVER leave via
  // this route — the raw email reaches the session doc only through the
  // server-side override at /api/session/start. Enumeration risk is MITIGATED by
  // the best-effort per-IP rate limit above (M3); see its comment for the
  // per-instance caveat.
  async function rosterLookup(req) {
    // M3: throttle BEFORE any roster read — a rejected caller learns nothing about
    // the roster (the 429 body is minimal: error + retry hint, no lookup fields).
    // A SUCCESSFUL (found-id) lookup is refunded below so a NAT'd hall of real
    // logins never accrues budget; only 404 misses (enumeration) consume it.
    const refundLookup = checkRosterLookupRateLimit(getClientIp(req));
    const body = parseBody(req);
    requireFields(body, ["unique_id"]);
    const meta = await getRosterMeta();
    if (!meta) throw httpError(404, "roster_not_configured");
    const entry = await findRosterEntry(meta, String(body.unique_id));
    if (!entry) throw httpError(404, "not_on_roster");
    refundLookup(); // a real candidate's confirm — only enumeration misses pay
    const mapping = meta.column_mapping || {};
    const field = (name) => (mapping[name] ? String(entry.fields?.[mapping[name]] || "") : "");
    return {
      found: true,
      unique_id: entry.unique_id,
      name: field("name"),
      roll_number: field("roll_number"),
      room: field("room"),
      hackerrank_username: field("hackerrank_username"),
      email_masked: maskEmail(field("email"))
    };
  }

  return {
    // route handlers — names match the dispatch table exactly so handler.mjs's
    // dispatch lines stay byte-identical (canaryIsolation). adminSaveRoster /
    // adminGetRoster are auth-first (routesAuthLint); the public routes are
    // candidate-facing (no admin auth), outside that rule.
    publicExamConfig,
    publicAccessCode,
    rosterLookup,
    adminGetRoster,
    adminSaveRoster,
    // shared roster helpers RETURNED for single-source reuse by resident code:
    // getRosterMeta (adminAttendance, B14) + findRosterEntry (resolvePersonRoster-
    // Identity / session start, B13). Never forked.
    getRosterMeta,
    findRosterEntry,
    // rate-limiter test seams RE-EXPORTED from handler.mjs so handler.mjs?<buster>
    // imports resolve (constraint #3).
    __setAccessCodeClockForTest,
    __setRosterLookupClockForTest,
    __resetRosterLookupRateLimitForTest,
    checkRosterLookupRateLimit
  };
}
