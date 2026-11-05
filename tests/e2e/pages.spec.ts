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

  test("a table's caption runs the full width, instead of one word per line", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const caption = page.locator("main .table-stack caption").first();
    await expect(caption).toBeVisible();
    const lineHeight = await caption.evaluate((element) =>
      parseFloat(getComputedStyle(element).lineHeight),
    );
    const box = await caption.boundingBox();
    expect(box?.height).toBeLessThan(lineHeight * 2 + 24);
  });

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

test.describe("Outbox", () => {
  test("a draft shows its amount in the heading font, and the current tab is yellow", async ({
    page,
  }) => {
    await page.goto("/outbox", { waitUntil: "networkidle" });
    const card = page.locator("main .outbox-card").first();
    await expect(card).toBeVisible();
    await expect(card.locator(".outbox-head .money")).toHaveCSS("font-family", /Clash Display/);
    await expect(card.locator(".outbox-meta .chip")).toBeVisible();
    const tab = page.locator('.tabs a[aria-current="page"]');
    await expect(tab).toHaveCSS("background-color", "rgb(232, 168, 0)");
    await expect(tab).toHaveCSS("color", "rgb(0, 0, 0)");
  });

  test("the primary action comes first, and fills the width on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await page.goto("/outbox", { waitUntil: "networkidle" });
    const first = page.locator("main .outbox-card .actions .button").first();
    await expect(first).toHaveText("Approve and send");
    const box = await first.boundingBox();
    const actions = await page.locator("main .outbox-card .actions").first().boundingBox();
    expect(box?.width).toBeCloseTo(actions?.width ?? 0, 0);
  });

  test("moving to another tab doesn't animate the cards", async ({ page }) => {
    await page.goto("/outbox?tab=sent", { waitUntil: "networkidle" });
    const item = page.locator("main .list-item").first();
    await expect(item).toBeVisible();
    await expect(item).toHaveCSS("opacity", "1");
  });
});

test.describe("Clients", () => {
  const CLIENT = "/clients/00000000-0000-4000-8000-0000000000c1";

  test("a client's balance is left-aligned with its label, in the heading font", async ({
    page,
  }) => {
    await page.goto(CLIENT, { waitUntil: "networkidle" });
    const balance = page.locator(".balance-value");
    await expect(balance).not.toHaveCSS("text-align", "right");
    await expect(balance).toHaveCSS("font-family", /Clash Display/);
  });

  test("the timeline has its dotted line, behind the icons", async ({ page }) => {
    await page.goto(CLIENT, { waitUntil: "networkidle" });
    const line = await page.locator(".timeline").evaluate((list) => {
      const style = getComputedStyle(list, "::before");
      return { border: style.borderLeftStyle, width: style.borderLeftWidth };
    });
    expect(line).toEqual({ border: "dotted", width: "2px" });
  });

  test("on a phone, the list and details stack, with nothing beside them", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await page.goto("/clients", { waitUntil: "networkidle" });
    await expect(page.locator('main td[data-label="Open balance"]').first()).toBeVisible();
    await expect(page.locator("main .table-stack thead")).toHaveCSS("position", "absolute");
    await page.goto(CLIENT, { waitUntil: "networkidle" });
    const columns = await page
      .locator("dl.details")
      .evaluate((list) => getComputedStyle(list).gridTemplateColumns.split(" ").length);
    expect(columns).toBe(1);
  });
});

