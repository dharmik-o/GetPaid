import { http, HttpResponse, type HttpHandler } from "msw";
import { GMAIL_API_BASE, GOOGLE_TOKEN_URL } from "@/lib/gmail";

// An in-memory Gmail and Google token endpoint for msw. Records every request, so tests can prove
// what was read and that the mailbox was never listed or searched. No real network calls.

export const FAKE_ACCESS_TOKEN = "fake-google-access-token";
export const FAKE_REFRESH_TOKEN = "fake-google-refresh-token";
export const FAKE_CODE = "fake-oauth-code";
export const FAKE_GMAIL_ADDRESS = "freelancer@example.test";
export const SCOPES_GRANTED =
  "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly";

export type SentMail = { id: string; threadId: string; raw: string; requestedThreadId?: string };

export type FakeThreadMessage = {
  id: string;
  from: string;
  body: string;
  messageId?: string;
  labelIds?: string[];
  internalDate?: string;
};

const base64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

export const createFakeGmail = () => {
  const state = {
    /** Every request path, in order, with its query. */
    requests: [] as string[],
    sent: [] as SentMail[],
    threads: new Map<string, FakeThreadMessage[]>(),
    tokenError: undefined as string | undefined,
    grantedScope: SCOPES_GRANTED,
    giveRefreshToken: true,
    sendFailure: undefined as number | "network" | undefined,
  };

  const headerValue = (raw: string, name: string): string | undefined => {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    const head = text.slice(0, text.indexOf("\r\n\r\n"));
    return new RegExp(`^${name}: (.*)$`, "mi").exec(head)?.[1]?.trim();
  };

  const toApiMessage = (threadId: string, message: FakeThreadMessage) => ({
    id: message.id,
    threadId,
    labelIds: message.labelIds ?? ["INBOX"],
    internalDate: message.internalDate ?? "1798000000000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: message.from },
        { name: "Message-ID", value: message.messageId ?? `<${message.id}@mail.example.test>` },
      ],
      body: { data: base64url(message.body) },
    },
  });

  const handlers: HttpHandler[] = [
    http.post(GOOGLE_TOKEN_URL, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      state.requests.push(`POST token ${form.get("grant_type") ?? ""}`);
      if (state.tokenError) return HttpResponse.json({ error: state.tokenError }, { status: 400 });
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== FAKE_CODE) {
          return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
        }
        return HttpResponse.json({
          access_token: FAKE_ACCESS_TOKEN,
          expires_in: 3600,
          scope: state.grantedScope,
          ...(state.giveRefreshToken ? { refresh_token: FAKE_REFRESH_TOKEN } : {}),
        });
      }
      if (form.get("refresh_token") !== FAKE_REFRESH_TOKEN) {
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      }
      return HttpResponse.json({ access_token: FAKE_ACCESS_TOKEN, expires_in: 3600 });
    }),

    http.all(`${GMAIL_API_BASE}/*`, async ({ request }) => {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
      state.requests.push(`${request.method} ${path}${url.search}`);
      if (request.headers.get("authorization") !== `Bearer ${FAKE_ACCESS_TOKEN}`) {
        return HttpResponse.json({ error: { message: "unauthenticated" } }, { status: 401 });
      }
      if (path === "/profile") return HttpResponse.json({ emailAddress: FAKE_GMAIL_ADDRESS });

      if (request.method === "POST" && path === "/messages/send") {
        if (state.sendFailure === "network") return HttpResponse.error();
        if (state.sendFailure) {
          return HttpResponse.json(
            { error: { message: "refused" } },
            { status: state.sendFailure },
          );
        }
        const body = (await request.json()) as { raw: string; threadId?: string };
        const id = `sent-${String(state.sent.length + 1)}`;
        const threadId = body.threadId ?? `thread-${String(state.sent.length + 1)}`;
        state.sent.push({
          id,
          threadId,
          raw: body.raw,
          ...(body.threadId ? { requestedThreadId: body.threadId } : {}),
        });
        const thread = state.threads.get(threadId) ?? [];
        thread.push({
          id,
          from: headerValue(body.raw, "From") ?? "",
          body: "(our own message)",
          messageId: `<gmail-${id}@mail.gmail.test>`,
          labelIds: ["SENT"],
        });
        state.threads.set(threadId, thread);
        return HttpResponse.json({ id, threadId, labelIds: ["SENT"] });
      }

      const message = /^\/messages\/([^/]+)$/.exec(path);
      if (request.method === "GET" && message?.[1]) {
        const found = state.sent.find((mail) => mail.id === message[1]);
        if (!found) return HttpResponse.json({ error: { message: "not found" } }, { status: 404 });
        return HttpResponse.json({
          id: found.id,
          threadId: found.threadId,
          payload: {
            headers: [{ name: "Message-ID", value: `<gmail-${found.id}@mail.gmail.test>` }],
          },
        });
      }

      const thread = /^\/threads\/([^/]+)$/.exec(path);
      if (request.method === "GET" && thread?.[1]) {
        const threadId = thread[1];
        const messages = state.threads.get(threadId);
        if (!messages)
          return HttpResponse.json({ error: { message: "not found" } }, { status: 404 });
        return HttpResponse.json({
          id: threadId,
          messages: messages.map((m) => toApiMessage(threadId, m)),
        });
      }
      // Anything else (a list, a search, labels, history) isn't something the app may do.
      return HttpResponse.json({ error: { message: `unexpected ${path}` } }, { status: 500 });
    }),
  ];

  return { state, handlers, headerValue };
};

export type FakeGmail = ReturnType<typeof createFakeGmail>;
