import { appNow } from "@/lib/clock";
import { outboxHandlers } from "@/lib/outbox-handlers";
import { runAsCurrentUser } from "@/lib/request-user";
import { STATUTES } from "@/lib/statutes";

export const dynamic = "force-dynamic";

const handlers = outboxHandlers({
  runAsUser: runAsCurrentUser,
  now: () => appNow(),
  laws: STATUTES,
});

export const GET = handlers.summary;
