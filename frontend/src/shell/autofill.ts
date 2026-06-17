// frontend/src/shell/autofill.ts
//
// F12.1 — browser/extension autofill suppression for candidate detail fields.
//
// EXAM BLOCKER root cause: on the candidate DETAILS page (onboarding stage 3,
// already in fullscreen), focusing the Email field triggered Chrome's native
// email/address autofill popup. That native popup drops the document out of
// fullscreen, re-prompting the "enter fullscreen" gate. It happened ONLY on the
// email field because Chrome's autofill heuristic keys off `type=email` + an
// email-like field name.
//
// Fix: suppress autofill on EVERY detail field so no native popup can ever
// appear. We hand the input:
//   - autoComplete="off"               — the standard hint (Chrome ignores it
//                                        for recognised field shapes, hence the
//                                        rest of this set)
//   - name="f_<obscure>"               — a STABLE, deterministic, non-email-like
//                                        name that defeats Chrome's field-name
//                                        heuristic (NEVER random — a random name
//                                        each render would itself look like an
//                                        anti-autofill tell and churns the DOM)
//   - data-1p-ignore                   — 1Password: skip this field
//   - data-lpignore="true"             — LastPass: skip this field
//   - data-form-type="other"           — Dashlane/others: not a login/email form
//
// Pure helper (no React/DOM) so it is unit-testable without a render harness.

export type AutofillSuppressionProps = {
  autoComplete: "off";
  name: string;
  "data-1p-ignore": "";
  "data-lpignore": "true";
  "data-form-type": "other";
};

// Derive a deterministic, non-email-like field name from the label. Same label
// always yields the same name (stable across renders); the `f_` prefix plus the
// slugified label is deliberately nothing Chrome recognises as email/name/etc.
export function autofillFieldName(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `f_${slug || "x"}`;
}

// The full attribute set to spread onto a detail-field <input> so neither the
// browser nor a password-manager extension fires an autofill popup on focus.
export function autofillSuppressionProps(label: string): AutofillSuppressionProps {
  return {
    autoComplete: "off",
    name: autofillFieldName(label),
    "data-1p-ignore": "",
    "data-lpignore": "true",
    "data-form-type": "other"
  };
}
