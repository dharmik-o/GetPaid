import { secretBox } from "@/lib/crypto";
import { withUserDb } from "@/lib/db";
import { internalApiToken } from "@/lib/env";
import { schedulerHandler } from "@/lib/scheduler-handler";
import { withServiceDb } from "@/lib/service-db";
import { STATUTES } from "@/lib/statutes";

// Called by n8n's 01_scheduler only (Bearer INTERNAL_API_TOKEN). The service role only finds
// invoices and planned reminders; each is then planned and drafted as its freelancer (RLS).
const handler = schedulerHandler({
  runAsService: withServiceDb,
  runAsUser: withUserDb,
  box: secretBox,
  now: () => new Date(),
  laws: STATUTES,
  token: () => internalApiToken(),
});

export const POST = handler.post;
