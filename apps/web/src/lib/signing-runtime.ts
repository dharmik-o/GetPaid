import { appNow } from "./clock";
import { defaultArchiveDir } from "./archive-paths";
import { withUserDb } from "./db";
import { renderPdf } from "./invoice-pdf";
import { withServiceDb } from "./service-db";
import { createSigningLimits } from "./signing-handlers";
import type { SigningDeps } from "./agreement-signing";

// Server-only: the signing page and its API share one set of dependencies and one set of
// request limits. The service role is used only to find an agreement by its token's hash.

export const signingLimits = createSigningLimits();

export const signingDeps: SigningDeps = {
  runAsService: withServiceDb,
  runAsUser: withUserDb,
  now: () => appNow(),
  renderPdf: (html) => renderPdf(html),
  archiveDir: () => defaultArchiveDir(),
};
