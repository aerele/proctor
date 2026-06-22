// frontend/src/admin/takeHomeDemoApi.test.ts — T-F8.
//
// The take-at-home admin card saves `take_home_enabled` + `proctor_contact_phone`
// through updateContestApi. The real backend JSON.stringify's the whole body so
// top-level fields pass through untouched; the DEMO path has an explicit
// whitelist (api.ts updateContestApi), so the two remote fields would silently
// drop unless they are added to it (A-2). This pins that whitelist passthrough.
//
// api.ts captures `VITE_DEMO_MODE` at module load, so each case imports it in a
// FRESH module registry (vi.resetModules) with the env stubbed — same pattern as
// demoFreezeNow.test.ts. The demo store is window.localStorage; the suite runs in
// pure node (no jsdom), so a minimal in-memory localStorage shim is installed,
// matching the codebase's "inject a fake" style (chunkBuffer.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear()
  };
}

beforeEach(() => {
  // Minimal window (localStorage + setTimeout) so the demo path works in node (no jsdom).
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: memoryStorage(),
    setTimeout: (fn: (...args: unknown[]) => void, ms?: number) => setTimeout(fn, ms)
  };
  vi.stubEnv("VITE_DEMO_MODE", "true");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("updateContestApi demo passthrough — take-home fields (T-F8)", () => {
  it("reflects take_home_enabled + proctor_contact_phone in the returned contest", async () => {
    const api = await import("../api");
    const updated = await api.updateContestApi("demo", {
      slug: "demo-drive-r1",
      take_home_enabled: true,
      proctor_contact_phone: "+91 98765 43210"
    });
    expect(updated.take_home_enabled).toBe(true);
    expect(updated.proctor_contact_phone).toBe("+91 98765 43210");
  });

  it("persists the take-home fields across reads of the demo store", async () => {
    const api = await import("../api");
    await api.updateContestApi("demo", {
      slug: "demo-drive-r1",
      take_home_enabled: true,
      proctor_contact_phone: "+91 99999 00000"
    });
    const contests = await api.fetchContests("demo");
    const reread = contests.find((contest) => contest.slug === "demo-drive-r1");
    expect(reread?.take_home_enabled).toBe(true);
    expect(reread?.proctor_contact_phone).toBe("+91 99999 00000");
  });

  it("maps a blank proctor phone to null (whitelist coercion)", async () => {
    const api = await import("../api");
    const updated = await api.updateContestApi("demo", {
      slug: "demo-drive-r1",
      take_home_enabled: false,
      proctor_contact_phone: ""
    });
    expect(updated.take_home_enabled).toBe(false);
    expect(updated.proctor_contact_phone).toBeNull();
  });

  it("leaves the take-home fields untouched when absent from the patch", async () => {
    const api = await import("../api");
    // Seed remote mode on, then save an unrelated patch (rename) without the fields.
    await api.updateContestApi("demo", {
      slug: "demo-drive-r1",
      take_home_enabled: true,
      proctor_contact_phone: "+91 90000 11111"
    });
    const renamed = await api.updateContestApi("demo", {
      slug: "demo-drive-r1",
      name: "Demo Drive — Round 1 (renamed)"
    });
    expect(renamed.name).toBe("Demo Drive — Round 1 (renamed)");
    expect(renamed.take_home_enabled).toBe(true);
    expect(renamed.proctor_contact_phone).toBe("+91 90000 11111");
  });
});
