import { currentUserId } from "@/lib/auth";
import { secretBox } from "@/lib/crypto";
import { gmailOAuthEnv } from "@/lib/env";
import { gmailHandlers } from "@/lib/gmail-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

const handlers = gmailHandlers({
  runAsUser: runAsCurrentUser,
  now: () => new Date(),
  box: secretBox,
  oauth: () => gmailOAuthEnv(),
  userId: currentUserId,
});

export const POST = handlers.connect;
export const DELETE = handlers.disconnect;
