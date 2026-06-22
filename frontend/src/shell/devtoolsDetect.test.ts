// frontend/src/shell/devtoolsDetect.test.ts
// P1 (v1.1 anti-cheat): the PURE DevTools heuristics — size-delta + the
// edge-triggered logging state machine.
import { describe, expect, it } from "vitest";
import {
  DEVTOOLS_SIZE_DELTA_PX,
  devtoolsTransition,
  sizeDeltaSuggestsDevtools
} from "./devtoolsDetect";

describe("sizeDeltaSuggestsDevtools (docked-DevTools heuristic)", () => {
  it("flags a large width gap (docked to the side)", () => {
    expect(sizeDeltaSuggestsDevtools({ outerWidth: 1600, innerWidth: 1200, outerHeight: 900, innerHeight: 890 })).toBe(true);
  });

  it("flags a large height gap (docked to the bottom)", () => {
    expect(sizeDeltaSuggestsDevtools({ outerWidth: 1600, innerWidth: 1590, outerHeight: 900, innerHeight: 600 })).toBe(true);
  });

  it("does not flag normal browser chrome / a thin scrollbar", () => {
    // ~85px of top chrome + ~15px scrollbar — under the 160px threshold.
    expect(sizeDeltaSuggestsDevtools({ outerWidth: 1600, innerWidth: 1585, outerHeight: 900, innerHeight: 815 })).toBe(false);
  });

  it("ignores implausible zero/negative dimensions (no false positive)", () => {
    expect(sizeDeltaSuggestsDevtools({ outerWidth: 0, innerWidth: 0, outerHeight: 0, innerHeight: 0 })).toBe(false);
    expect(sizeDeltaSuggestsDevtools({ outerWidth: -1, innerWidth: 1200, outerHeight: 900, innerHeight: 890 })).toBe(false);
  });

  it("honours a custom threshold", () => {
    const input = { outerWidth: 1600, innerWidth: 1500, outerHeight: 900, innerHeight: 890 };
    expect(sizeDeltaSuggestsDevtools(input, 50)).toBe(true);  // 100px gap > 50
    expect(sizeDeltaSuggestsDevtools(input, 200)).toBe(false); // 100px gap < 200
  });

  it("default threshold is the documented constant", () => {
    expect(DEVTOOLS_SIZE_DELTA_PX).toBe(160);
  });
});

describe("devtoolsTransition (edge-triggered logging)", () => {
  it("rising edge → opened", () => {
    const { next, transition } = devtoolsTransition({ open: false }, true);
    expect(transition).toBe("opened");
    expect(next.open).toBe(true);
  });

  it("falling edge → closed", () => {
    const { next, transition } = devtoolsTransition({ open: true }, false);
    expect(transition).toBe("closed");
    expect(next.open).toBe(false);
  });

  it("stays open → unchanged (logs once, not on every poll)", () => {
    const { transition } = devtoolsTransition({ open: true }, true);
    expect(transition).toBe("unchanged");
  });

  it("stays closed → unchanged", () => {
    const { transition } = devtoolsTransition({ open: false }, false);
    expect(transition).toBe("unchanged");
  });
});
