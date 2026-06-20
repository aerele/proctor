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

test("01 access-code landing", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Enter your test code" })).toBeVisible();
  await settle(page);
  // No live clock on this pre-exam screen → full deterministic shot.
  await expect(page).toHaveScreenshot("candidate-01-access-code.png", { fullPage: true });
});

test("02 permissions gate", async ({ page }) => {
  await page.goto(`/?contest=${DEMO_CONTEST_SLUG}`);
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
  await expect(page.getByText("Register and start recording")).toBeVisible();
  // The registration form renders beneath the permissions gate overlay; capture
  // the full page so both the gate and the form chrome are in frame.
  await settle(page);
  await expect(page).toHaveScreenshot("candidate-03-details-roster.png", {
    fullPage: true,
    mask: clockMask(page)
  });
});

test("04 details filled", async ({ page }) => {
  await page.goto(`/?contest=${DEMO_CONTEST_SLUG}`);
  await expect(page.getByText("Register and start recording")).toBeVisible();
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
