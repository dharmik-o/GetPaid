import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailConnect } from "@/components/GmailConnect";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser, type Db } from "@/lib/db";
import { devEmailAllowlist, googleOAuthEnv } from "@/lib/env";
import { GMAIL_REDIRECT_URI, GMAIL_SCOPES } from "@/lib/gmail";
import { gmailTokenContext, getGmailAccount, loadGmailRefreshToken } from "@/lib/gmail-account";
import { gmailHandlers } from "@/lib/gmail-handlers";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import {
  createFakeGmail,
  FAKE_CODE,
  FAKE_GMAIL_ADDRESS,
  FAKE_REFRESH_TOKEN,
  type FakeGmail,
} from "../mocks/gmail";

// next is installed in the web workspace only, so the mock names its path from here.
vi.mock("../../apps/web/node_modules/next/navigation.js", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

// Connecting Gmail: real migrations and RLS (PGlite), Google mocked by msw.

let handle: TestDatabase;
let gmail: FakeGmail;
const server = setupServer();
const box = createSecretBox(randomBytes(32));
const NOW = new Date("2026-11-04T10:00:00Z");
let clock = NOW;
const OAUTH = { clientId: "fake-client-id", clientSecret: "fake-client-secret" };

const asUser =
  (userId: string) =>
  <T>(work: (db: Db) => Promise<T>): Promise<T> =>
    runAsUser(handle.db, userId, work);

const handlers = (userId = USER_A.userId, oauth: typeof OAUTH | undefined = OAUTH) =>
  gmailHandlers({
    runAsUser: asUser(userId),
    now: () => clock,
    box: () => box,
    oauth: () => oauth,
    userId: () => userId,
  });

const jsonRequest = (method: string) =>
  new Request("http://127.0.0.1:3000/api/integrations/gmail", {
    method,
    headers: { "content-type": "application/json" },
    body: "{}",
  });

/** Starts connecting; gives back Google's consent address. */
const start = async (userId = USER_A.userId): Promise<URL> => {
  const response = await handlers(userId).connect(jsonRequest("POST"));
  expect(response.status).toBe(201);
  return new URL(((await response.json()) as { url: string }).url);
};

const callback = (query: Record<string, string>, userId = USER_A.userId) =>
  handlers(userId).callback(
    new Request(`${GMAIL_REDIRECT_URI}?${new URLSearchParams(query).toString()}`),
  );

const outcomeOf = (response: Response): string | null =>
  new URL(response.headers.get("location") ?? "").searchParams.get("gmail");

const account = (userId = USER_A.userId) => asUser(userId)((db) => getGmailAccount(db));

beforeAll(async () => {
  gmail = createFakeGmail();
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  server.listen({ onUnhandledFrame: "error" });
}, 60_000);

afterEach(() => {
  server.resetHandlers();
});

afterAll(async () => {
  server.close();
  await handle.close();
});

beforeEach(async () => {
  clock = NOW;
  gmail = createFakeGmail();
  server.use(...gmail.handlers);
  await handle.db.query(
    `UPDATE public.users SET gmail_token_enc = NULL, gmail_email = NULL,
       gmail_status = 'disconnected', gmail_reconnect_notified_at = NULL,
       gmail_oauth_state_hash = NULL, gmail_oauth_state_expires_at = NULL`,
  );
});

describe("the consent link", () => {
  it("asks for exactly send and readonly, offline, on the fixed redirect address", async () => {
    const url = await start();
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const params = url.searchParams;
    expect(params.get("client_id")).toBe(OAUTH.clientId);
    expect(params.get("redirect_uri")).toBe(
      "http://localhost:3000/api/integrations/gmail/callback",
    );
    expect(params.get("response_type")).toBe("code");
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("scope")?.split(" ").sort()).toEqual(
      [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
      ].sort(),
    );
    expect(GMAIL_SCOPES).toHaveLength(2);
    expect(params.get("state")).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });

  it("says which names to set when the OAuth client isn't configured", async () => {
    const response = await gmailHandlers({
      runAsUser: asUser(USER_A.userId),
      now: () => clock,
      box: () => box,
      oauth: () => undefined,
      userId: () => USER_A.userId,
    }).connect(jsonRequest("POST"));
    expect(response.status).toBe(503);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("GOOGLE_CLIENT_ID");
    expect(error).toContain("GOOGLE_CLIENT_SECRET");
  });
});

