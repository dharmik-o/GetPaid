import { projectHandlers } from "@/lib/project-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = projectHandlers({ runAsUser: runAsCurrentUser });

export const POST = handlers.create;
