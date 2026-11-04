import { randomBytes } from "node:crypto";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSecretBox } from "@/lib/crypto";
import { formatMoney } from "@/lib/format";
import { runAsUser, type Db } from "@/lib/db";
import { saveGmailConnection } from "@/lib/gmail-account";
import { maintenanceHandlers } from "@/lib/maintenance-handlers";
import { createPaypalClient } from "@/lib/paypal";
import { listOutbox } from "@/lib/outbox";
import { outboxHandlers } from "@/lib/outbox-handlers";
import { runScheduler } from "@/lib/scheduler";
import { senderHandler } from "@/lib/sender-handler";
import { runAsService } from "@/lib/service-db";
import { storedDraftSchema } from "@/lib/stored-draft";
import { recordMaintenanceCard } from "@/lib/maintenance-telegram";
import { telegramRun } from "@/lib/telegram-cards";
import { handleTelegramUpdate, type TelegramUpdate } from "@/lib/telegram-updates";
import type { TelegramOp } from "@/lib/telegram-card";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import { TEST_LAWS } from "../fixtures/statutes";
import {
  createFakeGmail,
  FAKE_GMAIL_ADDRESS,
  FAKE_REFRESH_TOKEN,
  type FakeGmail,
} from "../mocks/gmail";
import { createFakePaypal, type FakePaypal } from "../mocks/paypal";

// Maintenance and renewal reminders: real migrations and RLS (PGlite), PayPal and Gmail mocked by
// msw. No model is set up, so drafts come from the fixed template.

let handle: TestDatabase;
let fake: FakePaypal;
let gmail: FakeGmail;
const server = setupServer();
const box = createSecretBox(randomBytes(32));

const A = USER_A.userId;
const PROJECT = USER_A.rows.projects;
const TASK = USER_A.rows.maintenance_tasks;
const CHAT = 5150;
const OTHER_CHAT = 6160;
const CLIENT_EMAIL = "client-a@example.test";
const TOKEN = "t".repeat(64);
/** From the one money formatter, which puts a no-break space after the code. */
const COST = formatMoney(20_000, "USD");
/** A Wednesday, 15:00 UTC. The seeded task is due on 15 May 2027 unless a test moves it. */
const NOW = new Date("2026-12-23T15:00:00Z");
let clock = NOW;

const asA = <T>(work: (db: Db) => Promise<T>) => runAsUser(handle.db, A, work);
const paypal = () => createPaypalClient({ clientId: "id", clientSecret: "secret" });

const coreDeps = () => ({
  runAsUser:
    (userId: string) =>
    <T>(work: (db: Db) => Promise<T>) =>
      runAsUser(handle.db, userId, work),
  box: () => box,
  now: () => clock,
  laws: TEST_LAWS,
  paypal,
});

const handlers = () =>
  maintenanceHandlers({ ...coreDeps(), currentUser: () => A, runAsCurrent: asA });

const updateDeps = () => ({
  ...coreDeps(),
  runAsService: <T>(work: (db: Db) => Promise<T>) => runAsService(handle.db, work),
  outboxUrl: () => undefined,
});

const post = (body: unknown) =>
  new Request("http://127.0.0.1:3000/api/maintenance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const context = (id: string) => ({ params: Promise.resolve({ id }) });

const act = (body: unknown, id = TASK) => handlers().act(post(body), context(id));

const task = async () => {
  const { rows } = await handle.db.query<{
    next_due: string;
    last_done_on: string | null;
    snoozed_until: string | null;
    last_notice_on: string | null;
    notice_pending: boolean;
    telegram_message_id: string | null;
    telegram_stale_message_id: string | null;
    job_project_id: string | null;
    status: string;
  }>(
    `SELECT next_due::text, last_done_on::text, snoozed_until::text, last_notice_on::text,
       notice_pending, telegram_message_id::text, telegram_stale_message_id::text,
       job_project_id::text, status
     FROM public.maintenance_tasks WHERE id = $1`,
    [TASK],
  );
  const row = rows[0];
  if (!row) throw new Error("The task has gone.");
  return row;
};

const setTask = (sql: string, params: unknown[] = []) =>
  handle.db.query(`UPDATE public.maintenance_tasks SET ${sql} WHERE id = '${TASK}'`, params);

const headsUps = async () =>
  (
    await handle.db.query<{
      id: string;
      tier: string;
      approval_status: string;
      sent_at: Date | null;
      draft: unknown;
      telegram_message_id: string | null;
    }>(
      `SELECT id::text, tier, approval_status, sent_at, draft, telegram_message_id::text
       FROM public.reminders WHERE maintenance_task_id = $1 ORDER BY created_at`,
      [TASK],
    )
  ).rows;

const telegramOps = (): Promise<TelegramOp[]> =>
  runAsService(handle.db, (db) => telegramRun(db, clock, undefined));

const tap = (data: string, messageId = 900, chatId = CHAT): TelegramUpdate => ({
  callback_query: { id: "tap-1", data, message: { message_id: messageId, chat: { id: chatId } } },
});

const tapCard = (action: string, messageId = 900, chatId = CHAT) =>
  handleTelegramUpdate(updateDeps(), tap(`${action}:${TASK}`, messageId, chatId));

/** The card is on Telegram as message 900. */
const cardDelivered = async (messageId = 900) => {
  await setTask("notice_pending = true");
  await runAsService(handle.db, (db) => recordMaintenanceCard(db, TASK, messageId));
};

const scheduler = () => runScheduler({ ...updateDeps() });

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  await handle.db.query(
    `UPDATE public.users SET telegram_chat_id = ${String(CHAT)} WHERE id = '${A}'`,
  );
  await handle.db.query(`UPDATE public.retainers SET status = 'cancelled'`);
  await asA((db) =>
    saveGmailConnection(db, {
      userId: A,
      refreshToken: FAKE_REFRESH_TOKEN,
      email: FAKE_GMAIL_ADDRESS,
      box,
    }),
  );
  server.listen({ onUnhandledFrame: "error" });
}, 60_000);

