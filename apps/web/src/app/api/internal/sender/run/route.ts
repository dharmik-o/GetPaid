import { appNow } from "@/lib/clock";
import { secretBox } from "@/lib/crypto";
import { withUserDb } from "@/lib/db";
import { devEmailAllowlist, gmailOAuthEnv, internalApiToken } from "@/lib/env";
import { signedPdfFile } from "@/lib/agreement-pdf";
import { demandPdfFile } from "@/lib/final-demand-letter";
import { renderPdf } from "@/lib/invoice-pdf";
import { defaultArchiveDir } from "@/lib/archive-paths";
import { markArchiveSent, stageInArchive } from "@/lib/invoice-archive";
import { defaultPdfDir, invoicePdf } from "@/lib/invoice-pdfs";
import { senderHandler } from "@/lib/sender-handler";
import { withServiceDb } from "@/lib/service-db";

// Called by n8n's 04_sender only (Bearer INTERNAL_API_TOKEN). The service role only finds what's
// due; each send then reads and writes as that freelancer (RLS).
const handler = senderHandler({
  runAsService: withServiceDb,
  runAsUser: withUserDb,
  now: () => appNow(),
  box: secretBox,
  oauth: () => gmailOAuthEnv(),
  allowlist: () => devEmailAllowlist(),
  pdf: (userId, invoiceId) =>
    invoicePdf(
      {
        runAsUser: withUserDb(userId),
        renderPdf,
        dir: defaultPdfDir(),
        archiveDir: defaultArchiveDir(),
      },
      invoiceId,
    ),
  demandPdf: (userId, invoiceId, draft) =>
    demandPdfFile(
      {
        runAsUser: withUserDb(userId),
        renderPdf: (html) => renderPdf(html),
        archiveDir: defaultArchiveDir(),
        now: () => appNow(),
      },
      invoiceId,
      draft,
    ),
  signedPdf: (userId, agreementId) =>
    withUserDb(userId)((db) => signedPdfFile(db, defaultArchiveDir(), agreementId)),
  archive: {
    stage: (userId, invoiceId, file) =>
      stageInArchive({ runAsUser: withUserDb(userId), dir: defaultArchiveDir() }, invoiceId, file),
    markSent: (userId, fileId, at) => markArchiveSent(withUserDb(userId), fileId, at),
  },
  token: () => internalApiToken(),
});

export const POST = handler.post;