describe("the callback", () => {
  const code = async (userId = USER_A.userId) => ({
    code: FAKE_CODE,
    state: (await start(userId)).searchParams.get("state") ?? "",
  });

  it("stores the refresh token encrypted, and the address, then returns to Settings", async () => {
    const response = await callback(await code());
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/settings/integrations");
    expect(outcomeOf(response)).toBe("connected");
    expect(await account()).toEqual({ status: "connected", email: FAKE_GMAIL_ADDRESS });

    const { rows } = await handle.db.query<{ gmail_token_enc: string }>(
      "SELECT gmail_token_enc FROM public.users WHERE id = $1",
      [USER_A.userId],
    );
    const stored = rows[0]?.gmail_token_enc ?? "";
    expect(stored).not.toContain(FAKE_REFRESH_TOKEN);
    expect(box.decrypt(stored, gmailTokenContext(USER_A.userId))).toBe(FAKE_REFRESH_TOKEN);
    expect(await asUser(USER_A.userId)((db) => loadGmailRefreshToken(db, box))).toBe(
      FAKE_REFRESH_TOKEN,
    );
  });

  it("the token can't be opened as another user's", async () => {
    await callback(await code());
    const { rows } = await handle.db.query<{ gmail_token_enc: string }>(
      "SELECT gmail_token_enc FROM public.users WHERE id = $1",
      [USER_A.userId],
    );
    expect(() =>
      box.decrypt(rows[0]?.gmail_token_enc ?? "", gmailTokenContext(USER_B.userId)),
    ).toThrow();
  });

  it("never puts the token in a response or the log", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const response = await callback(await code());
    const logged = write.mock.calls.map(([line]) => String(line)).join("");
    write.mockRestore();
    expect(await response.text()).not.toContain(FAKE_REFRESH_TOKEN);
    expect(response.headers.get("location")).not.toContain(FAKE_REFRESH_TOKEN);
    expect(logged).not.toContain(FAKE_REFRESH_TOKEN);
    expect(logged).not.toContain(OAUTH.clientSecret);
  });

  it("refuses a state that's wrong, used twice, expired, or another user's", async () => {
    const good = await code();
    expect(outcomeOf(await callback({ ...good, state: "x".repeat(43) }))).toBe("invalid_state");
    expect((await account()).status).toBe("disconnected");

    expect(outcomeOf(await callback(good))).toBe("connected");
    expect(outcomeOf(await callback(good))).toBe("invalid_state");

    const late = await code(USER_B.userId);
    clock = new Date(NOW.getTime() + 11 * 60 * 1000);
    expect(outcomeOf(await callback(late, USER_B.userId))).toBe("invalid_state");
    clock = NOW;

    const someoneElses = await code(USER_B.userId);
    expect(outcomeOf(await callback(someoneElses, USER_A.userId))).toBe("invalid_state");
  });

  it("reports when you decline at Google, without calling it", async () => {
    const { state } = await code();
    expect(outcomeOf(await callback({ error: "access_denied", state }))).toBe("denied");
    expect(gmail.state.requests).toEqual([]);
    expect((await account()).status).toBe("disconnected");
  });

  it("refuses a grant that's missing a scope", async () => {
    gmail.state.grantedScope = "https://www.googleapis.com/auth/gmail.send";
    expect(outcomeOf(await callback(await code()))).toBe("missing_scope");
    expect((await account()).status).toBe("disconnected");
  });

  it("refuses a grant with no refresh token", async () => {
    gmail.state.giveRefreshToken = false;
    expect(outcomeOf(await callback(await code()))).toBe("no_refresh_token");
  });

  it("reports a code Google refuses", async () => {
    const { state } = await code();
    expect(outcomeOf(await callback({ code: "wrong", state }))).toBe("failed");
  });

  it("only reads the profile, and never lists anything", async () => {
    await callback(await code());
    expect(gmail.state.requests).toEqual(["POST token authorization_code", "GET /profile"]);
  });
});

