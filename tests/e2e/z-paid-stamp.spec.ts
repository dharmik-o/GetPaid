import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { fakeState, payInvoice } from "./helpers";

// The Paid stamp in a real browser. Named to run last: paying the demo's open installment clears the
// draft that tests/e2e/theme.spec.ts needs in the Outbox.

const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const PROJECT = "00000000-0000-4000-8000-0000000000d1";
const PROJECT_PAGE = `/projects/${PROJECT}`;
const CLIENT_PAGE = `/clients/${CLIENT}`;
const SETTLED_MS = 900;

const fresh = async (
  browser: Browser,
  options: Parameters<Browser["newContext"]>[0] = {},
): Promise<{ context: BrowserContext; page: Page }> => {
  const context = await browser.newContext(options);
  return { context, page: await context.newPage() };
};

const open = async (page: Page, path: string) => {
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("main h1").first()).toBeVisible();
};

const stamps = (page: Page) => page.locator(".paid-stamp");

/** The stamp's rotation in degrees, and its scale, as drawn. */
const pose = (page: Page) =>
  stamps(page)
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const matrix = new DOMMatrix(style.transform);
      return {
        rotate: Math.round((Math.atan2(matrix.b, matrix.a) * 180) / Math.PI),
        scale: Math.round(Math.hypot(matrix.a, matrix.b) * 100) / 100,
        opacity: style.opacity,
      };
    });

