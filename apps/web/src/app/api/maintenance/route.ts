import { currentUserId } from "@/lib/auth";
import { secretBox } from "@/lib/crypto";
import { withUserDb } from "@/lib/db";
import { maintenanceHandlers } from "@/lib/maintenance-handlers";
import { paypalFromEnv } from "@/lib/paypal";
import { runAsCurrentUser } from "@/lib/request-user";
import { STATUTES } from "@/lib/statutes";

const handlers = maintenanceHandlers({
  currentUser: currentUserId,
  runAsCurrent: runAsCurrentUser,
  runAsUser: withUserDb,
  box: secretBox,
  now: () => new Date(),
  laws: STATUTES,
  paypal: paypalFromEnv,
});

export const GET = handlers.list;
export const POST = handlers.create;
