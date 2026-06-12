// frontend/src/coding/stubReload.test.ts
// W9: "Reload stub" with 20s undo — the pure parts: button visibility rule,
// confirm copy, the snapshot/undo countdown state machine (trigger / expiry /
// problem- and language-switch discard) and the two additive editor events.
import { describe, expect, it } from "vitest";
import {
  STUB_UNDO_WINDOW_MS,
  STUB_UNDO_WINDOW_SECONDS,
  canReloadStub,
  reloadStubConfirmMessage,
  stubReloadUndoneEvent,
  stubReloadedEvent,
  takeUndoSnapshot,
  undoSecondsRemaining
} from "./stubReload";

describe("canReloadStub (button visibility)", () => {
  it("shows for a problem with an author stub for the current language", () => {
    const problem = { stubs: { python: "def solve():\n    pass\n" } };
    expect(canReloadStub(problem, "python")).toBe(true);
  });

  it("hides for languages the problem does not stub (generic STARTERS is not a stub)", () => {
    const problem = { stubs: { python: "PY STUB\n" } };
    expect(canReloadStub(problem, "cpp")).toBe(false);
    expect(canReloadStub(problem, "java")).toBe(false);
  });

  it("hides for no-stub problems, null/undefined problems and non-string stub values", () => {
    expect(canReloadStub({}, "python")).toBe(false);
    expect(canReloadStub(null, "python")).toBe(false);
    expect(canReloadStub(undefined, "python")).toBe(false);
    expect(canReloadStub({ stubs: { python: 42 as unknown as string } }, "python")).toBe(false);
  });

  it("shows for an explicit empty-string stub (an author CAN choose a blank stub — starterFor parity)", () => {
    expect(canReloadStub({ stubs: { python: "" } }, "python")).toBe(true);
  });
});

describe("reloadStubConfirmMessage", () => {
  it("warns in the owner's words and names the language", () => {
    const message = reloadStubConfirmMessage("python");
    expect(message).toContain("all your edits will be gone");
    expect(message).toContain("Are you sure?");
    expect(message).toContain("(python)");
    expect(message).toContain("Reload the starter stub for this problem");
  });
});

describe("undo snapshot state machine", () => {
  const T0 = 1_000_000; // arbitrary epoch ms base
  const snap = takeUndoSnapshot("p1", "python", "my edited code", T0);

  it("trigger: a fresh snapshot shows the full 20s window", () => {
    expect(STUB_UNDO_WINDOW_SECONDS).toBe(20);
    expect(undoSecondsRemaining(snap, "p1", "python", T0)).toBe(20);
    expect(snap.code).toBe("my edited code");
  });

  it("counts down with ceil (a countdown label like 'Undo (18s)')", () => {
    expect(undoSecondsRemaining(snap, "p1", "python", T0 + 1500)).toBe(19);
    expect(undoSecondsRemaining(snap, "p1", "python", T0 + 2000)).toBe(18);
    expect(undoSecondsRemaining(snap, "p1", "python", T0 + 19999)).toBe(1);
  });

  it("expiry: exactly at the window boundary and beyond → 0 (affordance gone)", () => {
    expect(undoSecondsRemaining(snap, "p1", "python", T0 + STUB_UNDO_WINDOW_MS)).toBe(0);
    expect(undoSecondsRemaining(snap, "p1", "python", T0 + STUB_UNDO_WINDOW_MS + 1)).toBe(0);
    expect(undoSecondsRemaining(snap, "p1", "python", T0 + 60_000)).toBe(0);
  });

  it("discard on problem switch: a snapshot never surfaces under another problem", () => {
    expect(undoSecondsRemaining(snap, "p2", "python", T0)).toBe(0);
  });

  it("discard on language switch: a snapshot never surfaces under another language", () => {
    expect(undoSecondsRemaining(snap, "p1", "cpp", T0)).toBe(0);
  });

  it("no snapshot → 0", () => {
    expect(undoSecondsRemaining(null, "p1", "python", T0)).toBe(0);
    expect(undoSecondsRemaining(undefined, "p1", "python", T0)).toBe(0);
  });
});

describe("telemetry events (additive — same family as problem_switched)", () => {
  it("stub_reloaded carries language + stub/replaced lengths + the ISO timestamp", () => {
    const event = stubReloadedEvent("python", 42, 980, "2026-06-12T10:00:00.000Z");
    expect(event).toEqual({
      type: "stub_reloaded",
      timestamp: "2026-06-12T10:00:00.000Z",
      detail: { language: "python", stub_len: 42, replaced_len: 980 }
    });
  });

  it("stub_reload_undone carries language + restored length + the ISO timestamp", () => {
    const event = stubReloadUndoneEvent("cpp", 980, "2026-06-12T10:00:05.000Z");
    expect(event).toEqual({
      type: "stub_reload_undone",
      timestamp: "2026-06-12T10:00:05.000Z",
      detail: { language: "cpp", restored_len: 980 }
    });
  });
});
