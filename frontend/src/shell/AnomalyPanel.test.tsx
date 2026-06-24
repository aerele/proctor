// frontend/src/shell/AnomalyPanel.test.tsx
//
// ALERT-1: the candidate two-button feedback on the AnomalyPanel red banner —
// the no-fault "Return to exam" acknowledge (T3) + the quieter "Report a problem
// with this alert" (dispute). Same pure-node renderToStaticMarkup harness as
// EnforcementOverlay.test.tsx (no jsdom): we pin the structural contract — the
// dispute button is rendered ONLY when onReportDispute is provided, and the
// banner copy frames the dispute as for genuine software faults only.
//
// LT-6: the OPTIONAL acknowledge comment. Its load-bearing logic (forward only a
// non-blank comment; omit a blank one) lives in the pure ackCommentToForward
// helper, unit-tested directly here since the node harness can't fire clicks.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnomalyPanel, ackCommentToForward } from "./AnomalyPanel";

const base = {
  reasons: [{ type: "tab_away", message: "You switched away from the exam", at: "2026-06-23T10:00:00.000Z" }],
  preconditions: { fullscreen: true, visible: true, recording: true },
  onRestore: () => {},
  onEnterFullscreen: async () => {}
};

const render = (props: Partial<Parameters<typeof AnomalyPanel>[0]>) =>
  renderToStaticMarkup(<AnomalyPanel {...base} {...props} />);

describe("AnomalyPanel — candidate dispute feedback (ALERT-1)", () => {
  it("renders the no-fault acknowledge action (T3) and never the old fault-presuming copy", () => {
    const html = render({});
    expect(html).toContain("Return to exam");
    // T3: the accusatory "I have fixed it" wording must be gone everywhere.
    expect(html).not.toContain("I have fixed it");
  });

  it("renders the dispute button ONLY when onReportDispute is provided", () => {
    expect(render({})).not.toContain("Report a problem with this alert");
    expect(render({ onReportDispute: () => {} })).toContain("Report a problem with this alert");
  });

  it("the dispute affordance does not replace or disable the restore action", () => {
    const html = render({ onReportDispute: () => {} });
    expect(html).toContain("Return to exam");
    expect(html).toContain("Report a problem with this alert");
  });
});

describe("AnomalyPanel — optional acknowledge comment (LT-6)", () => {
  it("renders the optional comment field ONLY when a proctor channel (onReportDispute) exists", () => {
    // No proctor channel ⇒ no point collecting a comment that can't be surfaced.
    expect(render({})).not.toContain("Add a comment (optional)");
    expect(render({ onReportDispute: () => {} })).toContain("Add a comment (optional)");
  });

  it("marks the comment as optional (an accidental trigger needn't write anything)", () => {
    expect(render({ onReportDispute: () => {} })).toContain("(optional)");
  });

  it("forwards a comment that the candidate provided (trimmed)", () => {
    expect(ackCommentToForward("my screen flickered")).toBe("my screen flickered");
    expect(ackCommentToForward("  padded note  ")).toBe("padded note");
  });

  it("omits a blank or whitespace-only comment (pure acknowledge — nothing sent)", () => {
    expect(ackCommentToForward("")).toBeNull();
    expect(ackCommentToForward("   ")).toBeNull();
    expect(ackCommentToForward("\n\t ")).toBeNull();
  });
});
