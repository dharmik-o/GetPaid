import { agreementHandlers } from "@/lib/agreement-handlers";
import { appNow } from "@/lib/clock";
import { runAsCurrentUser } from "@/lib/request-user";
import { STATUTES } from "@/lib/statutes";

const handlers = agreementHandlers({
  runAsUser: runAsCurrentUser,
  context: () => ({ now: appNow(), laws: STATUTES }),
});

export const POST = handlers.void;
