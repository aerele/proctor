// backend/src/lib/sanitize.mjs — stateless sanitization / masking / concurrency
// helpers (decomp B0). Moved VERBATIM out of handler.mjs: no env reads, no
// Firestore/Storage, only node:crypto. handler.mjs imports them back.
import { createHash, timingSafeEqual } from "node:crypto";

export function isoOrNow(value) {
  if (value && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

// Mask an email for the public confirm card: keep at most 2 leading chars of
// the local part + the full domain ("asha@x.com" -> "as**@x.com").
export function maskEmail(value) {
  const text = String(value || "");
  if (!text) return "";
  const at = text.indexOf("@");
  if (at <= 0) return `${text.slice(0, 2)}***`;
  const local = text.slice(0, at);
  const keep = Math.min(2, local.length);
  return `${local.slice(0, keep)}${"*".repeat(Math.max(1, local.length - keep))}${text.slice(at)}`;
}

// Run an async mapper over items with a bounded number of concurrent workers, so
// a single request can't fan out into hundreds of simultaneous GCS/IAM calls.
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  );
  return results;
}

// Room label sanitizer (Epic 4.2): a short human-readable label, stored on the
// session/alert for display only (never used in a GCS key). Keep letters,
// digits, space, dash, dot, underscore; bound the length. Never throws.
export function sanitizeRoom(value) {
  return String(value).trim().replace(/[^a-zA-Z0-9 ._-]/g, "").slice(0, 80);
}

export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");
  // timingSafeEqual requires equal-length buffers; comparing lengths first would
  // leak length but bail out, so hash both to a fixed width and compare those.
  const hashA = createHash("sha256").update(bufA).digest();
  const hashB = createHash("sha256").update(bufB).digest();
  return timingSafeEqual(hashA, hashB);
}

export function normalizeUsername(value) {
  return sanitizeSegment(String(value).trim().toLowerCase());
}

export function sanitizeSegment(value) {
  const cleaned = String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  // M1: a segment that is empty or all-dots (e.g. "", ".", "..") is a path
  // traversal / blank-key hazard once it lands in a GCS object key. Substitute a
  // safe token so a username like ".." can never become a ".." path component.
  if (cleaned === "" || /^\.+$/.test(cleaned)) return "_";
  return cleaned;
}

export function sanitizeObject(value) {
  return JSON.parse(JSON.stringify(value, (_key, nested) => {
    if (typeof nested === "string") return nested.slice(0, 500);
    return nested;
  }));
}

// Editor-event detail sanitizer (paste forensics). detail.text carries up to
// 2000 chars of inserted text by design; sanitizeObject's generic 500-char cap
// would clip it. Pull text out first, sanitize the rest, then re-attach with
// its OWN 2000-char cap plus a text_truncated flag when it was longer.
const EDITOR_TEXT_MAX_LENGTH = 2000;
export function sanitizeEditorDetail(rawDetail) {
  if (!rawDetail || typeof rawDetail !== "object" || Array.isArray(rawDetail)
      || !("text" in rawDetail)) {
    return sanitizeObject(rawDetail || {});
  }
  const { text, ...rest } = rawDetail;
  const detail = sanitizeObject(rest);
  const textStr = String(text);
  detail.text = textStr.slice(0, EDITOR_TEXT_MAX_LENGTH);
  if (textStr.length > EDITOR_TEXT_MAX_LENGTH) detail.text_truncated = true;
  return detail;
}

export function getClientIp(req) {
  // Cloud Run's ingress proxy APPENDS the real connecting client IP as the
  // LAST x-forwarded-for value; any earlier entries arrived in the client's
  // own request and are spoofable. Take the last hop (the only trustworthy one
  // for a direct Cloud Run deployment); fall back to the socket address when
  // there is no proxy (local dev).
  const forwarded = req.get?.("x-forwarded-for") || req.headers?.["x-forwarded-for"] || "";
  const hops = String(forwarded).split(",").map((part) => part.trim()).filter(Boolean);
  const lastForwarded = hops.length ? hops[hops.length - 1] : "";
  const direct = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "";
  return normalizeIp(lastForwarded || direct || "unknown");
}

export function normalizeIp(value) {
  return String(value).replace(/^::ffff:/, "").slice(0, 80);
}

export function hashPasscode(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function maskPasscode(value) {
  const text = String(value);
  return `${"*".repeat(Math.max(0, text.length - 2))}${text.slice(-2)}`;
}
