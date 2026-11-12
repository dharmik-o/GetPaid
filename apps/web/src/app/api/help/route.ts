import { secretBox } from "@/lib/crypto";
import { helpHandlers } from "@/lib/help-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = helpHandlers({ runAsUser: runAsCurrentUser, box: secretBox });

export const POST = handlers.ask;
