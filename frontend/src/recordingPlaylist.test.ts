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
  isManifestEvidence,
  isSourceChunk,
  startedAtMapFromManifest
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

// --- Recording-time anchor (manifest started_at) ---------------------------
// The Tier-1 chunk buffer uploads an offline-recorded chunk minutes after it
// was recorded, so its GCS last_modified is late and the OLD (last_modified −
// CHUNK_SECONDS) math placed it late → a phantom gap + a timeline clock jump.
// The recorder manifest records each chunk's started_at keyed by storage_key
// (== the GCS object key), which buildPlaylist uses as the primary anchor.
// CRITICAL: the recorder stamps started_at at the chunk window CLOSE (the single
// dataavailable/stop event ~CHUNK_SECONDS after recorder.start() —
// useProctorRecorder.ts L1254-1257 + L511/550/597), so it maps to the window
// START via − CHUNK_SECONDS, same form as the last_modified path. The ONLY
// difference is the SOURCE (recording-close time vs upload time), which is
// exactly what fixes buffered chunks (started_at carries the real recording time
// even when the upload lands minutes late).
describe("startedAtMapFromManifest", () => {
  it("maps storage_key → started_at from a well-formed manifest body", () => {
    const map = startedAtMapFromManifest({
      session_id: "s1",
      ended_at: "2026-06-05T09:10:00.000Z",
      manifest: [
        { kind: "screen", index: 1, storage_key: `${PREFIX}screen/chunk-00001.webm`, started_at: "2026-06-05T09:00:00.000Z" },
        { kind: "screen", index: 2, storage_key: `${PREFIX}screen/chunk-00002.webm`, started_at: "2026-06-05T09:00:30.000Z" }
      ]
    });
    expect(map.size).toBe(2);
    expect(map.get(`${PREFIX}screen/chunk-00001.webm`)).toBe("2026-06-05T09:00:00.000Z");
  });

  it("(f) tolerates malformed / partial input without throwing", () => {
    expect(startedAtMapFromManifest(null).size).toBe(0);
    expect(startedAtMapFromManifest(undefined).size).toBe(0);
    expect(startedAtMapFromManifest("not json").size).toBe(0);
    expect(startedAtMapFromManifest({}).size).toBe(0);
    expect(startedAtMapFromManifest({ manifest: "nope" }).size).toBe(0);
    // PARTIAL: only entries with a usable storage_key + parseable started_at survive.
    const partial = startedAtMapFromManifest({
      manifest: [
        { storage_key: `${PREFIX}screen/chunk-00001.webm`, started_at: "2026-06-05T09:00:00.000Z" },
        { storage_key: `${PREFIX}screen/chunk-00002.webm` }, // no started_at
        { started_at: "2026-06-05T09:01:00.000Z" }, // no storage_key
        { storage_key: `${PREFIX}screen/chunk-00003.webm`, started_at: "not-a-date" },
        null,
        42
      ]
    });
    expect(partial.size).toBe(1);
    expect(partial.has(`${PREFIX}screen/chunk-00001.webm`)).toBe(true);
  });
});

describe("isManifestEvidence", () => {
  it("matches the session manifest.json object only", () => {
    expect(isManifestEvidence(file(`${PREFIX}manifest.json`))).toBe(true);
    expect(isManifestEvidence(file(`${PREFIX}screen/chunk-00001.webm`))).toBe(false);
    expect(isManifestEvidence(file(`${PREFIX}events/events-1.jsonl`))).toBe(false);
  });
});

