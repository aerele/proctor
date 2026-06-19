// backend/src/evaluation.mjs — the candidate-evaluation ORCHESTRATOR (P1).
//
// Two layers:
//   1. PURE wrappers (evaluateCandidate / crossCandidatePass) re-exported for the
//      local analysis driver + tests — they touch no I/O and just compose the
//      pure metric modules.
//   2. makeEvaluation(ctx) — the I/O layer. It gathers session/submission docs
//      via the ctx.scopedQuery chokepoint (NO raw contest_slug filters — that is
//      the scopingLint contract), pulls editor/shell/clipboard evidence from GCS
//      with the SAME list+download+skip-malformed pattern as adminSessionEvents,
//      runs the pure modules per identity, writes one scorecard doc per
//      contest×identity, and (when the cursor reaches the end of the identity
//      universe) runs the cross-candidate pass + writes the contest meta doc.
//
// Contract: /tmp/eval-contract.md §evaluation.mjs + §routes + plan §2.1.
//
// Identity keying (mixed keying is THE acceptance case): an evaluation identity
// is the person_id when an enrollment/submission carries one, else the bare
// username_norm (anonymous/unmatched sessions). identityKeyOf() unifies both.

import {
  EVALUATOR_VERSION,
  buildScorecard,
  crossCandidateAnalysis,
  applyCrossPatches,
  identityKeyOf,
} from "./evaluationMetrics.mjs";
import { collapseWs } from "./evaluationReplay.mjs";
import { makeHardness } from "./evaluationClone.mjs";

// The meta doc id prefix — held out of the `evaluations` list by listEvaluations.
const META_ID_PREFIX = "__meta::";
// The per-contest job/status doc id prefix — mirrors META_ID_PREFIX. Holds the
// run progress {status,total,processed,cursor,run_id,started_at,updated_at} so
// the frontend can drive a "X / total" progress bar + resume from the SERVER
// cursor, and so a concurrent POST is locked out (idempotency lease). Also held
// out of the evaluations list (jobDocId has no schema_version/identity_key).
const JOB_ID_PREFIX = "__job::";
function jobDocId(slug) {
  return `${JOB_ID_PREFIX}${slug}`;
}

// ---------------------------------------------------------------------------
// PURE wrappers
// ---------------------------------------------------------------------------

// Pure per-candidate assembly. The local analysis driver imports THIS so it can
// reuse the exact orchestrator entry point without the I/O layer.
export function evaluateCandidate(input) {
  return buildScorecard(input);
}

// Pure cross-candidate pass: run the analysis, apply each patch to its
// candidate's scorecard, and return the meta doc + the patched scorecards.
// `candidates` carry { identityKey, scorecard, submissions, pastes, finalContents,
// room, ips, cross_inputs }; `problems` is [{ problem_id }].
export function crossCandidatePass(candidates, problems) {
  const { meta, patches } = crossCandidateAnalysis({ candidates, problems });
  const scorecards = candidates.map((c) =>
    applyCrossPatches(c.scorecard, patches.get(c.identityKey))
  );
  return { meta, scorecards };
}

