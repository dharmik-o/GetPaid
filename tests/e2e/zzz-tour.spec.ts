import { expect, test, type Page } from "@playwright/test";
import { APP_URL } from "./env";

// T1: the guided tour. Global setup marks the tour as done so no other spec is covered by it; this
// one starts it again by hand and puts it back at the end. `window.__noReload` is wiped by any real
// navigation, so it proves the tour moved between pages with the router.

declare global {
  interface Window {
    __noReload?: boolean;
  }
}

test.describe.configure({ mode: "serial" });

const send = (page: Page, body: object) =>
  page.request.post("/api/tour", { data: body, headers: { "content-type": "application/json" } });

const restart = async (page: Page) => {
  await send(page, { event: "replay" });
  await send(page, { event: "reset-tips" });
};

/** The page after a load, once the tour has asked the server how far this user got. */
const open = async (page: Page, path: string) => {
  const asked = page.waitForResponse(
    (r) => r.url().endsWith("/api/tour") && r.request().method() === "GET",
  );
  await page.goto(path, { waitUntil: "networkidle" });
  await asked;
};

test.afterAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: APP_URL });
  const headers = { "content-type": "application/json" };
  await api.post("/api/tour", { data: { event: "skip" }, headers });
  for (const tip of ["project", "calendar", "agreement", "client"]) {
    await api.post("/api/tour", { data: { event: "tip-seen", tip }, headers });
  }
  await api.dispose();
});

test("a new user sees step 1, walks all 10 steps across pages, and never sees it again", async ({
  page,
}) => {
  await restart(page);
  await open(page, "/");
  const tour = page.getByRole("dialog");
  await expect(tour).toBeVisible();
  await expect(tour.getByRole("heading", { name: "Start here" })).toBeVisible();
  await expect(tour).toContainText("1 of 10");
  await page.evaluate(() => {
    window.__noReload = true;
  });

  const paths = [
    "/",
    "/",
    "/projects",
    "/projects",
    "/projects",
    "/outbox",
    "/calendar",
    "/settings/integrations",
    "/settings/ai",
    "/settings",
  ];
  for (let step = 1; step <= 10; step += 1) {
    await expect(tour).toContainText(`${String(step)} of 10`);
    await expect(page).toHaveURL(
      (url) => url.pathname.replace(/\/projects\/[0-9a-f-]{36}/, "/projects") === paths[step - 1],
    );
    if (step < 10) await tour.getByRole("button", { name: "Got it" }).click();
  }
  await expect(tour).toContainText("Replay this tour any time from Settings.");
  await tour.getByRole("button", { name: "Finish" }).click();
  await expect(tour).toHaveCount(0);
  expect(await page.evaluate(() => window.__noReload)).toBe(true);

  await page.reload({ waitUntil: "networkidle" });
  await open(page, "/");
  await expect(page.locator(".tour-card")).toHaveCount(0);
});

test("Replay tour in Settings starts it again, and Skip on step 2 ends it", async ({ page }) => {
  await open(page, "/settings");
  await page.getByRole("button", { name: "Replay tour" }).click();
  const tour = page.getByRole("dialog");
  await expect(tour).toContainText("1 of 10");
  await expect(page).toHaveURL(/\/$/);
  await tour.getByRole("button", { name: "Got it" }).click();
  await expect(tour).toContainText("2 of 10");
  await tour.getByRole("button", { name: "Skip tour" }).click();
  await expect(tour).toHaveCount(0);

  await open(page, "/");
  await expect(page.locator(".tour-card")).toHaveCount(0);
});

test("a page tip shows on the first Calendar visit and not the second", async ({ page }) => {
  await restart(page);
  await send(page, { event: "skip" });
  await open(page, "/calendar");
  const tip = page.getByRole("dialog");
  await expect(tip).toContainText("1 of 3");
  await tip.getByRole("button", { name: "Got it" }).click();
  await tip.getByRole("button", { name: "Got it" }).click();
  await tip.getByRole("button", { name: "Finish" }).click();
  await expect(tip).toHaveCount(0);

  await open(page, "/calendar");
  await expect(page.locator(".tour-card")).toHaveCount(0);
});
