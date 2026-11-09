import { defaultArchiveDir } from "@/lib/archive-paths";
import { appNow } from "@/lib/clock";
import { renderPdf } from "@/lib/invoice-pdf";
import { lawyerPackHandlers } from "@/lib/lawyer-pack-handlers";
import { runAsCurrentUser } from "@/lib/request-user";
import { REFERENCE_RATES, STATUTES } from "@/lib/statutes";

const handlers = lawyerPackHandlers({
  runAsUser: runAsCurrentUser,
  renderPdf: (html) => renderPdf(html),
  archiveDir: defaultArchiveDir(),
  now: () => appNow(),
  laws: STATUTES,
  rates: REFERENCE_RATES,
});

export const POST = handlers.post;
