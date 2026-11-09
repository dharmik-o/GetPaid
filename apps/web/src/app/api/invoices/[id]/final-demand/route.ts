import { appNow } from "@/lib/clock";
import { secretBox } from "@/lib/crypto";
import { finalDemandHandlers } from "@/lib/final-demand-handlers";
import { REFERENCE_RATES, STATUTES } from "@/lib/statutes";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = finalDemandHandlers({
  runAsUser: runAsCurrentUser,
  box: secretBox,
  context: () => ({ now: appNow(), laws: STATUTES, rates: REFERENCE_RATES }),
});

export const POST = handlers.post;