afterAll(async () => {
  server.close();
  await handle.close();
});

beforeEach(async () => {
  clock = NOW;
  fake = createFakePaypal();
  gmail = createFakeGmail();
  server.resetHandlers(...fake.handlers, ...gmail.handlers);
  await handle.db.query("DELETE FROM public.reminders");
  await handle.db.query("DELETE FROM public.messages");
  await handle.db.query("DELETE FROM public.invoices");
  await handle.db.query(`DELETE FROM public.projects WHERE title LIKE '%(due %'`);
  await setTask(
    `next_due = '2027-05-15', repeat_months = 6, repeat_from = 'scheduled', est_cost_cents = 20000,
     lead_days = '{14,1}', snoozed_until = NULL, last_notice_on = NULL, last_done_on = NULL,
     notice_pending = false, telegram_message_id = NULL, telegram_card_sent_at = NULL,
     telegram_stale_message_id = NULL, job_project_id = NULL, job_due_on = NULL,
     status = 'active', gmail_thread_id = NULL, gmail_thread_subject = NULL`,
  );
});

describe("creating a task", () => {
  const FIELDS = {
    projectId: PROJECT,
    type: "renewal",
    task: "Domain renewal",
    repeatMonths: 12,
    nextDue: "2027-03-01",
    estCostCents: 1500,
    currency: "USD",
  };

  it("defaults to reminders 14 days and 1 day before", async () => {
    const response = await handlers().create(post(FIELDS));
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const { rows } = await handle.db.query<{ lead_days: number[] }>(
      "SELECT lead_days FROM public.maintenance_tasks WHERE id = $1",
      [id],
    );
    expect(rows[0]?.lead_days).toEqual([14, 1]);
    await handle.db.query("DELETE FROM public.maintenance_tasks WHERE id = $1", [id]);
  });

  it.each([
    ["another freelancer's project", { projectId: USER_B.rows.projects }, "projectId"],
    ["no repeat", { repeatMonths: 0 }, "repeatMonths"],
    ["a cost in a float", { estCostCents: 1.5 }, "estCostCents"],
    ["an unknown currency", { currency: "XXX" }, "currency"],
    ["a negative lead time", { leadDays: [-1] }, "leadDays.0"],
  ])("refuses %s", async (_label, overrides, field) => {
    const response = await handlers().create(post({ ...FIELDS, ...overrides }));
    expect(response.status).toBe(400);
    const { errors } = (await response.json()) as { errors: { field: string }[] };
    expect(errors.map((error) => error.field)).toContain(field);
  });
});

