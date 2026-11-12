import { currentUserId } from "@/lib/auth";
import { appNow } from "@/lib/clock";
import { secretBox } from "@/lib/crypto";
import { withUserDb } from "@/lib/db";
import { milestoneHandlers } from "@/lib/milestone-handlers";
import { paypalFromEnv } from "@/lib/paypal";
import { runAsCurrentUser } from "@/lib/request-user";
import { withServiceDb } from "@/lib/service-db";
import { STATUTES } from "@/lib/statutes";

const handlers = milestoneHandlers({
  runAsUser: runAsCurrentUser,
  holds: {
    currentUser: currentUserId,
    runAsService: withServiceDb,
    runAsUser: withUserDb,
    box: secretBox,
    now: () => appNow(),
    laws: STATUTES,
    paypal: paypalFromEnv,
  },
});

export const PATCH = handlers.markStatus;
export const DELETE = handlers.remove;
