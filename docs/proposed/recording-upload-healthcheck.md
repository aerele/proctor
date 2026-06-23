# DIAGNOSTIC TEST-1 — why tests + admin health-check missed the chunk-upload CORS regression (REC-1)

**Date:** 2026-06-23
**Scope:** read-only analysis + one scoped recommendation. No code written.

## The regression in one line

The v1.1 size-cap feature signs every chunk PUT with an
`x-goog-content-length-range` extension header
(`backend/src/routes/sessionTelemetry.mjs:141-143`). The browser then MUST send
that header on the PUT (`frontend/src/api.ts:615-617`). The evidence-bucket CORS
allowlist (`backend/gcs-cors.json:5`) lists only `Content-Type`, `ETag`,
`x-goog-content-length-range` — wait: it *does* list it now. The regression was
that the allowlist **did not** include `x-goog-content-length-range` at the time
v1.1 shipped, so the browser CORS **preflight** (`OPTIONS` with
`Access-Control-Request-Headers: x-goog-content-length-range`) was rejected by
GCS and the browser blocked every real chunk PUT in prod — while every test
stayed green and the admin health-check stayed green.

The root cause is structural: **nothing that runs in CI or in the health-check
ever exercises the browser CORS-preflight path against the real bucket's CORS
config.** Every "upload" check is a Node-side `fetch` PUT, which has no `Origin`
header, triggers no preflight, and — critically — does not even send the
`x-goog-content-length-range` header.

---

## (1) What the tests actually assert about chunk upload — and the gap

There are three test layers touching chunk upload. None of them can see a CORS
allowlist drift.

### a) `frontend/src/uploadSignedHeaders.test.ts` — the closest, still blind to CORS

This is the strongest test in the tree on this feature. It:
- generates a local RSA key and signs a **real** v4 WRITE URL with the *same*
  sign options the backend uses, including
  `extensionHeaders: { "x-goog-content-length-range": rangeValue }`
  (`uploadSignedHeaders.test.ts:49-58`);
- reads `X-Goog-SignedHeaders` straight out of the signed URL — the exact set
  GCS will demand (`:59-64`);
- drives the real `uploadBlob()` against a **mocked** `globalThis.fetch`
  (`:75-80`) and asserts the request header set is a superset of every signed
  header, with the range value byte-for-byte (`:101-110`).

**What it proves:** the *client* sends every header the *signature* requires —
i.e. it catches the "client dropped the header → 403 SignatureDoesNotMatch"
failure mode, which is a different bug (signature mismatch, not CORS).

**The gap:** `fetch` is mocked (`vi.spyOn(globalThis,"fetch").mockImplementation`
→ returns `{ok:true,status:200}` `:75-80`). No request ever leaves the process,
so there is **no preflight and no bucket** in the loop. The test asserts header
*parity with the signature*; it cannot assert header *acceptance by the bucket's
CORS allowlist*. The signed-header set and the CORS-allowed-header set are two
independent lists that must agree, and only one of them is checked here.

### b) `backend/test/v11InfraIntegration.test.mjs` — asserts the sign-options object only

`G3 #7` (`:134-150`) calls `POST /api/upload-url` through `api()` with a
**capturing fake Storage** and asserts:
`signed.opts.extensionHeaders["x-goog-content-length-range"] === "0,12345678"`
(`:149`) plus `res.body.max_bytes` (`:144`).

**The gap:** it inspects the *arguments passed to* `getSignedUrl` on a fake
bucket. There is no real signing, no PUT, no preflight, no CORS. It confirms the
backend *intends* to bind the header — which is exactly the intent that broke
the allowlist. It cannot detect that the allowlist is missing that header.

### c) `backend/test/healthCheck.test.mjs` — fake Storage + fake fetch, no preflight

The `chunk_upload_signed` probe is tested with a fake Storage whose
`getSignedUrl()` returns `https://signed.example/<key>` (`:122-127`) and a fake
`fetch` whose `PUT` branch just writes the body into the in-memory `_saved` map
and returns 200 (`:166-170`). The test asserts the probe is **green** in a
healthy run (`:262-263`).

**The gap:** the fake fetch returns 200 for *any* PUT regardless of headers or
origin — there is no CORS model at all. So the very probe meant to catch
"exam-morning chunk upload breakage" is, in test, structurally incapable of
going red on a CORS/allowlist drift. The test green-lights a probe that itself
doesn't exercise the broken path (see §2).

### Summary of the gap

| Layer | Real signature? | Real PUT to bucket? | Browser preflight / Origin? | Sends range header on PUT? |
|---|---|---|---|---|
| `uploadSignedHeaders.test.ts` | yes (local key) | **no — fetch mocked** | no | yes (asserted) |
| `v11InfraIntegration #7` | no (fake bucket) | no | no | n/a (inspects opts) |
| `healthCheck.test.mjs` | no (fake bucket) | no (fake fetch) | no | **no** |

