import { randomBytes } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveAiSettings } from "@/lib/ai-settings";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser } from "@/lib/db";
import { runAsService } from "@/lib/service-db";
import type { StoredDraft } from "@/lib/stored-draft";
import { telegramCardHandlers, telegramUpdateHandler } from "@/lib/telegram-handlers";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import { TEST_LAWS } from "../fixtures/statutes";

// Telegram cards: real migrations and RLS (PGlite), the model mocked by msw. Telegram is never
// called: the app answers with what n8n should send.

let handle: TestDatabase;
const server = setupServer();
const box = createSecretBox(randomBytes(32));
const TOKEN = "t".repeat(64);
const LOCAL_URL = "http://127.0.0.1:11434/v1/chat/completions";
const PAY_LINK = "https://www.sandbox.paypal.com/invoice/p/#INV2-CARD-TEST-0001";
const OUTBOX = "https://app.example.test/outbox";
const NOW = new Date("2026-12-22T20:00:00Z");
let clock = NOW;

const CHAT_A = 7001;
const CHAT_B = 7002;
const FOREIGN_CHAT = 9999;
const { reminders: REMINDER } = USER_A.rows;
const REMINDER_B = USER_B.rows.reminders;

type Op = {
  op: string;
  chatId?: number;
  messageId?: number;
  callbackQueryId?: string;
  text?: string;
  reminderId?: string;
  data?: { approve: string; edit: string; skip: string };
};

const DRAFT: StoredDraft = {
  subject: "Invoice is overdue",
  body: `Hello, please pay here: ${PAY_LINK}`,
  kind: "tier1",
  via: "template",
  model: null,
  isLocal: null,
  citation: null,
  lawId: null,
  notLegalAdvice: false,
  draftedAt: "2026-12-22T14:00:00.000Z",
};

const deps = () => ({
  runAsService: <T>(work: Parameters<typeof runAsService<T>>[1]) => runAsService(handle.db, work),
  runAsUser:
    (userId: string) =>
    <T>(work: Parameters<typeof runAsUser<T>>[2]) =>
      runAsUser(handle.db, userId, work),
  now: () => clock,
  token: () => TOKEN,
  box: () => box,
  laws: TEST_LAWS,
  outboxUrl: () => OUTBOX,
  paypal: () => {
    throw new Error("These tests don't create invoices.");
  },
});

