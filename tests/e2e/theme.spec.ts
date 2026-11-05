import { expect, test, type Page } from "@playwright/test";
import { contrast, parseColor } from "../contrast";

// Runs after the demo, so the pages have real invoices, drafts, retainers and jobs on them. Read-only.
// Each page is measured in both themes at desktop and phone width. A screenshot of each is left in
// test-results for a person to look at.

const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const PROJECT = "00000000-0000-4000-8000-0000000000d1";

const PAGES = [
  "/",
  "/outbox",
  "/clients",
  "/clients/new",
  `/clients/${CLIENT}`,
  `/clients/${CLIENT}?tab=invoices`,
  "/projects",
  "/projects/new",
  `/projects/${PROJECT}`,
  "/retainers",
  "/retainers/new",
  "/maintenance",
  "/maintenance/new",
  "/settings",
  "/settings/ai",
  "/settings/integrations",
  "/settings/templates",
  "/settings/templates/new",
];

type Measured = {
  label: string;
  text: string;
  fill: string;
  behind: string;
  border: string;
  width: number;
  shadow: string;
};

/** Colours as drawn: a see-through background shows whatever is behind it. */
const measure = (page: Page, selector: string): Promise<Measured[]> =>
  page.evaluate((query) => {
    const fillBehind = (element: Element): string => {
      for (let at: Element | null = element; at; at = at.parentElement) {
        const color = getComputedStyle(at).backgroundColor;
        // Only a zero alpha is see-through. Pure black, rgb(0, 0, 0), also ends in ", 0)".
        if (!/^rgba\(.*, 0\)$|^transparent$/.test(color)) return color;
      }
      return "rgb(255, 255, 255)";
    };
    return [...document.querySelectorAll(query)]
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => {
        const style = getComputedStyle(element);
        return {
          label: `${element.tagName.toLowerCase()}.${element.className} "${element.textContent.trim().slice(0, 30)}"`,
          text: style.color,
          fill: fillBehind(element),
          behind: element.parentElement ? fillBehind(element.parentElement) : "rgb(255, 255, 255)",
          border: style.borderTopColor,
          width: parseFloat(style.borderTopWidth),
          shadow: style.boxShadow,
        };
      });
  }, selector);

/**
 * Buttons that can't be seen or read, as readable lines, so a failure names them. A button needs a
 * visible border unless its own fill stands out at 3:1, as yellow does on black. On white it doesn't,
 * so there it needs the --edge outline.
 */
const buttonProblems = (buttons: Measured[]): string[] =>
  buttons.flatMap(({ label, text, fill, behind, border, width }) => {
    const problems: string[] = [];
    const ratio = contrast(text, fill);
    if (ratio < 4.5) problems.push(`${label}: text is ${ratio.toFixed(2)}:1`);
    const hasBorder = width >= 1 && parseColor(border).a > 0;
    if (!hasBorder && contrast(fill, behind) < 3) problems.push(`${label}: no visible border`);
    return problems;
  });

const FIELDS = 'main input:not([type="checkbox"]):not([type="radio"]), main select, main textarea';
const PANELS =
  "main .card, main .table, main .banner, main .schedule-preview, main .schedule-group, main .metric-tile, main .outbox-body, main .template-preview, main fieldset";

/** In light mode the shadows do the separating. In dark mode only a faint inset highlight is used. */
const shadowProblems = (items: Measured[], colorScheme: "light" | "dark"): string[] =>
  items.flatMap(({ label, shadow }) => {
    if (colorScheme === "light" && shadow === "none") return [`${label}: no shadow`];
    if (colorScheme === "dark" && shadow !== "none" && !shadow.includes("inset")) {
      return [`${label}: has a drop shadow`];
    }
    return [];
  });

/** Fields need 3:1 at the edge and readable text. Panels need an edge you can see. */
const fieldProblems = (fields: Measured[]): string[] =>
  fields.flatMap(({ label, text, fill, border, width }) => {
    const problems: string[] = [];
    if (width < 1) problems.push(`${label}: no border`);
    if (contrast(border, fill) < 3) problems.push(`${label}: border is too faint`);
    if (contrast(text, fill) < 4.5) problems.push(`${label}: text is too faint`);
    return problems;
  });

const panelProblems = (panels: Measured[], colorScheme: "light" | "dark"): string[] =>
  panels.flatMap(({ label, fill, border, width }) => {
    if (width < 1) return [`${label}: no border`];
    const floor = colorScheme === "light" ? 1.1 : 1.2;
    return contrast(border, fill) < floor ? [`${label}: border is too faint`] : [];
  });

/**
 * Anything poking out past its card's right edge. A page can have no sideways scroll and still do
 * this, so the page-level check doesn't catch it. Tables made to scroll sideways are left out.
 */
const spills = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll("main .card")].flatMap((card) => {
      const edge = card.getBoundingClientRect().right;
      return [...card.querySelectorAll("button, input, select, textarea, a, td")]
        .filter((element) => !element.closest(".table-scroll"))
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.right > edge + 1;
        })
        .map(
          (element) =>
            `${element.tagName.toLowerCase()} "${element.textContent.trim().slice(0, 30)}" spills out of its card`,
        );
    }),
  );

