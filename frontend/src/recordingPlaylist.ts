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

// Build the playlist for one session + source against a chosen test-start time.
//
// Each chunk is placed on the timeline by REAL time when its last_modified is
// known: a chunk's object is finalized when its 30s window CLOSES, so its START
// offset is (last_modified − CHUNK_SECONDS) relative to the test start. This is
// what correctly handles late-joiners (their first chunk lands after 0) and
// recording GAPS (a missing minute leaves a blank span). When last_modified is
// missing we fall back to index-based contiguous placement anchored on the
// session's created_at, so the playlist is still coherent. Identical math for
// both sources — a camera chunk and its simultaneous screen chunk land on the
// same offset.
export function buildPlaylist(
  evidence: SessionEvidence[],
  sessionCreatedAt: string | undefined,
  testStartMs: number,
  source: RecordingSource = "screen"
): TimelineChunk[] {
  const createdMs = sessionCreatedAt ? Date.parse(sessionCreatedAt) : NaN;
  const chunks = evidence
    .filter((file) => isSourceChunk(file, source))
    .map((file) => ({ file, index: chunkIndexFromKey(file.key, source) }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((a, b) => a.index - b.index);

  const placed = chunks.map((entry) => {
    const modifiedMs = entry.file.last_modified ? Date.parse(entry.file.last_modified) : NaN;
    let offsetSec: number;
    if (Number.isFinite(modifiedMs) && Number.isFinite(testStartMs)) {
      offsetSec = (modifiedMs - CHUNK_SECONDS * 1000 - testStartMs) / 1000;
    } else {
      // Index-based contiguous fallback, anchored on created_at vs test start.
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
