// frontend/src/candidate/consentContent.test.ts
// G1 (v1.1): the swappable consent copy module — version resolution + the
// per-contest {N} / {PROCTOR_TAIL} interpolation.
import { describe, expect, it } from "vitest";
import { CONSENT_VERSION, consentContentFor, renderConsentMarkdown } from "./consentContent";

describe("consentContentFor (version registry)", () => {
  it("resolves the current version", () => {
    const c = consentContentFor(CONSENT_VERSION);
    expect(c.version).toBe(CONSENT_VERSION);
    expect(c.terms.title).toBe("Terms & Conditions");
    expect(c.privacy.title).toBe("Privacy Policy");
  });

  it("falls back to the current version for an unknown/legacy/blank version", () => {
    expect(consentContentFor("v0.0-legacy").version).toBe(CONSENT_VERSION);
    expect(consentContentFor("").version).toBe(CONSENT_VERSION);
    expect(consentContentFor(null).version).toBe(CONSENT_VERSION);
    expect(consentContentFor(undefined).version).toBe(CONSENT_VERSION);
  });
});

describe("renderConsentMarkdown ({N} / {PROCTOR_TAIL})", () => {
  const src = "Erased after {N} days. We keep {N} record. If stuck, {PROCTOR_TAIL}.";

  it("interpolates the retention window with correct pluralisation", () => {
    expect(renderConsentMarkdown(src, { retentionDays: 4 })).toContain("Erased after 4 days");
    expect(renderConsentMarkdown(src, { retentionDays: 1 })).toContain("Erased after 1 day.");
    // The bare {N} (no trailing " days") becomes the number.
    expect(renderConsentMarkdown(src, { retentionDays: 7 })).toContain("We keep 7 record");
  });

  it("defaults a garbage/zero retention to 4 days", () => {
    expect(renderConsentMarkdown(src, { retentionDays: 0 })).toContain("Erased after 4 days");
    expect(renderConsentMarkdown(src, { retentionDays: NaN })).toContain("Erased after 4 days");
    expect(renderConsentMarkdown(src, { retentionDays: -3 })).toContain("Erased after 4 days");
  });

  it("remote take-home proctor tail names the phone when given", () => {
    const out = renderConsentMarkdown(src, { retentionDays: 4, takeHome: true, proctorPhone: "+91 99999 00000" });
    expect(out).toContain("call your proctor on +91 99999 00000");
  });

  it("remote take-home without a phone points at the on-screen number", () => {
    const out = renderConsentMarkdown(src, { retentionDays: 4, takeHome: true });
    expect(out).toContain("call your proctor on the number shown on your screen");
  });

  it("in-venue tail points at the invigilator", () => {
    const out = renderConsentMarkdown(src, { retentionDays: 4, takeHome: false });
    expect(out).toContain("ask your invigilator");
  });

  it("the real Terms/Privacy bodies have no leftover placeholders after render", () => {
    const c = consentContentFor(CONSENT_VERSION);
    const terms = renderConsentMarkdown(c.terms.markdown, { retentionDays: 5, takeHome: true, proctorPhone: "123" });
    const privacy = renderConsentMarkdown(c.privacy.markdown, { retentionDays: 5 });
    expect(terms).not.toContain("{N}");
    expect(terms).not.toContain("{PROCTOR_TAIL}");
    expect(privacy).not.toContain("{N}");
    // The truthful per-contest window appears.
    expect(terms).toContain("5 days");
    expect(privacy).toContain("5 days");
  });
});
