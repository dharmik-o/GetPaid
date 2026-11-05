import { appNow } from "@/lib/clock";
import { invoiceHandlers } from "@/lib/invoice-handlers";
import { renderPdf } from "@/lib/invoice-pdf";
import { defaultArchiveDir } from "@/lib/archive-paths";
import { defaultPdfDir, invoicePdf } from "@/lib/invoice-pdfs";
import { paypalFromEnv } from "@/lib/paypal";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = invoiceHandlers({
  runAsUser: runAsCurrentUser,
  paypal: paypalFromEnv,
  now: () => appNow(),
  pdf: (invoiceId) =>
    invoicePdf(
      {
        runAsUser: runAsCurrentUser,
        renderPdf,
        dir: defaultPdfDir(),
        archiveDir: defaultArchiveDir(),
      },
      invoiceId,
    ),
});

export const POST = handlers.issue;
