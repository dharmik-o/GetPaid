import { runAsCurrentUser } from "@/lib/request-user";
import { templateHandlers } from "@/lib/template-handlers";

const handlers = templateHandlers({ runAsUser: runAsCurrentUser });

export const GET = handlers.get;
export const PUT = handlers.update;
export const DELETE = handlers.remove;
