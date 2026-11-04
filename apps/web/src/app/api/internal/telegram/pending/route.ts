import { appNow } from "@/lib/clock";
import { internalApiToken, outboxPublicUrl } from "@/lib/env";
import { withServiceDb } from "@/lib/service-db";
import { telegramCardHandlers } from "@/lib/telegram-handlers";

// Called by n8n's 03_approval_handler only (Bearer INTERNAL_API_TOKEN): the cards to send now.
const handlers = telegramCardHandlers({
  runAsService: withServiceDb,
  now: () => appNow(),
  token: () => internalApiToken(),
  outboxUrl: () => outboxPublicUrl(),
});

export const POST = handlers.pending;
