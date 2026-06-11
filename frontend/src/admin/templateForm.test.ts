// frontend/src/admin/templateForm.test.ts
// FIX-B2 (#58): pure form/list logic for the Templates tab — draft <-> wire
// payload mapping + validation + reorder. The backend re-validates everything;
// these tests pin the UI-side behaviour (round-trip fidelity, blank-points =
// bank default, positional order, reorder clamping).
import { describe, expect, it } from "vitest";
import type { ContestTemplateDetail } from "../api";
import {
  draftFromTemplate,
  draftToSavePayload,
  emptyTemplateDraft,
  moveProblemRow,
  templateRowSummary,
  validateTemplateDraft,
  type TemplateDraft
} from "./templateForm";

const FULL_TEMPLATE: ContestTemplateDetail = {
  slug: "apt-r1",
  name: "Aptitude — Round 1",
  description: "First round.",
  archived: false,
  preset: false,
  problems: [
    { problem_id: "sum-two", points: null, order: 0 },
    { problem_id: "rev-str", points: 40, order: 1 }
  ],
  defaults: {
    duration_minutes: 90,
    identity_label: "Hall Ticket",
    room_gate_enabled: false,
    camera_recording: { enabled: false, fps: 5, width: 320 },
    enforcement: { mode: "alert_first", fullscreen_reentry_seconds: 30, fullscreen_exit_limit: 1 },
    evidence_retention_days: 7,
    languages: ["python", "cpp"]
  },
  created_at: "2026-06-01T00:00:00.000Z",
  updated_at: "2026-06-02T00:00:00.000Z"
};

describe("emptyTemplateDraft", () => {
  it("has the spec defaults and no problems", () => {
    const draft = emptyTemplateDraft();
    expect(draft.slug).toBe("");
    expect(draft.problems).toEqual([]);
    expect(draft.durationMinutes).toBe("120");
    expect(draft.identityLabel).toBe("Roll Number");
    expect(draft.roomGateEnabled).toBe(true);
    expect(draft.languages).toEqual(["python", "cpp", "java", "javascript"]);
    expect(draft.preset).toBe(false);
  });
});

describe("draftFromTemplate", () => {
  it("hydrates every field; null points becomes a blank string", () => {
    const draft = draftFromTemplate(FULL_TEMPLATE);
    expect(draft.slug).toBe("apt-r1");
    expect(draft.name).toBe("Aptitude — Round 1");
    expect(draft.description).toBe("First round.");
    expect(draft.problems).toEqual([
      { problem_id: "sum-two", points: "" },   // null -> blank (use bank points)
      { problem_id: "rev-str", points: "40" }
    ]);
    expect(draft.durationMinutes).toBe("90");
    expect(draft.identityLabel).toBe("Hall Ticket");
    expect(draft.roomGateEnabled).toBe(false);
    expect(draft.cameraEnabled).toBe(false);
    expect(draft.cameraFps).toBe("5");
    expect(draft.cameraWidth).toBe("320");
    expect(draft.enforcementMode).toBe("alert_first");
    expect(draft.fullscreenReentrySeconds).toBe("30");
    expect(draft.fullscreenExitLimit).toBe("1");
    expect(draft.evidenceRetentionDays).toBe("7");
    expect(draft.languages).toEqual(["python", "cpp"]);
  });

  it("falls back to defaults for a sparse/preset template and marks preset", () => {
    const sparse: ContestTemplateDetail = {
      slug: "system-check", name: "System check", description: "", archived: false, preset: true,
      problems: [{ problem_id: "sum-two", points: null, order: 0 }],
      defaults: { duration_minutes: 30 } as ContestTemplateDetail["defaults"],
      created_at: null, updated_at: null
    };
    const draft = draftFromTemplate(sparse);
    expect(draft.preset).toBe(true);
    expect(draft.durationMinutes).toBe("30");
    expect(draft.identityLabel).toBe("Roll Number"); // default
    expect(draft.cameraEnabled).toBe(true);          // default
    expect(draft.languages).toEqual(["python", "cpp", "java", "javascript"]); // default
  });
});