const GALLERY = ["button", "button button-secondary", "button button-danger", "link-button"];

/** One real button of each kind, on a card and on the page, enabled and disabled. */
const addGallery = (page: Page) =>
  page.evaluate((kinds) => {
    const shelf = document.createElement("div");
    shelf.id = "gallery";
    shelf.className = "card";
    for (const kind of kinds) {
      for (const disabled of [false, true]) {
        const button = document.createElement("button");
        button.className = kind;
        button.disabled = disabled;
        button.dataset.state = disabled ? "disabled" : "enabled";
        button.textContent = `${kind} ${disabled ? "disabled" : ""}`;
        button.style.margin = "4px";
        shelf.append(button);
      }
    }
    document.querySelector("main")?.prepend(shelf);
  }, GALLERY);

test.describe("the theme switch", () => {
  const themeOf = (page: Page) => page.locator("html").getAttribute("data-theme");
  const toggle = (page: Page) =>
    page.getByRole("button", { name: /^Switch to (light|dark) mode$/ });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`a first visit follows a device set to ${colorScheme}`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme });
      const page = await context.newPage();
      try {
        await page.goto("/settings", { waitUntil: "networkidle" });
        expect(await themeOf(page)).toBe(colorScheme);
      } finally {
        await context.close();
      }
    });
  }

  test("the toggle changes theme, is saved, and survives a reload", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    try {
      await page.goto("/settings", { waitUntil: "networkidle" });
      await expect(toggle(page)).toHaveAccessibleName("Switch to light mode");
      await toggle(page).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await expect(toggle(page)).toHaveAccessibleName("Switch to dark mode");
      await page.reload({ waitUntil: "networkidle" });
      expect(await themeOf(page)).toBe("light");
      await page.goto("/outbox", { waitUntil: "networkidle" });
      expect(await themeOf(page)).toBe("light");
    } finally {
      await context.close();
    }
  });

  test("the saved theme is set before the first paint, with no flash", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    try {
      await page.addInitScript(() => {
        localStorage.setItem("theme", "light");
        // Records the theme at the moment the app's first box reaches the page.
        new MutationObserver((_records, observer) => {
          if (!document.querySelector(".shell")) return;
          document.documentElement.dataset.themeAtShell =
            document.documentElement.dataset.theme ?? "none";
          observer.disconnect();
        }).observe(document, { childList: true, subtree: true });
      });
      await page.goto("/settings", { waitUntil: "networkidle" });
      expect(await page.locator("html").getAttribute("data-theme-at-shell")).toBe("light");
      expect(errors.filter((text) => /hydrat|script tag/i.test(text))).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

test.describe("fonts", () => {
  test("headings use Clash Display and the body Instrument Sans, self-hosted", async ({ page }) => {
    const external: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "font" && !request.url().includes("127.0.0.1")) {
        external.push(request.url());
      }
    });
    await page.goto("/settings", { waitUntil: "networkidle" });
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      // fonts.check() also says yes for a font that never loaded, so this reads each face's status.
      const faces = [...document.fonts].filter((face) => face.status === "loaded");
      return {
        clash: faces.filter((face) => face.family.includes("Clash Display")).length,
        instrument: faces.filter((face) => face.family.includes("Instrument Sans")).length,
        heading: getComputedStyle(document.querySelector("main h1") ?? document.body).fontFamily,
        body: getComputedStyle(document.body).fontFamily,
      };
    });
    expect(loaded.clash).toBeGreaterThan(0);
    expect(loaded.instrument).toBeGreaterThan(0);
    expect(loaded.heading).toContain("Clash Display");
    expect(loaded.body).toContain("Instrument Sans");
    expect(external).toEqual([]);
  });
});

test.describe("the logo", () => {
  test("the stamp loads and shows beside the name, at both widths", async ({ page }) => {
    const stamp = page.waitForResponse((response) => response.url().endsWith("/getpaid-stamp.svg"));
    await page.goto("/settings", { waitUntil: "networkidle" });
    expect((await stamp).ok()).toBe(true);
    for (const [width, area] of [
      [1280, ".sidebar"],
      [375, ".app-header"],
    ] as const) {
      await page.setViewportSize({ width, height: 800 });
      const mark = page.locator(`${area} .logo-mark`);
      await expect(mark).toBeVisible();
      expect((await mark.boundingBox())?.width).toBeGreaterThanOrEqual(40);
      await expect(page.locator(`${area} .logo-word`)).toBeVisible();
    }
  });
});

