import { appNow } from "@/lib/clock";
import { secretBox } from "@/lib/crypto";
import { withUserDb } from "@/lib/db";
import { gmailOAuthEnv, internalApiToken } from "@/lib/env";
import { replyListenerHandler } from "@/lib/reply-handlers";
import { withServiceDb } from "@/lib/service-db";

// Called by n8n's 05_reply_listener only (Bearer INTERNAL_API_TOKEN). The service role only lists
// the stored thread IDs; each is then read and saved as its freelancer (RLS).
const handler = replyListenerHandler({
  runAsService: withServiceDb,
  runAsUser: withUserDb,
  now: () => appNow(),
  box: secretBox,
  oauth: () => gmailOAuthEnv(),
  token: () => internalApiToken(),
});

export const POST = handler.post;
