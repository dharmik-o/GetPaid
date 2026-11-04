import { internalApiToken } from "@/lib/env";
import { withServiceDb } from "@/lib/service-db";
import { telegramUpdateHandler } from "@/lib/telegram-handlers";

// Called by n8n's 03_approval_handler only (Bearer INTERNAL_API_TOKEN).
const handler = telegramUpdateHandler({
  runAsService: withServiceDb,
  now: () => new Date(),
  token: () => internalApiToken(),
});

export const POST = handler.post;
