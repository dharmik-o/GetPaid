import { expect, test } from "@playwright/test";

// The signature setting in a real browser, drawn by real Chromium. Named to run last, as it changes
// the account's signature, which the earlier specs don't expect.

test.describe("the signature", () => {
  test("starts off, with a note on where to add one", async ({ page }) => {
    await page.goto("/retainers/new", { waitUntil: "networkidle" });
    const box = page.getByLabel("Include my signature");
    await expect(box).toBeDisabled();
    await expect(box).not.toBeChecked();
    await expect(page.getByText("Add a signature in Settings")).toBeVisible();
  });

  test("a typed name is drawn, and becomes the default for new invoices", async ({ page }) => {
    await page.goto("/settings/templates", { waitUntil: "networkidle" });
    await expect(
      page.getByText("This adds a picture of your signature. It isn't a legal e-signature."),
    ).toHaveCount(1);
    await page.getByLabel("Type my name").check();
    await page.getByLabel("Name to draw").fill("Demo Freelancer");
    await page.getByLabel("Signer's name").fill("Demo Freelancer");
    await page.getByLabel("Signer's title").fill("Founder");
    await page.getByLabel("Include my signature on new invoices").check();
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.getByText("Saved. New invoices use these details.")).toBeVisible();

    const drawn = page.getByAltText("Your signature");
    await expect(drawn).toBeVisible();
    expect(await drawn.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    const width = await drawn.evaluate((image: HTMLImageElement) => image.naturalWidth);
    expect(width).toBeGreaterThan(50);

    await page.goto("/retainers/new", { waitUntil: "networkidle" });
    const box = page.getByLabel("Include my signature");
    await expect(box).toBeEnabled();
    await expect(box).toBeChecked();
  });

  test("it shows in a template's preview", async ({ page }) => {
    await page.goto("/settings/templates", { waitUntil: "networkidle" });
    const tile = page.locator(".template-tile").filter({ hasText: "Studio" });
    await tile.locator("iframe").scrollIntoViewIfNeeded();
    const signature = tile.locator("iframe").contentFrame().getByAltText("Signature");
    await expect(signature).toBeVisible();
    await expect(tile.locator("iframe").contentFrame().getByText("Founder")).toBeVisible();
  });

  test("an SVG can't be chosen, and nothing else is offered", async ({ page }) => {
    await page.goto("/settings/templates", { waitUntil: "networkidle" });
    await page.getByLabel("Upload an image").check();
    await expect(page.getByLabel("Signature image")).toHaveAttribute(
      "accept",
      "image/png,image/jpeg",
    );
    await page.getByLabel("Signature image").setInputFiles({
      name: "signature.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from("<svg></svg>"),
    });
    await expect(page.getByText("Signature must be a PNG or JPG image.")).toBeVisible();
  });
});
