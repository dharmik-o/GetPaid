import { z } from "zod";
import type { SecretBox } from "./crypto";
import type { UserDbRunner } from "./db";
import type { GoogleOAuthEnv } from "./env";
import { toFieldIssues } from "./field-issues";
import {
  consentUrl,
  exchangeCode,
  GMAIL_REDIRECT_URI,
  GMAIL_SCOPES,
  GmailAuthExpired,
  gmailClientWithToken,
} from "./gmail";
import {
  consumeGmailState,
  disconnectGmail,
  saveGmailConnection,
  startGmailConnect,
} from "./gmail-account";
import { fieldErrors, jsonResponse, noContent, readJson, serverError } from "./http";
import { errorKind, logEvent } from "./log";

// Server-only: POST and DELETE /api/integrations/gmail (start connecting, disconnect) and GET
// /api/integrations/gmail/callback (Google sends the browser back here). All as the signed-in
// user. The state ties the callback to the one who started it. Only fixed outcome codes go back
// in the address: never a token, or Google's own error text.

type Deps = {
  runAsUser: UserDbRunner;
  now: () => Date;
  box: () => SecretBox;
  oauth: () => GoogleOAuthEnv | undefined;
  userId: () => string;
};

const emptySchema = z.strictObject({});

export const GMAIL_OUTCOMES = [
  "connected",
  "denied",
  "invalid_state",
  "missing_scope",
  "no_refresh_token",
  "failed",
] as const;

export type GmailOutcome = (typeof GMAIL_OUTCOMES)[number];

const backToSettings = (outcome: GmailOutcome): Response =>
  new Response(null, {
    status: 303,
    headers: {
      location: new URL(`/settings/integrations?gmail=${outcome}`, GMAIL_REDIRECT_URI).toString(),
    },
  });

const hasEveryScope = (granted: string | undefined): boolean => {
  const scopes = (granted ?? "").split(" ");
  return GMAIL_SCOPES.every((scope) => scopes.includes(scope));
};

/** What came back from Google, as far as it can be trusted: the state was already checked. */
const finishConnect = async (
  deps: Deps,
  oauth: GoogleOAuthEnv,
  code: string,
): Promise<GmailOutcome> => {
  const token = await exchangeCode(oauth, code);
  if (!hasEveryScope(token.scope)) return "missing_scope";
  if (!token.refresh_token) return "no_refresh_token";
  const refreshToken = token.refresh_token;
  const email = await gmailClientWithToken(() => Promise.resolve(token.access_token)).profile();
  await deps.runAsUser((db) =>
    saveGmailConnection(db, { userId: deps.userId(), refreshToken, email, box: deps.box() }),
  );
  return "connected";
};

export const gmailHandlers = (deps: Deps) => ({
  connect: async (request: Request): Promise<Response> => {
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = emptySchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    const oauth = deps.oauth();
    if (!oauth) {
      return jsonResponse(
        {
          error:
            "Gmail isn't set up: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see .env.example) and restart.",
        },
        503,
      );
    }
    try {
      const state = await deps.runAsUser((db) => startGmailConnect(db, deps.now()));
      return jsonResponse({ url: consentUrl(oauth, state) }, 201);
    } catch (error) {
      return serverError("gmail.connect_failed", error);
    }
  },

  callback: async (request: Request): Promise<Response> => {
    const params = new URL(request.url).searchParams;
    const oauth = deps.oauth();
    try {
      const state = params.get("state") ?? "";
      const valid = await deps.runAsUser((db) => consumeGmailState(db, state, deps.now()));
      if (!valid || !oauth) return backToSettings("invalid_state");
      if (params.has("error")) return backToSettings("denied");
      const code = params.get("code");
      if (!code) return backToSettings("failed");
      const outcome = await finishConnect(deps, oauth, code);
      logEvent("gmail.callback", { outcome });
      return backToSettings(outcome);
    } catch (error) {
      logEvent("gmail.callback_failed", {
        error: error instanceof GmailAuthExpired ? "invalid_grant" : errorKind(error),
      });
      return backToSettings("failed");
    }
  },

  disconnect: async (request: Request): Promise<Response> => {
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = emptySchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    try {
      await deps.runAsUser((db) => disconnectGmail(db));
      return noContent();
    } catch (error) {
      return serverError("gmail.disconnect_failed", error);
    }
  },
});
