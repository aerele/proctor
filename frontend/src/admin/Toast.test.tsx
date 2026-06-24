// frontend/src/admin/Toast.test.tsx
// LT-10: static-markup assertions for the floating toast's accessibility wiring.
// The repo has no jsdom, so the interactive provider/timer path is covered by the
// pure reducer/policy tests in toastState.test.ts; here we assert the rendered
// item carries the right role + aria-live per kind, the message, and a labelled
// dismiss control.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToastItem } from "./Toast";

const render = (kind: "success" | "error", message: string) =>
  renderToStaticMarkup(<ToastItem toast={{ id: "x", kind, message }} onDismiss={() => {}} />);

describe("ToastItem accessibility + content", () => {
  it("error toasts use role=alert + aria-live=assertive", () => {
    const html = render("error", "Problem referenced by contest x");
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain("Problem referenced by contest x");
  });

  it("success toasts use role=status + aria-live=polite", () => {
    const html = render("success", "Saved");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Saved");
  });

  it("renders a labelled dismiss button", () => {
    const html = render("error", "Failed");
    expect(html).toContain('aria-label="Dismiss notification"');
  });

  it("applies the danger tone to errors and the accent tone to success", () => {
    expect(render("error", "Failed")).toContain("text-danger");
    expect(render("success", "Saved")).toContain("text-accent");
  });
});
