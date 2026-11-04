import { currentUserId } from "@/lib/auth";
import { appNow } from "@/lib/clock";
import { secretBox } from "@/lib/crypto";
import { gmailOAuthEnv } from "@/lib/env";
import { gmailHandlers } from "@/lib/gmail-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

export const dynamic = "force-dynamic";

const handlers = gmailHandlers({
  runAsUser: runAsCurrentUser,
  now: () => appNow(),
  box: secretBox,
  oauth: () => gmailOAuthEnv(),
  userId: currentUserId,
});

export const GET = handlers.callback;
