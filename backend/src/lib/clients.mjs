// backend/src/lib/clients.mjs — the mutable GCP client singletons + their
// test-injection seams (decomp B0). This is the ONE place that owns the live
// Firestore/Storage handles and the Judge0 adapter, so the test swap via
// __setClientsForTest / __setJudge0AdapterForTest propagates to EVERY consumer
// that reads through getFirestore()/getStorage()/judge0().
//
// Env-derived configuration (the evidence bucket name, signed-URL expiry, and
// the Judge0 connection params) is INJECTED by handler.mjs via configureClients
// — this module never reads process.env, so the "?buster" re-evaluation
// semantics and the env-lint guard both hold.
import { Firestore } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";
import { makeJudge0Adapter } from "../judge0Adapter.mjs";
import { httpError } from "./http.mjs";

let firestore = new Firestore();
let storage = new Storage();

// Dependency-injection seam for unit tests only. Production code never calls
// these; tests inject fake Firestore/Storage objects so no real GCP is touched.
export function __setClientsForTest({ firestore: fakeFirestore, storage: fakeStorage } = {}) {
  if (fakeFirestore) firestore = fakeFirestore;
  if (fakeStorage) storage = fakeStorage;
}

// Getters (not the instances) so __setClientsForTest swaps propagate to every
// reader — the same getter-injection contract configure*Store already relies on.
export function getFirestore() {
  return firestore;
}
export function getStorage() {
  return storage;
}

// Env-derived config injected once at handler module-load. Defaults keep this
// module usable before configuration (e.g. if a test imports it standalone).
let _evidenceBucket;
let _urlExpirySeconds = 900;
let _judge0Config = {};
export function configureClients({ evidenceBucket, urlExpirySeconds, judge0Config } = {}) {
  if (evidenceBucket !== undefined) _evidenceBucket = evidenceBucket;
  if (urlExpirySeconds !== undefined) _urlExpirySeconds = urlExpirySeconds;
  if (judge0Config !== undefined) _judge0Config = judge0Config;
}

// Single adapter, built from injected config on first use. Tests inject a stub
// via __setJudge0AdapterForTest (mirrors __setClientsForTest). Pass null to reset.
let _judge0 = null;
let _judge0Override = null;
export function __setJudge0AdapterForTest(adapter) {
  _judge0Override = adapter || null;
}
export function judge0() {
  if (_judge0Override) return _judge0Override;
  if (!_judge0) {
    _judge0 = makeJudge0Adapter({
      baseUrl: _judge0Config.baseUrl, mode: _judge0Config.mode,
      apiKey: _judge0Config.apiKey, authToken: _judge0Config.authToken
    });
  }
  return _judge0;
}

export function bucket() {
  if (!_evidenceBucket) throw httpError(500, "EVIDENCE_BUCKET is not configured.");
  return storage.bucket(_evidenceBucket);
}

export async function putJsonl(key, records) {
  await bucket().file(key).save(records.map((record) => JSON.stringify(record)).join("\n") + "\n", {
    contentType: "application/x-ndjson"
  });
}

export async function resolveSignedReadUrl(objectKey) {
  // Best-effort: a missing bucket or a signing failure must not break the whole
  // admin listing, so we degrade to null instead of throwing.
  try {
    const [downloadUrl] = await bucket()
      .file(String(objectKey))
      .getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + _urlExpirySeconds * 1000
      });
    return downloadUrl;
  } catch (error) {
    console.warn(`Failed to sign read URL for ${objectKey}: ${error?.message || error}`);
    return null;
  }
}
