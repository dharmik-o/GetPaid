import { appNow } from "@/lib/clock";
import { invoiceHandlers } from "@/lib/invoice-handlers";
import { paypalFromEnv } from "@/lib/paypal";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = invoiceHandlers({
  runAsUser: runAsCurrentUser,
  paypal: paypalFromEnv,
  now: () => appNow(),
});

export const POST = handlers.recordPayment;
