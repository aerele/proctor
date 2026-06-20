// backend/src/routes/review.mjs — the pen-and-paper review cluster as a FACTORY
// (decomp B11, plan §A2/§A8). makeReviewRoutes(ctx) closes over the handler-built
// ctx (per ?buster instance) and returns the six admin review routes + the cluster
// helpers that resident handler.mjs code still needs (single source, by reference).
//
// Routes (all auth-first with requireAdmin — routesAuthLint pins this):
//   adminSetReviewRoster   POST /api/admin/review-roster   — replace the roster
//   adminGetReviewRoster   GET  /api/admin/review-roster   — roster + summary
//   adminReviewNext        POST /api/admin/review-next     — claim next username
//   adminReviewVerdict     POST /api/admin/review-verdict  — record + release
//   adminReviewMine        GET  /api/admin/review-mine     — this reviewer's set
//   adminReviews           GET  /api/admin/reviews         — all records (CSV src)
//
// Self-contained cluster: its own REVIEW_STATE / REVIEW / REVIEW_CLAIMS
// collections, its own roster/claim/ranking helpers. None of its reads is a raw
// contest_slug equality filter (review docs carry a contest_slug FIELD matched in
// memory via inReviewScope, not a Firestore .where), so scopingLint's allowlist
// stays {handler.mjs: 4}.
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as the other route domains: review tests import the handler
// with a ?buster and swap the fake Firestore via __setClientsForTest —
// getFirestore is therefore taken as a GETTER so the swap propagates (the live
// handle is never captured by value).
//
// RETURNED helpers (kept SINGLE-SOURCE, consumed by reference downstream — moving
// them without returning them would orphan resident callers or fork a helper):
//   getAllReviews        — also threaded into makeResultsRoutes ctx (Results-tab
//                          integrity column) → this factory MUST be instantiated
//                          BEFORE makeResultsRoutes.
//   reviewRecordId,
//   reviewerKeyFor,
//   reviewContestSlugOf,
//   getActiveClaims      — all also used by the resident dataLifecycle purge
//                          gatherer (gatherContestDatasets) → passed by reference.
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*). Nothing is imported here — every dependency (the live
// Firestore getter, the auth guard, the http transport helpers, the contest
// resolver + username normalizer + already-exists predicate, and the env-captured
// review collection names / ids / caps / claim TTL BY VALUE) arrives through ctx,
// so the env-capture-at-load semantics stay in handler.mjs (env-lint).

export function makeReviewRoutes(ctx) {
  const {
    getFirestore,
    requireAdmin,
    parseBody,
    requireFields,
    badRequest,
    // resident helpers (by reference)
    resolveContest,
    normalizeUsername,
    isAlreadyExists,
    // env-captured review collection names / ids / caps / TTL (by value)
    reviewStateCollection,
    reviewRosterId,
    reviewCollection,
    reviewClaimsCollection,
    reviewsQueryLimit,
    reviewRosterLimit,
    claimTtlMs
  } = ctx;

  // S-C (F9 D17): per-contest review state for NEW data — ids gain a ::{slug}
  // suffix (roster doc: roster::{slug}); SLUGLESS ids stay the legacy set and
  // keep working untouched. contestSlug = "" everywhere means "the legacy set".
  function reviewRosterRef(contestSlug = "") {
    return getFirestore().collection(reviewStateCollection)
      .doc(contestSlug ? `${reviewRosterId}::${contestSlug}` : reviewRosterId);
  }

  function reviewRecordId(usernameNorm, reviewerKey, contestSlug = "") {
    const base = `${usernameNorm}::${reviewerKey}`;
    return contestSlug ? `${base}::${contestSlug}` : base;
  }

  function reviewRecordRef(usernameNorm, reviewerKey, contestSlug = "") {
    return getFirestore().collection(reviewCollection).doc(reviewRecordId(usernameNorm, reviewerKey, contestSlug));
  }

  function reviewClaimRef(usernameNorm, contestSlug = "") {
    return getFirestore().collection(reviewClaimsCollection)
      .doc(contestSlug ? `${usernameNorm}::${contestSlug}` : usernameNorm);
  }

  // Resolve the optional review-scope contest param: absent → "" (the slugless
  // set — docs with no contest_slug field); a real contest → its slug; unknown →
  // 400 (typo safety).
  async function reviewContestSlugOf(param) {
    if (param === undefined || param === null || String(param).trim() === "") return "";
    const contest = await resolveContest(String(param).trim(), { requireOpen: false });
    return contest.slug;
  }

  // A review/claim doc belongs to scope `contestSlug` when its contest_slug field
  // matches ("" matches docs WITHOUT the field — the slugless set). New scoped
  // writes always stamp the field; old docs never get rewritten.
  function inReviewScope(doc, contestSlug) {
    return String(doc?.contest_slug || "") === contestSlug;
  }

  // A reviewer name is normalized to a key the same way usernames are (lowercased,
  // path-safe) so `${username_norm}::${reviewerKey}` is a stable, idempotent doc id
  // and review-mine/claim-owner comparisons are case-insensitive.
  function reviewerKeyFor(reviewerName) {
    return normalizeUsername(reviewerName);
  }

  // Normalize an operator-supplied roster: trim each entry, drop blanks, and
  // de-dupe by username_norm while KEEPING the first-seen original display form
  // and the roster ORDER. Returns [{ username, username_norm }] in roster order.
  function normalizeRoster(usernames) {
    const out = [];
    const seen = new Set();
    for (const raw of usernames) {
      if (raw === undefined || raw === null) continue;
      const display = String(raw).trim();
      if (!display) continue;
      const norm = normalizeUsername(display);
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push({ username: display, username_norm: norm });
    }
    return out;
  }

  // POST /api/admin/review-roster — replace the roster wholesale.
  async function adminSetReviewRoster(req) {
    requireAdmin(req);
    const body = parseBody(req);
    const contestSlug = await reviewContestSlugOf(body.contest);
    if (!Array.isArray(body.usernames)) return badRequest("usernames must be an array");
    if (body.usernames.length > reviewRosterLimit) {
      return badRequest(`Too many usernames in one request (max ${reviewRosterLimit})`);
    }
    const entries = normalizeRoster(body.usernames);
    const now = new Date().toISOString();
    // .set() (no merge) REPLACES the roster — a removed username is gone, matching
    // "replace the roster" rather than "append".
    await reviewRosterRef(contestSlug).set({
      entries,
      updated_at: now,
      ...(contestSlug ? { contest_slug: contestSlug } : {})
    });
    return { ok: true, count: entries.length };
  }

  // Read the persisted roster as [{ username, username_norm }] in roster order.
  async function getReviewRoster(contestSlug = "") {
    const doc = await reviewRosterRef(contestSlug).get();
    if (!doc.exists) return [];
    const entries = doc.data()?.entries;
    return Array.isArray(entries) ? entries : [];
  }

  // All review records IN SCOPE (S-C: contest slug or the legacy slugless set).
  // Capped so a pathological collection can't bloat a request.
  async function getAllReviews(contestSlug = "") {
    const snapshot = await getFirestore().collection(reviewCollection).limit(reviewsQueryLimit).get();
    return snapshot.docs.map((doc) => doc.data()).filter((review) => inReviewScope(review, contestSlug));
  }

  // Index reviews by username_norm → { records:[...] }. Each record is one
  // reviewer's verdict for that username.
  function indexReviewsByUsername(reviews) {
    const byUsername = new Map();
    for (const review of reviews) {
      const norm = review?.username_norm;
      if (!norm) continue;
      if (!byUsername.has(norm)) byUsername.set(norm, []);
      byUsername.get(norm).push(review);
    }
    return byUsername;
  }

  async function adminGetReviewRoster(req) {
    requireAdmin(req);
    const contestSlug = await reviewContestSlugOf(req.query?.contest);
    const roster = await getReviewRoster(contestSlug);
    const reviews = await getAllReviews(contestSlug);
    const claims = await getActiveClaims(contestSlug);

    const byUsername = indexReviewsByUsername(reviews);
    let with0 = 0;
    let with1 = 0;
    let with2plus = 0;
    for (const entry of roster) {
      const count = (byUsername.get(entry.username_norm) || []).length;
      if (count === 0) with0 += 1;
      else if (count === 1) with1 += 1;
      else with2plus += 1;
    }

    // active_claims counts only NON-expired claims that point at a roster username
    // (a stale claim is logically free; a claim for a since-removed username is not
    // part of this roster's working set).
    const rosterNorms = new Set(roster.map((entry) => entry.username_norm));
    const activeClaims = claims.filter((claim) => rosterNorms.has(claim.username_norm)).length;

    return {
      usernames: roster.map((entry) => entry.username),
      total: roster.length,
      with_0_reviews: with0,
      with_1_review: with1,
      with_2plus_reviews: with2plus,
      active_claims: activeClaims
    };
  }

  // A claim is ACTIVE (blocks a different reviewer) when its claimed_at is newer
  // than CLAIM_TTL_MS ago. An unparseable/missing claimed_at is treated as stale
  // (free) so a malformed claim can never permanently wedge a username.
  function isClaimActive(claim, nowMs) {
    if (!claim) return false;
    const claimedMs = claim.claimed_at ? Date.parse(claim.claimed_at) : NaN;
    if (!Number.isFinite(claimedMs)) return false;
    return nowMs - claimedMs < claimTtlMs;
  }

  // Every currently-active (non-expired) claim IN SCOPE.
  async function getActiveClaims(contestSlug = "") {
    const snapshot = await getFirestore().collection(reviewClaimsCollection).limit(reviewRosterLimit).get();
    const nowMs = Date.now();
    return snapshot.docs.map((doc) => doc.data())
      .filter((claim) => inReviewScope(claim, contestSlug))
      .filter((claim) => isClaimActive(claim, nowMs));
  }

  // POST /api/admin/review-next — serve reviewer R the next student to review by
  // PRIORITY, claiming it atomically so two reviewers never get the same username.
  //
  // candidates = roster usernames U where R has NOT already reviewed U AND U is not
  // currently claimed by a DIFFERENT reviewer with a non-expired claim. For each U,
  // r(U) = total completed reviews, pos(U) = count of verdict==1 reviews. Buckets,
  // lowest first:
  //   0: r == 0                      (every student gets at least 1 review)
  //   1: r == 1 AND pos == 1         (positively-reviewed students reach 2)
  //   2: r == 1 AND pos == 0         (negatively-reviewed students reach 2)
  //   3: r >= 2                      (all at 2 → keep reviewing the TOP candidates)
  // Within 0/1/2 by roster order; bucket 3 by pos DESC, tiebreak r ASC, then roster
  // order. We claim the top candidate atomically; if another reviewer won the race
  // we retry with the next candidate. {username} | {done:true}.
  async function adminReviewNext(req) {
    requireAdmin(req);
    const body = parseBody(req);
    requireFields(body, ["reviewer_name"]);
    const contestSlug = await reviewContestSlugOf(body.contest);
    const reviewerName = String(body.reviewer_name).trim();
    if (!reviewerName) return badRequest("reviewer_name is required");
    const reviewerKey = reviewerKeyFor(reviewerName);

    const roster = await getReviewRoster(contestSlug);
    if (!roster.length) return { done: true };

    const reviews = await getAllReviews(contestSlug);
    const byUsername = indexReviewsByUsername(reviews);
    const claimsByNorm = await loadClaimsByNorm(contestSlug);

    const candidates = rankReviewCandidates(roster, byUsername, reviewerKey, Date.now(), claimsByNorm);

    // Walk candidates best-first; the first one we can atomically claim wins. A
    // lost claim race falls through to the next candidate.
    for (const candidate of candidates) {
      const claimed = await claimReviewUsername(candidate.username_norm, reviewerName, contestSlug);
      if (claimed) return { username: candidate.username };
    }
    return { done: true };
  }

  // Load every IN-SCOPE claim doc keyed by username_norm (raw, including stale
  // ones) so the ranking pass can decide claimable-ness with a single read. Stale
  // claims are filtered in rankReviewCandidates so they don't exclude a username.
  async function loadClaimsByNorm(contestSlug = "") {
    const snapshot = await getFirestore().collection(reviewClaimsCollection).limit(reviewRosterLimit).get();
    const byNorm = new Map();
    for (const doc of snapshot.docs) {
      const claim = doc.data();
      if (claim?.username_norm && inReviewScope(claim, contestSlug)) byNorm.set(claim.username_norm, claim);
    }
    return byNorm;
  }

  // Pure ranking: produce the ordered candidate list for reviewer `reviewerKey`.
  // Exported-ish for the unit tests via the priority behavior; kept pure (no I/O)
  // so the bucket logic is deterministic and testable.
  function rankReviewCandidates(roster, byUsername, reviewerKey, nowMs, claimsByNorm) {
    const candidates = [];
    roster.forEach((entry, rosterIndex) => {
      const records = byUsername.get(entry.username_norm) || [];
      // Skip a username this reviewer already reviewed (idempotent: a reviewer
      // reviews a username at most once, so they're never re-served it).
      const alreadyMine = records.some((rec) => reviewerKeyFor(rec.reviewer_name) === reviewerKey);
      if (alreadyMine) return;

      // Skip a username actively claimed by a DIFFERENT reviewer. A claim by THIS
      // reviewer (e.g. a re-pull after a crash) does not exclude — they may re-take
      // it. A stale claim is ignored entirely.
      const claim = claimsByNorm.get(entry.username_norm);
      if (claim && isClaimActive(claim, nowMs) && reviewerKeyFor(claim.reviewer_name) !== reviewerKey) {
        return;
      }

      const r = records.length;
      const pos = records.filter((rec) => Number(rec.verdict) === 1).length;
      let bucket;
      if (r === 0) bucket = 0;
      else if (r === 1 && pos === 1) bucket = 1;
      else if (r === 1 && pos === 0) bucket = 2;
      else bucket = 3;

      candidates.push({ username: entry.username, username_norm: entry.username_norm, rosterIndex, r, pos, bucket });
    });

    candidates.sort((a, b) => {
      if (a.bucket !== b.bucket) return a.bucket - b.bucket; // lowest bucket first
      if (a.bucket === 3) {
        // TOP candidates first: highest positive-score, then fewest reviews, then
        // roster order.
        if (a.pos !== b.pos) return b.pos - a.pos;
        if (a.r !== b.r) return a.r - b.r;
      }
      return a.rosterIndex - b.rosterIndex; // buckets 0/1/2 (and final tiebreak) by roster order
    });

    return candidates;
  }

  // Atomically claim `usernameNorm` for `reviewerName`, mirroring the live-slot
  // lock pattern (acquireLiveSlot): the claim doc id is the username_norm, so two
  // concurrent review-next calls contend on the SAME doc. `.create()` is atomic —
  // exactly one concurrent writer wins. On an ALREADY_EXISTS collision we read the
  // existing claim:
  //   - active claim held by ANOTHER reviewer  → lost the race → return false (the
  //                                              caller tries the next candidate).
  //   - active claim already held by US         → idempotent re-claim → refresh +
  //                                              return true.
  //   - stale/expired claim                      → take it over (.set) → true.
  // Returns true on a successful claim, false when another reviewer holds it live.
  async function claimReviewUsername(usernameNorm, reviewerName, contestSlug = "") {
    const ref = reviewClaimRef(usernameNorm, contestSlug);
    const now = new Date().toISOString();
    const claimBody = {
      username_norm: usernameNorm, reviewer_name: reviewerName, claimed_at: now,
      ...(contestSlug ? { contest_slug: contestSlug } : {})
    };

    try {
      await ref.create(claimBody);
      return true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    // The doc exists — re-read it INSIDE the contention path (it may be a stale
    // claim, our own claim, or a live claim by someone else).
    const doc = await ref.get();
    const existing = doc.exists ? doc.data() : null;
    const nowMs = Date.now();

    if (!existing || !isClaimActive(existing, nowMs)) {
      // Absent (raced-away) or expired → take it over.
      await ref.set(claimBody);
      return true;
    }
    if (reviewerKeyFor(existing.reviewer_name) === reviewerKeyFor(reviewerName)) {
      // We already hold it — refresh the timestamp and keep serving it to us.
      await ref.set(claimBody);
      return true;
    }
    // Held live by a different reviewer — lost the race.
    return false;
  }

  // POST /api/admin/review-verdict — record reviewer R's binary verdict for a
  // roster username, then release (delete) that username's claim. Idempotent: a
  // re-verdict overwrites the same (username, reviewer) doc; created_at is set only
  // on the first write.
  async function adminReviewVerdict(req) {
    requireAdmin(req);
    const body = parseBody(req);
    requireFields(body, ["username", "reviewer_name"]);
    if (body.verdict === undefined || body.verdict === null) return badRequest("verdict is required");
    const reviewerName = String(body.reviewer_name).trim();
    if (!reviewerName) return badRequest("reviewer_name is required");

    const verdict = Number(body.verdict);
    if (verdict !== 0 && verdict !== 1) return badRequest("verdict must be 0 or 1");

    const contestSlug = await reviewContestSlugOf(body.contest);
    const usernameNorm = normalizeUsername(body.username);
    // Roster-only: a verdict may only be recorded for a username currently on the
    // roster, so a typo / stale username can't create an orphan review record.
    const roster = await getReviewRoster(contestSlug);
    const rosterEntry = roster.find((entry) => entry.username_norm === usernameNorm);
    if (!rosterEntry) return badRequest("username is not on the review roster");

    const reviewerKey = reviewerKeyFor(reviewerName);
    const ref = reviewRecordRef(usernameNorm, reviewerKey, contestSlug);
    const now = new Date().toISOString();

    // Preserve created_at on the first write; a re-verdict only bumps updated_at +
    // verdict. We store the roster's display form for the username + the reviewer's
    // supplied display name.
    const existing = await ref.get();
    const createdAt = existing.exists ? (existing.data()?.created_at || now) : now;
    await ref.set({
      username: rosterEntry.username,
      username_norm: usernameNorm,
      reviewer_name: reviewerName,
      verdict,
      created_at: createdAt,
      updated_at: now,
      ...(contestSlug ? { contest_slug: contestSlug } : {})
    });

    // Release the claim so the username is immediately free for the next reviewer.
    // Best-effort + idempotent (delete of a missing doc is a no-op).
    await reviewClaimRef(usernameNorm, contestSlug).delete();

    return { ok: true };
  }

  // GET /api/admin/review-mine?reviewer_name=X — every review this reviewer
  // completed, newest first.
  async function adminReviewMine(req) {
    requireAdmin(req);
    const reviewerName = req.query?.reviewer_name;
    if (reviewerName === undefined || reviewerName === null || String(reviewerName).trim() === "") {
      return badRequest("reviewer_name is required");
    }
    const contestSlug = await reviewContestSlugOf(req.query?.contest);
    const reviewerKey = reviewerKeyFor(reviewerName);
    const reviews = (await getAllReviews(contestSlug))
      .filter((review) => reviewerKeyFor(review.reviewer_name) === reviewerKey)
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));

    return {
      count: reviews.length,
      reviews: reviews.map((review) => ({
        username: review.username,
        verdict: Number(review.verdict),
        created_at: review.created_at || ""
      }))
    };
  }

  // GET /api/admin/reviews?username=<optional> — ALL review records (multiple rows
  // per username allowed), used to build the CSV username,reviewer_name,verdict.
  async function adminReviews(req) {
    requireAdmin(req);
    const usernameFilter = req.query?.username;
    const contestSlug = await reviewContestSlugOf(req.query?.contest);
    let reviews = await getAllReviews(contestSlug);
    if (usernameFilter !== undefined && usernameFilter !== null && String(usernameFilter).trim() !== "") {
      const norm = normalizeUsername(usernameFilter);
      reviews = reviews.filter((review) => review.username_norm === norm);
    }
    reviews.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return {
      reviews: reviews.map((review) => ({
        username: review.username,
        reviewer_name: review.reviewer_name,
        verdict: Number(review.verdict),
        created_at: review.created_at || ""
      }))
    };
  }

  return {
    // route handlers — names match the dispatch table exactly so handler.mjs's
    // dispatch lines stay byte-identical (canaryIsolation). All auth-first
    // (routesAuthLint).
    adminSetReviewRoster,
    adminGetReviewRoster,
    adminReviewNext,
    adminReviewVerdict,
    adminReviewMine,
    adminReviews,
    // cluster helpers RETURNED for single-source reuse by resident handler.mjs
    // code (the Results-tab integrity column via makeResultsRoutes ctx, and the
    // dataLifecycle purge gatherer + purge roster-doc delete). Never forked.
    getAllReviews,
    reviewRecordId,
    reviewerKeyFor,
    reviewContestSlugOf,
    getActiveClaims,
    reviewRosterRef
  };
}
