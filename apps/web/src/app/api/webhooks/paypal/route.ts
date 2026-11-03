import { loadPaypalEnv } from "@/lib/env";
import { paypalFromEnv } from "@/lib/paypal";
import { paypalWebhookHandler } from "@/lib/paypal-webhook";
import { withServiceDb } from "@/lib/service-db";

// Not a user-facing route: PayPal (through n8n) calls it. It verifies every delivery with
// PayPal before using the service role, which only webhook handlers may use.

const webhookId = (): string | undefined => {
  try {
    return loadPaypalEnv().PAYPAL_WEBHOOK_ID;
  } catch {
    return undefined;
  }
};

const handler = paypalWebhookHandler({
  runAsService: withServiceDb,
  paypal: paypalFromEnv,
  webhookId,
});

export const POST = handler.post;
