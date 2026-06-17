// backend/src/lib/http.mjs — stateless HTTP transport helpers (decomp B0).
// Moved VERBATIM out of handler.mjs: no env reads, no Firestore/Storage.
// setCors takes the allowed origin as an argument (handler passes the env
// const PUBLIC_APP_ORIGIN) so this module stays env-free.

export function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body !== "string") return req.body;
  // N3: malformed JSON is a client error, not a server crash. Catch the
  // SyntaxError and surface a clean 400 instead of falling through to the
  // catch-all (which would otherwise report it as a 500).
  try {
    return JSON.parse(req.body);
  } catch {
    throw httpError(400, "invalid_json");
  }
}

export function requireFields(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      throw httpError(400, `${field} is required`);
    }
  }
}

// Permissive email shape (F12 review gap): a non-space run, then @, then a
// non-space run, then a dot, then a non-space run. Deliberately lenient — it
// only catches obvious typos (missing @, missing domain dot). Mirrors the
// client gate in candidateRouting.ts (isCandidateEmailValid).
export const EMAIL_FORMAT = /^\S+@\S+\.\S+$/;

// Reject a malformed TYPED email with a clear 400. Only the start handlers
// where the candidate types the email call this; roster-mapped paths take the
// email from the roster cell, never the typed field, so they skip it.
export function requireValidEmail(body) {
  if (!EMAIL_FORMAT.test(String(body.email ?? "").trim())) {
    throw httpError(400, "email is not a valid email address");
  }
}

export function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// A query param is "truthy" when it is the string "true"/"1"/"yes" (case
// insensitive) or the boolean true. Anything else (incl. absent) is false.
export function isTruthyParam(value) {
  if (value === true) return true;
  const lowered = String(value === undefined || value === null ? "" : value).toLowerCase();
  return lowered === "true" || lowered === "1" || lowered === "yes";
}

export function badRequest(message) {
  throw httpError(400, message);
}

export function httpError(statusCode, message, payload) {
  const error = new Error(message);
  error.statusCode = statusCode;
  // S-C: optional structured payload merged into the JSON error body by the
  // api() catch (college_choices picker, duplicate row lists, ...).
  if (payload) error.payload = payload;
  return error;
}

// httpError carrying structured machine-readable context (S-I guard payloads).
// `extra` is merged into the JSON error body by the api() catch — only ever
// server-built objects (slug lists, problem-id lists), never raw client input.
export function httpErrorWith(statusCode, message, extra) {
  const error = httpError(statusCode, message);
  error.extra = extra;
  return error;
}

// Parse an env-supplied count into a POSITIVE integer, falling back to `fallback`
// when the value is missing, non-numeric (NaN), or <= 0. Used for caps where a
// silent NaN/0 would disable a safety limit (e.g. the brute-force GATE cap).
export function positiveIntOr(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function setCors(res, origin) {
  res.set("access-control-allow-origin", origin);
  res.set("access-control-allow-methods", "GET,POST,OPTIONS");
  res.set("access-control-allow-headers", "content-type,x-admin-password,x-api-key,x-invigilator-password");
}

export function send(res, statusCode, body) {
  res.status(statusCode).json(body);
}
