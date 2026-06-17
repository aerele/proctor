// F1 (e2e-live finding 2026-06-11) — chunk-index continuation + cumulative
// manifest across recording stints. Pure logic: the recorder must never reuse
// a prior stint's chunk indexes (GCS overwrite), and the end-of-test manifest
// must describe EVERY stint, not just the final recorder instance.
import { describe, expect, it } from "vitest";
import {
  chunkHwmKey,
  chunkIndexBase,
  clearChunkContinuity,
  mergeManifest,
  readChunkHwm,
  readStintManifest,
  stintManifestKey,
  writeChunkHwm,
  writeStintManifest,
  type KeyValueStorage
} from "./chunkContinuity";
import type { UploadManifestItem } from "./types";

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map)
  };
}

function item(kind: string, index: number, storageKey = `${kind}/chunk-${index}`): UploadManifestItem {
  return {
    kind,
    index,
    storage_key: storageKey,
    bytes: 1000,
    started_at: "2026-06-11T09:00:00.000Z",
    completed_at: "2026-06-11T09:00:01.000Z"
  };
}

describe("chunk hwm storage", () => {
  it("round-trips per (session, kind) and starts at 0", () => {
    const storage = memoryStorage();
    expect(readChunkHwm(storage, "s1", "screen")).toBe(0);
    writeChunkHwm(storage, "s1", "screen", 7);
    expect(readChunkHwm(storage, "s1", "screen")).toBe(7);
    // The camera series and other sessions are independent.
    expect(readChunkHwm(storage, "s1", "camera")).toBe(0);
    expect(readChunkHwm(storage, "s2", "screen")).toBe(0);
  });

  it("is monotonic — a lower or equal write never lowers the stored mark", () => {
    const storage = memoryStorage();
    writeChunkHwm(storage, "s1", "screen", 24);
    writeChunkHwm(storage, "s1", "screen", 3);
    writeChunkHwm(storage, "s1", "screen", 24);
    expect(readChunkHwm(storage, "s1", "screen")).toBe(24);
    writeChunkHwm(storage, "s1", "screen", 25);
    expect(readChunkHwm(storage, "s1", "screen")).toBe(25);
  });

  it("ignores garbage stored values and invalid writes", () => {
    const storage = memoryStorage({ [chunkHwmKey("s1", "screen")]: "twelve" });
    expect(readChunkHwm(storage, "s1", "screen")).toBe(0);
    writeChunkHwm(storage, "s1", "screen", -4);
    writeChunkHwm(storage, "s1", "screen", 1.5);
    writeChunkHwm(storage, "s1", "screen", 0);
    expect(readChunkHwm(storage, "s1", "screen")).toBe(0);
  });

  it("never throws when the storage is broken (private mode/quota)", () => {
    const broken: KeyValueStorage = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("denied"); }
    };
    expect(readChunkHwm(broken, "s1", "screen")).toBe(0);
    expect(() => writeChunkHwm(broken, "s1", "screen", 5)).not.toThrow();
    expect(() => clearChunkContinuity(broken, "s1")).not.toThrow();
  });
});

describe("chunkIndexBase", () => {
  it("takes the max over every knowledge leg", () => {
    expect(chunkIndexBase([24, 22, 25])).toBe(25); // local hwm ahead of server
    expect(chunkIndexBase([24, 24, 10])).toBe(24); // server ahead (new tab)
    expect(chunkIndexBase([0, 0, 0])).toBe(0); // fresh session
  });

  it("treats missing/garbage legs as 0 (pre-F1 backend, cleared storage)", () => {
    expect(chunkIndexBase([undefined, undefined, 7])).toBe(7);
    expect(chunkIndexBase([NaN, -3, undefined])).toBe(0);
    expect(chunkIndexBase([])).toBe(0);
    expect(chunkIndexBase([2.9])).toBe(2); // fractional garbage floors, never inflates
  });
});

describe("mergeManifest", () => {
  it("unions stints, de-duplicated by (kind, index), later items winning", () => {
    const stint1 = [item("screen", 1), item("screen", 2), item("camera", 1)];
    const stint2 = [item("screen", 2, "screen/chunk-2-retry"), item("screen", 3)];
    const merged = mergeManifest(stint1, stint2);
    expect(merged.map((m) => `${m.kind}:${m.index}`)).toEqual([
      "camera:1", "screen:1", "screen:2", "screen:3"
    ]);
    expect(merged.find((m) => m.kind === "screen" && m.index === 2)?.storage_key).toBe("screen/chunk-2-retry");
  });

  it("keeps a multi-stint MONOTONIC series intact (the F1 fix shape)", () => {
    // Stint 1 uploaded 1..3; stint 2 continued at 4..5 — nothing collides,
    // the cumulative manifest covers all five chunks.
    const merged = mergeManifest(
      [item("screen", 1), item("screen", 2), item("screen", 3)],
      [item("screen", 4), item("screen", 5)]
    );
    expect(merged.map((m) => m.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it("tolerates empty/garbage inputs", () => {
    expect(mergeManifest([], [])).toEqual([]);
    const withGarbage = mergeManifest(
      [item("screen", 1), null as unknown as UploadManifestItem],
      []
    );
    expect(withGarbage).toHaveLength(1);
  });
});

describe("stint manifest persistence", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    const items = [item("screen", 1), item("camera", 1)];
    writeStintManifest(storage, "s1", items);
    expect(readStintManifest(storage, "s1")).toEqual(items);
    // Other sessions stay independent.
    expect(readStintManifest(storage, "s2")).toEqual([]);
  });

  it("returns [] for absent, corrupt, or non-array stored values", () => {
    const storage = memoryStorage({
      [stintManifestKey("bad-json")]: "{not json",
      [stintManifestKey("not-array")]: JSON.stringify({ kind: "screen" })
    });
    expect(readStintManifest(storage, "missing")).toEqual([]);
    expect(readStintManifest(storage, "bad-json")).toEqual([]);
    expect(readStintManifest(storage, "not-array")).toEqual([]);
  });

  it("filters malformed entries out of a stored array", () => {
    const storage = memoryStorage({
      [stintManifestKey("s1")]: JSON.stringify([item("screen", 1), { bogus: true }, null, item("camera", 2)])
    });
    expect(readStintManifest(storage, "s1").map((m) => `${m.kind}:${m.index}`)).toEqual(["screen:1", "camera:2"]);
  });
});

describe("clearChunkContinuity", () => {
  it("removes both hwm keys and the stint manifest for the session only", () => {
    const storage = memoryStorage();
    writeChunkHwm(storage, "s1", "screen", 9);
    writeChunkHwm(storage, "s1", "camera", 8);
    writeStintManifest(storage, "s1", [item("screen", 1)]);
    writeChunkHwm(storage, "s2", "screen", 3);
    clearChunkContinuity(storage, "s1");
    expect(readChunkHwm(storage, "s1", "screen")).toBe(0);
    expect(readChunkHwm(storage, "s1", "camera")).toBe(0);
    expect(readStintManifest(storage, "s1")).toEqual([]);
    expect(readChunkHwm(storage, "s2", "screen")).toBe(3);
  });
});
