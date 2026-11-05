import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { UserDbRunner } from "./db";
import { findArchivedPdf, sha256Of, type PdfFacts } from "./invoice-archive";
import { loadInvoiceDocument } from "./invoice-document-data";
import { invoiceView } from "./invoice-document";
import type { PaperSize } from "./invoice-pdf";
import { renderInvoiceHtml } from "./template-render";

// Server-only: each invoice's PDF. The document is worked out every time, and only made into a PDF
// when it has changed: a PDF already sent comes from the archive, and one not sent yet from a working
// copy (INVOICE_PDF_DIR, default .data/invoice-pdfs next to the app). The database stores only the
// relative path, and a path is only ever "<user id>/<invoice id>.pdf", so nothing outside the folder
// can be read.

export type PdfDeps = {
  runAsUser: UserDbRunner;
  renderPdf: (html: string, paper: PaperSize) => Promise<Buffer>;
  /** Where working copies are kept. */
  dir: string;
  /** Where PDFs sent to clients are kept. */
  archiveDir: string;
};

export const defaultPdfDir = (): string =>
  resolve(process.env.INVOICE_PDF_DIR ?? join(process.cwd(), ".data", "invoice-pdfs"));

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SAFE_PATH = new RegExp(`^${UUID}/${UUID}\\.pdf$`);

export const pdfPathFor = (userId: string, invoiceId: string): string =>
  `${userId}/${invoiceId}.pdf`;

/** A stored working copy's full path; throws on anything that isn't in the expected form. */
export const workingCopyPath = (dir: string, relative: string): string => {
  if (!SAFE_PATH.test(relative)) throw new Error("A stored PDF path isn't in the expected form.");
  return join(dir, relative);
};

export type PdfFile = PdfFacts & { filename: string };

const filenameFor = (invoiceNumber: string): string =>
  `invoice-${invoiceNumber.replace(/[^A-Za-z0-9-]/g, "")}.pdf`;

const readWorkingCopy = async (
  dir: string,
  relative: string | null,
  madeFrom: string | null,
  sourceSha256: string,
): Promise<Buffer | undefined> => {
  if (!relative || madeFrom !== sourceSha256) return undefined;
  try {
    return await readFile(workingCopyPath(dir, relative));
  } catch {
    // The file is gone (a new machine, a cleaned folder): it's made again.
    return undefined;
  }
};

/** The invoice's PDF, as a client would get it now. Undefined = not found. */
export const invoicePdf = async (
  deps: PdfDeps,
  invoiceId: string,
): Promise<PdfFile | undefined> => {
  const loaded = await deps.runAsUser(async (db) => {
    const document = await loadInvoiceDocument(db, invoiceId);
    if (!document) return undefined;
    const { rows } = await db.query<{ pdf_source_sha256: string | null }>(
      "SELECT pdf_source_sha256 FROM public.invoices WHERE id = $1",
      [invoiceId],
    );
    return { ...document, madeFrom: rows[0]?.pdf_source_sha256 ?? null };
  });
  if (!loaded) return undefined;
  const html = renderInvoiceHtml(loaded.template, invoiceView(loaded.document));
  const sourceSha256 = sha256Of(`${loaded.paper}\n${html}`);
  const facts = {
    filename: filenameFor(loaded.document.invoice.number),
    sourceSha256,
    templateName: loaded.template.name,
    signed: loaded.document.signature !== null,
  };
  const kept =
    (await findArchivedPdf(
      { runAsUser: deps.runAsUser, dir: deps.archiveDir },
      invoiceId,
      sourceSha256,
    )) ?? (await readWorkingCopy(deps.dir, loaded.pdfPath, loaded.madeFrom, sourceSha256));
  if (kept) return { ...facts, pdf: kept };

  const pdf = await deps.renderPdf(html, loaded.paper);
  const relative = pdfPathFor(loaded.userId, invoiceId);
  const file = workingCopyPath(deps.dir, relative);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, pdf);
  await deps.runAsUser((db) =>
    db.query("UPDATE public.invoices SET pdf_path = $2, pdf_source_sha256 = $3 WHERE id = $1", [
      invoiceId,
      relative,
      sourceSha256,
    ]),
  );
  return { ...facts, pdf };
};
