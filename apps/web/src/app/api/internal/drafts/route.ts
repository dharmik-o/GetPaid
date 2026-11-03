import { secretBox } from "@/lib/crypto";
import { withUserDb } from "@/lib/db";
import { draftsHandler } from "@/lib/drafter-handler";
import { internalApiToken } from "@/lib/env";

// Called by n8n's 02_drafter only (Bearer INTERNAL_API_TOKEN). Acts as the given user (RLS).
const handler = draftsHandler({
  runAsUser: withUserDb,
  box: secretBox,
  now: () => new Date(),
  token: () => internalApiToken(),
});

export const POST = handler.post;
