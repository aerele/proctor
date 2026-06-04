import assert from "node:assert/strict";
import test from "node:test";

// Verifies the closed-by-default posture: with ALERTS_INGEST_API_KEY unset the
// ingest endpoint rejects EVERY request (and warns once). The handler reads the
// key at module-load time, so we must load a FRESH module instance with the key
// unset. A cache-busting query string gives us a separate ES module instance
// from the one alerts.test.mjs configured with a key.
delete process.env.ALERTS_INGEST_API_KEY;
process.env.ALERTS_COLLECTION = "test_alerts_closed";
process.env.EVIDENCE_BUCKET = "test-bucket";

const handler = await import("../src/handler.mjs?closed-by-default");
const { api, __setClientsForTest } = handler;

function makeReq({ method, path, headers = {}, body }) {
  const lowerHeaders = {};
  for (const [key, value] of Object.entries(headers)) lowerHeaders[key.toLowerCase()] = value;
  return {
    method,
    path,
    headers: lowerHeaders,
    query: {},
    body,
    get(name) {
      return lowerHeaders[String(name).toLowerCase()];
    }
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    set(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; }
  };
}

async function call(req) {
  const res = makeRes();
  await api(req, res);
  return res;
}

const validAlert = {
  id: "proctor:recording_stopped:alice:contest-1:2026-06-04T10:00:00Z",
  source: "proctor",
  type: "recording_stopped",
  severity: "critical",
  timestamp: "2026-06-04T10:00:00Z",
  hackerrank_username: "Alice",
  title: "Recording stopped"
};

test("ingestAlerts rejects ALL requests when ALERTS_INGEST_API_KEY is unset and warns once", async () => {
  // A fake firestore that throws if touched proves the request is rejected
  // before any write is attempted.
  __setClientsForTest({
    firestore: {
      collection() {
        throw new Error("Firestore must not be touched when the key is unset");
      }
    }
  });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    // Even a request that supplies *some* x-api-key value is rejected, because
    // there is no configured key to compare against.
    const res1 = await call(makeReq({
      method: "POST",
      path: "/api/alerts",
      headers: { "x-api-key": "anything" },
      body: validAlert
    }));
    assert.equal(res1.statusCode, 401);

    const res2 = await call(makeReq({
      method: "POST",
      path: "/api/alerts",
      headers: { "x-api-key": "another" },
      body: validAlert
    }));
    assert.equal(res2.statusCode, 401);
  } finally {
    console.warn = originalWarn;
  }

  const keyWarnings = warnings.filter((line) => line.includes("ALERTS_INGEST_API_KEY"));
  assert.equal(keyWarnings.length, 1, "warns exactly once across multiple rejected requests");
});
