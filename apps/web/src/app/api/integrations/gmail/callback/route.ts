import { currentUserId } from "@/lib/auth";
import { secretBox } from "@/lib/crypto";
import { googleOAuthEnv } from "@/lib/env";
import { gmailHandlers } from "@/lib/gmail-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

export const dynamic = "force-dynamic";

const handlers = gmailHandlers({
  runAsUser: runAsCurrentUser,
  now: () => new Date(),
  box: secretBox,
  oauth: () => googleOAuthEnv(),
  userId: currentUserId,
});

export const GET = handlers.callback;