test.describe("Projects", () => {
  const PROJECT = "/projects/00000000-0000-4000-8000-0000000000d1";

  const fits = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll("main .card")]
        .filter((card) => !card.querySelector(".paid-stamp"))
        .flatMap((card) => {
          const edge = card.getBoundingClientRect().right;
          return [...card.querySelectorAll("button, input, select, textarea, td")]
            .filter((element) => element.getBoundingClientRect().right > edge + 1)
            .map((element) => element.tagName);
        }),
    );

  for (const width of [768, 1000, 1200, 1280, 1440]) {
    test(`a project's milestones and invoices fit at ${String(width)}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PROJECT, { waitUntil: "networkidle" });
      await expect(page.locator("main h1").first()).toBeVisible();
      await page.waitForTimeout(900);
      expect(await fits(page)).toEqual([]);
    });
  }

  test("on a desktop, a milestone's arrows share a line", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(PROJECT, { waitUntil: "networkidle" });
    const row = page.locator("main .milestone-table tbody tr").first();
    const up = await row.getByRole("button", { name: /up$/ }).boundingBox();
    const down = await row.getByRole("button", { name: /down$/ }).boundingBox();
    expect(up?.y).toBe(down?.y);
  });

  test("a form's step headings sit a level under the card's title", async ({ page }) => {
    await page.goto(PROJECT, { waitUntil: "networkidle" });
    const title = await sizeOf(page, 'main h2[id="edit"]');
    expect(await sizeOf(page, "main .form > h2")).toBeLessThan(title);
  });

  test("on a phone, the list keeps every column, including the deadline", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await page.goto("/projects", { waitUntil: "networkidle" });
    await expect(page.locator('main td[data-label="Deadline"]').first()).toBeVisible();
    await expect(page.locator('main td[data-label="Total"]').first()).toBeVisible();
  });
});

test.describe("Retainers", () => {
  test("a retainer shows its amount in the heading font, and its status and method", async ({
    page,
  }) => {
    await page.goto("/retainers", { waitUntil: "networkidle" });
    const card = page.locator("main .outbox-card").first();
    await expect(card).toBeVisible();
    await expect(card.locator(".outbox-head .money")).toHaveCSS("font-family", /Clash Display/);
    await expect(card.locator(".outbox-meta .chip")).toHaveCount(2);
  });

  test("a card you can't click doesn't lift on hover", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "light" });
    const page = await context.newPage();
    try {
      await page.goto("/retainers", { waitUntil: "networkidle" });
      const card = page.locator("main .outbox-card").first();
      await page.mouse.move(0, 0);
      const shadow = () => card.evaluate((element) => getComputedStyle(element).boxShadow);
      const before = await shadow();
      await card.hover();
      await page.waitForTimeout(300);
      expect(await shadow()).toBe(before);
    } finally {
      await context.close();
    }
  });
});

test.describe("Maintenance", () => {
  test("a job's cost is in the heading font, and its facts share a row", async ({ page }) => {
    await page.goto("/maintenance", { waitUntil: "networkidle" });
    const card = page.locator("main .outbox-card").first();
    await expect(card).toBeVisible();
    await expect(card.locator(".outbox-head .money")).toHaveCSS("font-family", /Clash Display/);
    await expect(card.locator(".outbox-meta .chip").first()).toBeVisible();
  });

  test("its many buttons wrap inside the card on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await page.goto("/maintenance", { waitUntil: "networkidle" });
    const card = await page.locator("main .outbox-card").first().boundingBox();
    for (const button of await page.locator("main .outbox-card .actions button").all()) {
      const box = await button.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
        (card?.x ?? 0) + (card?.width ?? 0),
      );
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("Settings", () => {
  test("fieldsets have the design's edge, not the browser's square box", async ({ page }) => {
    await page.goto("/settings/ai", { waitUntil: "networkidle" });
    const group = page.locator("main fieldset").first();
    await expect(group).toHaveCSS("border-top-left-radius", "14px");
    await expect(group.locator("legend")).toHaveCSS("font-weight", "600");
  });

  test("the save button doesn't touch the group above it", async ({ page }) => {
    await page.goto("/settings/ai", { waitUntil: "networkidle" });
    const last = await page.locator("main form fieldset").last().boundingBox();
    const save = await page.getByRole("button", { name: "Save AI settings" }).boundingBox();
    expect(save?.y ?? 0).toBeGreaterThanOrEqual((last?.y ?? 0) + (last?.height ?? 0) + 8);
  });

  test("a checkbox sits on the same line as its words", async ({ page }) => {
    await page.goto("/settings/ai", { waitUntil: "networkidle" });
    const label = page.locator("main fieldset label.inline").first();
    await expect(label).toHaveCSS("display", "flex");
    await expect(label).toHaveCSS("font-weight", "400");
  });

  test("links to other settings pages are secondary: yellow is for the main action", async ({
    page,
  }) => {
    await page.goto("/settings", { waitUntil: "networkidle" });
    for (const name of ["Open AI settings", "Open invoice templates", "Integrations"]) {
      await expect(page.locator("main").getByRole("link", { name, exact: true })).toHaveClass(
        /button-secondary/,
      );
    }
  });

  test("the default template's chip doesn't touch its name", async ({ page }) => {
    await page.goto("/settings/templates", { waitUntil: "networkidle" });
    await expect(page.locator("main .template-tile .chip-after").first()).toHaveCSS(
      "margin-left",
      "8px",
    );
  });

  test("the gallery shows all six built-ins, each drawn from sample data", async ({ page }) => {
    await page.goto("/settings/templates", { waitUntil: "networkidle" });
    const tiles = page.locator("main .template-tile");
    await expect(tiles).toHaveText([
      /Classic/,
      /Modern/,
      /Minimal/,
      /Studio/,
      /Ledger/,
      /Noir.*Best on screen; uses a lot of ink if printed/s,
    ]);
    for (const tile of await tiles.all()) {
      const frame = tile.locator("iframe");
      await frame.scrollIntoViewIfNeeded();
      await expect(frame).toHaveAttribute("sandbox", "");
      await expect(tile.getByRole("link", { name: "Preview" })).toBeVisible();
      await expect(frame.contentFrame().getByText("FPR-000042").first()).toBeVisible();
    }
  });

  test("on a phone, the gallery fits, and every tile can be reached", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await page.goto("/settings/templates", { waitUntil: "networkidle" });
    for (const tile of await page.locator("main .template-tile").all()) {
      const box = await tile.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
    }
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
