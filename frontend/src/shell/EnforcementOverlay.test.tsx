// frontend/src/shell/EnforcementOverlay.test.tsx
//
// FIX 3 (exam-eve 2026-06-18): a11y focus target in simplified-recovery mode.
// The mount focus effect used to focus the typed-ack input (inputRef), but in
// simplified-recovery mode that input is NOT rendered — so focus was a no-op and
// keyboard/screen-reader users never landed in the dialog. The fix focuses the
// "Re-enter fullscreen" button instead.
//
// This harness has no jsdom/testing-library, so we cannot observe the imperative
// .focus() call directly. Instead we pin the STRUCTURAL contract the focus fix
// depends on via renderToStaticMarkup (pure node, same pattern as
// statementView.test.tsx): in simplified-recovery mode the focusable
// "Re-enter fullscreen" button is rendered (and the typed-ack input is gone),
// while the typed-ack path still renders its input. If a refactor drops the
// re-enter button in simplified mode, the focus target vanishes and this fails.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EnforcementOverlay } from "./EnforcementOverlay";

const base = {
  phase: "blocking" as const,
  violation: null,
  remainingSeconds: 30,
  exitCount: 1,
  ackOk: false,
  fullscreen: false,
  onAckChange: () => {},
  onEnterFullscreen: async () => {}
};

const render = (props: Partial<Parameters<typeof EnforcementOverlay>[0]>) =>
  renderToStaticMarkup(<EnforcementOverlay {...base} {...props} />);

describe("EnforcementOverlay — focus target structure (FIX 3)", () => {
  it("simplified-recovery, not in fullscreen: renders the re-enter button (focus target) and NO typed-ack input", () => {
    const html = render({ simplifiedRecovery: true });
    // The re-enter button exists → there IS a focusable element for the mount
    // focus effect to land on.
    expect(html).toContain("Re-enter fullscreen now");
    expect(html).toContain("<button");
    // The Step-1 typed-ack input is omitted in simplified mode (the reason the
    // old inputRef focus was a no-op).
    expect(html).not.toContain('placeholder="Type the sentence here"');
  });

  it("typed-ack mode (default), not in fullscreen: still renders the typed-ack input", () => {
    const html = render({ simplifiedRecovery: false });
    // The typed-ack path is unchanged — its input is the focus target.
    expect(html).toContain('placeholder="Type the sentence here"');
    expect(html).toContain("type this exact sentence");
  });

  it("locking phase renders neither the ack input nor the re-enter button (no recovery controls)", () => {
    const html = render({ phase: "locking", simplifiedRecovery: true });
    expect(html).not.toContain("Re-enter fullscreen now");
    expect(html).not.toContain('placeholder="Type the sentence here"');
  });
});

// ALERT-1: the second ("dispute") feedback button + its unambiguous copy.
describe("EnforcementOverlay — candidate dispute feedback (ALERT-1)", () => {
  it("renders the dispute button ONLY when onReportDispute is provided", () => {
    const without = render({});
    expect(without).not.toContain("Report a problem with this alert");
    const withDispute = render({ onReportDispute: () => {} });
    expect(withDispute).toContain("Report a problem with this alert");
  });

  it("frames the acknowledge path AND offers the dispute as a distinct, quieter option", () => {
    const html = render({ onReportDispute: () => {} });
    // Option A (acknowledge) is the recovery steps; the copy nudges completing them.
    expect(html).toContain("Acknowledge by completing the steps above");
    // Option B is a secondary, non-primary button (not the red primary action).
    expect(html).toContain("Report a problem with this alert");
  });

  it("the button label is NOT a reflexive 'dispute / unfair / make this go away' label", () => {
    const html = render({ onReportDispute: () => {} });
    // The deliberately careful label — the confirm copy carries the warning, not
    // the button text (which an honest candidate must not feel invited to press).
    expect(html).toContain("Report a problem with this alert");
    expect(html).not.toContain("This is unfair");
    expect(html).not.toContain("Make this go away");
  });

  it("is not shown in the locking phase (no recovery/feedback controls once locked)", () => {
    const html = render({ phase: "locking", onReportDispute: () => {} });
    expect(html).not.toContain("Report a problem with this alert");
  });
});
