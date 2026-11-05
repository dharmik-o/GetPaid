import { expect, test, type Page } from "@playwright/test";
import { contrast } from "../contrast";

// The phone's More menu: the only way to reach Projects, Retainers, Maintenance and Settings from the
// bottom bar. Read-only.

const LINKS = [
  ["Projects", "/projects"],
  ["Retainers", "/retainers"],
  ["Maintenance", "/maintenance"],
  ["Settings", "/settings"],
] as const;

const bar = (page: Page) => page.getByRole("navigation", { name: "Main" });
const more = (page: Page) => bar(page).getByRole("button", { name: "More" });
const menu = (page: Page) => page.locator(".more-menu");

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 844 } });

  for (const [label, path] of LINKS) {
    test(`More reaches ${label}, and the menu closes`, async ({ page }) => {
      await page.goto("/", { waitUntil: "networkidle" });
      await more(page).click();
      await expect(more(page)).toHaveAttribute("aria-expanded", "true");
      await menu(page).getByRole("link", { name: label }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.locator("main h1").first()).toBeVisible();
      await expect(menu(page)).toHaveCount(0);
      await expect(more(page)).toHaveAttribute("aria-expanded", "false");
    });
  }

  test("is closed until asked for, and only lists what the bar doesn't", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(menu(page)).toHaveCount(0);
    await expect(more(page)).toHaveAttribute("aria-expanded", "false");
    await more(page).click();
    await expect(menu(page).getByRole("link")).toHaveText(LINKS.map(([label]) => label));
  });

  test("Escape closes it and puts focus back on More", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await more(page).click();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await expect(more(page)).toBeFocused();
  });

  test("a tap elsewhere closes it", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await more(page).click();
    await expect(menu(page)).toBeVisible();
    await page.mouse.click(187, 200);
    await expect(menu(page)).toHaveCount(0);
  });

  test("works by keyboard alone", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await more(page).focus();
    await page.keyboard.press("Enter");
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(menu(page).getByRole("link", { name: "Projects" })).toBeFocused();
  });

  test("marks More as current on a page inside it", async ({ page }) => {
    await page.goto("/retainers", { waitUntil: "networkidle" });
    await expect(more(page)).toHaveClass(/is-current/);
    await more(page).click();
    await expect(menu(page).getByRole("link", { name: "Retainers" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(more(page)).not.toHaveClass(/is-current/);
  });

  test("every target is big enough to tap, and it stays on screen", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const button = await more(page).boundingBox();
    expect(button?.height).toBeGreaterThanOrEqual(44);
    await more(page).click();
    for (const link of await menu(page).getByRole("link").all()) {
      expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    await page.waitForTimeout(400);
    const box = await menu(page).boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(button?.y ?? 0);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test.describe(`in the ${colorScheme} theme`, () => {
      test.use({ colorScheme });

      test("its text is readable, and it leaves a screenshot", async ({ page }, testInfo) => {
        await page.goto("/", { waitUntil: "networkidle" });
        await more(page).click();
        await page.waitForTimeout(400);
        const colors = await menu(page)
          .getByRole("link")
          .first()
          .evaluate((link) => ({
            text: getComputedStyle(link).color,
            fill: getComputedStyle(link.closest(".more-menu") ?? link).backgroundColor,
          }));
        expect(contrast(colors.text, colors.fill)).toBeGreaterThanOrEqual(4.5);
        await page.screenshot({ path: testInfo.outputPath(`more-menu-${colorScheme}.png`) });
      });
    });
  }

  test("just appears with reduced motion", async ({ browser }) => {
    const context = await browser.newContext({
      reducedMotion: "reduce",
      viewport: { width: 375, height: 844 },
    });
    const page = await context.newPage();
    try {
      await page.goto("/", { waitUntil: "networkidle" });
      await more(page).click();
      const style = await menu(page).evaluate((element) => ({
        opacity: getComputedStyle(element).opacity,
        transform: getComputedStyle(element).transform,
      }));
      expect(style).toEqual({ opacity: "1", transform: "none" });
    } finally {
      await context.close();
    }
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the sidebar lists everything, and there's no More", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(more(page)).toBeHidden();
    for (const [label] of LINKS) {
      await expect(bar(page).getByRole("link", { name: label })).toBeVisible();
    }
  });
});