// ---------------------------------------------------------------------------
// makeEvaluation(ctx) — the I/O layer
// ---------------------------------------------------------------------------
export function makeEvaluation(ctx) {
  const {
    getFirestore,
    bucket,
    scopedQuery,
    resolveContest,
    contestProblemEntries,
    getProblem,
    listEnrollments,
    collections = {},
    editorEventsLabel = "editor-events",
    evaluateBatchLimit = 25,
    sessionsQueryLimit = 6000,
    submissionsQueryLimit = 120000,
    gcsConcurrency = 8,
    // Orchestration knobs (eval-batch-progress-idempotent). evalTimeBudgetMs caps
    // a single HTTP batch's per-identity loop so it returns well under the Cloud
    // Run 120s request timeout; evalLeaseMs is the idempotency-lock heartbeat
    // window; nowMs is the injectable epoch-ms clock (handler's __setEvalClock
    // seam) — defaults to the real clock so production needs no wiring.
    evalTimeBudgetMs = 90000,
    evalLeaseMs = 180000,
    nowMs = () => Date.now(),
  } = ctx;

  const evaluationsCollection = collections.evaluations;
  const submissionsCollection = collections.submissions;
  const sessionsCollection = collections.sessions;

  function evaluationsCol() {
    return getFirestore().collection(evaluationsCollection);
  }

  // ---- GCS NDJSON/JSONL gather (adminSessionEvents pattern: list → download →
  // split lines → JSON.parse, skipping malformed lines / unreadable objects). A
  // missing prefix lists empty, never throws.
  async function gatherJsonLines(prefix) {
    let files = [];
    try {
      const [listed] = await bucket().getFiles({ prefix, maxResults: 1000 });
      files = listed || [];
    } catch {
      return [];
    }
    const out = [];
    // Bounded concurrency over the listed files (small batches; sequential
    // within a batch). Each file: download, split, parse, skip malformed.
    for (let i = 0; i < files.length; i += gcsConcurrency) {
      const batch = files.slice(i, i + gcsConcurrency);
      const results = await Promise.all(
        batch.map(async (file) => {
          try {
            const [contents] = await file.download();
            const records = [];
            for (const line of String(contents).split("\n")) {
              if (!line.trim()) continue;
              try {
                const rec = JSON.parse(line);
                if (rec && typeof rec === "object") records.push(rec);
              } catch {
                // malformed line — skip, never fatal
              }
            }
            return records;
          } catch {
            return [];
          }
        })
      );
      for (const r of results) out.push(...r);
    }
    return out;
  }

  // All editor / shell / clipboard evidence for one session, sorted by ts.
  async function gatherSessionEvidence(session) {
    const prefix = String(session.storage_prefix || "");
    if (!prefix) return { editorEvents: [], shellEvents: [], clipboardEntries: [] };
    const [editorRaw, shellRaw, clipboardRaw] = await Promise.all([
      gatherJsonLines(`${prefix}${editorEventsLabel}/`),
      gatherJsonLines(`${prefix}events/`),
      gatherJsonLines(`${prefix}review/clipboard.jsonl`),
    ]);
    const clipboardEntries = [];
    for (const rec of clipboardRaw) {
      const text = typeof rec === "string" ? rec : rec && (rec.text || rec.content || rec.clipboard);
      if (typeof text === "string" && text) clipboardEntries.push(text);
    }
    return { editorEvents: editorRaw, shellEvents: shellRaw, clipboardEntries };
  }

  // ---- per-contest problem context (points / stubs / hardness) --------------
  // problemPoints: effective entry points (entry.points ?? problem.points ?? 100);
  // stubsByProblem: Object.values(problem.stubs || {}); maxTotal = Σ points.
  // hardness: makeHardness over accepted-distinct-identity counts per problem.
  async function buildProblemContext(contest, submissions) {
    const entries = contestProblemEntries(contest);
    const problemPoints = {};
    const stubsByProblem = {};
    let maxTotal = 0;
    const problemList = [];
    for (const entry of entries) {
      const pid = entry.problem_id;
      const problem = await getProblem(pid).catch(() => null);
      const points = entry.points != null
        ? entry.points
        : (problem && problem.points != null ? problem.points : 100);
      problemPoints[pid] = points;
      maxTotal += Number(points) || 0;
      stubsByProblem[pid] = problem && problem.stubs ? Object.values(problem.stubs) : [];
      problemList.push({ problem_id: pid });
    }
    // accepted-distinct-identity counts per problem → hardness buckets.
    const acceptedIdentitiesByProblem = new Map();
    for (const s of submissions) {
      if (s.verdict !== "accepted") continue;
      const key = identityKeyOf(s);
      if (!key) continue;
      if (!acceptedIdentitiesByProblem.has(s.problem_id)) {
        acceptedIdentitiesByProblem.set(s.problem_id, new Set());
      }
      acceptedIdentitiesByProblem.get(s.problem_id).add(key);
    }
    const challengeSet = new Set(problemList.map((p) => p.problem_id));
    const challenges = problemList.map((p) => ({
      slug: p.problem_id,
      solved: (acceptedIdentitiesByProblem.get(p.problem_id) || new Set()).size,
    }));
    // problems referenced only in submissions still need a hardness entry.
    for (const [pid, ids] of acceptedIdentitiesByProblem) {
      if (!challengeSet.has(pid)) {
        challenges.push({ slug: pid, solved: ids.size });
        challengeSet.add(pid);
        problemList.push({ problem_id: pid });
      }
    }
    const hardness = makeHardness(challenges);
    return { problemPoints, stubsByProblem, maxTotal, hardness, problemList };
  }

  // ---- identity universe ----------------------------------------------------
  // active enrollments' person_ids ∪ submission identity keys not already
  // covered; sorted by identityKey (cursor = last processed key).
  function buildIdentityUniverse(enrollments, submissions) {
    const map = new Map(); // identityKey → { person_id, username_norm, candidate_id, name }
    for (const e of enrollments) {
      if (String(e.status || "active") === "removed") continue;
      const pid = String(e.person_id || "");
      if (!pid) continue;
      if (!map.has(pid)) {
        map.set(pid, { person_id: pid, username_norm: null, candidate_id: null, name: null });
      }
    }
    for (const s of submissions) {
      const key = identityKeyOf(s);
      if (!key) continue;
      if (!map.has(key)) {
        map.set(key, {
          person_id: s.person_id != null ? s.person_id : null,
          username_norm: s.username_norm || null,
          candidate_id: s.candidate_id || null,
          name: null,
        });
      }
    }
    return [...map.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([key, identity]) => ({ key, identity }));
  }

  // Idempotency skip: an existing scorecard with the same evaluator_version AND
  // the same sorted session_ids AND the same submissions_n → skip (unless force).
  function isUpToDate(existing, sessionIds, submissionsN) {
    if (!existing) return false;
    if (String(existing.evaluator_version || "") !== EVALUATOR_VERSION) return false;
    const prev = Array.isArray(existing.session_ids) ? existing.session_ids.slice().sort() : [];
    const cur = sessionIds.slice().sort();
    if (prev.length !== cur.length) return false;
    for (let i = 0; i < prev.length; i++) if (prev[i] !== cur[i]) return false;
    const prevN = existing.coverage && Number.isFinite(existing.coverage.submissions_n)
      ? existing.coverage.submissions_n
      : null;
    return prevN === submissionsN;
  }

  function scorecardDocId(slug, identityKey) {
    return `${slug}::${identityKey}`;
  }

  // ---- job/status doc helpers ----------------------------------------------
  // The `__job::{slug}` doc tracks one run's progress + holds the idempotency
  // lease. updated_at_ms is the heartbeat the lock compares against the lease
  // window (numeric so the injected clock drives it deterministically); the ISO
  // timestamps are for human/UI display.
  async function readJob(slug) {
    const snap = await evaluationsCol().doc(jobDocId(slug)).get();
    return snap.exists ? snap.data() : null;
  }
  async function writeJob(slug, patch) {
    await evaluationsCol().doc(jobDocId(slug)).set(patch, { merge: true });
  }

  // The lock: a FRESH POST (no cursor — a brand-new "Run evaluation" click) is
  // rejected with 409 when a run is already `running` AND its heartbeat is within
  // the lease window. A cursor-carrying call is the SAME run resuming (the
  // frontend loop), so it never self-conflicts. A stale lease (heartbeat older
  // than evalLeaseMs) is reclaimable, so a crashed run never wedges the button.
  function isFreshLease(job, now) {
    if (!job || job.status !== "running") return false;
    const hb = Number.isFinite(job.updated_at_ms) ? job.updated_at_ms : Date.parse(job.updated_at || "");
    if (!Number.isFinite(hb)) return false;
    return now - hb < evalLeaseMs;
  }

  // ---- THE batch evaluator --------------------------------------------------
  async function evaluateContestBatch({ contestSlug, limit, cursor, force } = {}) {
    const contest = await resolveContest(String(contestSlug || "").trim(), { requireOpen: false });
    const slug = contest.legacy_empty_slug ? "" : contest.slug;
    const batchLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.floor(Number(limit))
      : evaluateBatchLimit;

    const cursorKey = cursor != null && cursor !== "" ? String(cursor) : null;

    // Idempotency lock (C): a FRESH start (no cursor) yields to a live run.
    const lockNow = nowMs();
    const existingJob = await readJob(slug);
    if (cursorKey == null && isFreshLease(existingJob, lockNow)) {
      const err = new Error("eval_in_progress");
      err.statusCode = 409;
      err.payload = {
        processed: Number(existingJob.processed) || 0,
        total: Number(existingJob.total) || 0,
      };
      throw err;
    }
    // Claim/refresh the lease. A fresh start mints a new run_id; a resume keeps
    // the in-flight one (or mints one if the doc was lost mid-run).
    const runId = cursorKey == null
      ? `run-${lockNow}-${Math.random().toString(36).slice(2, 8)}`
      : ((existingJob && existingJob.run_id) || `run-${lockNow}-${Math.random().toString(36).slice(2, 8)}`);

    // ONE submissions scan + ONE sessions scan + ONE enrollment scan, all scoped.
    const [submissionsSnap, sessionsSnap, enrollments] = await Promise.all([
      scopedQuery(getFirestore().collection(submissionsCollection), contest)
        .limit(submissionsQueryLimit)
        .get(),
      scopedQuery(getFirestore().collection(sessionsCollection), contest)
        .limit(sessionsQueryLimit)
        .get(),
      listEnrollments(contest),
    ]);
    const submissions = submissionsSnap.docs.map((d) => d.data());
    const sessions = sessionsSnap.docs.map((d) => d.data());

    const { problemPoints, stubsByProblem, maxTotal, hardness, problemList } =
      await buildProblemContext(contest, submissions);

    // Group sessions + submissions by identity key.
    const sessionsByKey = new Map();
    for (const s of sessions) {
      const key = identityKeyOf(s);
      if (!key) continue;
      if (!sessionsByKey.has(key)) sessionsByKey.set(key, []);
      sessionsByKey.get(key).push(s);
    }
    const submissionsByKey = new Map();
    for (const s of submissions) {
      const key = identityKeyOf(s);
      if (!key) continue;
      if (!submissionsByKey.has(key)) submissionsByKey.set(key, []);
      submissionsByKey.get(key).push(s);
    }

    const universe = buildIdentityUniverse(enrollments, submissions);
    const total = universe.length;
    // processed-so-far across prior chunks = universe identities at/before the
    // resume cursor (monotonic; reaches total when done).
    const processedBefore = cursorKey == null
      ? 0
      : universe.filter((u) => u.key <= cursorKey).length;

    // Resume from the cursor: process keys strictly greater than it.
    const pending = cursorKey == null
      ? universe
      : universe.filter((u) => u.key > cursorKey);

    // Claim/heartbeat the job doc for THIS chunk's start (status running).
    const startedAtIso = (existingJob && cursorKey != null && existingJob.started_at)
      ? existingJob.started_at
      : new Date(nowMs()).toISOString();
    await writeJob(slug, {
      status: "running", total, processed: processedBefore, cursor: cursorKey || "",
      run_id: runId, started_at: startedAtIso,
      updated_at: new Date(nowMs()).toISOString(), updated_at_ms: nowMs(),
    });

    const slice = pending.slice(0, batchLimit);
    let evaluated = 0;
    let skipped = 0;
    let lastKey = cursorKey;
    let budgetBroke = false;
    // A. per-batch wall-clock budget: break early (return cursor, done:false) once
    // elapsed exceeds evalTimeBudgetMs, so this HTTP request returns well under the
    // Cloud Run 120s timeout regardless of one heavy candidate's GCS gather.
    const batchStartMs = nowMs();

    for (const { key, identity } of slice) {
      // Budget check BEFORE starting the next identity's heavy GCS gather — but
      // only after at least one identity has been handled this chunk, so a single
      // heavy candidate always makes forward progress (no zero-progress wedge).
      // The work already done is preserved (its scorecards are written) and the
      // returned cursor points at the last COMPLETED identity.
      if (evaluated + skipped > 0 && nowMs() - batchStartMs > evalTimeBudgetMs) {
        budgetBroke = true;
        break;
      }
      lastKey = key;
      const idSessions = sessionsByKey.get(key) || [];
      const idSubs = (submissionsByKey.get(key) || [])
        .slice()
        .sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0));
      const sessionIds = idSessions.map((s) => s.session_id).filter(Boolean);

      // Idempotency: read the existing scorecard once.
      const existingDoc = await evaluationsCol().doc(scorecardDocId(slug, key)).get();
      const existing = existingDoc.exists ? existingDoc.data() : null;
      if (!force && isUpToDate(existing, sessionIds, idSubs.length)) {
        skipped += 1;
        continue;
      }

      // Gather GCS evidence across this identity's sessions.
      const editorEvents = [];
      const shellEvents = [];
      const clipboardEntries = [];
      for (const session of idSessions) {
        const ev = await gatherSessionEvidence(session);
        editorEvents.push(...ev.editorEvents);
        shellEvents.push(...ev.shellEvents);
        clipboardEntries.push(...ev.clipboardEntries);
      }
      editorEvents.sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
      shellEvents.sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));

      // Identity fields: enrollment/submission key + the newest session's name/etc.
      const newestSession = idSessions
        .slice()
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0] || null;
      const resolvedIdentity = {
        person_id: identity.person_id != null
          ? identity.person_id
          : (newestSession && newestSession.person_id != null ? newestSession.person_id : null),
        username_norm: identity.username_norm || (newestSession && newestSession.username_norm) || null,
        candidate_id: identity.candidate_id || (newestSession && newestSession.candidate_id) || null,
        name: identity.name || (newestSession && newestSession.name) || null,
      };

      const scorecard = evaluateCandidate({
        contest_slug: slug,
        identity: resolvedIdentity,
        sessions: idSessions,
        submissions: idSubs,
        editorEvents,
        shellEvents,
        problemPoints,
        stubsByProblem,
        hardness,
        maxTotal,
        clipboardEntries,
      });
      // Denorm contest_slug so scopedQuery list returns it.
      scorecard.contest_slug = slug;

      await evaluationsCol().doc(scorecardDocId(slug, key)).set(scorecard);
      evaluated += 1;
    }

    // done iff the full slice ran (no budget break) AND nothing pends beyond it.
    const remainingBeyondSlice = pending.length - slice.length;
    const done = !budgetBroke && remainingBeyondSlice <= 0;

    // processed-so-far = identities at/before the last COMPLETED key (cursor),
    // or the whole universe when done.
    const processed = done
      ? total
      : universe.filter((u) => lastKey != null && u.key <= lastKey).length;

    const result = { evaluated, skipped, done, run_id: runId, processed, total };
    if (!done) {
      result.cursor = lastKey;
    } else {
      // End of the universe → cross-candidate pass over ALL scorecards.
      result.meta_written = await runCrossPass(contest, slug, problemList);
    }

    // Update the job/status doc: `done` after runCrossPass, else still `running`
    // with the fresh heartbeat (keeps the lease alive for the next resume chunk).
    await writeJob(slug, {
      status: done ? "done" : "running",
      total, processed, cursor: done ? "" : (lastKey || ""), run_id: runId,
      started_at: startedAtIso,
      updated_at: new Date(nowMs()).toISOString(), updated_at_ms: nowMs(),
    });

    return result;
  }

  // GET status: the current run progress for the contest's job doc. Absent doc
  // (never evaluated) reads as idle with zero progress.
  async function evaluateStatus(contestSlug) {
    const contest = await resolveContest(String(contestSlug || "").trim(), { requireOpen: false });
    const slug = contest.legacy_empty_slug ? "" : contest.slug;
    const job = await readJob(slug);
    if (!job) return { status: "idle", total: 0, processed: 0, cursor: "", run_id: null };
    return {
      status: job.status || "idle",
      total: Number(job.total) || 0,
      processed: Number(job.processed) || 0,
      cursor: job.cursor || "",
      run_id: job.run_id || null,
      updated_at: job.updated_at || null,
    };
  }

  // ---- cross-candidate pass over the full evaluations corpus ----------------
  async function runCrossPass(contest, slug, problemListFromBatch) {
    const snap = await scopedQuery(evaluationsCol(), contest).limit(submissionsQueryLimit).get();
    const docs = snap.docs.map((d) => d.data());
    const scorecards = docs.filter((d) => d && d.schema_version && !isMetaDoc(d));

    if (!scorecards.length) {
      // Nothing to cross-analyze, but still write a (trivial) meta doc so the
      // list endpoint has a consistent meta to return.
      const { meta } = crossCandidateAnalysis({ candidates: [], problems: problemListFromBatch || [] });
      await writeMeta(slug, meta);
      return true;
    }

    // Reconstruct candidates from each scorecard's persisted cross_inputs.
    const candidates = scorecards.map((sc) => reconstructCandidate(sc));
    const problems = unionProblems(scorecards, problemListFromBatch);

    const { meta, patches } = crossCandidateAnalysis({ candidates, problems });

    // Re-write each patched scorecard.
    for (const c of candidates) {
      const patched = applyCrossPatches(c.scorecard, patches.get(c.identityKey));
      patched.contest_slug = slug;
      await evaluationsCol().doc(scorecardDocId(slug, c.identityKey)).set(patched);
    }

    await writeMeta(slug, meta);
    return true;
  }

  // A scorecard → cross-candidate candidate object. The cross modules need:
  // submissions (with source_code + verdict + created_at), pastes (foreign paste
  // records with text), finalContents {pid:norm}, room, ips, plus cross_inputs.
  // cross_inputs persisted on each scorecard supplies all of this cheaply.
  function reconstructCandidate(sc) {
    const ci = sc.cross_inputs || {};
    // Reconstruct "submissions" from cross_inputs.submit_times + the normalized
    // contents the cross passes match on. We feed final_content_norms (already
    // coreExact) as both the accepted final content AND as pseudo-submission
    // sources keyed by problem, so clone/paste matching works without GCS.
    const finalContents = ci.final_content_norms || {};
    const acceptedNorms = ci.accepted_norms || {};
    const failedNorms = ci.failed_norms || {};
    const submitTimes = Array.isArray(ci.submit_times) ? ci.submit_times : [];

    // Build pseudo-submissions: one per submit_time, attaching the matching
    // accepted-source norm (authoritative submitted text; falls back to the
    // replay-derived final-content norm for pre-accepted_norms scorecards) or
    // failed norm (non-accepted) as source_code so analyzeClones /
    // failed-clustering / paste matching see real text.
    const failedQueue = {};
    for (const pid of Object.keys(failedNorms)) failedQueue[pid] = (failedNorms[pid] || []).slice();
    const acceptedQueue = {};
    for (const pid of Object.keys(acceptedNorms)) acceptedQueue[pid] = (acceptedNorms[pid] || []).slice();
    const submissions = submitTimes.map((st) => {
      const pid = st.problem_id;
      const accepted = st.verdict === "accepted";
      let source = "";
      if (accepted) {
        source = (acceptedQueue[pid] && acceptedQueue[pid].length ? acceptedQueue[pid].shift() : "") || finalContents[pid] || "";
      } else if (failedQueue[pid] && failedQueue[pid].length) {
        source = failedQueue[pid].shift();
      }
      return {
        problem_id: pid,
        verdict: st.verdict || null,
        created_at: st.ts || null,
        source_code: source,
        score: 0,
      };
    });

    // foreign pastes (text-carrying) for D6 directed paste matching.
    const pastes = (ci.foreign_paste_texts || []).map((text) => ({
      problem_id: null,
      ts: null,
      len: text.length,
      text,
    }));

    return {
      identityKey: String(sc.identity_key || ""),
      username_norm: sc.username_norm || null,
      scorecard: sc,
      submissions,
      pastes,
      finalContents,
      cross_inputs: ci,
      room: ci.room || "",
      ips: Array.isArray(ci.ips) ? ci.ips : [],
    };
  }

  function unionProblems(scorecards, problemListFromBatch) {
    const set = new Set();
    const out = [];
    for (const p of problemListFromBatch || []) {
      if (!set.has(p.problem_id)) {
        set.add(p.problem_id);
        out.push({ problem_id: p.problem_id });
      }
    }
    for (const sc of scorecards) {
      const ci = sc.cross_inputs || {};
      for (const pid of Object.keys(ci.final_content_norms || {})) {
        if (!set.has(pid)) {
          set.add(pid);
          out.push({ problem_id: pid });
        }
      }
    }
    return out;
  }

  async function writeMeta(slug, meta) {
    const doc = {
      ...meta,
      contest_slug: slug,
      computed_at: new Date().toISOString(),
    };
    await evaluationsCol().doc(`${META_ID_PREFIX}${slug}`).set(doc);
  }

  // ---- list endpoint --------------------------------------------------------
  async function listEvaluations(contestSlug, identity) {
    const contest = await resolveContest(String(contestSlug || "").trim(), { requireOpen: false });
    const snap = await scopedQuery(evaluationsCol(), contest).limit(submissionsQueryLimit).get();
    const docs = snap.docs.map((d) => d.data());
    let meta = null;
    const evaluations = [];
    for (const d of docs) {
      if (isMetaDoc(d)) {
        meta = d;
        continue;
      }
      // The job/status doc is not a scorecard — never surface it in the list.
      if (isJobDoc(d)) continue;
      evaluations.push(d);
    }
    const wantKey = identity != null && identity !== "" ? String(identity) : null;
    const filtered = wantKey == null
      ? evaluations
      : evaluations.filter(
          (d) => String(d.identity_key || "") === wantKey
            || String(d.person_id || "") === wantKey
            || String(d.username_norm || "") === wantKey
        );
    return { evaluations: filtered, meta };
  }

  return { evaluateContestBatch, listEvaluations, evaluateStatus };
}

// A stored doc is the per-contest job/status doc iff it carries a `status` field
// (running|done|error) AND is neither a scorecard (no schema_version/identity_key)
// nor the meta doc (no clusters/cohort/recurring_pairs). data() loses the id, so
// we detect by shape — same defensive style as isMetaDoc.
function isJobDoc(d) {
  if (!d) return false;
  if (d.identity_key || d.schema_version) return false;
  if (isMetaDoc(d)) return false;
  return typeof d.status === "string" && Number.isFinite(Number(d.total));
}

// A stored doc is the contest meta doc iff its identity_key marks it so — meta
// docs carry no identity_key and no schema_version-bearing scorecard shape. We
// detect by the absence of identity_key + presence of the meta-only `clusters`
// field (defensive: the doc id also starts with __meta:: but data() loses the id).
function isMetaDoc(d) {
  if (!d) return false;
  if (d.identity_key) return false;
  // meta doc carries the cross artifacts; a scorecard never does at top level.
  return Object.prototype.hasOwnProperty.call(d, "clusters")
    || Object.prototype.hasOwnProperty.call(d, "cohort")
    || Object.prototype.hasOwnProperty.call(d, "recurring_pairs");
}
