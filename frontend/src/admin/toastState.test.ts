// frontend/src/admin/toastState.test.ts
// LT-10: pure logic for the floating admin toast — the reducer, the per-kind
// auto-dismiss policy, and toast construction. The interactive rendering/timer
// wiring lives in Toast.tsx (the repo has no jsdom); everything decision-making
// is pure and covered here.
import { describe, expect, it } from "vitest";
import {
  SUCCESS_DISMISS_MS,
  autoDismissMs,
  isAutoDismissed,
  makeToast,
  nextToastId,
  toastReducer,
  type Toast
} from "./toastState";

describe("autoDismiss policy", () => {
  it("success toasts auto-dismiss after SUCCESS_DISMISS_MS", () => {
    expect(autoDismissMs("success")).toBe(SUCCESS_DISMISS_MS);
    expect(isAutoDismissed("success")).toBe(true);
  });

  it("error toasts are sticky (never auto-dismiss)", () => {
    expect(autoDismissMs("error")).toBeNull();
    expect(isAutoDismissed("error")).toBe(false);
  });
});

describe("nextToastId", () => {
  it("returns a fresh, unique id each call", () => {
    const a = nextToastId();
    const b = nextToastId();
    expect(a).not.toBe(b);
  });
});

describe("makeToast", () => {
  it("builds a toast with the trimmed message and the given kind", () => {
    const toast = makeToast("error", "  Problem referenced by contest x  ");
    expect(toast).not.toBeNull();
    expect(toast?.kind).toBe("error");
    expect(toast?.message).toBe("Problem referenced by contest x");
    expect(toast?.id).toBeTruthy();
  });

  it("returns null for a blank/whitespace message (cleared '' state must not raise a banner)", () => {
    expect(makeToast("success", "")).toBeNull();
    expect(makeToast("error", "   ")).toBeNull();
  });
});

const t = (id: string, kind: Toast["kind"], message: string): Toast => ({ id, kind, message });

describe("toastReducer", () => {
  it("add appends to the stack", () => {
    const state = toastReducer([], { type: "add", toast: t("a", "success", "Saved") });
    expect(state).toHaveLength(1);
    const next = toastReducer(state, { type: "add", toast: t("b", "error", "Failed") });
    expect(next.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("add collapses a same-kind duplicate message instead of stacking it", () => {
    const state = [t("a", "error", "Boom")];
    const next = toastReducer(state, { type: "add", toast: t("b", "error", "Boom") });
    expect(next).toBe(state); // unchanged reference — duplicate ignored
    expect(next).toHaveLength(1);
  });

  it("add keeps a same-message toast of a DIFFERENT kind", () => {
    const state = [t("a", "error", "Done")];
    const next = toastReducer(state, { type: "add", toast: t("b", "success", "Done") });
    expect(next).toHaveLength(2);
  });

  it("dismiss removes exactly the toast with the given id", () => {
    const state = [t("a", "success", "Saved"), t("b", "error", "Failed")];
    const next = toastReducer(state, { type: "dismiss", id: "a" });
    expect(next.map((x) => x.id)).toEqual(["b"]);
  });

  it("dismiss of an unknown id is a no-op", () => {
    const state = [t("a", "success", "Saved")];
    const next = toastReducer(state, { type: "dismiss", id: "zzz" });
    expect(next).toEqual(state);
  });

  it("clear empties a non-empty stack", () => {
    const state = [t("a", "success", "Saved"), t("b", "error", "Failed")];
    expect(toastReducer(state, { type: "clear" })).toEqual([]);
  });

  it("clear on an already-empty stack returns the same reference (no churn)", () => {
    const empty: Toast[] = [];
    expect(toastReducer(empty, { type: "clear" })).toBe(empty);
  });
});
