import { defaultArchiveDir } from "@/lib/archive-paths";
import { invoicePdfHandler } from "@/lib/invoice-document-handlers";
import { renderPdf } from "@/lib/invoice-pdf";
import { defaultPdfDir } from "@/lib/invoice-pdfs";
import { runAsCurrentUser } from "@/lib/request-user";

const handler = invoicePdfHandler(() => ({
  runAsUser: runAsCurrentUser,
  renderPdf,
  dir: defaultPdfDir(),
  archiveDir: defaultArchiveDir(),
}));

export const GET = handler.get;
