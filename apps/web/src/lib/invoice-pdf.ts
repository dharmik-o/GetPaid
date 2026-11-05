import Mustache from "mustache";
import { chromium } from "playwright-core";
import { documentFontCss } from "./document-fonts";

// Server-only: an invoice document to a PDF with headless Chromium (Playwright's, installed with
// `npx playwright install chromium`). JavaScript is off and the network is off: the context is
// offline and every request is aborted, so a template can't load or send anything.

const RENDER_TIMEOUT_MS = 15_000;

export const PDF_CONTEXT = {
  javaScriptEnabled: false,
  offline: true,
  serviceWorkers: "block",
} as const;

export type PaperSize = "A4" | "Letter";

const launch = async () => {
  try {
    return await chromium.launch({ headless: true, args: ["--disable-background-networking"] });
  } catch {
    throw new Error(
      "Headless Chromium isn't installed for PDFs. Run `npx playwright install chromium` once, then try again.",
    );
  }
};

const HANDWRITING = "Mrs Saint Delafield";

/** A typed name, drawn in the handwriting font, as a PNG with a clear background. */
export const renderTypedSignature = async (name: string): Promise<string> => {
  const browser = await launch();
  try {
    const context = await browser.newContext({ ...PDF_CONTEXT, deviceScaleFactor: 2 });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    const css = `${documentFontCss(HANDWRITING)}
      body { margin: 0; background: transparent; }
      span { display: inline-block; padding: 4px 16px 8px 10px; color: #1a1a2e; line-height: 1.1;
             font: 44px "${HANDWRITING}", cursive; white-space: nowrap; }`;
    await page.setContent(`<style>${css}</style><span>${Mustache.escape(name)}</span>`, {
      waitUntil: "load",
      timeout: RENDER_TIMEOUT_MS,
    });
    const png = await page.locator("span").screenshot({ omitBackground: true });
    return `data:image/png;base64,${png.toString("base64")}`;
  } finally {
    await browser.close();
  }
};

/** The paper is for a template that sets no @page size: a custom template's own size wins. */
export const renderPdf = async (documentHtml: string, paper: PaperSize = "A4"): Promise<Buffer> => {
  const browser = await launch();
  try {
    const context = await browser.newContext(PDF_CONTEXT);
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(documentHtml, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    return await page.pdf({ format: paper, printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
};