describe("disconnecting", () => {
  it("clears the token and the address, for this user only", async () => {
    const stateA = (await start()).searchParams.get("state") ?? "";
    await callback({ code: FAKE_CODE, state: stateA });
    const stateB = (await start(USER_B.userId)).searchParams.get("state") ?? "";
    await callback({ code: FAKE_CODE, state: stateB }, USER_B.userId);

    expect((await handlers().disconnect(jsonRequest("DELETE"))).status).toBe(204);
    expect(await account()).toEqual({ status: "disconnected", email: null });
    expect((await account(USER_B.userId)).status).toBe("connected");
    const { rows } = await handle.db.query<{ gmail_token_enc: string | null }>(
      "SELECT gmail_token_enc FROM public.users WHERE id = $1",
      [USER_A.userId],
    );
    expect(rows[0]?.gmail_token_enc).toBeNull();
  });
});

describe("the Gmail client can't read the mailbox", () => {
  it("has no way to list or search: only these calls exist in the code", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "apps", "web", "src", "lib", "gmail.ts"),
      "utf8",
    );
    const paths = [...source.matchAll(/\$\{GMAIL_API_BASE\}([^`]*)`/g)].map((m) => m[1]);
    expect(paths.sort()).toEqual(
      [
        "/messages/${safeId(id)}?format=metadata&metadataHeaders=Message-ID",
        "/messages/send",
        "/profile",
        "/threads/${safeId(threadId)}?format=full",
      ].sort(),
    );
    expect(source).not.toMatch(/[?&]q=|\/history|\/labels/);
  });
});

describe("env", () => {
  it("needs both OAuth names", () => {
    expect(googleOAuthEnv({})).toBeUndefined();
    expect(googleOAuthEnv({ GOOGLE_CLIENT_ID: "a" })).toBeUndefined();
    expect(googleOAuthEnv({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" })).toEqual({
      clientId: "a",
      clientSecret: "b",
    });
  });

  it("the allowlist is empty unless set, trims, and ignores case", () => {
    expect(devEmailAllowlist({}).size).toBe(0);
    expect(devEmailAllowlist({ DEV_EMAIL_ALLOWLIST: "" }).size).toBe(0);
    expect([
      ...devEmailAllowlist({ DEV_EMAIL_ALLOWLIST: " A@Example.test , b@example.test,," }),
    ]).toEqual(["a@example.test", "b@example.test"]);
  });

  it("every name is in .env.example, with no value", () => {
    const example = readFileSync(join(import.meta.dirname, "..", "..", ".env.example"), "utf8");
    for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "DEV_EMAIL_ALLOWLIST"]) {
      expect(example).toMatch(new RegExp(`^${name}=\\s*$`, "m"));
    }
  });
});

describe("GmailConnect", () => {
  const render = (props: Partial<Parameters<typeof GmailConnect>[0]>) =>
    renderToStaticMarkup(
      createElement(GmailConnect, {
        status: "disconnected",
        email: null,
        configured: true,
        outcome: null,
        ...props,
      }),
    );

  it("offers Connect, and names what it asks for", () => {
    const html = render({});
    expect(html).toContain("Connect Gmail");
    expect(html).toContain("read only the threads");
  });

  it("names the OAuth env values when they aren't set", () => {
    const html = render({ configured: false });
    expect(html).toContain("GOOGLE_CLIENT_ID");
    expect(html).not.toContain("<button");
  });

  it("shows the address and Disconnect once connected", () => {
    const html = render({ status: "connected", email: FAKE_GMAIL_ADDRESS });
    expect(html).toContain(FAKE_GMAIL_ADDRESS);
    expect(html).toContain("Disconnect Gmail");
  });

  it("says sends are held, not lost, when it needs reconnecting", () => {
    const html = render({ status: "needs_reconnect", email: FAKE_GMAIL_ADDRESS });
    expect(html).toContain("Reconnect Gmail");
    expect(html).toContain("held");
  });

  it.each(["denied", "invalid_state", "missing_scope", "no_refresh_token", "failed"])(
    "explains the outcome %s",
    (outcome) => {
      expect(render({ outcome })).toContain('role="alert"');
    },
  );
});
