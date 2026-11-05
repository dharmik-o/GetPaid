import { appNow } from "@/lib/clock";
import { renderPdf } from "@/lib/invoice-pdf";
import { defaultArchiveDir } from "@/lib/archive-paths";
import { defaultPdfDir, invoicePdf } from "@/lib/invoice-pdfs";
import { paypalFromEnv } from "@/lib/paypal";
import { replyHandlers } from "@/lib/reply-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = replyHandlers({
  runAsUser: runAsCurrentUser,
  now: () => appNow(),
  paypal: paypalFromEnv,
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

export const POST = handlers.post;
