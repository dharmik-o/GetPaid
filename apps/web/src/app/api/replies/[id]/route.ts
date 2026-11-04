import { renderPdf } from "@/lib/invoice-pdf";
import { defaultPdfDir, invoicePdf } from "@/lib/invoice-pdfs";
import { paypalFromEnv } from "@/lib/paypal";
import { replyHandlers } from "@/lib/reply-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = replyHandlers({
  runAsUser: runAsCurrentUser,
  now: () => new Date(),
  paypal: paypalFromEnv,
  pdf: (invoiceId) =>
    invoicePdf({ runAsUser: runAsCurrentUser, renderPdf, dir: defaultPdfDir() }, invoiceId, {
      fresh: true,
    }),
});

export const POST = handlers.post;
