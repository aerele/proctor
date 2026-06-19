// frontend/src/recordingPlaylist.ts — pure playlist-by-source logic for the
// recordings review (F10.1: the Screen/Camera source toggle). Extracted from
// RecordingReview.tsx so the chunk-key parsing and the timeline placement are
// vitest-covered. The screen recording and the separate low-res camera stream
// are independent chunk series (screen/chunk-*.webm and camera/chunk-*.webm,
// each 1-based) that share the SAME created_at/last_modified-anchored offset
// math, so switching source keeps the timeline (and every overlay marker)
// aligned. No React, no IO.
import type { SessionEvidence } from "./types";

/** The two recorded chunk series under a session's storage prefix. */
export type RecordingSource = "screen" | "camera";

/** Every recorded chunk is a fixed 30-second .webm (uploadConfig.chunk_seconds
 * on the backend) — both sources segment on the same clock. */
export const CHUNK_SECONDS = 30;

// A single chunk placed on the test-relative timeline. offsetSec is the chunk's
// START time in seconds relative to the test start; [offsetSec, offsetSec+CHUNK_SECONDS]
// is the span it occupies. `url` is the signed download URL (refreshable).
export type TimelineChunk = {
  index: number; // 1-based numeric index parsed from the chunk key
  key: string;
  url: string;
  offsetSec: number; // start, relative to test start
  endSec: number; // offsetSec + CHUNK_SECONDS
};

// Pull the numeric index out of a chunk key FOR THE GIVEN SOURCE, e.g.
// ".../screen/chunk-00007.webm" → 7 with source "screen". Returns NaN for the
// other source's chunks and for non-chunk keys (manifest, events, ...).
export function chunkIndexFromKey(key: string, source: RecordingSource): number {
  const match = key.match(new RegExp(`${source}/chunk-(\\d+)\\.(?:webm|bin)$`));
  return match ? Number(match[1]) : NaN;
}

export function isSourceChunk(evidence: SessionEvidence, source: RecordingSource): boolean {
  return new RegExp(`${source}/chunk-\\d+\\.(?:webm|bin)$`).test(evidence.key);
}

/** Whether this session uploaded any camera chunks at all — drives the
 * Screen/Camera toggle's visibility (and the camera-recorded labels). */
export function hasCameraChunks(evidence: SessionEvidence[]): boolean {
  return evidence.some((file) => isSourceChunk(file, "camera"));
}

/** The GCS object key of a session's recorder manifest, relative to a known
 * storage prefix. The manifest lives at `{prefix}/manifest.json` and is listed
 * in the session evidence alongside the chunks. */
export function isManifestEvidence(evidence: SessionEvidence): boolean {
  return /(?:^|\/)manifest\.json$/.test(evidence.key);
}

/** Build the recording-time anchor map from a parsed manifest.json body. The
 * manifest is `{ session_id, ended_at, manifest:[{storage_key, started_at,...}] }`
 * (backend session/end). We tolerate ANYTHING that isn't that exact shape:
 * non-object input, a missing/non-array `manifest`, and entries that lack a
 * usable storage_key or started_at are skipped per-entry — a PARTIAL manifest
 * yields a partial map and the rest of the chunks fall back to last_modified.
 * Never throws (callers pass already-parsed JSON, but a malformed object still
 * returns an empty map rather than crashing playback). */
export function startedAtMapFromManifest(parsed: unknown): StartedAtByKey {
  const out: StartedAtByKey = new Map();
  const items = (parsed as { manifest?: unknown } | null)?.manifest;
  if (!Array.isArray(items)) return out;
  for (const entry of items) {
    if (!entry || typeof entry !== "object") continue;
    const { storage_key: storageKey, started_at: startedAt } = entry as {
      storage_key?: unknown;
      started_at?: unknown;
    };
    if (typeof storageKey !== "string" || !storageKey) continue;
    if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) continue;
    out.set(storageKey, startedAt);
  }
  return out;
}

