// frontend/src/shell/permissions.test.ts
//
// F5.1 — permissions-first onboarding: pure checklist state for the stage-1
// PermissionsGate (screen share + camera + microphone + clipboard, requested
// BEFORE fullscreen so browser prompts can never kick the candidate out of
// fullscreen mid-onboarding).
import { describe, it, expect, vi } from "vitest";
import {
  initialPermissionChecklist, PERMISSION_META, PERMISSION_ORDER,
  permissionsReady, allPermissionsGranted, permissionsAttempted, permissionRetryable,
  permissionStatusLine, screenStatusFromErrorKind, screenShareFailureMessage,
  raceWithTimeout, primeClipboardWithTimeout, CLIPBOARD_PRIMER_TIMEOUT_MS,
  type PermissionChecklist, type PermissionKey, type PermissionStatus
} from "./permissions";

const allGranted: PermissionChecklist = {
  screen: "granted", camera: "granted", microphone: "granted", clipboard: "granted"
};

describe("initialPermissionChecklist", () => {
  it("starts every permission as pending", () => {
    expect(initialPermissionChecklist).toEqual({
      screen: "pending", camera: "pending", microphone: "pending", clipboard: "pending"
    });
  });
});

describe("PERMISSION_ORDER / PERMISSION_META", () => {
  it("orders the screen share first (the gating permission) and covers every key", () => {
    expect(PERMISSION_ORDER[0]).toBe("screen");
    expect([...PERMISSION_ORDER].sort()).toEqual(["camera", "clipboard", "microphone", "screen"]);
  });
  it("marks ONLY the screen share as required — camera/mic/clipboard stay optional (existing recorder semantics)", () => {
    expect(PERMISSION_META.screen.required).toBe(true);
    expect(PERMISSION_META.camera.required).toBe(false);
    expect(PERMISSION_META.microphone.required).toBe(false);
    expect(PERMISSION_META.clipboard.required).toBe(false);
  });
  it("every key carries a human label", () => {
    for (const key of PERMISSION_ORDER) {
      expect(PERMISSION_META[key].label.length).toBeGreaterThan(0);
    }
  });
});

describe("permissionsReady", () => {
  it("ready when the screen share is granted, even if every optional item was denied/unavailable", () => {
    expect(permissionsReady(allGranted)).toBe(true);
    expect(permissionsReady({
      screen: "granted", camera: "denied", microphone: "unavailable", clipboard: "denied"
    })).toBe(true);
  });
  it("NOT ready while the screen share is anything but granted, even with all optionals granted", () => {
    for (const status of ["pending", "requesting", "denied", "unavailable"] as const) {
      expect(permissionsReady({ ...allGranted, screen: status })).toBe(false);
    }
  });
});

describe("allPermissionsGranted", () => {
  it("true only when every item is granted (drives the auto-continue)", () => {
    expect(allPermissionsGranted(allGranted)).toBe(true);
    expect(allPermissionsGranted({ ...allGranted, clipboard: "denied" })).toBe(false);
    expect(allPermissionsGranted({ ...allGranted, camera: "unavailable" })).toBe(false);
    expect(allPermissionsGranted(initialPermissionChecklist)).toBe(false);
  });
});

describe("permissionsAttempted", () => {
  it("false on the fresh checklist (gate shows the single setup button)", () => {
    expect(permissionsAttempted(initialPermissionChecklist)).toBe(false);
  });
  it("true once ANY item left pending (per-item statuses + retry buttons take over)", () => {
    expect(permissionsAttempted({ ...initialPermissionChecklist, screen: "requesting" })).toBe(true);
    expect(permissionsAttempted({ ...initialPermissionChecklist, clipboard: "denied" })).toBe(true);
    expect(permissionsAttempted(allGranted)).toBe(true);
  });
});

describe("permissionRetryable", () => {
  it("denied is retryable; pending too (a screen share killed between setup and start drops back to pending)", () => {
    expect(permissionRetryable("denied")).toBe(true);
    expect(permissionRetryable("pending")).toBe(true);
  });
  it("granted / requesting / unavailable get no retry button", () => {
    expect(permissionRetryable("granted")).toBe(false);
    expect(permissionRetryable("requesting")).toBe(false);
    expect(permissionRetryable("unavailable")).toBe(false);
  });
});

describe("permissionStatusLine", () => {
  it("returns non-empty copy for every key x status combination", () => {
    const statuses: PermissionStatus[] = ["pending", "requesting", "granted", "denied", "unavailable"];
    for (const key of PERMISSION_ORDER as PermissionKey[]) {
      for (const status of statuses) {
        expect(permissionStatusLine(key, status).length).toBeGreaterThan(0);
      }
    }
  });
  it("the screen lines steer toward the ENTIRE screen", () => {
    expect(permissionStatusLine("screen", "requesting")).toMatch(/entire screen/i);
    expect(permissionStatusLine("screen", "granted")).toMatch(/entire screen/i);
  });
  it("unavailable explains the browser/device limitation", () => {
    expect(permissionStatusLine("camera", "unavailable")).toMatch(/browser|device/i);
  });
});

