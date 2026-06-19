// backend/src/lib/clients.mjs — the mutable GCP client singletons + their
// test-injection seams (decomp B0). This is the ONE place that owns the live
// Firestore/Storage handles and the Judge0 adapter, so the test swap via
// __setClientsForTest / __setJudge0AdapterForTest propagates to EVERY consumer
// that reads through getFirestore()/getStorage()/judge0().
//
// Env-derived configuration (the evidence bucket name, signed-URL expiry, and
// the Judge0 connection params) is INJECTED by handler.mjs via configureClients
// — this module never reads the environment, so the "?buster" re-evaluation
// semantics and the env-lint guard both hold.
import { Firestore } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";
import { makeJudge0Adapter } from "../judge0Adapter.mjs";
import { httpError } from "./http.mjs";

let firestore = new Firestore();
// MAIN client: default ADC (the metadata server on Cloud Run), reliable for
// token-bearing work — getFiles, save, Firestore, every API call. Tokens come
// from the metadata server, NOT the flaky external oauth2/v4/token endpoint.
let storage = new Storage();
// SIGNING client: built ONLY when a signer key file is configured. v4 URL
// signing is a LOCAL crypto operation off the key — no token, no network — so
// routing signing through this client keeps it off the flaky external token
// endpoint while every token-bearing call still uses the metadata-backed main
// client. Null until configured; signingBucket() then falls back to `storage`.
let signingStorage = null;

// Dependency-injection seam for unit tests only. Production code never calls
// these; tests inject fake Firestore/Storage objects so no real GCP is touched.
// A test may inject `signingStorage` to exercise the signing client distinctly;
// if it injects only `storage`, that same fake also drives signing (so existing
// tests that stub only `storage` keep exercising signing through the fake).
export function __setClientsForTest({ firestore: fakeFirestore, storage: fakeStorage, signingStorage: fakeSigningStorage } = {}) {
  if (fakeFirestore) firestore = fakeFirestore;
  if (fakeStorage) storage = fakeStorage;
  if (fakeSigningStorage) signingStorage = fakeSigningStorage;
  else if (fakeStorage) signingStorage = fakeStorage;
}

// ---- Write-isolation guard (proctor-eval) ---------------------------------
// When EVAL_WRITE_ALLOWLIST is configured (proctor-eval only), every Firestore
// WRITE to a collection NOT in the allowlist throws. This makes a runaway or
// compromised eval deploy incapable of mutating the test-taking data — it can
// only write its OWN collection(s). UNSET (proctor-api) → `_evalWriteAllowlist`
// stays null and getFirestore() returns the RAW client with ZERO wrapping, so
// proctor-api behavior + overhead are completely unchanged. READS are always
// allowed (the guard only intercepts mutations).
let _evalWriteAllowlist = null; // Set<string> | null
let _guardedFirestore = null; // memoized proxy; invalidated on client/allowlist change
let _guardedBase = null; // the firestore instance the memoized proxy wraps

// The write methods we must block on a non-allowlisted DocumentReference /
// CollectionReference. (DocumentReference: set/update/delete/create; the
// CollectionReference also exposes add().)
const DOC_WRITE_METHODS = new Set(["set", "update", "delete", "create"]);

function denyWrite(collectionName) {
  throw new Error(
    `eval write-isolation: ${collectionName} not in EVAL_WRITE_ALLOWLIST`
  );
}

