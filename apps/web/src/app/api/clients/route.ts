import { clientHandlers } from "@/lib/client-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = clientHandlers({ runAsUser: runAsCurrentUser });

export const GET = handlers.list;
export const POST = handlers.create;
