import { accountHandlers } from "@/lib/account";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = accountHandlers({ runAsUser: runAsCurrentUser });

export const PUT = handlers.put;