describe("the freelancer's reminders", () => {
  it("nothing is due before the first lead day", async () => {
    await setTask("next_due = '2027-01-07'");
    clock = new Date("2026-12-23T15:00:00Z");
    expect((await scheduler()).noticed).toBe(0);
  });

  it("sends a card at the lead day, once, with all four buttons and the cost from the database", async () => {
    await setTask("next_due = '2027-01-06'");
    expect((await scheduler()).noticed).toBe(1);
    const ops = await telegramOps();
    const card = ops.find((op) => op.op === "sendMaintenance");
    expect(card).toMatchObject({
      chatId: CHAT,
      taskId: TASK,
      data: {
        tell: `mt:${TASK}`,
        invoice: `mi:${TASK}`,
        snooze: `ms:${TASK}`,
        done: `md:${TASK}`,
      },
    });
    expect(card && "text" in card ? card.text : "").toContain(COST);
    expect(card && "text" in card ? card.text : "").toContain("6 Jan 2027");
    expect((await scheduler()).noticed).toBe(0);
    expect((await telegramOps()).filter((op) => op.op === "sendMaintenance")).toEqual([]);
  });

  it("the next lead day replaces the card, closing the old one", async () => {
    await setTask("next_due = '2027-01-06'");
    await scheduler();
    await telegramOps();
    await runAsService(handle.db, (db) => recordMaintenanceCard(db, TASK, 900));
    clock = new Date("2027-01-05T15:00:00Z");
    expect((await scheduler()).noticed).toBe(1);
    const ops = await telegramOps();
    expect(ops).toContainEqual({
      op: "editText",
      chatId: CHAT,
      messageId: 900,
      text: "Replaced by the new draft below.",
    });
    expect(ops.some((op) => op.op === "sendMaintenance")).toBe(true);
  });

  it("hands a card over again only if Telegram never confirmed it", async () => {
    await setTask("next_due = '2027-01-06'");
    await scheduler();
    await telegramOps();
    expect((await telegramOps()).filter((op) => op.op === "sendMaintenance")).toEqual([]);
    clock = new Date(NOW.getTime() + 11 * 60 * 1000);
    expect((await telegramOps()).filter((op) => op.op === "sendMaintenance")).toHaveLength(1);
  });
});

describe("Telegram buttons", () => {
  beforeEach(async () => {
    await cardDelivered();
  });

  it.each(["mt", "mi", "ms", "md"])("%s is ignored from another chat", async (action) => {
    const before = await task();
    expect(await tapCard(action, 900, OTHER_CHAT)).toEqual([]);
    expect(await task()).toEqual(before);
    expect(await headsUps()).toEqual([]);
    expect(fake.invoices.size).toBe(0);
  });

  it.each(["mt", "mi", "ms", "md"])("%s does nothing on an old card", async (action) => {
    const before = await task();
    const ops = await tapCard(action, 111);
    expect(ops).toContainEqual(expect.objectContaining({ op: "editText", messageId: 111 }));
    expect(await task()).toEqual(before);
    expect(await headsUps()).toEqual([]);
  });

  it("Tell the client makes a draft for approval, and sends nothing", async () => {
    const ops = await tapCard("mt");
    const [headsUp] = await headsUps();
    expect(headsUp).toMatchObject({
      tier: "maintenance",
      approval_status: "waiting",
      sent_at: null,
    });
    const draft = storedDraftSchema.parse(headsUp?.draft);
    expect(draft.kind).toBe("maintenance");
    expect(draft.body).toContain("15 May 2027");
    expect(draft.body).toContain(COST);
    expect(ops.some((op) => op.op === "sendCard")).toBe(true);
    expect(gmail.state.sent).toEqual([]);
  });

  it("Tell the client twice keeps one draft", async () => {
    await tapCard("mt");
    const ops = await tapCard("mt");
    expect(await headsUps()).toHaveLength(1);
    expect(ops).toEqual([
      expect.objectContaining({ op: "answer", text: expect.stringContaining("already") as string }),
    ]);
  });

  it("Create invoice uses the invoice flow in the sandbox, with the amount from the database, and emails nobody", async () => {
    const ops = await tapCard("mi");
    const [invoice] = [...fake.invoices.values()];
    expect(invoice?.status).toBe("UNPAID");
    expect(JSON.stringify(invoice?.body)).toContain('"value":"200.00"');
    const send = fake.calls.find((call) => call.path.endsWith("/send"));
    expect(JSON.parse(send?.body ?? "{}")).toMatchObject({ send_to_recipient: false });
    expect(ops.some((op) => op.op === "sendText" && op.text.includes(COST))).toBe(true);
    expect(gmail.state.sent).toEqual([]);
  });

  it("Create invoice twice keeps one invoice", async () => {
    await tapCard("mi");
    await tapCard("mi");
    expect(fake.invoices.size).toBe(1);
  });

  it("Create invoice leaves the original project's total alone", async () => {
    await tapCard("mi");
    const { rows } = await handle.db.query<{ total_cents: string }>(
      "SELECT total_cents::text FROM public.projects WHERE id = $1",
      [PROJECT],
    );
    expect(rows[0]?.total_cents).toBe("300000");
  });

  it("Create invoice with no estimate asks for one", async () => {
    await setTask("est_cost_cents = NULL");
    const ops = await tapCard("mi");
    expect(ops).toEqual([
      expect.objectContaining({
        op: "answer",
        text: expect.stringContaining("no estimated") as string,
      }),
    ]);
    expect(fake.invoices.size).toBe(0);
  });

  it("Snooze waits, closes the card, and reminds again afterwards", async () => {
    await setTask("next_due = '2027-01-06'");
    const ops = await tapCard("ms");
    expect(ops).toContainEqual(
      expect.objectContaining({
        op: "editText",
        text: expect.stringContaining("Snoozed until") as string,
      }),
    );
    expect(await task()).toMatchObject({
      snoozed_until: "2026-12-30",
      telegram_message_id: null,
      telegram_stale_message_id: null,
    });
    await setTask("last_notice_on = '2026-12-23'");
    expect((await scheduler()).noticed).toBe(0);
    clock = new Date("2026-12-30T15:00:00Z");
    expect((await scheduler()).noticed).toBe(1);
  });

  it("Mark done sets the next date from the scheduled date", async () => {
    const ops = await tapCard("md");
    expect((await task()).next_due).toBe("2027-11-15");
    expect((await task()).last_done_on).toBe("2026-12-23");
    expect(ops).toContainEqual(
      expect.objectContaining({
        op: "editText",
        text: expect.stringContaining("15 Nov 2027") as string,
      }),
    );
  });

  it("Mark done sets the next date from the done date, per the setting", async () => {
    await setTask("repeat_from = 'done'");
    await tapCard("md");
    expect((await task()).next_due).toBe("2027-06-23");
  });

  it("Mark done twice moves the date once: the second tap finds the card closed", async () => {
    await tapCard("md");
    await tapCard("md");
    expect((await task()).next_due).toBe("2027-11-15");
  });

  it("Mark done stops a heads-up still waiting, as its date is now wrong", async () => {
    await tapCard("mt");
    await tapCard("md");
    expect((await headsUps())[0]?.approval_status).toBe("skipped");
  });

  it("no button's text can reach a model or change an amount: only fixed data is read", async () => {
    const before = await task();
    const ops = await handleTelegramUpdate(updateDeps(), tap(`md:${TASK}:amount=1`));
    expect(ops).toEqual([expect.objectContaining({ op: "answer" })]);
    expect(await task()).toEqual(before);
  });
});