test.describe("the Paid stamp", () => {
  test("plays once for a newly paid invoice, and not again on reload or elsewhere", async ({
    browser,
  }) => {
    const { context, page } = await fresh(browser);
    try {
      await open(page, PROJECT_PAGE);
      // The demo's two paid invoices have their first showing in this browser.
      await expect(stamps(page)).toHaveCount(2);
      await page.reload({ waitUntil: "networkidle" });
      await expect(stamps(page)).toHaveCount(0);

      const { invoices } = await fakeState(page.request);
      const open2of2 = invoices.at(-1);
      if (!open2of2) throw new Error("The demo's second installment is missing.");
      await expect(page.locator("main").getByText("Sent", { exact: true })).toBeVisible();

      // The Outbox is open too: its draft for this invoice collapses away by itself.
      const outbox = await context.newPage();
      await open(outbox, "/outbox");
      await expect(outbox.locator("main .outbox-card")).toHaveCount(1);

      await payInvoice(page.request, { id: open2of2.id, value: "750.00" });
      await expect(outbox.locator("main .outbox-card")).toHaveCount(0, { timeout: 20_000 });
      await expect(outbox.locator("main .card.empty")).toBeVisible();
      await outbox.close();

      await open(page, PROJECT_PAGE);
      await expect(stamps(page)).toHaveCount(1);
      await expect(page.getByRole("status").filter({ hasText: /FPR-\d+ paid/ })).toHaveCount(1);

      await page.waitForTimeout(SETTLED_MS);
      expect(await pose(page)).toEqual({ rotate: -14, scale: 1, opacity: "1" });

      await page.reload({ waitUntil: "networkidle" });
      await expect(stamps(page)).toHaveCount(0);
      await open(page, CLIENT_PAGE);
      await expect(stamps(page)).toHaveCount(0);
      await open(page, "/");
      await expect(stamps(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  for (const [where, path] of [
    ["the client timeline", CLIENT_PAGE],
    ["Home", "/"],
  ] as const) {
    test(`plays on ${where}, with the badge and an announcement`, async ({ browser }) => {
      const { context, page } = await fresh(browser);
      try {
        await open(page, path);
        await expect(stamps(page).first()).toBeVisible();
        const moment = page
          .locator(".paid-moment")
          .filter({ has: stamps(page) })
          .first();
        await expect(moment.locator(".badge-paid")).toBeVisible();
        await expect(moment.getByRole("status")).toHaveText(/paid|captured/i);
      } finally {
        await context.close();
      }
    });
  }

  test("never blocks a click, and is hidden from screen readers", async ({ browser }) => {
    const { context, page } = await fresh(browser);
    try {
      await open(page, PROJECT_PAGE);
      await page.waitForTimeout(SETTLED_MS);
      const stamp = stamps(page).first();
      await expect(stamp).toHaveCSS("pointer-events", "none");
      await expect(stamp).toHaveAttribute("aria-hidden", "true");
      const onTop = await stamp.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return hit === element;
      });
      expect(onTop).toBe(false);
    } finally {
      await context.close();
    }
  });

  for (const [colorScheme, ink] of [
    ["dark", "rgb(232, 168, 0)"],
    ["light", "rgb(135, 91, 0)"],
  ] as const) {
    test(`is drawn in --accent-ink in ${colorScheme} mode`, async ({ browser }) => {
      const { context, page } = await fresh(browser, { colorScheme });
      try {
        await open(page, PROJECT_PAGE);
        await expect(stamps(page).first()).toHaveCSS("background-color", ink);
      } finally {
        await context.close();
      }
    });
  }

  for (const [name, width] of [
    ["desktop", 1280],
    ["phone", 375],
  ] as const) {
    test(`doesn't make the page scroll sideways on a ${name}, even mid-slam`, async ({
      browser,
    }) => {
      const { context, page } = await fresh(browser, { viewport: { width, height: 844 } });
      try {
        await page.goto(PROJECT_PAGE, { waitUntil: "commit" });
        await expect(stamps(page).first()).toBeVisible();
        const widest = await page.evaluate(async () => {
          let most = 0;
          const until = performance.now() + 800;
          while (performance.now() < until) {
            const { scrollWidth, clientWidth } = document.documentElement;
            most = Math.max(most, scrollWidth - clientWidth);
            await new Promise(requestAnimationFrame);
          }
          return most;
        });
        expect(widest).toBe(0);
      } finally {
        await context.close();
      }
    });
  }

  for (const colorScheme of ["light", "dark"] as const) {
    for (const [name, width] of [
      ["desktop", 1280],
      ["phone", 375],
    ] as const) {
      test(`leaves a screenshot to look at: ${colorScheme}, ${name}`, async ({
        browser,
      }, testInfo) => {
        const { context, page } = await fresh(browser, {
          colorScheme,
          viewport: { width, height: 844 },
        });
        try {
          for (const [label, path] of [
            ["project", PROJECT_PAGE],
            ["client", CLIENT_PAGE],
            ["home", "/"],
          ] as const) {
            await page.evaluate(() => {
              try {
                localStorage.clear();
              } catch {
                // about:blank has no storage, and nothing to clear.
              }
            });
            await open(page, path);
            await expect(stamps(page).first()).toBeVisible();
            await page.waitForTimeout(SETTLED_MS);
            await page.screenshot({
              path: testInfo.outputPath(`stamp-${label}-${colorScheme}-${name}.png`),
              fullPage: true,
            });
          }
        } finally {
          await context.close();
        }
      });
    }
  }

  test("doesn't cover an amount on a phone's timeline", async ({ browser }) => {
    const { context, page } = await fresh(browser, { viewport: { width: 375, height: 844 } });
    try {
      await open(page, CLIENT_PAGE);
      await expect(stamps(page).first()).toBeVisible();
      await page.waitForTimeout(SETTLED_MS);
      const overlaps = await stamps(page).evaluateAll((all) =>
        all.flatMap((stamp) => {
          const box = stamp.getBoundingClientRect();
          const title = stamp.parentElement?.querySelector("strong");
          if (!title) return [];
          const range = document.createRange();
          range.selectNodeContents(title);
          return [...range.getClientRects()]
            .filter((line) => line.right > box.left + 4 && line.left < box.right - 4)
            .filter((line) => line.bottom > box.top + 4 && line.top < box.bottom - 4)
            .map(() => title.textContent);
        }),
      );
      expect(overlaps).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("is mid-drop partway through: it animates, rather than just appearing", async ({
    browser,
  }) => {
    const { context, page } = await fresh(browser);
    try {
      // Sampled from inside the page, from the moment the stamp arrives: a poll from here is too slow
      // to catch a drop that lasts 0.45s.
      await page.addInitScript(() => {
        const scales: number[] = [];
        Object.assign(window, { stampScales: scales });
        const sample = () => {
          const stamp = document.querySelector(".paid-stamp");
          if (stamp) {
            const matrix = new DOMMatrix(getComputedStyle(stamp).transform);
            scales.push(Math.hypot(matrix.a, matrix.b));
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await open(page, PROJECT_PAGE);
      await expect(stamps(page).first()).toBeAttached();
      await page.waitForTimeout(SETTLED_MS);
      const seen = await page.evaluate(
        () => (window as unknown as { stampScales: number[] }).stampScales,
      );
      expect(Math.max(...seen)).toBeGreaterThan(1.5);
      expect(seen.at(-1)).toBeCloseTo(1, 1);
    } finally {
      await context.close();
    }
  });

  test("just appears with reduced motion: no movement at all", async ({ browser }) => {
    const { context, page } = await fresh(browser, { reducedMotion: "reduce" });
    try {
      await open(page, PROJECT_PAGE);
      await expect(stamps(page).first()).toBeVisible();
      // No waiting: it's already at rest, the first time it can be measured.
      expect(await pose(page)).toEqual({ rotate: -14, scale: 1, opacity: "1" });
      const moment = page
        .locator(".paid-moment")
        .filter({ has: stamps(page) })
        .first();
      expect(await moment.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
      const badge = moment.locator(".badge-paid");
      expect(await badge.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
    } finally {
      await context.close();
    }
  });

  test("stays away, without errors, if the browser's storage is blocked", async ({ browser }) => {
    const { context, page } = await fresh(browser);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.addInitScript(() => {
        const read = Storage.prototype.getItem.bind(localStorage);
        Storage.prototype.getItem = function getItem(key: string) {
          if (key.includes("paid-stamps")) throw new Error("blocked");
          return read(key);
        };
      });
      await open(page, PROJECT_PAGE);
      await expect(page.locator(".badge-paid").first()).toBeVisible();
      await expect(stamps(page)).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