// Wrap a DocumentReference so its write methods throw (collection not allowed),
// while reads (get) and sub-navigation (collection) pass through. A subcollection
// is re-guarded under its OWN name via guardCollection.
function guardDoc(docRef, collectionName) {
  return new Proxy(docRef, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && DOC_WRITE_METHODS.has(prop)) {
        return () => denyWrite(collectionName);
      }
      // A subcollection off this doc is guarded under the SUBcollection's name.
      if (prop === "collection") {
        return (subName) => guardCollection(target.collection(subName), subName);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

// Wrap a CollectionReference so add() throws and .doc() returns a guarded doc,
// while query builders (where/orderBy/limit) and reads (get) pass through. Only
// called for collections NOT in the allowlist — allowlisted collections return
// the raw ref untouched (zero overhead inside the allowed write surface).
function guardCollection(colRef, collectionName) {
  return new Proxy(colRef, {
    get(target, prop, receiver) {
      if (prop === "add") {
        return () => denyWrite(collectionName);
      }
      if (prop === "doc") {
        return (id) => guardDoc(target.doc(id), collectionName);
      }
      const value = Reflect.get(target, prop, receiver);
      // where()/orderBy()/limit() return a Query (no write surface), so they
      // need no further wrapping; bind and pass through. get() reads — allowed.
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

// Build the guarded Firestore proxy: collection(name) returns the RAW ref for an
// allowlisted name, or a write-guarded ref otherwise. batch()/runTransaction()/
// bulkWriter() are blocked wholesale — the eval path uses none of them today, so
// blocking them keeps the guard airtight (a future eval write via a batch can't
// silently bypass the per-collection check). collectionGroup() returns a Query
// (reads only). Everything else passes through.
function buildGuardedFirestore(base, allowlist) {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "collection") {
        return (name) =>
          allowlist.has(name) ? target.collection(name) : guardCollection(target.collection(name), name);
      }
      if (prop === "batch" || prop === "bulkWriter") {
        return () => {
          throw new Error(
            `eval write-isolation: ${prop}() is not permitted under EVAL_WRITE_ALLOWLIST`
          );
        };
      }
      if (prop === "runTransaction") {
        return () => {
          throw new Error(
            "eval write-isolation: runTransaction() is not permitted under EVAL_WRITE_ALLOWLIST"
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

// Getters (not the instances) so __setClientsForTest swaps propagate to every
// reader — the same getter-injection contract configure*Store already relies on.
export function getFirestore() {
  // Fast path: no allowlist (proctor-api) → the RAW client, no proxy, no overhead.
  if (!_evalWriteAllowlist) return firestore;
  // Memoize the proxy; rebuild if the underlying client was swapped (test seam).
  if (!_guardedFirestore || _guardedBase !== firestore) {
    _guardedFirestore = buildGuardedFirestore(firestore, _evalWriteAllowlist);
    _guardedBase = firestore;
  }
  return _guardedFirestore;
}
export function getStorage() {
  return storage;
}

// Env-derived config injected once at handler module-load. Defaults keep this
// module usable before configuration (e.g. if a test imports it standalone).
let _evidenceBucket;
let _urlExpirySeconds = 900;
let _judge0Config = {};
export function configureClients({ evidenceBucket, urlExpirySeconds, judge0Config, signerKeyFile, evalWriteAllowlist } = {}) {
  if (evidenceBucket !== undefined) _evidenceBucket = evidenceBucket;
  if (urlExpirySeconds !== undefined) _urlExpirySeconds = urlExpirySeconds;
  if (judge0Config !== undefined) _judge0Config = judge0Config;
  // A signer key file (arriving ONLY via this call — clients.mjs reads no env)
  // builds a dedicated client that signs v4 URLs locally with the key. The main
  // `storage` client stays on metadata ADC for all token-bearing work.
  if (signerKeyFile) signingStorage = new Storage({ keyFilename: signerKeyFile });
  // Write-isolation allowlist (comma-separated collection names). Empty/unset →
  // null (no guard, proctor-api unchanged). Parsed here (handler.mjs is the env
  // reader and passes the raw string in, so clients.mjs stays env-free).
  if (evalWriteAllowlist !== undefined) {
    const names = String(evalWriteAllowlist || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    _evalWriteAllowlist = names.length ? new Set(names) : null;
    // Invalidate any memoized guarded proxy so the new allowlist takes effect.
    _guardedFirestore = null;
    _guardedBase = null;
  }
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

// The bucket handle used for v4 URL signing ONLY. Uses the dedicated signing
// client when a signer key is configured (local crypto, no token/network);
// falls back to the main client otherwise — so tests and non-key deploys keep
// the exact current behavior.
export function signingBucket() {
  if (!_evidenceBucket) throw httpError(500, "EVIDENCE_BUCKET is not configured.");
  return (signingStorage || storage).bucket(_evidenceBucket);
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
    const [downloadUrl] = await signingBucket()
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
