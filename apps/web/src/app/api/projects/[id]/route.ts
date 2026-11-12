import { currentUserId } from "@/lib/auth";
import { appNow } from "@/lib/clock";
import { secretBox } from "@/lib/crypto";
import { withUserDb } from "@/lib/db";
import { paypalFromEnv } from "@/lib/paypal";
import { projectHandlers } from "@/lib/project-handlers";
import { runAsCurrentUser } from "@/lib/request-user";
import { withServiceDb } from "@/lib/service-db";
import { STATUTES } from "@/lib/statutes";

// Deleting may cancel invoices and void holds in PayPal first, as the signed-in freelancer. The
// service role only records PayPal's answers about a hold already found as them (RLS).
const handlers = projectHandlers({
  runAsUser: runAsCurrentUser,
  deleting: () => {
    try {
      return {
        runAsUser: runAsCurrentUser,
        paypal: paypalFromEnv(),
        now: appNow(),
        userId: currentUserId(),
        holds: {
          runAsService: withServiceDb,
          runAsUser: withUserDb,
          box: secretBox,
          now: () => appNow(),
          laws: STATUTES,
          paypal: paypalFromEnv,
        },
      };
    } catch {
      return undefined;
    }
  },
});

export const GET = handlers.get;
export const PATCH = handlers.update;
export const DELETE = handlers.remove;
