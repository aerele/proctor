// F10.1 — playlist-by-source logic for the recordings review (pure; extracted
// from RecordingReview.tsx so the Screen/Camera source toggle is vitest-
// covered). The camera stream is a SEPARATE chunk series under camera/ with
// its own 1-based indexes; both sources share the same created_at/
// last_modified-anchored offset math so the timeline lines up across sources.
import { describe, expect, it } from "vitest";
import {
  CHUNK_SECONDS,
  buildPlaylist,
  chunkIndexFromKey,
  hasCameraChunks,
  isSourceChunk
} from "./recordingPlaylist";
import type { SessionEvidence } from "./types";

const PREFIX = "contests/kec-2026/sessions/alice/s1/";

function file(key: string, lastModified?: string): SessionEvidence {
  return { key, size: 1000, last_modified: lastModified, download_url: `https://signed.example/${key}` };
}

const MIXED: SessionEvidence[] = [
  file(`${PREFIX}screen/chunk-00001.webm`, "2026-06-05T09:00:30.000Z"),
  file(`${PREFIX}screen/chunk-00002.webm`, "2026-06-05T09:01:00.000Z"),
  file(`${PREFIX}camera/chunk-00001.webm`, "2026-06-05T09:00:30.000Z"),
  file(`${PREFIX}camera/chunk-00002.webm`, "2026-06-05T09:01:00.000Z"),
  file(`${PREFIX}manifest.json`),
  file(`${PREFIX}events/events-1.jsonl`)
];

describe("chunkIndexFromKey", () => {
  it("parses the 1-based index for the matching source only", () => {
    expect(chunkIndexFromKey(`${PREFIX}screen/chunk-00007.webm`, "screen")).toBe(7);
    expect(chunkIndexFromKey(`${PREFIX}camera/chunk-00007.webm`, "camera")).toBe(7);
    expect(chunkIndexFromKey(`${PREFIX}camera/chunk-00007.webm`, "screen")).toBeNaN();
    expect(chunkIndexFromKey(`${PREFIX}screen/chunk-00007.webm`, "camera")).toBeNaN();
  });

  it("accepts the .bin fallback extension and rejects non-chunk keys", () => {
    expect(chunkIndexFromKey(`${PREFIX}camera/chunk-00003.bin`, "camera")).toBe(3);
    expect(chunkIndexFromKey(`${PREFIX}manifest.json`, "screen")).toBeNaN();
    expect(chunkIndexFromKey(`${PREFIX}events/events-1.jsonl`, "camera")).toBeNaN();
  });
});

describe("isSourceChunk", () => {
  it("matches only the requested source's chunk files", () => {
    expect(isSourceChunk(MIXED[0], "screen")).toBe(true);
    expect(isSourceChunk(MIXED[0], "camera")).toBe(false);
    expect(isSourceChunk(MIXED[2], "camera")).toBe(true);
    expect(isSourceChunk(MIXED[2], "screen")).toBe(false);
    expect(isSourceChunk(MIXED[4], "screen")).toBe(false);
    expect(isSourceChunk(MIXED[4], "camera")).toBe(false);
  });
});

