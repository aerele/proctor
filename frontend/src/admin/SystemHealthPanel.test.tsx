// frontend/src/admin/SystemHealthPanel.test.tsx
//
// Light render test for the Pre-flight health-check panel. This harness has no
// jsdom/testing-library, so we render the IDLE panel with renderToStaticMarkup
// (pure node — same pattern as statementView.test.tsx / EnforcementOverlay)
// and pin the static contract: the panel mounts WITHOUT firing an API call
// (it only probes on click), exposes the primary "Run pre-flight check" button,
// and offers the paid "Full check" opt-in. No verdict/checks render until a run.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SystemHealthPanel } from "./SystemHealthPanel";

const render = () => renderToStaticMarkup(<SystemHealthPanel password="pw" />);

describe("SystemHealthPanel — idle render", () => {
  it("renders the run button and the paid full-check opt-in, and no verdict yet", () => {
    const html = render();
    expect(html).toContain("Run pre-flight check");
    expect(html).toContain("Full check (runs Judge0 — 2 paid executions)");
    expect(html).toContain('type="checkbox"');
    // Nothing has run, so no overall verdict / cleanup line is present.
    expect(html).not.toContain("All systems go");
    expect(html).not.toContain("Not ready");
    expect(html).not.toContain("Cleanup");
  });
});
