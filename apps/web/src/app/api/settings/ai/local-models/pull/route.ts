import { currentUserId } from "@/lib/auth";
import { localAiHandlers } from "@/lib/local-ai-handlers";
import { puller } from "@/lib/local-ai";

const handlers = localAiHandlers({ puller, userId: currentUserId });

export const GET = handlers.get;
export const POST = handlers.pull;
