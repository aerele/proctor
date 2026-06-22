// frontend/src/candidate/panels/ConsentGate.test.tsx
// G1 (v1.1): the consent disclosure + gate render correctly and the gate keeps
// the agreement boxes DISABLED until both pages are viewed. Rendered with
// react-dom/server (the suite's no-jsdom idiom — EvaluationPanel.test.tsx).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConsentDisclosurePanel, ConsentGate } from "./ConsentGate";

describe("ConsentDisclosurePanel (DELETED vs RETAINED)", () => {
  it("shows the truthful per-contest window and the kept list", () => {
    const html = renderToStaticMarkup(
      <ConsentDisclosurePanel retentionDays={7} cameraRecorded ownEditor />
    );
    expect(html).toContain("Erased after 7 days");
    expect(html).toContain("Your screen recording");
    expect(html).toContain("Your camera recording");
    expect(html).toContain("Your keystrokes / editor activity");
    expect(html).toContain("Your roll number / identifier");
    expect(html).toContain("Your scores and final submission");
  });

  it("omits the camera + editor rows when those captures are off (no overclaim)", () => {
    const html = renderToStaticMarkup(
      <ConsentDisclosurePanel retentionDays={4} cameraRecorded={false} ownEditor={false} />
    );
    expect(html).not.toContain("Your camera recording");
    expect(html).not.toContain("Your keystrokes / editor activity");
    expect(html).toContain("Your screen recording");
  });

  it("pluralises a 1-day window correctly", () => {
    const html = renderToStaticMarkup(
      <ConsentDisclosurePanel retentionDays={1} cameraRecorded ownEditor />
    );
    expect(html).toContain("Erased after 1 day");
    expect(html).not.toContain("1 days");
  });
});

describe("ConsentGate (view-both-pages → unlock)", () => {
  const baseProps = {
    consentVersion: "v1.1",
    retentionDays: 4,
    takeHome: false,
    proctorPhone: "",
    consentSentence: "I consent to the recording.",
    openDoc: () => undefined,
    onChange: () => undefined
  };

  it("disables the agreement checkboxes until BOTH pages are viewed", () => {
    const html = renderToStaticMarkup(
      <ConsentGate
        {...baseProps}
        state={{ viewedTerms: false, viewedPrivacy: false, rightToConsent: false, consentAccepted: false }}
      />
    );
    // Both consent checkboxes render disabled; the "open both" hint shows.
    expect(html).toContain("disabled");
    expect(html).toContain("Open both the Terms and the Privacy Policy to continue.");
  });

  it("enables the checkboxes once both pages are viewed", () => {
    const html = renderToStaticMarkup(
      <ConsentGate
        {...baseProps}
        state={{ viewedTerms: true, viewedPrivacy: true, rightToConsent: false, consentAccepted: false }}
      />
    );
    expect(html).not.toContain("Open both the Terms and the Privacy Policy to continue.");
    expect(html).toContain("I consent to the recording.");
    // The "Viewed" markers show on both doc buttons.
    expect(html.match(/Viewed/g)?.length).toBe(2);
  });
});
