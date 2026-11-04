import { currentUserId } from "@/lib/auth";
import { appNow } from "@/lib/clock";
import { secretBox } from "@/lib/crypto";
import { withUserDb } from "@/lib/db";
import { paypalFromEnv } from "@/lib/paypal";
import { runAsCurrentUser } from "@/lib/request-user";
import { retainerHandlers } from "@/lib/retainer-handlers";
import { STATUTES } from "@/lib/statutes";

const handlers = retainerHandlers({
  currentUser: currentUserId,
  runAsCurrent: runAsCurrentUser,
  runAsUser: withUserDb,
  box: secretBox,
  laws: STATUTES,
  paypal: paypalFromEnv,
  now: () => appNow(),
});

export const POST = handlers.act;
