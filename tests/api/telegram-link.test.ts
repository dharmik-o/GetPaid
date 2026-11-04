import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser, type Db } from "@/lib/db";
import { runAsService } from "@/lib/service-db";
import { telegramLinkHandlers, telegramUpdateHandler } from "@/lib/telegram-handlers";
import { getTelegramStatus } from "@/lib/telegram-link";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// Connect Telegram: real migrations and RLS (PGlite). Telegram itself is never called: n8n relays
// each update here and sends the reply this answers with.

let handle: TestDatabase;
let clock = new Date("2026-11-04T10:00:00Z");

const TOKEN = "t".repeat(64);
const box = createSecretBox(randomBytes(32));
const BOT = "PaymentRecoveryTestBot";
const CHAT_A = 7001;
const CHAT_B = 7002;

const asUser =
  (userId: string) =>
  <T>(work: (db: Db) => Promise<T>): Promise<T> =>
    runAsUser(handle.db, userId, work);

const linkHandlers = (userId = USER_A.userId) =>
  telegramLinkHandlers({
    runAsUser: asUser(userId),
    now: () => clock,
    botUsername: () => BOT,
  });

const jsonRequest = (method: string, body: unknown = {}) =>
  new Request("http://127.0.0.1:3000/api/telegram/link", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Starts a link and gives back the code from the deep link. */
const startLink = async (userId = USER_A.userId): Promise<string> => {
  const response = await linkHandlers(userId).post(jsonRequest("POST"));
  expect(response.status).toBe(201);
  const { url } = (await response.json()) as { url: string };
  return new URL(url).searchParams.get("start") ?? "";
};

const relay = (update: unknown, authorization: string | null = `Bearer ${TOKEN}`) =>
  telegramUpdateHandler({
    runAsService: (work) => runAsService(handle.db, work),
    runAsUser: asUser,
    now: () => clock,
    token: () => TOKEN,
    box: () => box,
    laws: [],
    outboxUrl: () => undefined,
  paypal: () => {
    throw new Error("These tests don't create invoices.");
  },
  }).post(
    new Request("http://127.0.0.1:3000/api/internal/telegram/update", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(update),
    }),
  );

const message = (text: string, chatId = CHAT_A, type = "private") => ({
  update_id: 1,
  message: { message_id: 1, chat: { id: chatId, type }, text },
});

const replyOf = async (response: Response) =>
  ((await response.json()) as { ops: { chatId: number; text: string }[] }).ops[0] ?? null;

const chatIdOf = async (userId: string) => {
  const { rows } = await handle.db.query<{ telegram_chat_id: string | null }>(
    "SELECT telegram_chat_id::text FROM public.users WHERE id = $1",
    [userId],
  );
  return rows[0]?.telegram_chat_id ?? null;
};

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  clock = new Date("2026-11-04T10:00:00Z");
  await handle.db.query(
    `UPDATE public.users SET telegram_chat_id = NULL, telegram_link_hash = NULL,
       telegram_link_expires_at = NULL`,
  );
  await handle.db.query("DELETE FROM public.events WHERE entity = 'user'");
});

describe("starting a link", () => {
  it("gives a t.me deep link with a code Telegram accepts", async () => {
    const response = await linkHandlers().post(jsonRequest("POST"));
    expect(response.status).toBe(201);
    const { url } = (await response.json()) as { url: string };
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`https://t.me/${BOT}`);
    // Telegram's start parameter: up to 64 of A-Z a-z 0-9 _ -
    expect(parsed.searchParams.get("start")).toMatch(/^[A-Za-z0-9_-]{32,64}$/);
  });

  it("stores only a hash of the code", async () => {
    const code = await startLink();
    const { rows } = await handle.db.query<{ telegram_link_hash: string }>(
      "SELECT telegram_link_hash FROM public.users WHERE id = $1",
      [USER_A.userId],
    );
    expect(rows[0]?.telegram_link_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.telegram_link_hash).not.toContain(code);
  });

  it("says what to set when the bot isn't configured", async () => {
    const unset = telegramLinkHandlers({
      runAsUser: asUser(USER_A.userId),
      now: () => clock,
      botUsername: () => undefined,
    });
    const refused = await unset.post(jsonRequest("POST"));
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: string }).error).toContain("TELEGRAM_BOT_USERNAME");
  });

  it("a new link replaces the old one", async () => {
    const first = await startLink();
    const second = await startLink();
    expect(await replyOf(await relay(message(`/start ${first}`)))).toMatchObject({
      text: expect.stringContaining("expired") as string,
    });
    expect(await chatIdOf(USER_A.userId)).toBeNull();
    await relay(message(`/start ${second}`));
    expect(await chatIdOf(USER_A.userId)).toBe(String(CHAT_A));
  });
});

