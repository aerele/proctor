// frontend/src/admin/EvaluationPanel.test.tsx
// The Evaluation tab renders ONLY a caption + a full-size iframe whose src points
// at the eval service's /eval-ui page with the contest slug — the SPA renders
// none of the evaluation content itself (that is owned by proctor-eval).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvaluationPanel } from "./EvaluationPanel";
import { evalApiBaseUrl } from "../api";

const render = (contestSlug: string) =>
  renderToStaticMarkup(<EvaluationPanel contestSlug={contestSlug} />);

describe("EvaluationPanel — eval-service-embedded iframe", () => {
  it("renders an iframe whose src is ${evalApiBaseUrl}/eval-ui?contest=<slug>", () => {
    const html = render("mcet-june-2026");
    expect(html).toContain("<iframe");
    // The src points at the eval base + /eval-ui + the encoded slug.
    expect(html).toContain(`${evalApiBaseUrl}/eval-ui?contest=mcet-june-2026`);
  });

  it("shows the 'Served by the evaluation service' caption", () => {
    const html = render("mcet-june-2026");
    expect(html).toContain("Served by the evaluation service");
  });

  it("URL-encodes an odd contest slug in the iframe src (no raw spaces/special chars)", () => {
    const html = render("a b&c");
    expect(html).toContain(`/eval-ui?contest=${encodeURIComponent("a b&c")}`);
    // The raw, un-encoded form must not appear in the src attribute.
    expect(html).not.toContain("contest=a b&c");
  });

  it("still renders the iframe pointed at /eval-ui when no contest slug is set", () => {
    const html = render("");
    expect(html).toContain("<iframe");
    expect(html).toContain(`${evalApiBaseUrl}/eval-ui?contest=`);
  });
});
