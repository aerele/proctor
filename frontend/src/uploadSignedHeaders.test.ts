// uploadSignedHeaders.test.ts — v1.1 G3 (#7) THE recording blocker.
//
// The backend signs the chunk-upload WRITE URL with the extension header
// {"x-goog-content-length-range":"0,<max>"} whenever MAX_UPLOAD_CHUNK_BYTES>0
// (the DEFAULT — 64 MiB). GCS v4 FOLDS every signed extension header into
// X-Goog-SignedHeaders and the canonical request, so the candidate's PUT MUST
// send that EXACT header or GCS rejects the signature with 403
// SignatureDoesNotMatch — and no screen/camera recording is ever stored.
//
// This test does NOT inspect a hand-written list of "expected" headers (that is
// exactly the hollow check that let the live bug ship). Instead it:
//   1. signs a REAL v4 WRITE URL with @google-cloud/storage using the SAME sign
//      options the backend builds (sessionTelemetry.mjs), with a locally-
//      generated RSA key (no network — v4 signing is a local HMAC over the
//      canonical request);
//   2. reads X-Goog-SignedHeaders straight out of the signed URL — i.e. the
//      EXACT set GCS will demand on the PUT;
//   3. drives the real uploadBlob() against a captured fetch and asserts the
//      request header set is a SUPERSET of every signed header (minus `host`,
//      which the browser/fetch sets itself), with the x-goog-content-length-range
//      VALUE matching `0,<max_bytes>` byte-for-byte.
// If uploadBlob ever drops the header again, this fails — it is wired to the
// real signer, not to a fixture.
import { describe, expect, it, vi, afterEach } from "vitest";
import { Storage } from "@google-cloud/storage";
import { generateKeyPairSync } from "node:crypto";
import { uploadBlob } from "./api";

const MAX_BYTES = 12345678; // a recognizable, non-default cap value
const OBJECT_KEY = "contests/kec-2026/sessions/alice/sess1/screen/chunk-00000.webm";
const CONTENT_TYPE = "video/webm";

// Sign a REAL v4 WRITE URL with the exact sign options the backend uses, and
// return both the URL and the canonical signed-header set GCS baked into it.
async function signRealWriteUrl(
  maxBytes: number
): Promise<{ url: string; signedHeaders: Set<string>; rangeValue: string }> {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  const storage = new Storage({
    projectId: "proctor-test",
    credentials: { client_email: "signer@proctor-test.iam.gserviceaccount.com", private_key: privateKey }
  });
  // MIRRORS backend sessionTelemetry.mjs signOpts exactly (version/action/
  // contentType/extensionHeaders) — if the backend shape drifts, update here.
  const rangeValue = `0,${maxBytes}`;
  const [url] = await storage
    .bucket("proctor-evidence")
    .file(OBJECT_KEY)
    .getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + 900_000,
      contentType: CONTENT_TYPE,
      extensionHeaders: { "x-goog-content-length-range": rangeValue }
    });
  const parsed = new URL(url);
  const signed = String(parsed.searchParams.get("X-Goog-SignedHeaders") || "")
    .split(";")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return { url, signedHeaders: new Set(signed), rangeValue };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Capture the headers uploadBlob actually puts on the PUT request. Returns the
// header map keyed lower-case so it can be diffed against the signed set.
function captureUploadHeaders(): { headers: () => Record<string, string>; restore: () => void } {
  let captured: Record<string, string> = {};
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    captured = {};
    const h = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(h)) captured[k.toLowerCase()] = String(v);
    return { ok: true, status: 200 } as Response;
  });
  return { headers: () => captured, restore: () => spy.mockRestore() };
}

describe("uploadBlob signed-header parity (v1.1 G3 #7 — recording 403 blocker)", () => {
  it("sends EXACTLY the header set GCS signed (superset incl. x-goog-content-length-range), so the signed PUT does not 403", async () => {
    const { url, signedHeaders, rangeValue } = await signRealWriteUrl(MAX_BYTES);

    // Sanity: GCS really did fold the range header into the signature. If GCS
    // ever stops signing it, this guard tells us the premise changed.
    expect(signedHeaders.has("x-goog-content-length-range")).toBe(true);
    expect(signedHeaders.has("content-type")).toBe(true);

    const cap = captureUploadHeaders();
    await uploadBlob(url, new Blob(["x".repeat(1024)], { type: CONTENT_TYPE }), MAX_BYTES);
    const sent = cap.headers();
    cap.restore();

    // THE assertion: every header GCS signed must be present on the PUT, except
    // `host`, which fetch/the browser sets itself (it is not settable in init
    // and is always present on the wire). A MISSING signed header == a 403.
    const settableSigned = [...signedHeaders].filter((h) => h !== "host");
    for (const h of settableSigned) {
      expect(sent, `signed header '${h}' MUST be on the PUT or GCS returns 403`).toHaveProperty(h);
    }

    // And the size-range value must match the signed value BYTE-FOR-BYTE — a
    // different value (e.g. wrong max) is just as fatal as omitting it.
    expect(sent["x-goog-content-length-range"]).toBe(rangeValue);
    expect(sent["x-goog-content-length-range"]).toBe(`0,${MAX_BYTES}`);
    expect(sent["content-type"]).toBe(CONTENT_TYPE);
  });

  it("does NOT send the range header when no cap was bound (legacy backend, max_bytes absent)", async () => {
    // A legacy backend signs WITHOUT the extension header; the client must then
    // NOT send it (sending an unsigned header is fine for GCS, but the contract
    // is: only echo what the backend bound). Proves the maxBytes guard.
    const cap = captureUploadHeaders();
    await uploadBlob("https://signed.example/legacy", new Blob(["x"], { type: CONTENT_TYPE }));
    const sent = cap.headers();
    cap.restore();
    expect(sent).not.toHaveProperty("x-goog-content-length-range");
    expect(sent["content-type"]).toBe(CONTENT_TYPE);
  });

  it("does NOT send the range header when the cap is 0 (disabled)", async () => {
    const cap = captureUploadHeaders();
    await uploadBlob("https://signed.example/zero", new Blob(["x"], { type: CONTENT_TYPE }), 0);
    const sent = cap.headers();
    cap.restore();
    expect(sent).not.toHaveProperty("x-goog-content-length-range");
  });
});
