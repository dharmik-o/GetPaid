import { aiRouteHandler } from "@/lib/ai-route-handler";
import { secretBox } from "@/lib/crypto";
import { withUserDb } from "@/lib/db";
import { internalApiToken } from "@/lib/env";

// Called by n8n's 07_ai_router only (Bearer INTERNAL_API_TOKEN). Acts as the given user (RLS).
const handler = aiRouteHandler({
  runAsUser: withUserDb,
  box: secretBox,
  token: () => internalApiToken(),
});

export const POST = handler.post;
