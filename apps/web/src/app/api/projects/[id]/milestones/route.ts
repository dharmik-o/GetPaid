import { milestoneHandlers } from "@/lib/milestone-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = milestoneHandlers({ runAsUser: runAsCurrentUser });

export const PUT = handlers.savePlan;