Every layer either mocks the network or mocks the bucket. **No layer crosses a
real CORS preflight.** A CORS allowlist that omits a signed header is invisible
to all of them by construction.

---

## (2) What the admin health-check actually verifies — and why it can't catch this

The `chunk_upload_signed` probe is the one explicitly labelled "THE path that
broke on exam morning" (`backend/src/routes/healthCheck.mjs:434-435`). It:

1. mints a v4 signed WRITE URL via `signingBucket().file(objectKey).getSignedUrl({version:"v4",action:"write",...,contentType:"video/webm"})` (`healthCheck.mjs:440-444`);
2. PUTs to it with `fetchImpl(uploadUrl, { method:"PUT", headers:{ "Content-Type":"video/webm" }, body:"WEBMHEALTHCHECK" })` (`:446-448`);
3. asserts `putRes.ok` and that the object then lists under its prefix (`:449-452`).

Three independent reasons it can NEVER catch the CORS regression:

1. **It runs server-to-server, so there is no preflight.** `fetchImpl` defaults
   to `(...args)=>fetch(...args)` (`healthCheck.mjs:72`), i.e. Cloud Run's Node
   `fetch`. A Node PUT sends **no `Origin` header**, so GCS does a plain PUT and
   never evaluates the CORS config. CORS preflight is a *browser* behaviour
   triggered by `Origin` + a non-safelisted request header. The health-check is
   not a browser; it bypasses the exact mechanism that broke.

2. **It signs WITHOUT the size-cap extension header.** The probe's `getSignedUrl`
   call (`:440-444`) omits `extensionHeaders` entirely — it never sets
   `x-goog-content-length-range`. So even the *signature* it tests is the
   pre-v1.1 shape, not the production shape. The probe is testing a *different
   signature contract* than production uses. (The real `createUploadUrl` adds
   the header at `sessionTelemetry.mjs:141-143` whenever `maxUploadChunkBytes>0`,
   the default.)

3. **Its PUT sends only `Content-Type`** (`:447`), never
   `x-goog-content-length-range`. So even if it *were* a browser, the header
   that the allowlist was missing is never on the request, so the missing
   allowlist entry would never be exercised.

The frontend `SystemHealthPanel.tsx` only POSTs to `/api/admin/health-check`
(`SystemHealthPanel.tsx:106`, via `runHealthCheck`) and renders the returned
`checks[]`. It performs no upload of its own — so the one place in the system
that *is* a browser does not do a chunk PUT during the health check. The browser
preflight path has zero coverage end-to-end.

**Net:** the health-check probe is green-by-construction for this class of bug.
It exercises Cloud-Run→GCS connectivity and local v4 signing (both genuinely
valuable — they caught the original exam-morning signer breakage), but the
candidate's real path is browser→preflight(OPTIONS)→PUT-with-range-header→GCS,
and the probe shares none of the three CORS-relevant properties (Origin,
signed range header, range header on the PUT).

---

## (3) Recommendation — the smallest high-value check that WOULD have caught it

The CORS preflight is a *browser* mechanism, but the thing that broke is purely
**config drift**: the set of headers the backend *signs* drifted away from the
set the bucket CORS *allows*. We do not need a real browser to catch that — we
need to assert the two lists agree, and ideally to fire one real preflight.
Recommend **two layers**, cheapest first. Layer A alone would have caught REC-1.

### Layer A (primary, cheapest, deterministic, CI-runnable) — a static parity test

**Where:** new backend test `backend/test/corsHeaderParity.test.mjs` (sibling of
`v11InfraIntegration.test.mjs`).

**What it asserts:** every extension header the backend can bind into a signed
WRITE URL is present (case-insensitively) in `gcs-cors.json`'s `responseHeader`
list for the PUT method.

Concretely:
- Import / read `backend/gcs-cors.json`; collect the lower-cased
  `responseHeader` set for the rule whose `method` includes `"PUT"`.
- Drive `POST /api/upload-url` through `api()` with `MAX_UPLOAD_CHUNK_BYTES` set
  (mirroring `v11InfraIntegration` `:24,134-150`) and a capturing fake Storage;
  read back `signed.opts.extensionHeaders` (the same capture point used at
  `v11InfraIntegration.test.mjs:146-149`).
- Assert: for every key in `extensionHeaders`, that key (lower-cased) is in the
  bucket-CORS `responseHeader` set. Fail loudly naming the missing header.

**Why this is the right primary check:** it is the *exact* invariant that broke
("a header the backend signs is not in the bucket CORS allowlist"), it needs no
network/GCS/credentials, runs in milliseconds in CI on every PR, and it is
**derived from the real backend signing path** (not a hand-maintained list), so
it can't rot the way a fixture would. Had it existed, the moment v1.1 added
`x-goog-content-length-range` to `extensionHeaders` without adding it to
`gcs-cors.json`, this test goes red. ~25 LOC.