describe("screenStatusFromErrorKind", () => {
  it("unsupported browser maps to unavailable (dead end, no retry)", () => {
    expect(screenStatusFromErrorKind("unsupported")).toBe("unavailable");
  });
  it("cancel / invalid surface / unknown map to denied (retryable)", () => {
    expect(screenStatusFromErrorKind("share_cancelled")).toBe("denied");
    expect(screenStatusFromErrorKind("invalid_surface")).toBe("denied");
    expect(screenStatusFromErrorKind("unknown")).toBe("denied");
  });
});

describe("screenShareFailureMessage", () => {
  it("invalid surface demands the ENTIRE screen", () => {
    expect(screenShareFailureMessage("invalid_surface")).toMatch(/entire screen/i);
  });
  it("cancelled/blocked tells the candidate to allow the share", () => {
    expect(screenShareFailureMessage("share_cancelled")).toMatch(/entire screen/i);
  });
  it("unsupported points at Chrome/Edge", () => {
    expect(screenShareFailureMessage("unsupported")).toMatch(/chrome/i);
  });
  it("unknown still offers a retry path", () => {
    expect(screenShareFailureMessage("unknown").length).toBeGreaterThan(0);
  });
});

// FIX-B3 #1: clipboard primer must never wedge onboarding. A controllable timer
// harness lets us drive the race deterministically — `fire()` runs the pending
// timeout callback on demand instead of waiting real wall-clock time.
function makeTimerHarness() {
  let pending: (() => void) | null = null;
  let cleared = false;
  const setTimeoutFn = (cb: () => void) => {
    pending = cb;
    return 1;
  };
  const clearTimeoutFn = () => {
    cleared = true;
    pending = null;
  };
  return {
    setTimeoutFn,
    clearTimeoutFn,
    fire: () => { pending?.(); },
    get cleared() { return cleared; }
  };
}

describe("raceWithTimeout", () => {
  it("resolves with the promise value when it wins before the timeout", async () => {
    const h = makeTimerHarness();
    const result = await raceWithTimeout(Promise.resolve("ok"), 1000, "TIMEOUT", h.setTimeoutFn, h.clearTimeoutFn);
    expect(result).toBe("ok");
    expect(h.cleared).toBe(true); // timer cancelled once the promise won
  });

  it("rejects with the promise reason when it rejects before the timeout", async () => {
    const h = makeTimerHarness();
    await expect(
      raceWithTimeout(Promise.reject(new Error("blocked")), 1000, "TIMEOUT", h.setTimeoutFn, h.clearTimeoutFn)
    ).rejects.toThrow("blocked");
    expect(h.cleared).toBe(true);
  });

  it("resolves with the timeout value when the timer fires first", async () => {
    const h = makeTimerHarness();
    // A promise that never settles — only the timeout can decide this race.
    const never = new Promise<string>(() => {});
    const raced = raceWithTimeout(never, 1000, "TIMEOUT", h.setTimeoutFn, h.clearTimeoutFn);
    h.fire();
    await expect(raced).resolves.toBe("TIMEOUT");
  });

  it("ignores a late promise settle after the timeout already won", async () => {
    const h = makeTimerHarness();
    let resolveLate: (v: string) => void = () => {};
    const slow = new Promise<string>((r) => { resolveLate = r; });
    const raced = raceWithTimeout(slow, 1000, "TIMEOUT", h.setTimeoutFn, h.clearTimeoutFn);
    h.fire(); // timeout wins
    resolveLate("too-late"); // must NOT flip the result
    await expect(raced).resolves.toBe("TIMEOUT");
  });
});

describe("primeClipboardWithTimeout", () => {
  it("returns 'granted' when readText resolves in time", async () => {
    const h = makeTimerHarness();
    const outcome = await primeClipboardWithTimeout(
      () => Promise.resolve("clipboard text"), 1000, h.setTimeoutFn, h.clearTimeoutFn
    );
    expect(outcome).toBe("granted");
  });

  it("returns 'denied' when readText rejects (blocked)", async () => {
    const h = makeTimerHarness();
    const outcome = await primeClipboardWithTimeout(
      () => Promise.reject(new DOMException("denied")), 1000, h.setTimeoutFn, h.clearTimeoutFn
    );
    expect(outcome).toBe("denied");
  });

  it("returns 'timeout' when readText hangs past the timeout — onboarding proceeds", async () => {
    const h = makeTimerHarness();
    const hung = primeClipboardWithTimeout(
      () => new Promise<string>(() => {}), 1000, h.setTimeoutFn, h.clearTimeoutFn
    );
    h.fire(); // grant prompt never answered → timeout decides
    await expect(hung).resolves.toBe("timeout");
  });

  it("does not inspect the clipboard text on grant (only the boolean outcome)", async () => {
    const read = vi.fn(() => Promise.resolve("SECRET COPIED TEXT"));
    const h = makeTimerHarness();
    const outcome = await primeClipboardWithTimeout(read, 1000, h.setTimeoutFn, h.clearTimeoutFn);
    expect(outcome).toBe("granted");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("exposes a short default timeout (3-4s) so a hung prompt can't strand setup", () => {
    expect(CLIPBOARD_PRIMER_TIMEOUT_MS).toBeGreaterThanOrEqual(3000);
    expect(CLIPBOARD_PRIMER_TIMEOUT_MS).toBeLessThanOrEqual(4000);
  });
});