describe("the bot receives /start <code>", () => {
  it("saves the chat ID on the code's owner, once, and confirms", async () => {
    const code = await startLink();
    const reply = await replyOf(await relay(message(`/start ${code}`)));
    expect(reply?.chatId).toBe(CHAT_A);
    expect(reply?.text).toContain("Connected");
    expect(await chatIdOf(USER_A.userId)).toBe(String(CHAT_A));
    expect(await chatIdOf(USER_B.userId)).toBeNull();
    expect(await asUser(USER_A.userId)((db) => getTelegramStatus(db))).toEqual({ connected: true });
  });

  it("refuses a code used a second time, from any chat", async () => {
    const code = await startLink();
    await relay(message(`/start ${code}`));
    const reply = await replyOf(await relay(message(`/start ${code}`, CHAT_B)));
    expect(reply?.text).toContain("expired");
    expect(await chatIdOf(USER_A.userId)).toBe(String(CHAT_A));
  });

  it("refuses an expired code", async () => {
    const code = await startLink();
    clock = new Date(clock.getTime() + 16 * 60 * 1000);
    const reply = await replyOf(await relay(message(`/start ${code}`)));
    expect(reply?.text).toContain("expired");
    expect(await chatIdOf(USER_A.userId)).toBeNull();
  });

  it("refuses a code that was never issued", async () => {
    await startLink();
    const reply = await replyOf(await relay(message(`/start ${"x".repeat(43)}`)));
    expect(reply?.text).toContain("expired");
    expect(await chatIdOf(USER_A.userId)).toBeNull();
  });

  it("won't take a chat already linked to someone else, and keeps the code usable", async () => {
    await relay(message(`/start ${await startLink(USER_B.userId)}`, CHAT_A));
    const code = await startLink();
    const reply = await replyOf(await relay(message(`/start ${code}`, CHAT_A)));
    expect(reply?.text).toContain("another account");
    expect(await chatIdOf(USER_A.userId)).toBeNull();
    expect(await chatIdOf(USER_B.userId)).toBe(String(CHAT_A));
    await relay(message(`/start ${code}`, CHAT_B));
    expect(await chatIdOf(USER_A.userId)).toBe(String(CHAT_B));
  });

  it("only links a private chat, so a group's members can't get the cards", async () => {
    const code = await startLink();
    expect(await replyOf(await relay(message(`/start ${code}`, -100, "group")))).toBeNull();
    expect(await chatIdOf(USER_A.userId)).toBeNull();
  });

  it("explains a bare /start and ignores other text", async () => {
    expect((await replyOf(await relay(message("/start"))))?.text).toContain("Connect Telegram");
    expect(await replyOf(await relay(message("hello")))).toBeNull();
    expect(await replyOf(await relay({ update_id: 2 }))).toBeNull();
  });

  it("records the link without the code or the chat ID in the event or the log", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const code = await startLink();
    await relay(message(`/start ${code}`));
    const logged = write.mock.calls.map(([line]) => String(line)).join("");
    write.mockRestore();
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(String(CHAT_A));
    const { rows } = await handle.db.query<{ type: string; payload: unknown }>(
      "SELECT type, payload FROM public.events WHERE entity = 'user' AND entity_id = $1",
      [USER_A.userId],
    );
    expect(rows).toEqual([{ type: "telegram.connected", payload: {} }]);
  });
});

describe("who may call", () => {
  it("refuses n8n's endpoint without the token, or with a wrong one", async () => {
    const code = await startLink();
    expect((await relay(message(`/start ${code}`), null)).status).toBe(401);
    expect((await relay(message(`/start ${code}`), "Bearer wrong")).status).toBe(401);
    expect(await chatIdOf(USER_A.userId)).toBeNull();
  });

  it("rejects an update that isn't one", async () => {
    expect((await relay({ message: { chat: { id: "not a number" } } })).status).toBe(400);
  });
});

describe("disconnecting", () => {
  it("clears the chat and any live code, for this user only", async () => {
    await relay(message(`/start ${await startLink(USER_B.userId)}`, CHAT_B));
    await relay(message(`/start ${await startLink()}`));
    const unused = await startLink();
    const response = await linkHandlers().remove(jsonRequest("DELETE"));
    expect(response.status).toBe(204);
    expect(await chatIdOf(USER_A.userId)).toBeNull();
    expect(await chatIdOf(USER_B.userId)).toBe(String(CHAT_B));
    expect((await replyOf(await relay(message(`/start ${unused}`))))?.text).toContain("expired");
    expect(await asUser(USER_A.userId)((db) => getTelegramStatus(db))).toEqual({
      connected: false,
    });
  });
});