> Note: GCS preflight checks `Access-Control-Request-Headers` against the rule's
> **`responseHeader`** list (that field is overloaded as the allowed
> request+response header set for CORS). So asserting against `responseHeader`
> is the correct target — that is literally the list GCS consults on the OPTIONS.

### Layer B (defense-in-depth, real preflight) — a live OPTIONS probe in the health-check

**Where:** a new probe in `backend/src/routes/healthCheck.mjs`, inserted right
after the existing `chunk_upload_signed` probe (after `:454`), id e.g.
`chunk_upload_cors`.

**What it does:** fire a **real CORS preflight** against the bucket and assert
GCS approves the size-cap header — i.e. simulate what the browser sends:

```
OPTIONS https://storage.googleapis.com/<EVIDENCE_BUCKET>/<canaryKey>
  Origin: <publicAppOrigin>                       // a concrete origin, or skip
  Access-Control-Request-Method: PUT
  Access-Control-Request-Headers: content-type,x-goog-content-length-range
```
Assert `res.ok` (2xx) **and** that the response
`Access-Control-Allow-Headers` contains `x-goog-content-length-range`
(case-insensitive). Red if the header is absent or the OPTIONS is non-2xx.

Notes / scoping for Layer B:
- The header set asserted must be **derived**, not hard-coded: build the
  `Access-Control-Request-Headers` value from the *same* `signOpts` shape the
  real `createUploadUrl` uses (`sessionTelemetry.mjs:135-143`) so it tracks the
  signed set automatically — otherwise it becomes the very hollow check the
  uploadSignedHeaders test author warned against (`uploadSignedHeaders.test.ts:10-11`).
- **Skip cleanly when `publicAppOrigin` is `*` or unset** (return
  `{status:"skip", detail:"PUBLIC_APP_ORIGIN not a concrete origin"}`), mirroring
  the `bundle_hashes` skip at `healthCheck.mjs:381-387`. A preflight needs a
  concrete `Origin`; with `*` the assertion is meaningless. This makes the probe
  meaningful exactly in the locked-CORS production posture (`docs/DEPLOY.md:434`),
  which is when this regression actually bites.
- This is a metadata-only `OPTIONS` to GCS — no object written, no billing, safe
  to run mid-exam in LIGHT mode (consistent with the LIGHT-mode contract,
  `healthCheck.mjs:23`). It is added to the always-run probe set, not gated to
  FULL.
- It requires `globalThis.fetch` to be able to reach `storage.googleapis.com`
  from Cloud Run (it already does for the signed PUT probe), and is testable via
  the existing injected `fetchImpl` seam (`healthCheck.mjs:72`) — the fake fetch
  in `healthCheck.test.mjs` would add an `OPTIONS` branch returning the allow
  headers, with a red-path variant omitting `x-goog-content-length-range`.

### Why both, and which alone suffices

- **Layer A alone would have caught REC-1**, deterministically, in CI, with no
  infra. It is the must-do. It catches the *config drift* the instant it is
  introduced — before deploy.
- **Layer B** is the belt-and-braces: it catches drift that A can't see — e.g.
  someone edits `gcs-cors.json` correctly but the **deployed** bucket was never
  updated (`deploy-gcp.sh:166` skipped / a manual bucket / a stale env), or the
  allowlist is correct in the repo but a different bucket is wired in prod. A
  checks the *repo's* JSON; B checks the *live bucket*. Given the operator runs
  the health-check right before an exam, B converts "silent in prod until the
  first student's first chunk" into "red button before the exam starts."

**Recommended order:** ship Layer A now (tiny, pure CI win, closes the exact
hole). Add Layer B as the operator-facing live guard. Both are <40 LOC each and
fit the existing factory/probe + capturing-fake-Storage patterns already in the
tree, so no new test scaffolding is needed.

---

## Citations index

- `backend/src/routes/sessionTelemetry.mjs:135-143` — signOpts + the conditional
  `extensionHeaders["x-goog-content-length-range"]` (the header the bucket must allow).
- `frontend/src/api.ts:599,612-623` — `uploadBlob` sends the range header on the PUT.
- `backend/gcs-cors.json:5` — bucket `responseHeader` allowlist (the list GCS checks on preflight).
- `backend/deploy-gcp.sh:166` — `gcloud storage buckets update ... --cors-file=backend/gcs-cors.json`.
- `frontend/src/uploadSignedHeaders.test.ts:49-58,75-80,101-110` — real signature, **mocked** fetch, no preflight.
- `backend/test/v11InfraIntegration.test.mjs:134-150` — asserts sign-options object only, fake bucket.
- `backend/test/healthCheck.test.mjs:122-170,262-263` — fake Storage + fake fetch, green-by-construction.
- `backend/src/routes/healthCheck.mjs:72,434-454` — `chunk_upload_signed` probe: Node fetch (no Origin), no range header signed, only Content-Type on the PUT.
- `frontend/src/admin/SystemHealthPanel.tsx:106` — panel only POSTs `/api/admin/health-check`; does no upload itself.
