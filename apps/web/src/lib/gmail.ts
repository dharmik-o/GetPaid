import { z } from "zod";
import type { GoogleOAuthEnv } from "./env";

// Server-only: Google's token endpoint and the Gmail API. This client can send, read the
// connected address, and read one message or thread by ID. It has no way to list or search the
// mailbox (security rule 7), and only stored thread IDs are ever passed to it (lib/replies.ts).

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Registered in the Google OAuth client, so it's fixed here rather than configured. */
export const GMAIL_REDIRECT_URI = "http://localhost:3000/api/integrations/gmail/callback";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

const TIMEOUT_MS = 30_000;

/** Google refused the token (invalid_grant): it needs connecting again. */
export class GmailAuthExpired extends Error {
  constructor() {
    super("Google refused the Gmail token. Reconnect Gmail in Settings > Integrations.");
    this.name = "GmailAuthExpired";
  }
}

/** A Gmail call failed. `outcomeUnknown`: the request may have taken effect anyway. */
export class GmailError extends Error {
  readonly status: number | null;
  readonly outcomeUnknown: boolean;

  constructor(what: string, status: number | null) {
    super(
      status === null
        ? `Gmail didn't answer the ${what} request. Check the connection and try again.`
        : `Gmail refused the ${what} request (HTTP ${String(status)}).`,
    );
    this.name = "GmailError";
    this.status = status;
    // Only a send can have taken effect: a failed token or read changed nothing.
    this.outcomeUnknown = what === "send" && (status === null || status >= 500);
  }
}

export const consentUrl = (oauth: GoogleOAuthEnv, state: string): string => {
  const params = new URLSearchParams({
    client_id: oauth.clientId,
    redirect_uri: GMAIL_REDIRECT_URI,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    // Google gives a refresh token only on consent, and a reconnect needs a new one.
    prompt: "consent",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
};

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

const postToken = async (form: Record<string, string>): Promise<z.infer<typeof tokenSchema>> => {
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GmailError("token", null);
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (body.error === "invalid_grant") throw new GmailAuthExpired();
  if (!response.ok) throw new GmailError("token", response.status);
  const parsed = tokenSchema.safeParse(body);
  if (!parsed.success) throw new GmailError("token", response.status);
  return parsed.data;
};

export const exchangeCode = (
  oauth: GoogleOAuthEnv,
  code: string,
): Promise<z.infer<typeof tokenSchema>> =>
  postToken({
    grant_type: "authorization_code",
    code,
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    redirect_uri: GMAIL_REDIRECT_URI,
  });

const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Gmail's IDs are short tokens. Anything else can't reach a request path. */
const safeId = (id: string): string => {
  if (!SAFE_ID.test(id)) throw new Error("A Gmail ID isn't in the expected form.");
  return id;
};

const sentSchema = z.object({ id: z.string().min(1), threadId: z.string().min(1) });

const headerSchema = z.object({ name: z.string(), value: z.string() });

const messageHeadersSchema = z.object({
  payload: z.object({ headers: z.array(headerSchema).default([]) }),
});

type GmailPart = {
  mimeType?: string | undefined;
  headers?: { name: string; value: string }[] | undefined;
  body?: { data?: string | undefined } | undefined;
  parts?: GmailPart[] | undefined;
};

const partSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    headers: z.array(headerSchema).optional(),
    body: z.object({ data: z.string().optional() }).optional(),
    parts: z.array(partSchema).optional(),
  }),
);

const threadSchema = z.object({
  messages: z
    .array(
      z.object({
        id: z.string().min(1),
        labelIds: z.array(z.string()).default([]),
        internalDate: z.string().optional(),
        payload: partSchema,
      }),
    )
    .default([]),
});

export type GmailThread = z.infer<typeof threadSchema>;
export type GmailThreadMessage = GmailThread["messages"][number];

export type GmailClient = {
  /** The connected address. */
  profile: () => Promise<string>;
  /** Sends raw MIME, on `threadId` if there is one. */
  send: (raw: string, threadId: string | null) => Promise<{ id: string; threadId: string }>;
  /** The Message-ID header of a message this app sent. */
  rfcMessageId: (id: string) => Promise<string | undefined>;
  /** One thread, by the ID the app stored when it sent the first reminder. */
  thread: (threadId: string) => Promise<GmailThread>;
};

/** A client on one access token, as from a code exchange or a refresh. */
export const gmailClientWithToken = (token: () => Promise<string>): GmailClient => {
  const call = async (what: string, url: string, init?: RequestInit): Promise<unknown> => {
    const accessToken = await token();
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(init?.body ? { "content-type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new GmailError(what, null);
    }
    if (!response.ok) throw new GmailError(what, response.status);
    return response.json();
  };

  return {
    profile: async () => {
      const body = await call("profile", `${GMAIL_API_BASE}/profile`);
      return z.object({ emailAddress: z.string().min(1) }).parse(body).emailAddress;
    },

    send: async (raw, threadId) => {
      const body = await call("send", `${GMAIL_API_BASE}/messages/send`, {
        method: "POST",
        body: JSON.stringify(threadId ? { raw, threadId: safeId(threadId) } : { raw }),
      });
      return sentSchema.parse(body);
    },

    rfcMessageId: async (id) => {
      const body = await call(
        "message",
        `${GMAIL_API_BASE}/messages/${safeId(id)}?format=metadata&metadataHeaders=Message-ID`,
      );
      return messageHeadersSchema
        .parse(body)
        .payload.headers.find((header) => header.name.toLowerCase() === "message-id")?.value;
    },

    thread: async (threadId) =>
      threadSchema.parse(
        await call("thread", `${GMAIL_API_BASE}/threads/${safeId(threadId)}?format=full`),
      ),
  };
};

/** A client that refreshes its access token once, on first use. Never logs or returns a token. */
export const gmailClient = (oauth: GoogleOAuthEnv, refreshToken: string): GmailClient => {
  let accessToken: Promise<string> | undefined;
  return gmailClientWithToken(() => {
    accessToken ??= postToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
    }).then((token) => token.access_token);
    return accessToken;
  });
};
