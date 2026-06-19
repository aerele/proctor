// backend/test/signingClient.test.mjs — the "separate signing client" seam.
//
// Background: proctor-api runs with the signer key set so v4 URL signing works,
// but every Google client built off the key fetched ACCESS TOKENS from the
// external oauth2/v4/token endpoint — which is flaky from the service and
// intermittently 500'd token-heavy reads (admin recordings playback lists chunks
// via getFiles). The fix routes TOKEN-bearing work (getFiles, save, Firestore)
// through the MAIN metadata-ADC client and uses the key ONLY for LOCAL v4
// signing via a dedicated client.
//
// This test pins the routing contract of clients.mjs:
//   - signingBucket() returns the SIGNING client's bucket when a signer key is
//     configured (here: a distinct injected signingStorage fake).
//   - signingBucket() FALLS BACK to the MAIN client's bucket when no signer key
//     / signing client is configured — so tests that inject only `storage` and
//     non-key deploys keep the exact current behavior.
import { test } from "node:test";
import assert from "node:assert/strict";

// Fresh ?buster import so module-level singletons (storage/signingStorage) are
// clean for this file — mirrors the per-file isolation the rest of the suite uses.
const clients = await import("../src/lib/clients.mjs?signingClient");
const { configureClients, __setClientsForTest, bucket, signingBucket } = clients;

// Minimal fakes: each bucket carries a tag so we can prove WHICH client served
// signingBucket(). configureClients only needs evidenceBucket set for the
// bucket()/signingBucket() guards to pass.
function makeTaggedStorage(tag) {
  return {
    bucket(name) {
      return { __tag: tag, __name: name };
    }
  };
}

test("signingBucket() uses the injected signing client when one is configured", () => {
  configureClients({ evidenceBucket: "sign-bucket" });
  __setClientsForTest({
    storage: makeTaggedStorage("main"),
    signingStorage: makeTaggedStorage("signer")
  });

  assert.equal(bucket().__tag, "main", "bucket() must stay on the MAIN (metadata-ADC) client");
  assert.equal(bucket().__name, "sign-bucket");
  assert.equal(signingBucket().__tag, "signer", "signingBucket() must use the dedicated SIGNING client");
  assert.equal(signingBucket().__name, "sign-bucket");
});

test("signingBucket() falls back to the MAIN client when no signing client is configured", () => {
  configureClients({ evidenceBucket: "fallback-bucket" });
  // Inject ONLY storage (no distinct signingStorage). __setClientsForTest mirrors
  // it into signingStorage so existing storage-only tests still exercise signing
  // through the same fake — i.e. signing routes to the MAIN bucket here.
  __setClientsForTest({ storage: makeTaggedStorage("main-only") });

  assert.equal(bucket().__tag, "main-only");
  assert.equal(signingBucket().__tag, "main-only",
    "with no separate signer, signingBucket() must fall back to the main client (current behavior)");
  assert.equal(signingBucket().__name, "fallback-bucket");
});
