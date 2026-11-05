import { expect, test, type Page } from "@playwright/test";

// The page-by-page restyle: what each page should look like, on top of the checks every page gets in
// tests/e2e/theme.spec.ts. Read-only, and runs on the demo's data.

const sizeOf = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));

test.describe("Home", () => {
  test("leads with what needs attention, then money, then what's coming", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const headings = await page.locator("main .card h2").allTextContents();
    expect(headings.slice(0, 3)).toEqual(["Needs attention", "Recovery", "Upcoming"]);
  });

  for (const [name, width, smallest] of [
    ["desktop", 1280, 50],
    ["phone", 375, 36],
  ] as const) {
    test(`the amount recovered is the biggest number, and fits, on a ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/", { waitUntil: "networkidle" });
      const big = await sizeOf(page, ".metric-tile:first-child .metric-value");
      expect(big).toBeGreaterThanOrEqual(smallest);
      expect(big).toBeGreaterThan(await sizeOf(page, ".metric-tile:nth-child(2) .metric-value"));
      const fits = await page
        .locator(".metric-tile:first-child")
        .evaluate((tile) => tile.scrollWidth <= tile.clientWidth);
      expect(fits).toBe(true);
    });
  }

  test("the smaller tiles fill their row, with no empty slot", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.goto("/", { waitUntil: "networkidle" });
    const row = await page.locator(".metric-tiles").boundingBox();
    const last = await page.locator(".metric-tile").last().boundingBox();
    expect((last?.x ?? 0) + (last?.width ?? 0)).toBeCloseTo((row?.x ?? 0) + (row?.width ?? 0), 0);
  });

  test("expected income is a row of amounts with their codes, not a stray line", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const totals = page.getByRole("list", { name: "Expected income by currency" });
    await expect(totals.getByRole("listitem").first()).toContainText(/^[A-Z]{3}\s[\d,]+\.\d{2}$/);
    await expect(totals.getByRole("listitem").first()).not.toHaveCSS("text-align", "right");
  });
});

test.describe("Home on a phone", () => {
  test.use({ viewport: { width: 375, height: 844 } });

  test("tables become labelled rows, so no amount hides behind a scroll", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const amounts = page.locator('main .table-stack td[data-label="Amount"]');
    await expect(amounts.first()).toBeVisible();
    for (const amount of await amounts.all()) {
      const box = await amount.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
    }
    await expect(page.locator("main .table-stack thead").first()).toHaveCSS("position", "absolute");
  });
});

test.describe("every page", () => {
  test("fades in, and doesn't with reduced motion", async ({ browser }) => {
    for (const [reducedMotion, name] of [
      ["no-preference", "page-in"],
      ["reduce", "none"],
    ] as const) {
      const context = await browser.newContext({ reducedMotion });
      const page = await context.newPage();
      try {
        await page.goto("/settings", { waitUntil: "networkidle" });
        await expect(page.locator(".page").first()).toHaveCSS("animation-name", name);
      } finally {
        await context.close();
      }
    }
  });
});

test.describe("an empty state", () => {
  test("has the page's one dotted triangle", async ({ page }) => {
    await page.goto("/outbox?tab=skipped", { waitUntil: "networkidle" });
    const empty = page.locator("main .card.empty");
    await expect(empty).toBeVisible();
    const after = await empty.evaluate((element) => {
      const style = getComputedStyle(element, "::after");
      return { image: style.backgroundImage, clip: style.clipPath, position: style.position };
    });
    expect(after.image).toContain("radial-gradient");
    expect(after.clip).toContain("polygon");
    expect(after.position).toBe("absolute");
    await expect(page.locator(".sidebar .dot-tri")).toBeHidden();
  });

  test("a page without one keeps the triangle in the sidebar", async ({ page }) => {
    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".sidebar .dot-tri")).toBeVisible();
  });
});
