import { secretBox } from "@/lib/crypto";
import { withUserDb } from "@/lib/db";
import { devEmailAllowlist, googleOAuthEnv, internalApiToken } from "@/lib/env";
import { renderPdf } from "@/lib/invoice-pdf";
import { defaultPdfDir, invoicePdf } from "@/lib/invoice-pdfs";
import { senderHandler } from "@/lib/sender-handler";
import { withServiceDb } from "@/lib/service-db";

// Called by n8n's 04_sender only (Bearer INTERNAL_API_TOKEN). The service role only finds what's
// due; each send then reads and writes as that freelancer (RLS).
const handler = senderHandler({
  runAsService: withServiceDb,
  runAsUser: withUserDb,
  now: () => new Date(),
  box: secretBox,
  oauth: () => googleOAuthEnv(),
  allowlist: () => devEmailAllowlist(),
  pdf: (userId, invoiceId) =>
    invoicePdf({ runAsUser: withUserDb(userId), renderPdf, dir: defaultPdfDir() }, invoiceId),
  token: () => internalApiToken(),
});

export const POST = handler.post;
