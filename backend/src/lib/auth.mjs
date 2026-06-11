// backend/src/lib/auth.mjs — the request-auth guards as a FACTORY (decomp B0,
// A2). makeAuth(ctx) closes over the credential VALUES (captured at handler
// load, per ?buster instance) and returns fresh guard functions + per-instance
// "warned once" state. handler.mjs builds ctx from config and destructures the
// returned guards at module scope, so the route bodies call them unchanged.
//
// Factory (not a configure-mutated singleton) BECAUSE the handler is imported
// multiple times per test process with different env (invigilator.test.mjs):
// each makeAuth(ctx) instance keeps its own credentials, so a later instance
// can never leak its config back into an earlier one.
import { httpError } from "./http.mjs";
import { getClientIp, safeEqual } from "./sanitize.mjs";

export function makeAuth(ctx) {
  const { adminPassword, invigilatorPassword, apiKey, sweepKey } = ctx;

  function requireAdmin(req) {
    // Timing-safe compare via safeEqual, matching requireApiKey / requireInvigilatorFor.
    // Closed-by-default: with ADMIN_PASSWORD unset every admin request rejects.
    const password = req.get?.("x-admin-password") || req.headers?.["x-admin-password"] || "";
    if (!adminPassword || !safeEqual(password, adminPassword)) {
      throw httpError(401, "Unauthorized");
    }
  }

  // S3: invigilator auth — x-invigilator-password vs INVIGILATOR_PASSWORD. The
  // ADMIN credential is accepted too, in EITHER header, so an admin can open the
  // portal (the portal client always sends x-invigilator-password). Comparisons
  // are timing-safe (match requireApiKey's discipline). Closed-by-default: with
  // INVIGILATOR_PASSWORD unset the invigilator path always rejects — only the
  // admin fallback can pass.
  let warnedMissingInvigilatorPassword = false;

  function requireInvigilator(req) {
    requireInvigilatorFor(req, null);
  }

  // S-D (vision §2.7/I1): per-contest invigilator token auth. The portal sends
  // whatever credential it has in x-invigilator-password; it is accepted when it
  // is (a) the admin password, (b) THE NAMED CONTEST's invigilator_key, or
  // (c) the global INVIGILATOR_PASSWORD (demoted to Aerele-staff fallback).
  // A contest key never authenticates another contest (the compare runs against
  // the resolved contest only) and never authenticates the legacy no-param
  // portal. All compares are timing-safe via safeEqual.
  function requireInvigilatorFor(req, contest) {
    const invig = req.get?.("x-invigilator-password") || req.headers?.["x-invigilator-password"] || "";
    const admin = req.get?.("x-admin-password") || req.headers?.["x-admin-password"] || "";
    if (adminPassword && (safeEqual(admin, adminPassword) || safeEqual(invig, adminPassword))) return;
    if (contest && !contest.legacy && contest.invigilator_key && safeEqual(invig, contest.invigilator_key)) return;
    if (!invigilatorPassword) {
      if (!warnedMissingInvigilatorPassword) {
        console.warn("INVIGILATOR_PASSWORD is not set; rejecting invigilator-password requests.");
        warnedMissingInvigilatorPassword = true;
      }
      throw httpError(401, "Unauthorized");
    }
    if (!safeEqual(invig, invigilatorPassword)) throw httpError(401, "Unauthorized");
  }

  let warnedMissingApiKey = false;

  function requireApiKey(req) {
    // Closed-by-default: if no ingest key is configured, reject every request so
    // a misconfigured deploy never accepts unauthenticated alert writes.
    if (!apiKey) {
      if (!warnedMissingApiKey) {
        console.warn("ALERTS_INGEST_API_KEY is not set; rejecting all /api/alerts ingest requests.");
        warnedMissingApiKey = true;
      }
      throw httpError(401, "Unauthorized");
    }
    const provided = req.get?.("x-api-key") || req.headers?.["x-api-key"] || "";
    if (!safeEqual(provided, apiKey)) {
      throw httpError(401, "Unauthorized");
    }
  }

  function requireSweepAuth(req) {
    const admin = req.get?.("x-admin-password") || req.headers?.["x-admin-password"] || "";
    if (adminPassword && safeEqual(admin, adminPassword)) return;
    const key = req.get?.("x-api-key") || req.headers?.["x-api-key"] || "";
    if (sweepKey && safeEqual(key, sweepKey)) return;
    throw httpError(401, "Unauthorized");
  }

  function adminActor(req, body = {}) {
    return {
      name: String(body.actor_name || "").slice(0, 200),
      ip: getClientIp(req),
      userAgent: req.get?.("user-agent") || req.headers?.["user-agent"] || ""
    };
  }

  return { requireAdmin, requireInvigilator, requireInvigilatorFor, requireApiKey, requireSweepAuth, adminActor };
}
