import { invoiceHandlers } from "@/lib/invoice-handlers";
import { renderPdf } from "@/lib/invoice-pdf";
import { defaultPdfDir, invoicePdf } from "@/lib/invoice-pdfs";
import { paypalFromEnv } from "@/lib/paypal";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = invoiceHandlers({
  runAsUser: runAsCurrentUser,
  paypal: paypalFromEnv,
  now: () => new Date(),
  pdf: (invoiceId) =>
    invoicePdf({ runAsUser: runAsCurrentUser, renderPdf, dir: defaultPdfDir() }, invoiceId),
});

export const POST = handlers.issue;
