// backend/test/corsHeaderParity.test.mjs — Layer A regression guard (REC-1).
// Deterministic, no GCS/network: assert that every extension header the backend
// binds into a signed chunk-upload PUT is present (case-insensitively) in the
// evidence bucket's CORS responseHeader allowlist (gcs-cors.json). GCS checks
// that list on the browser preflight, so a signed header missing from it blocks
// every real chunk upload — the exact drift that shipped in v1.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.EVIDENCE_BUCKET = "cors-parity-bucket";
process.env.MAX_UPLOAD_CHUNK_BYTES = "12345678"; // any >0 so the cap header is bound

const { api, __setClientsForTest } = await import("../src/handler.mjs?corsparity");

const corsRules = JSON.parse(readFileSync(new URL("../gcs-cors.json", import.meta.url)));
const putRule = corsRules.find((r) => r.method.includes("PUT"));
const allowed = new Set((putRule?.responseHeader || []).map((h) => h.toLowerCase()));

const firestore = { collection: (name) => ({
  where() { return this; }, limit() { return this; }, async get() { return { docs: [] }; },
  doc: () => ({
    async set() {}, async update() {}, async get() {
      return { exists: true, data: () => ({
        session_id: "s1", status: "active", contest_slug: "kec-2026",
        storage_prefix: "contests/kec-2026/sessions/alice/s1/", chunk_count: 0 }) };
    }
  })
}) };
let captured;
const storage = { bucket: () => ({ file: (key) => ({
  async getSignedUrl(opts) { captured = opts; return [`https://signed.example/${key}`]; }
}) }) };

test("Layer A: every signed chunk-upload extension header is in the gcs-cors.json PUT allowlist", async () => {
  __setClientsForTest({ firestore, storage });
  const res = { statusCode: null, headers: {}, set() {},
    status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, send(p) { this.body = p; return this; } };
  const req = { method: "POST", path: "/api/upload-url", headers: {}, query: {},
    body: { session_id: "s1", kind: "screen", chunk_index: 0, content_type: "video/webm" }, get() {} };
  await api(req, res);
  assert.equal(res.statusCode, 200, `upload-url failed: ${JSON.stringify(res.body)}`);

  const signedHeaders = Object.keys(captured?.extensionHeaders || {});
  assert.ok(signedHeaders.length > 0, "expected the backend to bind at least one extension header");
  for (const h of signedHeaders) {
    assert.ok(allowed.has(h.toLowerCase()),
      `signed chunk-upload header "${h}" is NOT in gcs-cors.json responseHeader allowlist ` +
      `[${[...allowed].join(", ")}] — browser CORS preflight will block every chunk upload (REC-1).`);
  }
});
