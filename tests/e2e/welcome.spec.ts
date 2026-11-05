import { expect, test, type Page } from "@playwright/test";

// The landing page. Its calls to action all reach the dashboard, and everything on it is there with
// reduced motion and with no JavaScript at all.

const fitsWidth = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

const scrollThrough = async (page: Page) => {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 400) {
    await page.evaluate((top) => {
      window.scrollTo(0, top);
    }, y);
    await page.waitForTimeout(40);
  }
};

test.describe("the landing page", () => {
  test("loads with no app shell, and only the brief's words", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "networkidle" });
    await expect(page).toHaveTitle(/GetPaid/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("You did");
    await expect(page.locator(".sidebar")).toHaveCount(0);
    await expect(page.locator(".app-header")).toHaveCount(0);
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/sign (in|up)/i);
    expect(text).not.toContain("₹");
  });

  test("every link goes to the dashboard or a section on the page", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "networkidle" });
    const hrefs = await page
      .locator("a")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    expect(hrefs.length).toBeGreaterThan(5);
    for (const href of hrefs) expect(["/", "#how", "#features"]).toContain(href);
    for (const id of ["how", "features"]) await expect(page.locator(`#${id}`)).toHaveCount(1);
  });

  for (const name of ["header", "hero", "final"]) {
    test(`the ${name} call to action reaches the dashboard`, async ({ page }) => {
      await page.goto("/welcome", { waitUntil: "networkidle" });
      await page.locator(`[data-cta="${name}"]`).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator(".sidebar")).toBeVisible();
    });
  }

  test("the example invoice ends paid and stamped, with the card at rest", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "networkidle" });
    const stamp = page.locator(".landing-stamp");
    await expect(stamp).toBeVisible();
    await expect.poll(() => stamp.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await expect(page.locator(".invoice-pill-paid")).toHaveText("Paid");
    await expect
      .poll(() => page.locator(".invoice-pill-paid").evaluate((el) => getComputedStyle(el).opacity))
      .toBe("1");
  });

  test("the track and the band fill as you scroll", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/welcome", { waitUntil: "networkidle" });
    const word = page.locator(".band-word").first();
    const last = page.locator(".band-word").last();
    await expect
      .poll(() => last.evaluate((el) => Number(getComputedStyle(el).opacity)))
      .toBeLessThan(0.5);
    await scrollThrough(page);
    await last.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await expect.poll(() => last.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
    await expect(word).toBeVisible();
    await expect
      .poll(() =>
        page.locator(".how-track-fill").evaluate((el) => {
          const { width } = el.getBoundingClientRect();
          return width / (el.parentElement?.getBoundingClientRect().width ?? 1);
        }),
      )
      .toBeGreaterThan(0.99);
  });

  for (const width of [375, 1280]) {
    test(`the stamp leaves every amount readable at ${String(width)}px`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/welcome", { waitUntil: "networkidle" });
      const stamp = await page.locator(".landing-stamp").boundingBox();
      for (const selector of [".invoice-card-amount", ".invoice-card-rows .money"]) {
        for (const amount of await page.locator(selector).all()) {
          const box = await amount.boundingBox();
          const overlaps =
            stamp !== null &&
            box !== null &&
            stamp.x < box.x + box.width &&
            box.x < stamp.x + stamp.width &&
            stamp.y < box.y + box.height &&
            box.y < stamp.y + stamp.height;
          expect(overlaps, selector).toBe(false);
        }
      }
    });
  }

  test("the band's words line up with the other sections", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 844 });
    await page.goto("/welcome", { waitUntil: "networkidle" });
    const band = await page.locator(".band-text").boundingBox();
    const features = await page.locator("#features .landing-container").boundingBox();
    expect(band?.x).toBeCloseTo(features?.x ?? 0, 0);
  });

  test("the phone nav keeps its button on one line, inside the screen", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await page.goto("/welcome", { waitUntil: "networkidle" });
    const button = await page.locator('[data-cta="header"]').boundingBox();
    expect(button?.height).toBeLessThan(52);
    expect((button?.x ?? 0) + (button?.width ?? 0)).toBeLessThanOrEqual(375);
  });

  test("a phone shows at most one triangle per section", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await page.goto("/welcome", { waitUntil: "networkidle" });
    const counts = await page
      .locator("[data-section]")
      .evaluateAll((sections) =>
        sections.map(
          (section) =>
            [...section.querySelectorAll(".dot-tri")].filter(
              (triangle) => getComputedStyle(triangle).display !== "none",
            ).length,
        ),
      );
    for (const count of counts) expect(count).toBeLessThanOrEqual(1);
  });

  test("the nav settles once you scroll", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "networkidle" });
    const nav = page.locator(".landing-nav");
    await expect(nav).not.toHaveClass(/is-scrolled/);
    await page.evaluate(() => {
      window.scrollTo(0, 200);
    });
    await expect(nav).toHaveClass(/is-scrolled/);
  });

  test("works with reduced motion: everything is already in place", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/welcome", { waitUntil: "networkidle" });
    for (const selector of [".landing-stamp", ".invoice-pill-paid", ".band-word", ".how-step"]) {
      const opacity = await page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).opacity);
      expect(opacity, selector).toBe("1");
    }
    // Nothing was left for GSAP to move: no inline transforms anywhere on the page.
    const moved = await page
      .locator("main *")
      .evaluateAll((all) => all.filter((el) => (el as HTMLElement).style.transform !== "").length);
    expect(moved).toBe(0);
    await expect(page.locator(".how-track-fill")).toBeVisible();
    await page.locator('[data-cta="hero"]').click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("reads in full with no JavaScript", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto("/welcome");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".landing-stamp")).toBeVisible();
    await expect(page.getByText("Less time chasing clients")).toBeVisible();
    await context.close();
  });

  for (const theme of ["dark", "light"] as const) {
    for (const width of [375, 768, 1280, 1440]) {
      test(`fits at ${String(width)}px in ${theme}`, async ({ page }) => {
        await page.addInitScript((chosen) => {
          localStorage.setItem("theme", chosen);
        }, theme);
        await page.setViewportSize({ width, height: 844 });
        await page.goto("/welcome", { waitUntil: "networkidle" });
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        expect(await fitsWidth(page)).toBe(true);
        await scrollThrough(page);
        expect(await fitsWidth(page)).toBe(true);
      });
    }
  }
});