describe("buildPlaylist — recording-time anchor (manifest started_at)", () => {
  const testStartMs = Date.parse("2026-06-05T09:00:00.000Z");

  // (a) BUFFERED chunk: started_at is the window CLOSE (so chunk 1 of a test that
  // starts at T0 stamps started_at = T0 + CHUNK_SECONDS, chunk 2 = T0 + 2·CHUNK).
  // last_modified is +60s/+90s late (the buffer drained the chunk long after
  // recording). Placement uses started_at − CHUNK_SECONDS, so chunk 1 lands at the
  // window OPEN (offset 0) with NO phantom gap — the late upload time is ignored.
  it("(a) places a buffered chunk at its window-open offset, not its late last_modified — no phantom gap", () => {
    const evidence = [
      // Recorded 09:00:00→09:00:30, but the buffer uploaded it at 09:01:30 (+60s late).
      file(`${PREFIX}screen/chunk-00001.webm`, "2026-06-05T09:01:30.000Z"),
      // Recorded 09:00:30→09:01:00, uploaded at 09:02:30 (+90s late).
      file(`${PREFIX}screen/chunk-00002.webm`, "2026-06-05T09:02:30.000Z")
    ];
    const startedAt = new Map([
      // started_at = window CLOSE: chunk 1 closes at T0+30, chunk 2 at T0+60.
      [`${PREFIX}screen/chunk-00001.webm`, "2026-06-05T09:00:30.000Z"],
      [`${PREFIX}screen/chunk-00002.webm`, "2026-06-05T09:01:00.000Z"]
    ]);
    const playlist = buildPlaylist(evidence, "2026-06-05T09:00:00.000Z", testStartMs, "screen", startedAt);
    // Window-CLOSE started_at − CHUNK_SECONDS → window-OPEN offsets 0 and 30.
    expect(playlist.map((c) => c.offsetSec)).toEqual([0, 30]);
    // Contiguous: chunk-2 starts exactly when chunk-1 ends — no gap.
    expect(playlist[1].offsetSec - playlist[0].endSec).toBe(0);
  });

  // (b) REAL gap: the recording actually stopped — started_at (window CLOSE)
  // jumps by far more than CHUNK_SECONDS. The gap STILL renders from the
  // corrected (− CHUNK_SECONDS) offsets.
  it("(b) preserves a real recording gap when started_at jumps past one window", () => {
    const evidence = [
      file(`${PREFIX}screen/chunk-00001.webm`, "2026-06-05T09:00:30.000Z"),
      file(`${PREFIX}screen/chunk-00002.webm`, "2026-06-05T09:05:30.000Z")
    ];
    const startedAt = new Map([
      // Chunk 1 recorded 09:00:00→09:00:30, closes (started_at) at 09:00:30.
      [`${PREFIX}screen/chunk-00001.webm`, "2026-06-05T09:00:30.000Z"],
      // Recording stopped ~4.5 min; chunk 2 recorded 09:05:00→09:05:30, closes at 09:05:30.
      [`${PREFIX}screen/chunk-00002.webm`, "2026-06-05T09:05:30.000Z"]
    ]);
    const playlist = buildPlaylist(evidence, "2026-06-05T09:00:00.000Z", testStartMs, "screen", startedAt);
    // Window-OPEN offsets: chunk 1 at 0, chunk 2 at 300 (09:05:00).
    expect(playlist.map((c) => c.offsetSec)).toEqual([0, 300]);
    // A real 270s blank between chunk-1's end (30) and chunk-2's start (300).
    expect(playlist[1].offsetSec - playlist[0].endSec).toBe(270);
  });

  // (c) MISSING started_at (legacy session / no manifest): falls back to the
  // EXACT last_modified (− CHUNK_SECONDS) placement of today.
  it("(c) falls back to last_modified (−CHUNK_SECONDS) when started_at is absent", () => {
    const evidence = [
      file(`${PREFIX}screen/chunk-00001.webm`, "2026-06-05T09:00:30.000Z"),
      file(`${PREFIX}screen/chunk-00002.webm`, "2026-06-05T09:01:00.000Z")
    ];
    const withMap = buildPlaylist(evidence, "2026-06-05T09:00:00.000Z", testStartMs, "screen", new Map());
    const noMap = buildPlaylist(evidence, "2026-06-05T09:00:00.000Z", testStartMs, "screen");
    expect(withMap.map((c) => c.offsetSec)).toEqual([0, 30]);
    expect(withMap.map((c) => c.offsetSec)).toEqual(noMap.map((c) => c.offsetSec));
  });

  // (d) NON-buffered session (REALISTIC producer data): both started_at and
  // last_modified are the window CLOSE within ~1-2s of each other (started_at is
  // the recorder's dataavailable/stop time, last_modified is GCS's finalize time
  // for the same direct upload). Anchored placement (started_at − CHUNK_SECONDS)
  // must stay within ~1s of the legacy (last_modified − CHUNK_SECONDS) placement —
  // i.e. NO regression on direct uploads vs today.
  it("(d) non-buffered placement is unchanged (within ~1s) vs last_modified", () => {
    const evidence = [
      file(`${PREFIX}screen/chunk-00001.webm`, "2026-06-05T09:00:31.200Z"),
      file(`${PREFIX}screen/chunk-00002.webm`, "2026-06-05T09:01:01.400Z")
    ];
    const startedAt = new Map([
      // started_at ≈ last_modified (both window close; direct upload, no buffer delay).
      [`${PREFIX}screen/chunk-00001.webm`, "2026-06-05T09:00:30.500Z"],
      [`${PREFIX}screen/chunk-00002.webm`, "2026-06-05T09:01:00.700Z"]
    ]);
    const anchored = buildPlaylist(evidence, "2026-06-05T09:00:00.000Z", testStartMs, "screen", startedAt);
    const legacy = buildPlaylist(evidence, "2026-06-05T09:00:00.000Z", testStartMs, "screen");
    anchored.forEach((c, i) => {
      expect(Math.abs(c.offsetSec - legacy[i].offsetSec)).toBeLessThanOrEqual(1);
    });
    // And both land within ~1s of the window-open offsets 0 / 30.
    expect(Math.abs(anchored[0].offsetSec - 0)).toBeLessThanOrEqual(1);
    expect(Math.abs(anchored[1].offsetSec - 30)).toBeLessThanOrEqual(1);
  });

  // (e) Activity-log markers use real event timestamps on the SAME test-relative
  // base ((eventMs − testStartMs)/1000). With chunks placed at the window OPEN
  // (started_at − CHUNK_SECONDS, also test-relative), an event recorded mid-chunk
  // lands inside that chunk's span — the two are aligned. (RecordingReview
  // computes both; this pins the math.)
  it("(e) an event at a chunk's real time lands inside that chunk's placed span", () => {
    const evidence = [file(`${PREFIX}screen/chunk-00003.webm`, "2026-06-05T09:11:30.000Z")];
    const startedAt = new Map([
      // Buffered: recorded over the window [09:01:00, 09:01:30] so started_at (the
      // window CLOSE) is 09:01:30 — but the buffer uploaded it ~10 min late.
      [`${PREFIX}screen/chunk-00003.webm`, "2026-06-05T09:01:30.000Z"]
    ]);
    const playlist = buildPlaylist(evidence, "2026-06-05T09:00:00.000Z", testStartMs, "screen", startedAt);
    // started_at (09:01:30) − CHUNK_SECONDS → window-OPEN offset 60s.
    expect(playlist[0].offsetSec).toBe(60);
    // An event fired at 09:01:15 (mid-window) → marker offset 75s, inside [60, 90].
    const markerOffset = (Date.parse("2026-06-05T09:01:15.000Z") - testStartMs) / 1000;
    expect(markerOffset).toBe(75);
    expect(markerOffset).toBeGreaterThanOrEqual(playlist[0].offsetSec);
    expect(markerOffset).toBeLessThan(playlist[0].endSec);
    // Had we used the late last_modified, the chunk would be placed at offset ~630
    // (10.5 min in) and the real event would fall OUTSIDE it — the old desync.
  });

  // (f) Partial manifest: only some chunks have started_at → per-chunk fallback,
  // no crash. The covered chunk uses started_at; the rest use last_modified.
  it("(f) mixes started_at and last_modified per chunk for a partial manifest", () => {
    const evidence = [
      file(`${PREFIX}screen/chunk-00001.webm`, "2026-06-05T09:02:00.000Z"), // late upload
      file(`${PREFIX}screen/chunk-00002.webm`, "2026-06-05T09:01:00.000Z") // direct upload
    ];
    // Only chunk-1 is in the manifest map; its started_at is the window CLOSE.
    const startedAt = new Map([[`${PREFIX}screen/chunk-00001.webm`, "2026-06-05T09:00:30.000Z"]]);
    const playlist = buildPlaylist(evidence, "2026-06-05T09:00:00.000Z", testStartMs, "screen", startedAt);
    const byKey = Object.fromEntries(playlist.map((c) => [c.key, c.offsetSec]));
    // chunk-1: started_at (− CHUNK_SECONDS) anchor → 0 (NOT the +120s its late last_modified implies).
    expect(byKey[`${PREFIX}screen/chunk-00001.webm`]).toBe(0);
    // chunk-2: no started_at → last_modified − CHUNK_SECONDS → 30.
    expect(byKey[`${PREFIX}screen/chunk-00002.webm`]).toBe(30);
  });

  it("camera + screen still share offsets when both carry started_at", () => {
    const evidence = [
      file(`${PREFIX}screen/chunk-00001.webm`, "2026-06-05T09:09:00.000Z"),
      file(`${PREFIX}camera/chunk-00001.webm`, "2026-06-05T09:09:00.000Z")
    ];
    const startedAt = new Map([
      // started_at = window CLOSE for chunk 1 of a test starting at 09:00:00.
      [`${PREFIX}screen/chunk-00001.webm`, "2026-06-05T09:00:30.000Z"],
      [`${PREFIX}camera/chunk-00001.webm`, "2026-06-05T09:00:30.000Z"]
    ]);
    const screen = buildPlaylist(evidence, "2026-06-05T09:00:00.000Z", testStartMs, "screen", startedAt);
    const camera = buildPlaylist(evidence, "2026-06-05T09:00:00.000Z", testStartMs, "camera", startedAt);
    expect(screen[0].offsetSec).toBe(0);
    expect(camera[0].offsetSec).toBe(screen[0].offsetSec);
  });

  // (GUARD — regression sentinel) The recorder stamps started_at at the chunk
  // window CLOSE, so buildPlaylist MUST subtract CHUNK_SECONDS to recover the
  // window OPEN. This test feeds window-CLOSE started_at values and asserts that
  // an activity-log marker for an event fired DURING the recording window lands
  // inside the placed chunk span. It FAILS against the buggy no-subtraction code
  // (which would place the chunk CHUNK_SECONDS too late, pushing the event before
  // the chunk's start) and PASSES after the correction — so the ~30s over-shift
  // regression can never silently return.
  it("(GUARD) window-close started_at keeps the chunk aligned to its mid-window activity marker", () => {
    // Chunk recorded over the window [09:02:00, 09:02:30]; the recorder stamps
    // started_at at the CLOSE (09:02:30). A direct upload, so last_modified is the
    // same close time — the failure mode here is purely the CHUNK_SECONDS offset.
    const evidence = [file(`${PREFIX}screen/chunk-00005.webm`, "2026-06-05T09:02:30.000Z")];
    const startedAt = new Map([[`${PREFIX}screen/chunk-00005.webm`, "2026-06-05T09:02:30.000Z"]]);
    const playlist = buildPlaylist(evidence, "2026-06-05T09:00:00.000Z", testStartMs, "screen", startedAt);

    // CORRECT placement: window OPEN = started_at − CHUNK_SECONDS = 09:02:00 → 120s.
    // The buggy code (no subtraction) would place it at 150s — off by CHUNK_SECONDS.
    expect(playlist[0].offsetSec).toBe(120);
    expect(playlist[0].endSec).toBe(150);

    // An event fired at 09:02:10 (10s into the real recording window) → marker
    // offset 130s. It MUST sit inside [offsetSec, endSec). Under the buggy +30s
    // placement the chunk span would be [150, 180) and 130 would fall OUTSIDE it
    // (before the chunk) — the exact activity-marker desync this guards against.
    const markerOffset = (Date.parse("2026-06-05T09:02:10.000Z") - testStartMs) / 1000;
    expect(markerOffset).toBe(130);
    expect(markerOffset).toBeGreaterThanOrEqual(playlist[0].offsetSec);
    expect(markerOffset).toBeLessThan(playlist[0].endSec);
  });
});

