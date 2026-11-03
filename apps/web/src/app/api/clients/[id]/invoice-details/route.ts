import { runAsCurrentUser } from "@/lib/request-user";
import { templateHandlers } from "@/lib/template-handlers";

const handlers = templateHandlers({ runAsUser: runAsCurrentUser });

export const GET = handlers.getClientDetails;
export const PUT = handlers.saveClientDetails;
