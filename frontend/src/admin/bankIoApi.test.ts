// frontend/src/admin/bankIoApi.test.ts — BANK-1 (F11) UI.
// The export → preview → commit demo helpers in api.ts back the offline admin
// demo of the import dialog. This pins the round-trip: exporting the seed demo
// problems yields a well-formed bundle; re-importing it previews every item as
// UNCHANGED (self-import is a no-op — the safety property in spec §6.8); a fresh
// bundle whose problems aren't local previews as CREATE and commits them in; and
// a non-bundle JSON is rejected. Same env/localStorage harness as
// takeHomeDemoApi.test.ts (api.ts captures VITE_DEMO_MODE at module load).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BankBundle } from "../types";

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

describe("bankExport (demo) — bundle assembly", () => {
  it("exports the selected seed problems into a proctor.bank-bundle", async () => {
    const api = await import("../api");
    const bundle = await api.bankExport("demo", { problem_ids: ["sum-two", "reverse-words"], template_slugs: [] });
    expect(bundle.kind).toBe("proctor.bank-bundle");
    expect(bundle.bundle_version).toBe(1);
    expect(bundle.counts.problems).toBe(2);
    expect(bundle.problems.map((p) => p.id).sort()).toEqual(["reverse-words", "sum-two"]);
    // Each problem carries the full authored surface + a portable id.
    const sumTwo = bundle.problems.find((p) => p.id === "sum-two")!;
    expect(sumTwo.portable_id).toMatch(/^[0-9a-f-]{8,}/);
    expect(Array.isArray(sumTwo.hiddenTests)).toBe(true);
  });

  it("a selected TEMPLATE pulls in every problem it references (self-contained)", async () => {
    const api = await import("../api");
    // demo-aptitude-r1 references sum-two + reverse-words + max-window-sum.
    const bundle = await api.bankExport("demo", { problem_ids: [], template_slugs: ["demo-aptitude-r1"] });
    expect(bundle.counts.templates).toBe(1);
    expect(bundle.counts.problems).toBe(3);
    // The template references its problems by PORTABLE id (not the local slug).
    const tpl = bundle.templates[0];
    expect(tpl.problems.every((e) => typeof e.problem_portable_id === "string")).toBe(true);
    expect(tpl.problems.map((e) => e.problem_id_hint).sort()).toEqual(["max-window-sum", "reverse-words", "sum-two"]);
  });
});

describe("bankImportPreview (demo) — the dry-run plan", () => {
  it("a self-import previews every item as UNCHANGED (no-op safety property)", async () => {
    const api = await import("../api");
    const bundle = await api.bankExport("demo", { problem_ids: ["sum-two", "reverse-words"], template_slugs: [] });
    const plan = await api.bankImportPreview("demo", bundle);
    expect(plan.problems.every((p) => p.action === "skip")).toBe(true);
    expect(plan.summary.unchanged).toBe(2);
    expect(plan.summary.created).toBe(0);
    expect(plan.preview_token).toBeTruthy();
  });

  it("a brand-new problem (no local match) previews as CREATE", async () => {
    const api = await import("../api");
    const bundle: BankBundle = {
      kind: "proctor.bank-bundle", bundle_version: 1, exported_at: "now", exported_from: "other",
      counts: { problems: 1, templates: 0 },
      problems: [{
        portable_id: "11111111-aa00-4000-8000-111111110000",
        id: "brand-new-problem", title: "Brand new", statement: "do it",
        languages: ["python"], cpuTimeLimit: 5, memoryLimit: 128000, points: 100,
        scoring: "per_test", status: "published", tags: [], sampleTests: [], hiddenTests: []
      }],
      templates: []
    };
    const plan = await api.bankImportPreview("demo", bundle);
    expect(plan.problems[0].action).toBe("create");
    expect(plan.problems[0].target_slug).toBe("brand-new-problem");
    expect(plan.summary.created).toBe(1);
  });

  it("a template referencing a problem that is neither in the bundle nor local is BLOCKED", async () => {
    const api = await import("../api");
    const bundle: BankBundle = {
      kind: "proctor.bank-bundle", bundle_version: 1, exported_at: "now", exported_from: "other",
      counts: { problems: 0, templates: 1 },
      problems: [],
      templates: [{
        portable_id: "22222222-bb00-4000-8000-222222220000",
        slug: "ghost-set", name: "Ghost set", description: "",
        problems: [{ problem_portable_id: "33333333-aa00-4000-8000-333333330000", problem_id_hint: "no-such-problem", points: null, order: 0 }]
      }]
    };
    const plan = await api.bankImportPreview("demo", bundle);
    expect(plan.templates[0].action).toBe("blocked");
    expect(plan.templates[0].reason).toBe("dangling_problem_refs");
    expect(plan.summary.blocked).toBe(1);
  });

  it("rejects a file that isn't a bank bundle", async () => {
    const api = await import("../api");
    await expect(api.bankImportPreview("demo", { foo: "bar" } as unknown as BankBundle)).rejects.toThrow();
  });
});

describe("bankImportCommit (demo) — applies the resolved plan", () => {
  it("creates a brand-new problem and it then appears in the bank", async () => {
    const api = await import("../api");
    const bundle: BankBundle = {
      kind: "proctor.bank-bundle", bundle_version: 1, exported_at: "now", exported_from: "other",
      counts: { problems: 1, templates: 0 },
      problems: [{
        portable_id: "44444444-aa00-4000-8000-444444440000",
        id: "imported-problem", title: "Imported", statement: "stmt",
        languages: ["python"], cpuTimeLimit: 5, memoryLimit: 128000, points: 100,
        scoring: "per_test", status: "published", tags: [], sampleTests: [], hiddenTests: []
      }],
      templates: []
    };
    const plan = await api.bankImportPreview("demo", bundle);
    const result = await api.bankImportCommit("demo", { bundle, preview_token: plan.preview_token });
    expect(result.ok).toBe(true);
    expect(result.applied.created).toBe(1);
    const problems = await api.fetchProblems("demo");
    expect(problems.some((p) => p.id === "imported-problem")).toBe(true);
  });

  it("refuses commit when the preview_token doesn't match the bundle", async () => {
    const api = await import("../api");
    const bundle = await api.bankExport("demo", { problem_ids: ["sum-two"], template_slugs: [] });
    await expect(
      api.bankImportCommit("demo", { bundle, preview_token: "stale-token" })
    ).rejects.toThrow();
  });
});
