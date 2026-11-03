import { clientHandlers } from "@/lib/client-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = clientHandlers({ runAsUser: runAsCurrentUser });

export const GET = handlers.get;
export const PATCH = handlers.update;
export const DELETE = handlers.remove;
