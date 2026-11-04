import { appNow } from "@/lib/clock";
import { secretBox } from "@/lib/crypto";
import { withUserDb } from "@/lib/db";
import { internalApiToken, outboxPublicUrl } from "@/lib/env";
import { paypalFromEnv } from "@/lib/paypal";
import { withServiceDb } from "@/lib/service-db";
import { STATUTES } from "@/lib/statutes";
import { telegramUpdateHandler } from "@/lib/telegram-handlers";

// Called by n8n's 03_approval_handler only (Bearer INTERNAL_API_TOKEN). The service role only
// finds which freelancer a chat belongs to; drafts are then read and changed as them (RLS).
const handler = telegramUpdateHandler({
  runAsService: withServiceDb,
  runAsUser: withUserDb,
  box: secretBox,
  now: () => appNow(),
  laws: STATUTES,
  token: () => internalApiToken(),
  outboxUrl: () => outboxPublicUrl(),
  paypal: paypalFromEnv,
});

export const POST = handler.post;
