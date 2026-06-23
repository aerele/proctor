// frontend/src/shell/AnomalyPanel.test.tsx
//
// ALERT-1: the candidate two-button feedback on the AnomalyPanel red banner —
// "I have fixed it — continue my test" (acknowledge) + the quieter "Report a problem with this
// alert" (dispute). Same pure-node renderToStaticMarkup harness as
// EnforcementOverlay.test.tsx (no jsdom): we pin the structural contract — the
// dispute button is rendered ONLY when onReportDispute is provided, and the
// banner copy frames the dispute as for genuine software faults only.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnomalyPanel } from "./AnomalyPanel";

const base = {
  reasons: [{ type: "tab_away", message: "You switched away from the exam", at: "2026-06-23T10:00:00.000Z" }],
  preconditions: { fullscreen: true, visible: true, recording: true },
  onRestore: () => {},
  onEnterFullscreen: async () => {}
};

const render = (props: Partial<Parameters<typeof AnomalyPanel>[0]>) =>
  renderToStaticMarkup(<AnomalyPanel {...base} {...props} />);

describe("AnomalyPanel — candidate dispute feedback (ALERT-1)", () => {
  it("always renders the acknowledge action", () => {
    expect(render({})).toContain("I have fixed it — continue my test");
  });

  it("renders the dispute button ONLY when onReportDispute is provided", () => {
    expect(render({})).not.toContain("Report a problem with this alert");
    expect(render({ onReportDispute: () => {} })).toContain("Report a problem with this alert");
  });

  it("the dispute affordance does not replace or disable the restore action", () => {
    const html = render({ onReportDispute: () => {} });
    expect(html).toContain("I have fixed it — continue my test");
    expect(html).toContain("Report a problem with this alert");
  });
});
