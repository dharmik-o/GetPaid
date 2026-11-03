import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invoiceView, SAMPLE_DOCUMENT } from "@/lib/invoice-document";
import { renderPdf } from "@/lib/invoice-pdf";
import { renderInvoiceHtml } from "@/lib/template-render";
import { openMigratedPglite } from "./db/pglite";

// PDFs come from headless Chromium (needs `npx playwright install chromium`) with JavaScript
// off and the network off. A local server counts every request a document tries to make.

let server: Server;
let hits: string[] = [];
let base = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    hits.push(request.url ?? "");
    response.end("x");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});

const isPdf = (pdf: Buffer) => pdf.subarray(0, 5).toString("latin1") === "%PDF-";

describe("renderPdf", () => {
  it("renders with the network off: nothing loads, even from a hostile document", async () => {
    hits = [];
    // Straight to the renderer, skipping the sanitiser, to test the renderer's own lock.
    const hostile = `<!DOCTYPE html><html><head>
      <link rel="stylesheet" href="${base}/style.css">
      <style>@import url("${base}/import.css"); body { background: url("${base}/bg.png"); }</style>
      </head><body>
      <p>Invoice</p>
      <img src="${base}/pixel.png">
      <iframe src="${base}/frame"></iframe>
      <script>fetch("${base}/script"); new Image().src = "${base}/beacon";</script>
      </body></html>`;
    const pdf = await renderPdf(hostile);
    expect(isPdf(pdf)).toBe(true);
    expect(hits).toEqual([]);
  }, 60_000);

  it("renders a built-in template to a PDF", async () => {
    const handle = await openMigratedPglite();
    const { rows } = await handle.db.query<{ html: string; css: string }>(
      "SELECT html, css FROM public.invoice_templates WHERE name = 'Modern'",
    );
    await handle.close();
    const template = rows[0];
    if (!template) throw new Error("The Modern built-in is missing.");
    const pdf = await renderPdf(renderInvoiceHtml(template, invoiceView(SAMPLE_DOCUMENT)));
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(5_000);
  }, 60_000);
});