describe("buildPlaylist", () => {
  const testStartMs = Date.parse("2026-06-05T09:00:00.000Z");

  it("filters by source: screen playlist carries only screen chunks", () => {
    const screen = buildPlaylist(MIXED, "2026-06-05T09:00:00.000Z", testStartMs, "screen");
    expect(screen.map((c) => c.key)).toEqual([
      `${PREFIX}screen/chunk-00001.webm`,
      `${PREFIX}screen/chunk-00002.webm`
    ]);
  });

  it("camera playlist carries only camera chunks, on the SAME offsets as matching screen chunks", () => {
    const screen = buildPlaylist(MIXED, "2026-06-05T09:00:00.000Z", testStartMs, "screen");
    const camera = buildPlaylist(MIXED, "2026-06-05T09:00:00.000Z", testStartMs, "camera");
    expect(camera.map((c) => c.key)).toEqual([
      `${PREFIX}camera/chunk-00001.webm`,
      `${PREFIX}camera/chunk-00002.webm`
    ]);
    // Identical last_modified stamps → identical timeline offsets across sources.
    expect(camera.map((c) => c.offsetSec)).toEqual(screen.map((c) => c.offsetSec));
    expect(camera[0].offsetSec).toBe(0);
    expect(camera[0].endSec).toBe(CHUNK_SECONDS);
    expect(camera[1].offsetSec).toBe(30);
  });

  it("defaults to the screen source (existing call sites unchanged)", () => {
    const playlist = buildPlaylist(MIXED, "2026-06-05T09:00:00.000Z", testStartMs);
    expect(playlist).toHaveLength(2);
    expect(playlist.every((c) => c.key.includes("screen/"))).toBe(true);
  });

  it("falls back to index-contiguous placement anchored on created_at when last_modified is missing", () => {
    const noStamps = [
      file(`${PREFIX}camera/chunk-00001.webm`),
      file(`${PREFIX}camera/chunk-00002.webm`)
    ];
    // Session created 60s after the chosen test start → first chunk at +60s.
    const playlist = buildPlaylist(noStamps, "2026-06-05T09:01:00.000Z", testStartMs, "camera");
    expect(playlist.map((c) => c.offsetSec)).toEqual([60, 90]);
  });

  it("sorts by index and drops non-matching keys", () => {
    const shuffled = [MIXED[3], MIXED[5], MIXED[2], MIXED[4]];
    const playlist = buildPlaylist(shuffled, "2026-06-05T09:00:00.000Z", testStartMs, "camera");
    expect(playlist.map((c) => c.index)).toEqual([1, 2]);
  });

  // F1 (e2e finding): multi-stint sessions. With monotonic indexes every
  // stint's chunks SURVIVE; the playlist places each at its true recorded
  // time, leaving the restart window as an honest gap.
  it("places a two-stint session chronologically with the real gap between stints", () => {
    const twoStints = [
      // Stint 1: chunks 1-2 (09:00:30 / 09:01:00 = offsets 0 / 30).
      file(`${PREFIX}screen/chunk-00001.webm`, "2026-06-05T09:00:30.000Z"),
      file(`${PREFIX}screen/chunk-00002.webm`, "2026-06-05T09:01:00.000Z"),
      // Share drop + recovery → stint 2 CONTINUES at 3-4, ~5 minutes later.
      file(`${PREFIX}screen/chunk-00003.webm`, "2026-06-05T09:06:30.000Z"),
      file(`${PREFIX}screen/chunk-00004.webm`, "2026-06-05T09:07:00.000Z")
    ];
    const playlist = buildPlaylist(twoStints, "2026-06-05T09:00:00.000Z", testStartMs, "screen");
    expect(playlist.map((c) => c.index)).toEqual([1, 2, 3, 4]);
    expect(playlist.map((c) => c.offsetSec)).toEqual([0, 30, 360, 390]);
    // The restart window (60s..360s) is a real blank between chunk 2 and 3 —
    // RecordingReview derives its gap summary from exactly these spans.
    expect(playlist[2].offsetSec - playlist[1].endSec).toBe(300);
  });

  // Backward compat: a LEGACY overwritten session (recorded before the F1 fix)
  // has early indexes carrying LATE bytes (the final stint overwrote them).
  // The playlist orders by true recorded time, so offsets stay monotonic (the
  // player's binary-search/auto-advance invariant) even though the index order
  // disagrees.
  it("orders a legacy overwritten session by recorded time, keeping offsets monotonic", () => {
    const legacy = [
      // chunk 1-2 were overwritten by the final stint (late timestamps)...
      file(`${PREFIX}screen/chunk-00001.webm`, "2026-06-05T09:30:30.000Z"),
      file(`${PREFIX}screen/chunk-00002.webm`, "2026-06-05T09:31:00.000Z"),
      // ...while chunk 3-4 still carry the FIRST stint (early timestamps).
      file(`${PREFIX}screen/chunk-00003.webm`, "2026-06-05T09:01:30.000Z"),
      file(`${PREFIX}screen/chunk-00004.webm`, "2026-06-05T09:02:00.000Z")
    ];
    const playlist = buildPlaylist(legacy, "2026-06-05T09:00:00.000Z", testStartMs, "screen");
    expect(playlist.map((c) => c.index)).toEqual([3, 4, 1, 2]);
    const offsets = playlist.map((c) => c.offsetSec);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });
});

describe("hasCameraChunks", () => {
  it("true only when the evidence carries at least one camera chunk", () => {
    expect(hasCameraChunks(MIXED)).toBe(true);
    expect(hasCameraChunks(MIXED.filter((e) => !e.key.includes("camera/")))).toBe(false);
    expect(hasCameraChunks([])).toBe(false);
  });
});
