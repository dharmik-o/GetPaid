import { outboxHandlers } from "@/lib/outbox-handlers";
import { runAsCurrentUser } from "@/lib/request-user";
import { STATUTES } from "@/lib/statutes";

const handlers = outboxHandlers({
  runAsUser: runAsCurrentUser,
  now: () => new Date(),
  laws: STATUTES,
});

export const POST = handlers.post;
