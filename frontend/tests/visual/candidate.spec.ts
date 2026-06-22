// frontend/tests/visual/candidate.spec.ts
// Candidate (StudentApp) visual shots from the demo build.
//
// DETERMINISM NOTE: every candidate exam-shell screen carries a LIVE wall-clock /
// elapsed timer in the top bar (ExamTopBar) that ticks every second and cannot be
// frozen by VITE_DEMO_FREEZE_NOW (it is real `Date.now()` in the shell, not demo
// API data). We mask that single liveness cluster so the rest of the page diffs
// stably. The fullscreen + Monaco "recording" workspace and the live screen-share
// preview tile are a KNOWN GAP (headless fullscreen + live tile are inherently
// non-reproducible) — see report 07 §6 and the harness README note.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { DEMO_CONTEST_SLUG, settle } from "./_helpers";

// The ticking LOCAL/ELAPSED/LEFT clock cluster in the exam top bar.
function clockMask(page: Page): Locator[] {
  return [page.locator("div.shrink-0.items-center.gap-3.px-3")];
}

// G2 (v1.1 anti-cheat): a pinned-contest candidate now hits the BROWSER CHECK
// preflight before the registration form. In the demo build the active capture
// probes synthetically pass (browserPreflightProbe demoMode), so clicking
// "Check my browser" advances to the form. Helper to clear the gate.
async function passPreflight(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Browser check" })).toBeVisible();
  await page.getByRole("button", { name: /Check my browser/ }).click();
  await expect(page.getByText("Register and start recording")).toBeVisible();
}

test("01 access-code landing", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Enter your test code" })).toBeVisible();
  await settle(page);
  // No live clock on this pre-exam screen → full deterministic shot.
  await expect(page).toHaveScreenshot("candidate-01-access-code.png", { fullPage: true });
});

// G2 (v1.1): the browser/codec preflight gate — the new first screen for a
// pinned candidate. Deterministic (no live clock, pre-capture).
test("01b browser preflight gate", async ({ page }) => {
  await page.goto(`/?contest=${DEMO_CONTEST_SLUG}`);
  await expect(page.getByRole("heading", { name: "Browser check" })).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("candidate-01b-browser-preflight.png", { fullPage: true });
});

test("02 permissions gate", async ({ page }) => {
  await page.goto(`/?contest=${DEMO_CONTEST_SLUG}`);
  await passPreflight(page);
  await expect(page.getByText("This is a proctored exam")).toBeVisible();
  await expect(page.getByRole("button", { name: /Set up permissions/ })).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("candidate-02-permissions-gate.png", {
    fullPage: true,
    mask: clockMask(page)
  });
});

test("03 details / registration form (behind the gate)", async ({ page }) => {
  await page.goto(`/?contest=${DEMO_CONTEST_SLUG}`);
  await passPreflight(page);
  // The registration form renders beneath the permissions gate overlay; capture
  // the full page so both the gate and the form chrome are in frame. G1 (v1.1):
  // the form now carries the DELETED-vs-RETAINED disclosure + the consent gate.
  await settle(page);
  await expect(page).toHaveScreenshot("candidate-03-details-roster.png", {
    fullPage: true,
    mask: clockMask(page)
  });
});

test("04 details filled", async ({ page }) => {
  await page.goto(`/?contest=${DEMO_CONTEST_SLUG}`);
  await passPreflight(page);
  const texts = page.locator('input[type="text"]');
  await texts.nth(0).fill("SR001");
  await texts.nth(1).fill("Arav Menon");
  await texts.nth(2).fill("arav@example.edu");
  await page.locator("select").first().selectOption({ index: 1 });
  await settle(page);
  await expect(page).toHaveScreenshot("candidate-04-details-filled.png", {
    fullPage: true,
    mask: clockMask(page)
  });
});
// NOTE: the G1 consent gate + the in-app Terms/Privacy modal are exercised by
// the component render tests (src/candidate/panels/ConsentGate.test.tsx) and the
// DELETED-vs-RETAINED disclosure is visible in the form shot (03) above. A live
// modal shot is intentionally NOT added here: in the pinned demo flow the
// PermissionsGate overlay sits ON TOP of the form, so the consent buttons aren't
// click-reachable from the screenshot harness — forcing it would be flaky for no
// extra coverage.
