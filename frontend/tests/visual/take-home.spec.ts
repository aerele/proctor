// frontend/tests/visual/take-home.spec.ts
// #135 take-home — visual baselines + clean doc PNGs for the NEW remote screens.
//
// The pure presentational panels (WaitingRoom, ComeBackLater, ProctorHelpLine,
// the SOFT enforcement nudge, the locked-with-phone screen) are mounted in
// ISOLATION via the demo-only /demo-gallery route (App.tsx, gated on
// VITE_DEMO_MODE) with realistic, FIXED props — so the countdowns are
// deterministic (passed as ms, not clock-driven) and the shots are byte-stable.
//
// The admin "Take-at-home (remote)" card is driven through the real admin demo
// flow (Contests → Detail) in BOTH toggle states — see the admin-card block.
import { test, expect } from "@playwright/test";
import { settle, unlockAdmin, gotoAdminView } from "./_helpers";

// Each pure panel renders under a stable ?screen=<id> selector in the gallery.
async function gallery(page: import("@playwright/test").Page, screen: string): Promise<void> {
  await page.goto(`/demo-gallery?screen=${screen}`);
  await settle(page);
}

test.describe("take-home — new candidate screens (isolated panels)", () => {
  test("01 waiting room", async ({ page }) => {
    await gallery(page, "waiting-room");
    await expect(page.getByRole("heading", { name: /Your test starts soon/ })).toBeVisible();
    await expect(page).toHaveScreenshot("take-home-01-waiting-room.png", { fullPage: true });
  });

  test("02 come back later", async ({ page }) => {
    await gallery(page, "come-back-later");
    await expect(page.getByRole("heading", { name: /come back closer to start time/ })).toBeVisible();
    await expect(page).toHaveScreenshot("take-home-02-come-back-later.png", { fullPage: true });
  });

  test("03 soft fullscreen-exit nudge", async ({ page }) => {
    await gallery(page, "soft-nudge");
    await expect(page.getByRole("heading", { name: "You're not in fullscreen" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Back to fullscreen/ })).toBeVisible();
    await expect(page).toHaveScreenshot("take-home-03-soft-nudge.png", { fullPage: true });
  });

  test("04 proctor help line", async ({ page }) => {
    await gallery(page, "proctor-help-line");
    await expect(page.getByText(/Need help\? Call your proctor:/)).toBeVisible();
    await expect(page).toHaveScreenshot("take-home-04-proctor-help-line.png", { fullPage: true });
  });

  test("06 locked screen with phone CTA", async ({ page }) => {
    await gallery(page, "locked-with-phone");
    await expect(page.getByRole("heading", { name: /Your test is locked/ })).toBeVisible();
    await expect(page.getByText("Have the unlock code?")).toBeVisible();
    await expect(page).toHaveScreenshot("take-home-06-locked-with-phone.png", { fullPage: true });
  });
});

test.describe("take-home — admin contests card", () => {
  // Open the Contests view and expand the first contest's detail so the
  // "Take-at-home (remote)" card is in frame. The demo `demo-drive-r1` contest
  // HAS a start_at, so the A11 no-start_at warning does not show on it (correct).
  async function openFirstContestDetail(page: import("@playwright/test").Page): Promise<void> {
    await unlockAdmin(page);
    await gotoAdminView(page, "Contest", "Contests");
    const detailBtn = page.getByRole("button", { name: "Detail" }).first();
    await expect(detailBtn).toBeVisible();
    await detailBtn.click();
    await expect(page.getByRole("heading", { name: "Take-at-home (remote)" })).toBeVisible();
    await settle(page);
  }

  test("05a card — toggle OFF (phone hidden)", async ({ page }) => {
    await openFirstContestDetail(page);
    // Toggle starts OFF (demo contest has no take_home_enabled) → phone hidden,
    // reentry/exit-limit inputs shown.
    await expect(page.getByText(/Remote \(take-at-home\) contest/)).toBeVisible();
    const card = page.getByRole("heading", { name: "Take-at-home (remote)" }).locator("xpath=ancestor::div[1]");
    await expect(card).toBeVisible();
    await expect(card).toHaveScreenshot("take-home-05a-admin-card-off.png");
  });

  test("05b card — toggle ON (phone shown)", async ({ page }) => {
    await openFirstContestDetail(page);
    // Click the take-home checkbox inside the card to reveal the phone field.
    const card = page.getByRole("heading", { name: "Take-at-home (remote)" }).locator("xpath=ancestor::div[1]");
    await card.locator('input[type="checkbox"]').first().check();
    await expect(page.getByText("Proctor contact phone")).toBeVisible();
    await settle(page);
    await expect(card).toHaveScreenshot("take-home-05b-admin-card-on.png");
  });
});