describe("draftToSavePayload", () => {
  it("round-trips a hydrated draft back to wire shape; order is positional", () => {
    const payload = draftToSavePayload(draftFromTemplate(FULL_TEMPLATE));
    expect(payload.slug).toBe("apt-r1"); // update path keeps the slug
    expect(payload.name).toBe("Aptitude — Round 1");
    expect(payload.problems).toEqual([
      { problem_id: "sum-two", points: null, order: 0 },
      { problem_id: "rev-str", points: 40, order: 1 }
    ]);
    expect(payload.defaults.duration_minutes).toBe(90);
    expect(payload.defaults.identity_label).toBe("Hall Ticket");
    expect(payload.defaults.camera_recording).toEqual({ enabled: false, fps: 5, width: 320 });
    expect(payload.defaults.enforcement).toEqual({ mode: "alert_first", fullscreen_reentry_seconds: 30, fullscreen_exit_limit: 1 });
    expect(payload.defaults.languages).toEqual(["python", "cpp"]);
  });

  it("omits slug for a new template and re-derives order after a reorder", () => {
    const draft: TemplateDraft = {
      ...emptyTemplateDraft(),
      name: "  New One  ",
      problems: [
        { problem_id: "b", points: "10" },
        { problem_id: "a", points: "" }
      ]
    };
    const payload = draftToSavePayload(draft);
    expect(payload.slug).toBeUndefined();
    expect(payload.name).toBe("New One"); // trimmed
    expect(payload.problems).toEqual([
      { problem_id: "b", points: 10, order: 0 },
      { problem_id: "a", points: null, order: 1 } // blank -> null
    ]);
  });
});

describe("validateTemplateDraft", () => {
  const base = (): TemplateDraft => ({
    ...emptyTemplateDraft(),
    name: "Round 1",
    problems: [{ problem_id: "sum-two", points: "" }]
  });

  it("accepts a minimal valid draft", () => {
    expect(validateTemplateDraft(base())).toBe("");
  });

  it("requires a name", () => {
    expect(validateTemplateDraft({ ...base(), name: "  " })).toMatch(/name/i);
  });

  it("requires at least one problem", () => {
    expect(validateTemplateDraft({ ...base(), problems: [] })).toMatch(/problem/i);
  });

  it("rejects a duplicate problem", () => {
    const draft = { ...base(), problems: [{ problem_id: "x", points: "" }, { problem_id: "x", points: "" }] };
    expect(validateTemplateDraft(draft)).toMatch(/twice/i);
  });

  it("rejects out-of-range points but accepts a blank (bank default)", () => {
    expect(validateTemplateDraft({ ...base(), problems: [{ problem_id: "x", points: "9999" }] })).toMatch(/points/i);
    expect(validateTemplateDraft({ ...base(), problems: [{ problem_id: "x", points: "" }] })).toBe("");
    expect(validateTemplateDraft({ ...base(), problems: [{ problem_id: "x", points: "0" }] })).toBe("");
  });

  it("requires at least one language", () => {
    expect(validateTemplateDraft({ ...base(), languages: [] })).toMatch(/language/i);
  });
});

describe("moveProblemRow", () => {
  const rows = [
    { problem_id: "a", points: "" },
    { problem_id: "b", points: "" },
    { problem_id: "c", points: "" }
  ];

  it("swaps adjacent rows", () => {
    expect(moveProblemRow(rows, 0, 1).map((r) => r.problem_id)).toEqual(["b", "a", "c"]);
    expect(moveProblemRow(rows, 2, -1).map((r) => r.problem_id)).toEqual(["a", "c", "b"]);
  });

  it("returns the same array identity when the move falls off an edge (no-op)", () => {
    expect(moveProblemRow(rows, 0, -1)).toBe(rows);
    expect(moveProblemRow(rows, 2, 1)).toBe(rows);
  });
});

describe("templateRowSummary", () => {
  it("pluralizes and formats", () => {
    expect(templateRowSummary(1, 100)).toBe("1 problem · 100 pts");
    expect(templateRowSummary(3, 240)).toBe("3 problems · 240 pts");
  });
});
