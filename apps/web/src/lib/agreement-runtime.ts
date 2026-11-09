import { defaultArchiveDir } from "./archive-paths";
import { agreementHandlers } from "./agreement-handlers";
import { newSigningToken } from "./agreements";
import { appNow } from "./clock";
import { appPublicUrl } from "./env";
import { runAsCurrentUser } from "./request-user";
import { STATUTES } from "./statutes";

// Server-only: the agreement routes' shared handlers, built once from the running app's settings.

export const handlers = agreementHandlers({
  runAsUser: runAsCurrentUser,
  context: () => ({ now: appNow(), laws: STATUTES }),
  send: () => ({ token: newSigningToken, appUrl: appPublicUrl() }),
  archiveDir: () => defaultArchiveDir(),
});
