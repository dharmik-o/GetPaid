import { aiTestHandler } from "@/lib/ai-test-handler";
import { secretBox } from "@/lib/crypto";
import { runAsCurrentUser } from "@/lib/request-user";

// Runs the 4 sample tasks against the signed-in user's saved AI models.
const handler = aiTestHandler({ runAsUser: runAsCurrentUser, box: secretBox });

export const POST = handler.post;
