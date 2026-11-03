import { chromium } from "playwright-core";

// Server-only: an invoice document to a PDF with headless Chromium (Playwright's, installed with
// `npx playwright install chromium`). JavaScript is off and the network is off: the context is
// offline and every request is aborted, so a template can't load or send anything.

const RENDER_TIMEOUT_MS = 15_000;

export const PDF_CONTEXT = {
  javaScriptEnabled: false,
  offline: true,
  serviceWorkers: "block",
} as const;

export const renderPdf = async (documentHtml: string): Promise<Buffer> => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--disable-background-networking"] });
  } catch {
    throw new Error(
      "Headless Chromium isn't installed for PDFs. Run `npx playwright install chromium` once, then try again.",
    );
  }
  try {
    const context = await browser.newContext(PDF_CONTEXT);
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(documentHtml, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    return await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
};