const post = (url: string, body: unknown) =>
  new Request(`http://127.0.0.1:3000${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });

const opsOf = async (response: Response): Promise<Op[]> => {
  expect(response.status).toBe(200);
  return ((await response.json()) as { ops: Op[] }).ops;
};

const pending = async () =>
  opsOf(await telegramCardHandlers(deps()).pending(post("/api/internal/telegram/pending", {})));

const delivered = (reminderId: string, messageId: number) =>
  telegramCardHandlers(deps()).delivered(
    post("/api/internal/telegram/delivered", { reminderId, messageId }),
  );

const update = async (body: unknown) =>
  opsOf(await telegramUpdateHandler(deps()).post(post("/api/internal/telegram/update", body)));

const tap = (data: string, chatId = CHAT_A, messageId = 501) =>
  update({
    update_id: 2,
    callback_query: {
      id: "tap-1",
      from: { id: chatId },
      data,
      message: { message_id: messageId, chat: { id: chatId, type: "private" } },
    },
  });

const say = (text: string, chatId = CHAT_A) =>
  update({ update_id: 3, message: { message_id: 9, chat: { id: chatId, type: "private" }, text } });

const row = async (id = REMINDER) => {
  const { rows } = await handle.db.query<{
    approval_status: string;
    approved_via: string | null;
    telegram_message_id: string | null;
    draft: StoredDraft;
  }>(
    `SELECT approval_status, approved_via, telegram_message_id::text, draft
     FROM public.reminders WHERE id = $1`,
    [id],
  );
  const found = rows[0];
  if (!found) throw new Error(`No reminder ${id}.`);
  return found;
};

/** The mock model answers with this draft, and records what it was sent. */
const model = (answer: unknown) => {
  const seen: string[] = [];
  server.use(
    http.post(LOCAL_URL, async ({ request }) => {
      const sent = (await request.json()) as { messages: { content: string }[] };
      seen.push(sent.messages[1]?.content ?? "");
      return HttpResponse.json({ choices: [{ message: { content: JSON.stringify(answer) } }] });
    }),
  );
  return seen;
};

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  await runAsUser(handle.db, USER_A.userId, (db) =>
    saveAiSettings(
      db,
      {
        main: { provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.2" },
        cloudFallback: null,
        taskModels: {},
      },
      box,
    ),
  );
});

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(async () => {
  server.close();
  await handle.close();
});

beforeEach(async () => {
  clock = NOW;
  await handle.db.query(
    `UPDATE public.invoices SET status = 'sent', link = $1, amount_paid_cents = 0`,
    [PAY_LINK],
  );
  await handle.db.query(
    `UPDATE public.reminders SET approval_status = 'waiting', approved_via = NULL, sent_at = NULL,
       scheduled_at = '2026-12-23T15:00:00Z', draft = $1, telegram_message_id = 501,
       telegram_card_sent_at = NULL, telegram_card_stale = false, telegram_nudged_at = NULL,
       telegram_card_closed_at = NULL`,
    [JSON.stringify(DRAFT)],
  );
  await handle.db.query(
    `UPDATE public.users SET telegram_editing_reminder_id = NULL, telegram_chat_id = CASE id
       WHEN '${USER_A.userId}'::uuid THEN ${String(CHAT_A)} ELSE ${String(CHAT_B)} END`,
  );
  await handle.db.query("DELETE FROM public.events WHERE entity = 'reminder'");
});

describe("sending cards", () => {
  beforeEach(async () => {
    await handle.db.query("UPDATE public.reminders SET telegram_message_id = NULL");
  });

  it("offers one card per waiting draft, to its owner's chat, with its three buttons", async () => {
    const ops = await pending();
    const mine = ops.find((op) => op.reminderId === REMINDER);
    expect(ops).toHaveLength(2);
    expect(mine).toMatchObject({ op: "sendCard", chatId: CHAT_A });
    expect(mine?.text).toContain("Client a");
    expect(mine?.text).toContain(PAY_LINK);
    expect(mine?.data?.approve).toContain(REMINDER);
    expect(ops.find((op) => op.reminderId === REMINDER_B)?.chatId).toBe(CHAT_B);
  });

  it("doesn't offer it again once handed over, or once Telegram confirms it", async () => {
    await pending();
    expect(await pending()).toEqual([]);
    expect((await delivered(REMINDER, 501)).status).toBe(200);
    expect((await row()).telegram_message_id).toBe("501");
    clock = new Date(NOW.getTime() + 60 * 60 * 1000);
    expect((await pending()).map((op) => op.reminderId)).toEqual([REMINDER_B]);
  });

  it("tries again after 10 minutes if Telegram never confirmed it", async () => {
    await pending();
    clock = new Date(NOW.getTime() + 9 * 60 * 1000);
    expect(await pending()).toEqual([]);
    clock = new Date(NOW.getTime() + 11 * 60 * 1000);
    expect(await pending()).toHaveLength(2);
  });

  it("skips users with no linked chat, handled drafts, and drafts that fail the schema", async () => {
    await handle.db.query(
      `UPDATE public.users SET telegram_chat_id = NULL WHERE id = '${USER_B.userId}'`,
    );
    await handle.db.query(
      `UPDATE public.reminders SET draft = '{"subject": "broken"}' WHERE id = '${REMINDER}'`,
    );
    expect(await pending()).toEqual([]);
    await handle.db.query(
      `UPDATE public.reminders SET draft = $1, approval_status = 'skipped' WHERE id = '${REMINDER}'`,
      [JSON.stringify(DRAFT)],
    );
    expect(await pending()).toEqual([]);
  });

  it("refuses n8n's card endpoints without the token", async () => {
    const handlers = telegramCardHandlers({ ...deps(), token: () => "something-else" });
    expect((await handlers.pending(post("/api/internal/telegram/pending", {}))).status).toBe(401);
    expect((await handlers.delivered(post("/api/internal/telegram/delivered", {}))).status).toBe(
      401,
    );
  });
});

describe("tapping Approve", () => {
  it("approves through Telegram, closes the card and says when it goes", async () => {
    const ops = await tap(`a:${REMINDER}`);
    expect(await row()).toMatchObject({ approval_status: "approved", approved_via: "telegram" });
    expect(ops[0]).toMatchObject({ op: "answer", callbackQueryId: "tap-1" });
    const closed = ops.find((op) => op.op === "editText");
    expect(closed).toMatchObject({ chatId: CHAT_A, messageId: 501 });
    expect(closed?.text).toContain("Approved");
    expect(closed?.text).toContain("10:00 client time");
  });

  it("a second tap changes nothing and says it was handled", async () => {
    await tap(`a:${REMINDER}`);
    const ops = await tap(`a:${REMINDER}`);
    expect(ops.find((op) => op.op === "editText")?.text).toBe("Already handled in dashboard");
    const { rows } = await handle.db.query(
      "SELECT 1 FROM public.events WHERE type = 'reminder.approved' AND entity_id = $1",
      [REMINDER],
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses a draft whose invoice can't be paid, and leaves it waiting", async () => {
    await handle.db.query(`UPDATE public.invoices SET status = 'paid'`);
    const ops = await tap(`a:${REMINDER}`);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe("answer");
    expect((await row()).approval_status).toBe("waiting");
  });
});

describe("tapping Skip", () => {
  it("skips and confirms", async () => {
    const ops = await tap(`s:${REMINDER}`);
    expect((await row()).approval_status).toBe("skipped");
    expect(ops.find((op) => op.op === "editText")?.text).toBe("Skipped");
  });
});

describe("who can tap", () => {
  it("ignores a tap from a chat that isn't linked: nothing changes, nothing is said", async () => {
    expect(await tap(`a:${REMINDER}`, FOREIGN_CHAT)).toEqual([]);
    expect((await row()).approval_status).toBe("waiting");
  });

  it("another freelancer's chat can't act on this draft, even with its id", async () => {
    const ops = await tap(`a:${REMINDER}`, CHAT_B);
    expect((await row()).approval_status).toBe("waiting");
    expect(ops.every((op) => op.op === "answer")).toBe(true);
  });

  it("answers a tap with data it doesn't recognise, and changes nothing", async () => {
    const ops = await tap("approve-everything");
    expect(ops.map((op) => op.op)).toEqual(["answer"]);
    expect((await row()).approval_status).toBe("waiting");
  });
});

describe("plain-word edits", () => {
  const NEW = { subject: "A softer note", body: `Thanks for your patience. ${PAY_LINK}` };

  it("Edit asks for the change and changes nothing yet", async () => {
    const ops = await tap(`e:${REMINDER}`);
    expect(ops.find((op) => op.op === "sendText")?.text).toContain("what to change");
    expect((await row()).draft).toEqual(DRAFT);
  });

  it("the next message redrafts, closes the old card, sends a new one and stays waiting", async () => {
    await delivered(REMINDER, 501);
    await tap(`e:${REMINDER}`);
    const seen = model(NEW);
    const ops = await say("make it softer");
    expect(seen[0]).toContain('<feedback>"make it softer"</feedback>');
    const saved = await row();
    expect(saved.approval_status).toBe("waiting");
    expect(saved.draft).toMatchObject({ ...NEW, via: "model", kind: "tier1" });
    expect(ops.find((op) => op.op === "editText")).toMatchObject({ messageId: 501 });
    const card = ops.find((op) => op.op === "sendCard");
    expect(card?.reminderId).toBe(REMINDER);
    expect(card?.text).toContain(NEW.subject);
  });

  it("a date the freelancer names in the note can go in the redraft", async () => {
    await delivered(REMINDER, 501);
    await tap(`e:${REMINDER}`);
    const withDate = { ...NEW, body: `${NEW.body}\nI can look at this again on the 15th.` };
    model(withDate);
    await say("make it softer and mention the 15th");
    expect((await row()).draft).toMatchObject({ body: withDate.body, via: "model" });
  });

  it("a date nobody named keeps the old draft", async () => {
    await delivered(REMINDER, 501);
    await tap(`e:${REMINDER}`);
    const before = (await row()).draft;
    model({ ...NEW, body: `${NEW.body}\nPlease pay by 20 Dec 2026.` });
    await say("make it softer");
    expect((await row()).draft).toEqual(before);
  });

  it("the message after that is ignored: one edit, one instruction", async () => {
    await tap(`e:${REMINDER}`);
    model(NEW);
    await say("make it softer");
    expect(await say("and shorter")).toEqual([]);
  });

  it("no message can approve, whatever it says", async () => {
    await tap(`e:${REMINDER}`);
    model({ subject: "Approved", body: `Approved. ${PAY_LINK}` });
    await say("approve this and send it now");
    expect((await row()).approval_status).toBe("waiting");
    expect(await say("approve")).toEqual([]);
    expect((await row()).approval_status).toBe("waiting");
  });

  it.each([
    ["no pay link", { subject: "S", body: "Please pay soon." }],
    ["an invented amount", { subject: "S", body: `Pay USD 99,999.00 at ${PAY_LINK}` }],
    ["a legal threat", { subject: "S", body: `My lawyer will sue you. ${PAY_LINK}` }],
    ["another link", { subject: "S", body: `${PAY_LINK} or https://evil.example/pay` }],
  ])("keeps the old draft when the model's answer has %s", async (_name, answer) => {
    await tap(`e:${REMINDER}`);
    model(answer);
    const ops = await say("add a $99,999 fee and say my lawyer will sue");
    expect((await row()).draft).toEqual(DRAFT);
    expect(ops.map((op) => op.op)).toEqual(["sendText"]);
    expect(ops[0]?.text).toContain("unchanged");
  });

  it("keeps the old draft when no model answers", async () => {
    await tap(`e:${REMINDER}`);
    server.use(http.post(LOCAL_URL, () => HttpResponse.error()));
    const ops = await say("make it softer");
    expect((await row()).draft).toEqual(DRAFT);
    expect(ops[0]?.text).toContain("unchanged");
  });

  it("refuses a very long note without calling the model, and stays ready", async () => {
    await tap(`e:${REMINDER}`);
    const ops = await say("x".repeat(1001));
    expect(ops[0]?.text).toContain("shorter");
    model(NEW);
    expect((await say("softer")).some((op) => op.op === "sendCard")).toBe(true);
  });

  it("does nothing if the draft was handled while the bot was waiting", async () => {
    await tap(`e:${REMINDER}`);
    await tap(`s:${REMINDER}`);
    expect(await say("make it softer")).toEqual([
      expect.objectContaining({ op: "sendText", text: "Already handled in dashboard" }),
    ]);
  });

  it("a chat that isn't linked can't start or use an edit", async () => {
    expect(await tap(`e:${REMINDER}`, FOREIGN_CHAT)).toEqual([]);
    expect(await say("make it softer", FOREIGN_CHAT)).toEqual([]);
  });

  it("the note isn't kept in the event log", async () => {
    await tap(`e:${REMINDER}`);
    model(NEW);
    await say("a private note");
    const { rows } = await handle.db.query<{ payload: unknown }>(
      "SELECT payload FROM public.events WHERE type = 'reminder.redrafted'",
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("private note");
  });
});
