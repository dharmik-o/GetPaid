import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { UserDbRunner } from "./db";
import { loadInvoiceDocument } from "./invoice-document-data";
import { invoiceView } from "./invoice-document";
import type { PaperSize } from "./invoice-pdf";
import { renderInvoiceHtml } from "./template-render";

// Server-only: each invoice's PDF, made once and kept on disk (INVOICE_PDF_DIR, default
// .data/invoice-pdfs next to the app). The database stores only the relative path, and a path
// is only ever "<user id>/<invoice id>.pdf", so nothing outside the folder can be read.

export type PdfDeps = {
  runAsUser: UserDbRunner;
  renderPdf: (html: string, paper: PaperSize) => Promise<Buffer>;
  /** Where PDFs are kept. */
  dir: string;
};

export const defaultPdfDir = (): string =>
  resolve(process.env.INVOICE_PDF_DIR ?? join(process.cwd(), ".data", "invoice-pdfs"));

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SAFE_PATH = new RegExp(`^${UUID}/${UUID}\\.pdf$`);

export const pdfPathFor = (userId: string, invoiceId: string): string =>
  `${userId}/${invoiceId}.pdf`;

const absolute = (dir: string, relative: string): string => {
  if (!SAFE_PATH.test(relative)) throw new Error("A stored PDF path isn't in the expected form.");
  return join(dir, relative);
};

export type PdfFile = { pdf: Buffer; filename: string };

const filenameFor = (invoiceNumber: string): string =>
  `invoice-${invoiceNumber.replace(/[^A-Za-z0-9-]/g, "")}.pdf`;

/**
 * The invoice's PDF: the stored file, or a fresh one (rendered outside any transaction, then
 * saved). `fresh` re-renders, e.g. after the invoice's details changed. Undefined = not found.
 */
export const invoicePdf = async (
  deps: PdfDeps,
  invoiceId: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<PdfFile | undefined> => {
  const loaded = await deps.runAsUser((db) => loadInvoiceDocument(db, invoiceId));
  if (!loaded) return undefined;
  const filename = filenameFor(loaded.document.invoice.number);
  if (loaded.pdfPath && !fresh) {
    try {
      return { pdf: await readFile(absolute(deps.dir, loaded.pdfPath)), filename };
    } catch {
      // The file is gone (a new machine, a cleaned folder): make it again below.
    }
  }
  const html = renderInvoiceHtml(loaded.template, invoiceView(loaded.document));
  const pdf = await deps.renderPdf(html, loaded.paper);
  const relative = pdfPathFor(loaded.userId, invoiceId);
  const file = absolute(deps.dir, relative);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, pdf);
  await deps.runAsUser((db) =>
    db.query("UPDATE public.invoices SET pdf_path = $2 WHERE id = $1", [invoiceId, relative]),
  );
  return { pdf, filename };
};
