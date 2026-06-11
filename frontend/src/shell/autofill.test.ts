// frontend/src/shell/autofill.test.ts
//
// F12.1 — autofill suppression helper. The shared candidate `Field` input spreads
// these props so Chrome's email/address autofill popup (which drops fullscreen)
// can never appear. Render-testing is not set up in this suite, so we cover the
// pure helper directly; App.tsx spreads it on the <input>.
import { describe, it, expect } from "vitest";
import { autofillFieldName, autofillSuppressionProps } from "./autofill";

describe("autofillFieldName", () => {
  it("slugifies the label into an obscure, non-email-like name", () => {
    expect(autofillFieldName("Email")).toBe("f_email");
    expect(autofillFieldName("Full name")).toBe("f_full_name");
    expect(autofillFieldName("Roll number")).toBe("f_roll_number");
  });

  it("is deterministic — same label always yields the same name", () => {
    expect(autofillFieldName("Email")).toBe(autofillFieldName("Email"));
    expect(autofillFieldName("Candidate ID")).toBe(autofillFieldName("Candidate ID"));
  });

  it("collapses punctuation/whitespace and trims edge underscores", () => {
    expect(autofillFieldName("  Roll #/Number!  ")).toBe("f_roll_number");
    expect(autofillFieldName("Reg. No.")).toBe("f_reg_no");
  });

  it("never produces an email-like name and never starts empty", () => {
    expect(autofillFieldName("Email")).not.toContain("email@");
    expect(autofillFieldName("Email").startsWith("f_")).toBe(true);
    expect(autofillFieldName("!!!")).toBe("f_x");
  });
});

describe("autofillSuppressionProps", () => {
  it("turns off native autocomplete", () => {
    expect(autofillSuppressionProps("Email").autoComplete).toBe("off");
  });

  it("carries the deterministic obscure name", () => {
    expect(autofillSuppressionProps("Email").name).toBe("f_email");
  });

  it("sets the password-manager ignore attributes (1Password / LastPass / Dashlane)", () => {
    const props = autofillSuppressionProps("Email");
    expect(props["data-1p-ignore"]).toBe("");
    expect(props["data-lpignore"]).toBe("true");
    expect(props["data-form-type"]).toBe("other");
  });

  it("returns the same shape for the same label (no random churn)", () => {
    expect(autofillSuppressionProps("Email")).toEqual(autofillSuppressionProps("Email"));
  });
});