test.describe("depth in light mode", () => {
  test.use({ colorScheme: "light" });

  const style = (
    page: Page,
    selector: string,
    property: "boxShadow" | "backgroundColor" | "transform",
  ) =>
    page
      .locator(selector)
      .first()
      .evaluate((element, name) => getComputedStyle(element)[name], property);

  test("white cards sit on a warm page, each kind of item with its own shadow", async ({
    page,
  }) => {
    await page.goto("/settings", { waitUntil: "networkidle" });
    expect(
      await page.locator("html").evaluate((html) => getComputedStyle(html).backgroundColor),
    ).toBe("rgb(245, 244, 240)");
    expect(await style(page, "main .card", "backgroundColor")).toBe("rgb(255, 255, 255)");
    expect(await style(page, "main .card", "boxShadow")).toContain("-6px");
    expect(await style(page, "main input", "boxShadow")).toContain("inset");
    expect(await style(page, ".icon-button", "boxShadow")).not.toBe("none");
    expect(await style(page, ".sidebar", "boxShadow")).toContain("16px");
    expect(
      await style(page, "main .button:not(.button-secondary, .button-danger)", "boxShadow"),
    ).toBe("none");
  });

  test("a clickable card or row only changes its shadow on hover", async ({ page }) => {
    for (const [path, selector] of [
      ["/outbox", "main .outbox-card"],
      ["/clients", "main .table tbody tr"],
    ] as const) {
      await page.goto(path, { waitUntil: "networkidle" });
      await expect(page.locator(selector).first()).toBeVisible();
      await page.mouse.move(0, 0);
      const before = await style(page, selector, "boxShadow");
      await page.locator(selector).first().hover();
      await expect.poll(() => style(page, selector, "boxShadow")).not.toBe(before);
      expect(await style(page, selector, "transform")).toBe("none");
    }
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("a primary button doesn't move on hover", async ({ page }) => {
    await page.goto("/settings", { waitUntil: "networkidle" });
    const button = page.locator("main .button:not(.button-secondary, .button-danger)").first();
    await button.hover();
    const moved = await button.evaluate((element) => getComputedStyle(element).transform);
    expect(moved).toBe("none");
  });
});

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test("every button state is readable and has a border", async ({ page }, testInfo) => {
      await page.goto("/settings", { waitUntil: "networkidle" });
      await addGallery(page);
      const found: string[] = [];
      const shelf = "#gallery button";
      found.push(...buttonProblems(await measure(page, shelf)));
      const enabled = page.locator(`${shelf}[data-state="enabled"]`);
      for (let index = 0; index < GALLERY.length; index += 1) {
        const button = enabled.nth(index);
        const selector = `${shelf}[data-state="enabled"]:nth-of-type(${String(index * 2 + 1)})`;
        await button.hover();
        found.push(...buttonProblems(await measure(page, selector)).map((line) => `hover ${line}`));
        await page.mouse.move(0, 0);
        await button.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        const ring = await button.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            color: style.outlineColor,
            width: style.outlineWidth,
            style: style.outlineStyle,
          };
        });
        expect(ring.style, `focus ring on ${GALLERY[index] ?? ""}`).toBe("solid");
        expect(parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
        const card = await page
          .locator("#gallery")
          .evaluate((element) => getComputedStyle(element).backgroundColor);
        expect(contrast(ring.color, card)).toBeGreaterThanOrEqual(3);
      }
      await page.screenshot({ path: testInfo.outputPath(`buttons-${colorScheme}.png`) });
      expect(found).toEqual([]);
    });

    for (const [width, height, name] of [
      [1280, 900, "desktop"],
      [375, 844, "phone"],
    ] as const) {
      test(`every page's buttons, fields, panels and fit on a ${name}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height });
        const found: string[] = [];
        let currentPath = "";
        page.on("pageerror", (error) => {
          found.push(`${currentPath}: ${error.message.slice(0, 120)}`);
        });
        for (const path of PAGES) {
          currentPath = path;
          await page.goto(path, { waitUntil: "networkidle" });
          await expect(page.locator("main h1").first()).toBeVisible();
          const sideways = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          const crammed = await page.evaluate(() =>
            [...document.querySelectorAll("main .card, main .metric-tile")]
              // A stamp mid-drop is wider than its card on purpose, and the card clips it.
              .filter((box) => !box.querySelector(".paid-stamp"))
              .filter((box) => box.scrollWidth > box.clientWidth + 1)
              .map((box) => (box.querySelector("h2")?.textContent ?? box.className).slice(0, 30)),
          );
          found.push(...crammed.map((name) => `${path}: "${name}" overflows its box`));
          if (sideways > 0)
            found.push(`${path}: the page scrolls sideways by ${String(sideways)}px`);
          const problems = [
            ...buttonProblems(
              await measure(page, "main button, main a.button, .app-header button"),
            ),
            ...fieldProblems(await measure(page, FIELDS)),
            ...panelProblems(await measure(page, PANELS), colorScheme),
            ...shadowProblems(await measure(page, `${PANELS}, ${FIELDS}`), colorScheme),
          ];
          found.push(...problems.map((line) => `${path}: ${line}`));
          found.push(...(await spills(page)).map((line) => `${path}: ${line}`));
          const file = path.replace(/[^a-z0-9]+/gi, "-").replace(/^-$/, "-home");
          await page.screenshot({
            path: testInfo.outputPath(`${name}-${colorScheme}${file}.png`),
            fullPage: true,
          });
        }
        expect(found).toEqual([]);
      });
    }
  });
}
