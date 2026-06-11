// frontend/src/chunkContinuity.ts — F1 (e2e-live finding 2026-06-11): pure
// logic that keeps recording-chunk indexes MONOTONIC across recorder restarts
// within one session, and the upload manifest CUMULATIVE across those stints.
//
// Background: the recorder counts chunks per instance. Every restart (share-
// drop recovery, lock→unlock, refresh-resume) used to re-count from 1 and
// OVERWRITE the prior stint's GCS objects (screen/chunk-00001.webm, ...), and
// the end-of-test manifest only described the final instance.
//
// Fix shape (three belts, any one of which prevents an overwrite):
//   1. sessionStorage high-water mark per (session, kind) — written by the
//      recorder at every index allocation, read as a continuation base on the
//      next start (covers in-tab restarts and same-tab refresh-resume).
//   2. server-reported chunk_count / *_chunk_index_hwm on start/resume
//      (covers a brand-new tab/window after a crash).
//   3. server-side bump in /api/upload-url (covers stale cached bundles).
// The continuation base is the MAX over every leg.
//
// No React, no network — storage is injected (vitest runs without a DOM).
import type { UploadManifestItem } from "./types";

export type ChunkKind = "screen" | "camera";

/** Minimal Storage surface (window.sessionStorage satisfies it). */
export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const HWM_PREFIX = "proctor_chunk_hwm::";
const STINT_MANIFEST_PREFIX = "proctor_stint_manifest::";

// Defensive cap: a 3h session at 30s chunks is ~720 entries across both kinds;
// 4000 keeps even pathological sessions far below the storage quota.
const MAX_STORED_MANIFEST_ITEMS = 4000;

export function chunkHwmKey(sessionId: string, kind: ChunkKind): string {
  return `${HWM_PREFIX}${sessionId}::${kind}`;
}

export function stintManifestKey(sessionId: string): string {
  return `${STINT_MANIFEST_PREFIX}${sessionId}`;
}

/** Stored high-water mark for (session, kind): 0 on absence/garbage/negative. */
export function readChunkHwm(storage: KeyValueStorage, sessionId: string, kind: ChunkKind): number {
  try {
    const raw = storage.getItem(chunkHwmKey(sessionId, kind));
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Persist the high-water mark — MONOTONIC (never lowers a stored value) and
 * never throws (private mode / quota failures degrade to the server legs). */
export function writeChunkHwm(storage: KeyValueStorage, sessionId: string, kind: ChunkKind, index: number): void {
  if (!Number.isInteger(index) || index <= 0) return;
  try {
    if (index <= readChunkHwm(storage, sessionId, kind)) return;
    storage.setItem(chunkHwmKey(sessionId, kind), String(index));
  } catch {
    // best-effort: the server-side legs still prevent overwrites
  }
}

/** The continuation base for a kind: the MAX over every knowledge leg (server
 * count, server hwm, local hwm). The recorder's first chunk of the new stint
 * is base+1, so no surviving object's index is ever reused. Garbage legs
 * (undefined / NaN / negative / fractional) count as 0. */
export function chunkIndexBase(legs: Array<number | undefined>): number {
  let base = 0;
  for (const leg of legs) {
    const value = Number(leg);
    if (Number.isFinite(value) && value > base) base = Math.floor(value);
  }
  return base;
}

/** Union two manifest lists de-duplicated by (kind, index) — later items win
 * (they carry fresher storage keys/timestamps) — sorted by kind then index so
 * the stored manifest reads chronologically per series. */
export function mergeManifest(prior: UploadManifestItem[], next: UploadManifestItem[]): UploadManifestItem[] {
  const byKey = new Map<string, UploadManifestItem>();
  for (const item of [...prior, ...next]) {
    if (!item || typeof item !== "object") continue;
    byKey.set(`${item.kind}::${item.index}`, item);
  }
  return [...byKey.values()].sort((a, b) =>
    a.kind === b.kind ? a.index - b.index : String(a.kind).localeCompare(String(b.kind))
  );
}

/** Prior stints' manifest items persisted for this session ([] on garbage). */
export function readStintManifest(storage: KeyValueStorage, sessionId: string): UploadManifestItem[] {
  try {
    const raw = storage.getItem(stintManifestKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is UploadManifestItem =>
        Boolean(item) && typeof item === "object"
        && typeof (item as UploadManifestItem).kind === "string"
        && Number.isFinite((item as UploadManifestItem).index)
    );
  } catch {
    return [];
  }
}

/** Persist the accumulated manifest (bounded, never throws). */
export function writeStintManifest(storage: KeyValueStorage, sessionId: string, items: UploadManifestItem[]): void {
  try {
    storage.setItem(stintManifestKey(sessionId), JSON.stringify(items.slice(-MAX_STORED_MANIFEST_ITEMS)));
  } catch {
    // best-effort: losing the persisted copy only thins the manifest bookkeeping
  }
}

/** End-of-session cleanup: drop both hwm keys and the stint manifest. */
export function clearChunkContinuity(storage: KeyValueStorage, sessionId: string): void {
  try {
    storage.removeItem(chunkHwmKey(sessionId, "screen"));
    storage.removeItem(chunkHwmKey(sessionId, "camera"));
    storage.removeItem(stintManifestKey(sessionId));
  } catch {
    // best-effort
  }
}
