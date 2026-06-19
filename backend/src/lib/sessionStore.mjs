// backend/src/lib/sessionStore.mjs — neutral session read helpers + GCS-prefix
// builders as a FACTORY (decomp B0, A2/A8c). makeSessionStore(ctx) closes over
// ctx.getFirestore (the live-client getter, so __setClientsForTest swaps
// propagate) and the session collection name captured at handler load.
//
// Only the genuinely NEUTRAL store helpers move here in B0 — the contest-scoped
// raw contest_slug equality-filter sites (findLiveSessionFor / endAllLiveSessions)
// and the live-slot lock cluster stay in handler.mjs and relocate at B13/B14 with
// their scopingLint re-pin. Factory (not configure-mutated singleton) for the
// same per-?buster-instance isolation reason as makeAuth.
import { httpError } from "./http.mjs";

export function makeSessionStore(ctx) {
  const { getFirestore, sessionCollection } = ctx;

  function sessionRef(sessionId) {
    return getFirestore().collection(sessionCollection).doc(sessionId);
  }

  async function getSession(sessionId) {
    const doc = await sessionRef(sessionId).get();
    if (!doc.exists) throw httpError(404, "Session not found");
    return doc.data();
  }

  // H3: gate every client WRITE endpoint on session status so admin lock/end and
  // the pending-approval hold actually stop the browser instead of silently
  // accepting more evidence/heartbeats:
  //   ended  → 409 session_ended (the test is over; no further writes)
  //   locked → 403 session_locked (admin paused it; needs unlock)
  //   pending_approval → 403 waiting_for_approval (second device, not yet live)
  // active (and any unknown/legacy status) is allowed so happy paths are unchanged.
  function requireWritableSession(session) {
    const status = session?.status;
    if (status === "ended") throw httpError(409, "session_ended");
    if (status === "locked") throw httpError(403, "session_locked");
    if (status === "pending_approval") throw httpError(403, "waiting_for_approval");
    return session;
  }

  // Like getSession but returns null instead of throwing — used by resume and
  // single-session reconciliation where "not found" is a normal control-flow path.
  async function getSessionOrNull(sessionId) {
    const doc = await sessionRef(String(sessionId)).get();
    return doc.exists ? doc.data() : null;
  }

  // ---- GCS contest-foldering (Phase 2, 2.1) ---------------------------------
  // ONE place that assembles the per-session GCS prefix. Every key-build site
  // calls sessionPrefix(session) so upload, signing, and admin-evidence listing
  // always agree. Shape: contests/<slug>/sessions/<username_norm>/<session_id>/...

  // Build the per-session prefix from parts. A contest slug is always present on
  // current sessions; the no-slug arm only ever serves a pre-Phase-2 doc that
  // lacks storage_prefix (via sessionPrefix's fallback) and never emits a
  // contests// double-slash.
  function buildStoragePrefix(contestSlug, usernameNorm, sessionId) {
    if (contestSlug) {
      return `contests/${contestSlug}/sessions/${usernameNorm}/${sessionId}/`;
    }
    return `sessions/${usernameNorm}/${sessionId}/`;
  }

  // The prefix for an existing session doc. Prefer the persisted storage_prefix
  // (zero extra reads); fall back to reconstructing from stored fields so old
  // docs written before Phase 2 still resolve to their original path.
  function sessionPrefix(session) {
    if (session && session.storage_prefix) return session.storage_prefix;
    return buildStoragePrefix(session?.contest_slug, session?.username_norm, session?.session_id);
  }

  function candidateOf(doc) {
    return {
      id: doc?.candidate_id || doc?.roster_unique_id || doc?.hackerrank_username || "",
      id_norm: doc?.username_norm || "",
      label: doc?.identity_label || "Candidate ID",
      name: doc?.name || "",
      roll_number: doc?.roll_number || "",
      room: doc?.room || ""
    };
  }

  return {
    sessionRef, getSession, getSessionOrNull,
    requireWritableSession, buildStoragePrefix, sessionPrefix, candidateOf
  };
}
