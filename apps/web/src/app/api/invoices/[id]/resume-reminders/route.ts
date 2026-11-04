import { paypalFromEnv } from "@/lib/paypal";
import { replyHandlers } from "@/lib/reply-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = replyHandlers({
  runAsUser: runAsCurrentUser,
  now: () => new Date(),
  paypal: paypalFromEnv,
});

export const POST = handlers.resumeInvoice;
