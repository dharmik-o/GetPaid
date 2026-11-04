import { appNow } from "@/lib/clock";
import { paypalFromEnv } from "@/lib/paypal";
import { replyHandlers } from "@/lib/reply-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = replyHandlers({
  runAsUser: runAsCurrentUser,
  now: () => appNow(),
  paypal: paypalFromEnv,
});

export const POST = handlers.resumeInvoice;
