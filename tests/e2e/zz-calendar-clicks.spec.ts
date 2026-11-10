import { expect, test } from "@playwright/test";

// A6: the month changes without a page load, and a day opens a panel where an entry can be added,
// changed and deleted in place. `window.__noReload` is wiped by any real navigation, so it proves
// nothing reloaded. Runs after the demo; leaves the calendar as it found it.

declare global {
  interface Window {
    __noReload?: boolean;
  }
}

test("month buttons don't reload, and a day adds, edits and deletes an entry in place", async ({
  page,
}) => {
  await page.goto("/calendar", { waitUntil: "networkidle" });
  const heading = page.locator('section[aria-label="Month"] h2').first();
  const first = (await heading.textContent()) ?? "";
  const next = page.getByRole("button", { name: "Next", exact: true });
  const previous = page.getByRole("button", { name: "Previous", exact: true });

  // Month buttons: no reload, scroll stays, the address names the month.
  await next.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    window.scrollBy(0, 40);
    window.__noReload = true;
  });
  await expect(next).toBeInViewport();
  const scrolled = await page.evaluate(() => window.scrollY);
  await next.click();
  await expect(heading).not.toContainText(first);
  await expect(page).toHaveURL(/\/calendar\?month=\d{4}-\d{2}$/);
  await previous.click();
  await expect(heading).toContainText(first);
  expect(await page.evaluate(() => window.__noReload)).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);

  // A day opens the panel; add an entry from it.
  const today = page.locator(".cal-today");
  await today.locator(".cal-daybtn").click();
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /^Add entry on / }).click();
  await panel.getByLabel("Title").fill("E2E click entry");
  await panel.getByRole("button", { name: "Add entry", exact: true }).click();
  await expect(panel.getByText("E2E click entry")).toBeVisible();
  const chip = today.locator(".cal-item", { hasText: "E2E click entry" });
  await expect(chip).toHaveCount(1);

  // Esc closes the panel and focus goes back to the day.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(today.locator(".cal-daybtn")).toBeFocused();

  // An item chip opens the panel on that item. Edit its title.
  await chip.click();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  await panel.getByLabel("Title").fill("E2E renamed entry");
  await panel.getByRole("button", { name: "Save changes" }).click();
  await expect(panel.getByText("E2E renamed entry")).toBeVisible();
  await expect(today.locator(".cal-item", { hasText: "E2E renamed entry" })).toHaveCount(1);

  // Delete asks first, then removes it.
  await panel.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(panel.getByText("Delete this entry?")).toBeVisible();
  await panel.getByRole("button", { name: "Yes, delete" }).click();
  await expect(panel.getByText("E2E renamed entry")).toHaveCount(0);
  await expect(today.locator(".cal-item", { hasText: "E2E renamed entry" })).toHaveCount(0);

  expect(await page.evaluate(() => window.__noReload)).toBe(true);
});
