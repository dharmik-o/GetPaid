import { currentUserId } from "@/lib/auth";
import { secretBox } from "@/lib/crypto";
import { withUserDb } from "@/lib/db";
import { holdHandlers } from "@/lib/hold-handlers";
import { paypalFromEnv } from "@/lib/paypal";
import { withServiceDb } from "@/lib/service-db";
import { STATUTES } from "@/lib/statutes";

// The service role only records PayPal's answers about a hold already found as the freelancer (RLS).
const handlers = holdHandlers({
  currentUser: currentUserId,
  runAsService: withServiceDb,
  runAsUser: withUserDb,
  box: secretBox,
  now: () => new Date(),
  laws: STATUTES,
  paypal: paypalFromEnv,
});

export const POST = handlers.act;
