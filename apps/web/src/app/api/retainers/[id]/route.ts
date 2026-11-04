import { paypalFromEnv } from "@/lib/paypal";
import { runAsCurrentUser } from "@/lib/request-user";
import { retainerHandlers } from "@/lib/retainer-handlers";

const handlers = retainerHandlers({
  runAsUser: runAsCurrentUser,
  paypal: paypalFromEnv,
  now: () => new Date(),
});

export const POST = handlers.act;