// A Map from a chunk's GCS object key (== the recorder manifest's storage_key)
// to its TRUE recording-window START (the manifest `started_at` ISO). This is
// the authoritative anchor for timeline placement — see buildPlaylist. Built by
// RecordingReview from the session's manifest.json; empty/absent for legacy
// sessions (which then fall back to last_modified, exactly as before).
export type StartedAtByKey = Map<string, string>;

// Build the playlist for one session + source against a chosen test-start time.
//
// PLACEMENT ANCHOR (in priority order, per chunk):
//   1. RECORDING TIME (primary): when the chunk's manifest `started_at` is known
//      (startedAtByKey, keyed by the GCS object key) the chunk is placed at its
//      TRUE recording-window start — offsetSec = (started_at − testStart). This
//      is correct even when the object's last_modified (its GCS UPLOAD time) is
//      minutes late: the Tier-1 chunk buffer uploads an offline-recorded chunk
//      long after it was recorded, so last_modified would otherwise place the
//      chunk late and manufacture a PHANTOM gap (and desync the activity-log
//      markers, which use real event timestamps). started_at is the window
//      START, so we do NOT subtract CHUNK_SECONDS here.
//   2. UPLOAD TIME (fallback 1): no started_at but last_modified present — the
//      object is finalized when its 30s window CLOSES, so its START offset is
//      (last_modified − CHUNK_SECONDS). Today's behavior, unchanged. Correct for
//      direct (non-buffered) uploads where last_modified ≈ window close.
//   3. INDEX-CONTIGUOUS (fallback 2): neither stamp — place contiguously by
//      index, anchored on the session's created_at. Today's behavior, unchanged.
//
// Identical math for both sources — a camera chunk and its simultaneous screen
// chunk land on the same offset.
export function buildPlaylist(
  evidence: SessionEvidence[],
  sessionCreatedAt: string | undefined,
  testStartMs: number,
  source: RecordingSource = "screen",
  startedAtByKey?: StartedAtByKey
): TimelineChunk[] {
  const createdMs = sessionCreatedAt ? Date.parse(sessionCreatedAt) : NaN;
  const chunks = evidence
    .filter((file) => isSourceChunk(file, source))
    .map((file) => ({ file, index: chunkIndexFromKey(file.key, source) }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((a, b) => a.index - b.index);

  const placed = chunks.map((entry) => {
    const startedAtIso = startedAtByKey?.get(entry.file.key);
    const startedAtMs = startedAtIso ? Date.parse(startedAtIso) : NaN;
    const modifiedMs = entry.file.last_modified ? Date.parse(entry.file.last_modified) : NaN;
    let offsetSec: number;
    if (Number.isFinite(startedAtMs) && Number.isFinite(testStartMs)) {
      // PRIMARY: recording-window START. No CHUNK_SECONDS subtraction.
      offsetSec = (startedAtMs - testStartMs) / 1000;
    } else if (Number.isFinite(modifiedMs) && Number.isFinite(testStartMs)) {
      // FALLBACK 1: upload time approximates the window CLOSE.
      offsetSec = (modifiedMs - CHUNK_SECONDS * 1000 - testStartMs) / 1000;
    } else {
      // FALLBACK 2: index-based contiguous, anchored on created_at vs test start.
      const anchorOffset = Number.isFinite(createdMs) && Number.isFinite(testStartMs)
        ? (createdMs - testStartMs) / 1000
        : 0;
      offsetSec = (entry.index - 1) * CHUNK_SECONDS + anchorOffset;
    }
    return {
      index: entry.index,
      key: entry.file.key,
      url: entry.file.download_url,
      offsetSec,
      endSec: offsetSec + CHUNK_SECONDS
    };
  });

  // F1: order the playlist CHRONOLOGICALLY (offset, then index). For sessions
  // recorded after the index-continuation fix this equals index order; for
  // legacy multi-stint sessions whose restarts OVERWROTE early indexes with
  // late bytes, it restores true play order, keeps the player's binary-search
  // invariant (offsets sorted) intact, and makes the gap summary honest.
  return placed.sort((a, b) => a.offsetSec - b.offsetSec || a.index - b.index);
}
