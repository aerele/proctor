// backend/src/lib/sessionStore.mjs — neutral session/settings read helpers +
// GCS-prefix builders as a FACTORY (decomp B0, A2/A8c). makeSessionStore(ctx)
// closes over ctx.getFirestore (the live-client getter, so __setClientsForTest
// swaps propagate) and the collection names captured at handler load.
//
// Only the genuinely NEUTRAL store helpers move here in B0 — the contest-scoped
// raw contest_slug equality-filter sites (findLiveSessionFor / endAllLiveSessions)
// and the live-slot lock cluster stay in handler.mjs and relocate at B13/B14 with
// their scopingLint re-pin. Factory (not configure-mutated singleton) for the
// same per-?buster-instance isolation reason as makeAuth.
import { httpError } from "./http.mjs";
import { sanitizeSegment } from "./sanitize.mjs";

export function makeSessionStore(ctx) {
  const { getFirestore, sessionCollection, settingsCollection, settingsId } = ctx;

  function sessionRef(sessionId) {
    return getFirestore().collection(sessionCollection).doc(sessionId);
  }

  function settingsRef() {
    return getFirestore().collection(settingsCollection).doc(settingsId);
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

  async function getSettings() {
    const doc = await settingsRef().get();
    return doc.exists ? doc.data() : null;
  }

  // ---- GCS contest-foldering (Phase 2, 2.1) ---------------------------------
  // ONE place that turns a contest_url into a path slug, and ONE place that
  // assembles the per-session GCS prefix. Every key-build site calls
  // sessionPrefix(session) so upload, signing, and admin-evidence listing always
  // agree. New shape: contests/<slug>/sessions/<username_norm>/<session_id>/...
  // Legacy fallback (no/invalid contest_url): sessions/<username_norm>/<session_id>/...

  // Extract the contest slug from a contest_url: last non-empty path segment, then
  // the existing sanitizeSegment. Empty/invalid url → "" (legacy, no contest folder).
  function contestSlugFromUrl(contestUrl) {
    if (!contestUrl) return "";
    let pathname;
    try {
      pathname = new URL(String(contestUrl)).pathname;
    } catch {
      return "";
    }
    const segments = String(pathname).split("/").filter(Boolean);
    if (!segments.length) return "";
    return sanitizeSegment(segments[segments.length - 1]);
  }

  // Build the per-session prefix from parts. Slug present → contest folder; absent
  // → legacy layout (and never a contests// double-slash).
  function buildStoragePrefix(contestSlug, usernameNorm, sessionId) {
    if (contestSlug) {
      return `contests/${contestSlug}/sessions/${usernameNorm}/${sessionId}/`;
    }
    return `sessions/${usernameNorm}/${sessionId}/`;
  }

  // The prefix for an existing session doc. Prefer the persisted storage_prefix
  // (zero extra reads); fall back to reconstructing from stored fields so legacy
  // docs written before Phase 2 still resolve to their original legacy path.
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
    sessionRef, settingsRef, getSession, getSessionOrNull, getSettings,
    requireWritableSession, contestSlugFromUrl, buildStoragePrefix, sessionPrefix, candidateOf
  };
}