describe("the heads-up's approval", () => {
  const send = () =>
    senderHandler({
      ...updateDeps(),
      oauth: () => ({ clientId: "id", clientSecret: "secret", redirectUri: "http://x" }),
      token: () => TOKEN,
      allowlist: () => new Set([CLIENT_EMAIL]),
      pdf: () => Promise.reject(new Error("A heads-up has no PDF.")),
    }).post(
      new Request("http://127.0.0.1:3000/api/internal/sender/run", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: "{}",
      }),
    );

  const outbox = (id: string, body: unknown) =>
    outboxHandlers({ runAsUser: asA, now: () => clock, laws: TEST_LAWS }).post(
      post(body),
      context(id),
    );

  const makeDraft = async () => {
    const response = await act({ action: "tell" });
    expect(response.status).toBe(200);
    const [headsUp] = await headsUps();
    if (!headsUp) throw new Error("No draft.");
    return headsUp;
  };

  it("sits in the Outbox's Waiting tab, with the estimate and no pay link", async () => {
    const { id } = await makeDraft();
    const items = await asA((db) => listOutbox(db, "waiting", clock));
    expect(items).toContainEqual(
      expect.objectContaining({
        id,
        tier: "maintenance",
        amountDue: `Estimate ${COST}`,
        payLink: null,
        clientName: "Client a",
      }),
    );
  });

  it("isn't sent until it's approved", async () => {
    await makeDraft();
    await send();
    expect(gmail.state.sent).toEqual([]);
  });

  it("goes out after approval, with no attachment, and is recorded", async () => {
    const { id } = await makeDraft();
    expect((await outbox(id, { action: "approve" })).status).toBe(200);
    await send();
    expect(gmail.state.sent).toHaveLength(1);
    const [row] = await headsUps();
    expect(row?.sent_at).not.toBeNull();
    const raw = Buffer.from(gmail.state.sent[0]?.raw ?? "", "base64url").toString("utf8");
    expect(raw).not.toContain("application/pdf");
    const { rows } = await handle.db.query<{ maintenance_task_id: string; invoice_id: null }>(
      "SELECT maintenance_task_id::text, invoice_id FROM public.messages",
    );
    expect(rows).toEqual([{ maintenance_task_id: TASK, invoice_id: null }]);
  });

  it("is refused for an address not on the allowlist", async () => {
    const { id } = await makeDraft();
    await outbox(id, { action: "approve" });
    await senderHandler({
      ...updateDeps(),
      oauth: () => ({ clientId: "id", clientSecret: "secret", redirectUri: "http://x" }),
      token: () => TOKEN,
      allowlist: () => new Set<string>(),
      pdf: () => Promise.reject(new Error("A heads-up has no PDF.")),
    }).post(
      new Request("http://127.0.0.1:3000/api/internal/sender/run", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: "{}",
      }),
    );
    expect(gmail.state.sent).toEqual([]);
  });

  it("stops if the job has moved since the draft was approved", async () => {
    const { id } = await makeDraft();
    await outbox(id, { action: "approve" });
    await setTask("next_due = '2027-07-01'");
    await send();
    expect(gmail.state.sent).toEqual([]);
    expect((await headsUps())[0]?.approval_status).toBe("skipped");
  });

  it("an edit that invents an amount or adds a link isn't saved", async () => {
    const { id } = await makeDraft();
    for (const body of ["It will cost USD 999.00 now.", "Details: https://example.test/x"]) {
      const response = await outbox(id, { action: "edit", subject: "Heads-up", body });
      expect(response.status).toBe(400);
    }
  });

  it("can be skipped from the Outbox", async () => {
    const { id } = await makeDraft();
    expect((await outbox(id, { action: "skip" })).status).toBe(200);
    expect((await headsUps())[0]?.approval_status).toBe("skipped");
  });

  it("is written by the scheduler if the first attempt never finished", async () => {
    await handle.db.query(
      `INSERT INTO public.reminders (user_id, maintenance_task_id, maintenance_due_on, tier, scheduled_at)
       VALUES ($1, $2, '2027-05-15', 'maintenance', $3)`,
      [A, TASK, clock.toISOString()],
    );
    await scheduler();
    expect(storedDraftSchema.parse((await headsUps())[0]?.draft).kind).toBe("maintenance");
  });
});