// The exact composition RecordingReview performs: locate the manifest.json
// evidence object, parse its (fetched) JSON body into the started_at map, and
// feed that map to buildPlaylist. Tested here as pure data so the join is
// covered without a DOM test environment (the suite is node-only).
describe("RecordingReview manifest join (composition)", () => {
  const testStartMs = Date.parse("2026-06-05T09:00:00.000Z");

  function joinAndBuild(evidence: SessionEvidence[], manifestBody: unknown) {
    const manifestEvidence = evidence.find(isManifestEvidence);
    expect(manifestEvidence).toBeDefined(); // manifest.json is listed in evidence
    const map = startedAtMapFromManifest(manifestBody);
    return buildPlaylist(evidence, "2026-06-05T09:00:00.000Z", testStartMs, "screen", map);
  }

  it("anchors a buffered session on manifest started_at, killing the phantom gap", () => {
    const evidence: SessionEvidence[] = [
      file(`${PREFIX}screen/chunk-00001.webm`, "2026-06-05T09:00:30.000Z"),
      file(`${PREFIX}screen/chunk-00002.webm`, "2026-06-05T09:03:00.000Z"), // +120s late upload
      file(`${PREFIX}manifest.json`)
    ];
    const manifestBody = {
      session_id: "s1",
      ended_at: "2026-06-05T09:02:00.000Z",
      manifest: [
        // started_at = window CLOSE (chunk 1 closes at +30, chunk 2 at +60).
        { kind: "screen", index: 1, storage_key: `${PREFIX}screen/chunk-00001.webm`, started_at: "2026-06-05T09:00:30.000Z" },
        { kind: "screen", index: 2, storage_key: `${PREFIX}screen/chunk-00002.webm`, started_at: "2026-06-05T09:01:00.000Z" }
      ]
    };
    const playlist = joinAndBuild(evidence, manifestBody);
    expect(playlist.map((c) => c.offsetSec)).toEqual([0, 30]); // contiguous, no gap
  });

  it("degrades to last_modified when the manifest body is malformed", () => {
    const evidence: SessionEvidence[] = [
      file(`${PREFIX}screen/chunk-00001.webm`, "2026-06-05T09:00:30.000Z"),
      file(`${PREFIX}screen/chunk-00002.webm`, "2026-06-05T09:01:00.000Z"),
      file(`${PREFIX}manifest.json`)
    ];
    const playlist = joinAndBuild(evidence, { garbage: true });
    expect(playlist.map((c) => c.offsetSec)).toEqual([0, 30]); // last_modified fallback
  });
});

describe("hasCameraChunks", () => {
  it("true only when the evidence carries at least one camera chunk", () => {
    expect(hasCameraChunks(MIXED)).toBe(true);
    expect(hasCameraChunks(MIXED.filter((e) => !e.key.includes("camera/")))).toBe(false);
    expect(hasCameraChunks([])).toBe(false);
  });
});
