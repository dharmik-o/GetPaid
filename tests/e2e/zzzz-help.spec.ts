import { expect, test } from "@playwright/test";

// E3 in a real browser: the Help button opens a side panel, a suggestion is answered from the manual
// (the model is the E2E's fake), the sections used and the allowed links show, a link outside the
// allowlist doesn't, the PDF downloads, and Esc closes it. Named to run last.

test("Ask GetPaid answers from the manual in a side panel", async ({ page, request }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Help" }).click();
  const panel = page.getByRole("dialog", { name: "Ask GetPaid" });
  await expect(panel).toBeVisible();
  for (const chip of [
    "How do I record a bank transfer?",
    "How do I connect Telegram?",
    "How do reminders work?",
  ]) {
    await expect(panel.getByRole("button", { name: chip })).toBeVisible();
  }

  await panel.getByRole("button", { name: "How do I record a bank transfer?" }).click();
  await expect(panel.getByText("1. Open the invoice. 2. Press Record a payment.")).toBeVisible();
  await expect(panel.getByText(/^From the manual: /)).toBeVisible();
  await expect(panel.getByRole("link", { name: "Settings > AI" })).toHaveAttribute(
    "href",
    "/settings/ai",
  );
  await expect(panel.locator("a[href*='evil']")).toHaveCount(0);

  const pdf = panel.getByRole("link", { name: "Download the manual (PDF)" });
  await expect(pdf).toHaveAttribute("href", "/GetPaid-User-Manual.pdf");
  const file = await request.get("/GetPaid-User-Manual.pdf");
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toContain("pdf");

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("the question box refuses more than 500 characters", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Help" }).click();
  const box = page.getByRole("dialog", { name: "Ask GetPaid" }).getByLabel("Your question");
  await box.fill("x".repeat(600));
  expect((await box.inputValue()).length).toBe(500);
});
