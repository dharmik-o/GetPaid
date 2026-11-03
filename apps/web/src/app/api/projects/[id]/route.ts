import { projectHandlers } from "@/lib/project-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = projectHandlers({ runAsUser: runAsCurrentUser });

export const GET = handlers.get;
export const PATCH = handlers.update;