describe("the dashboard's buttons", () => {
  it("Mark done moves the date, closes any Telegram card, and a double click is refused", async () => {
    await cardDelivered();
    const response = await act({ action: "done", expectedDue: "2027-05-15" });
    expect(response.status).toBe(200);
    expect(await task()).toMatchObject({
      next_due: "2027-11-15",
      telegram_message_id: null,
      telegram_stale_message_id: "900",
    });
    const again = await act({ action: "done", expectedDue: "2027-05-15" });
    expect(again.status).toBe(409);
    expect((await task()).next_due).toBe("2027-11-15");
    expect(await telegramOps()).toContainEqual({
      op: "editText",
      chatId: CHAT,
      messageId: 900,
      text: "Already handled in dashboard",
    });
  });

  it("Reschedule sets a new date and starts the reminders over", async () => {
    await setTask("last_notice_on = '2026-12-01'");
    expect((await act({ action: "reschedule", nextDue: "2027-02-01" })).status).toBe(200);
    expect(await task()).toMatchObject({ next_due: "2027-02-01", last_notice_on: null });
  });

  it("Reschedule refuses a past date", async () => {
    expect((await act({ action: "reschedule", nextDue: "2026-12-01" })).status).toBe(400);
  });

  it("Create invoice can take a deposit, as installment 1", async () => {
    const response = await act({ action: "invoice", depositCents: 5000 });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      invoices: { amountCents: number; installment: { number: number; count: number } }[];
    };
    expect(body.invoices).toMatchObject([
      { amountCents: 5000, installment: { number: 1, count: 2 } },
    ]);
  });

  it("Stop ends the reminders", async () => {
    await setTask("next_due = '2027-01-06'");
    expect((await act({ action: "stop" })).status).toBe(200);
    expect((await scheduler()).noticed).toBe(0);
  });

  it("another freelancer can't act on this task", async () => {
    const other = maintenanceHandlers({
      ...coreDeps(),
      currentUser: () => USER_B.userId,
      runAsCurrent: (work) => runAsUser(handle.db, USER_B.userId, work),
    });
    const before = await task();
    for (const body of [
      { action: "tell" },
      { action: "snooze" },
      { action: "done", expectedDue: "2027-05-15" },
      { action: "invoice" },
    ]) {
      expect((await other.act(post(body), context(TASK))).status).toBe(404);
    }
    expect(await task()).toEqual(before);
    expect(await headsUps()).toEqual([]);
  });
});
