// frontend/src/demoFreezeNow.test.ts — the screenshot-harness determinism toggle.
//
// `VITE_DEMO_FREEZE_NOW=<ISO>` (read ONCE at api.ts module load) freezes the demo
// clock and seeds the demo session ids so Playwright pixel-diffs are stable. This
// pins the contract the harness relies on:
//   * UNSET  → fully inert: demoNowMs() tracks the real wall clock and demoUuid()
//              returns real random UUIDs (existing behavior unchanged).
//   * SET    → demoNowMs()/demoNowIso() return the frozen instant and demoUuid()
//              returns deterministic, seeded, RFC-4122-shaped ids.
// Each case imports api.ts in a FRESH module registry (vi.resetModules) so the
// module-load env capture is exercised per-case.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("demo freeze-now (unset → inert)", () => {
  it("does not freeze the clock and yields random UUIDs when the env is absent", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "true");
    vi.stubEnv("VITE_DEMO_FREEZE_NOW", "");
    vi.resetModules();
    const api = await import("./api");

    expect(api.isDemoClockFrozen).toBe(false);

    // demoNowMs tracks the real wall clock (within a generous bound).
    const before = Date.now();
    const now = api.demoNowMs();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);

    // Real random UUIDs: RFC-4122 shape AND unique across calls.
    const a = api.demoUuid();
    const b = api.demoUuid();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(a).not.toBe(b);
    expect(a.startsWith("demo0000-")).toBe(false);
  });
});

describe("demo freeze-now (set → deterministic)", () => {
  it("freezes the clock and seeds UUIDs when a valid ISO instant is set", async () => {
    const frozen = "2026-06-05T09:30:00.000Z";
    vi.stubEnv("VITE_DEMO_MODE", "true");
    vi.stubEnv("VITE_DEMO_FREEZE_NOW", frozen);
    vi.resetModules();
    const api = await import("./api");

    expect(api.isDemoClockFrozen).toBe(true);

    // The clock is pinned to the frozen instant — identical across calls.
    expect(api.demoNowIso()).toBe(frozen);
    expect(api.demoNowMs()).toBe(Date.parse(frozen));
    expect(api.demoNowMs()).toBe(api.demoNowMs());

    // UUIDs are deterministic, seeded, monotonic — and RFC-4122 shaped.
    const first = api.demoUuid();
    const second = api.demoUuid();
    expect(first).toBe("demo0000-0000-4000-8000-000000000001");
    expect(second).toBe("demo0000-0000-4000-8000-000000000002");
    // 8-4-4-4-12 grouped, RFC-4122-shaped (deterministic "demo" prefix, not hex).
    expect(first).toMatch(/^.{8}-.{4}-.{4}-.{4}-.{12}$/);
  });

  it("stays inert (no freeze) when the env value is not a parseable date", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "true");
    vi.stubEnv("VITE_DEMO_FREEZE_NOW", "not-a-date");
    vi.resetModules();
    const api = await import("./api");

    expect(api.isDemoClockFrozen).toBe(false);
    // Falls back to the real clock + random UUIDs.
    const a = api.demoUuid();
    expect(a.startsWith("demo0000-")).toBe(false);
  });
});
