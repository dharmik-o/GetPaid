import { installmentHandlers } from "@/lib/installment-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = installmentHandlers({ runAsUser: runAsCurrentUser, now: () => new Date() });

export const PUT = handlers.save;
export const DELETE = handlers.remove;
