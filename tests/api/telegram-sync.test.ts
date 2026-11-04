import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser, type Db } from "@/lib/db";
import { listOutbox } from "@/lib/outbox";
import { outboxHandlers } from "@/lib/outbox-handlers";
import { runAsService } from "@/lib/service-db";
import type { StoredDraft } from "@/lib/stored-draft";
import { telegramCardHandlers, telegramUpdateHandler } from "@/lib/telegram-handlers";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import { TEST_LAWS } from "../fixtures/statutes";

// The Outbox and Telegram staying in step: real migrations and RLS (PGlite). No network.

let handle: TestDatabase;
const box = createSecretBox(randomBytes(32));
const TOKEN = "t".repeat(64);
const PAY_LINK = "https://www.sandbox.paypal.com/invoice/p/#INV2-SYNC-TEST-0001";
const NOW = new Date("2026-12-22T20:00:00Z");
const HOUR = 60 * 60 * 1000;
let clock = NOW;

const CHAT_A = 7001;
const CHAT_B = 7002;
const FOREIGN_CHAT = 9999;
const MESSAGE = 501;
const { reminders: REMINDER } = USER_A.rows;

type Op = { op: string; chatId?: number; messageId?: number; text?: string; reminderId?: string };

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

const asUserA = <T>(work: (db: Db) => Promise<T>): Promise<T> =>
  runAsUser(handle.db, USER_A.userId, work);

const deps = () => ({
  runAsService: <T>(work: (db: Db) => Promise<T>) => runAsService(handle.db, work),
  runAsUser:
    (userId: string) =>
    <T>(work: (db: Db) => Promise<T>) =>
      runAsUser(handle.db, userId, work),
  now: () => clock,
  token: () => TOKEN,
  box: () => box,
  laws: TEST_LAWS,
  outboxUrl: () => undefined,
});

const internal = (url: string, body: unknown) =>
  new Request(`http://127.0.0.1:3000${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });

const opsOf = async (response: Response): Promise<Op[]> => {
  expect(response.status).toBe(200);
  return ((await response.json()) as { ops: Op[] }).ops;
};

/** n8n's one-minute run, for user A's draft only (user B's has no card or chat here). */
const run = async () =>
  opsOf(await telegramCardHandlers(deps()).pending(internal("/api/internal/telegram/pending", {})));

const tap = async (data: string, chatId = CHAT_A, messageId = MESSAGE) =>
  opsOf(
    await telegramUpdateHandler(deps()).post(
      internal("/api/internal/telegram/update", {
        update_id: 1,
        callback_query: {
          id: "tap-1",
          data,
          message: { message_id: messageId, chat: { id: chatId, type: "private" } },
        },
      }),
    ),
  );

const outbox = (payload: unknown) =>
  outboxHandlers({ runAsUser: asUserA, now: () => clock, laws: TEST_LAWS }).post(
    new Request(`http://127.0.0.1:3000/api/outbox/${REMINDER}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ id: REMINDER }) },
  );

const row = async () => {
  const { rows } = await handle.db.query<{
    approval_status: string;
    approved_via: string | null;
    sent_at: unknown;
    telegram_message_id: string | null;
  }>(
    `SELECT approval_status, approved_via, sent_at, telegram_message_id::text
     FROM public.reminders WHERE id = $1`,
    [REMINDER],
  );
  const found = rows[0];
  if (!found) throw new Error("The test reminder is missing.");
  return found;
};

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  await handle.db.query(`UPDATE public.invoices SET status = 'sent', link = $1`, [PAY_LINK]);
}, 60_000);

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  clock = NOW;
  await handle.db.query(`UPDATE public.invoices SET status = 'sent', amount_paid_cents = 0`);
  await handle.db.query(`DELETE FROM public.reminders WHERE id <> '${REMINDER}'`);
  await handle.db.query(
    `UPDATE public.reminders SET approval_status = 'waiting', approved_via = NULL, sent_at = NULL,
       scheduled_at = '2026-12-23T15:00:00Z', draft = $1, telegram_message_id = ${String(MESSAGE)},
       telegram_card_sent_at = $2, telegram_card_closed_at = NULL, telegram_card_stale = false,
       telegram_nudged_at = NULL`,
    [JSON.stringify(DRAFT), NOW.toISOString()],
  );
  await handle.db.query(
    `UPDATE public.users SET telegram_editing_reminder_id = NULL, default_settings = '{}',
       telegram_chat_id = CASE id WHEN '${USER_A.userId}'::uuid THEN ${String(CHAT_A)}
                                  ELSE ${String(CHAT_B)} END`,
  );
  await handle.db.query("DELETE FROM public.events WHERE entity = 'reminder'");
});

describe("approved in the Outbox", () => {
  it("the card changes to say so, once, and its buttons stop working", async () => {
    expect((await outbox({ action: "approve" })).status).toBe(200);
    expect(await run()).toEqual([
      {
        op: "editText",
        chatId: CHAT_A,
        messageId: MESSAGE,
        text: "Already handled in dashboard",
      },
    ]);
    expect(await run()).toEqual([]);
    const ops = await tap(`a:${REMINDER}`);
    expect(ops.find((op) => op.op === "editText")?.text).toBe("Already handled in dashboard");
    expect(await row()).toMatchObject({ approval_status: "approved", approved_via: "outbox" });
  });

  it("a skip in the Outbox expires the card too, and a tap can't bring it back", async () => {
    await outbox({ action: "skip" });
    expect((await run()).map((op) => op.text)).toEqual(["Already handled in dashboard"]);
    await tap(`a:${REMINDER}`);
    expect((await row()).approval_status).toBe("skipped");
  });

  it("a payment that stopped the draft expires the card as well", async () => {
    await handle.db.query(
      `UPDATE public.reminders SET approval_status = 'skipped' WHERE id = '${REMINDER}'`,
    );
    expect((await run()).map((op) => op.op)).toEqual(["editText"]);
  });
});

describe("approved in Telegram", () => {
  it("the Outbox shows it as scheduled, and refuses to act on it as waiting", async () => {
    await tap(`a:${REMINDER}`);
    expect(await asUserA((db) => listOutbox(db, "waiting", clock))).toEqual([]);
    const [item] = await asUserA((db) => listOutbox(db, "scheduled", clock));
    expect(item).toMatchObject({ id: REMINDER, approvedVia: "telegram" });
    const again = await outbox({ action: "approve" });
    expect(again.status).toBe(409);
    expect(await row()).toMatchObject({ approval_status: "approved", approved_via: "telegram" });
  });

  it("the card isn't edited a second time by the next run", async () => {
    await tap(`a:${REMINDER}`);
    expect(await run()).toEqual([]);
  });
});

describe("double approve", () => {
  it("counts only once across both places", async () => {
    await outbox({ action: "approve" });
    await tap(`a:${REMINDER}`);
    await tap(`a:${REMINDER}`);
    expect((await outbox({ action: "approve" })).status).toBe(409);
    const { rows } = await handle.db.query(
      "SELECT 1 FROM public.events WHERE type = 'reminder.approved' AND entity_id = $1",
      [REMINDER],
    );
    expect(rows).toHaveLength(1);
    expect((await row()).approved_via).toBe("outbox");
  });
});

describe("foreign chat ID", () => {
  it.each(["a", "e", "s"])("ignores a %s: tap from a chat that isn't linked", async (action) => {
    expect(await tap(`${action}:${REMINDER}`, FOREIGN_CHAT)).toEqual([]);
    expect((await row()).approval_status).toBe("waiting");
  });

  it("another freelancer's chat can't skip it either", async () => {
    const ops = await tap(`s:${REMINDER}`, CHAT_B);
    expect(ops.every((op) => op.op === "answer")).toBe(true);
    expect((await row()).approval_status).toBe("waiting");
  });
});

describe("a card that's out of date can't approve", () => {
  const STALE_TEXT = /newer/;

  it("after an edit in the Outbox, its buttons refuse until the new card is out", async () => {
    await outbox({ action: "edit", subject: "New wording", body: `New wording. ${PAY_LINK}` });
    const ops = await tap(`a:${REMINDER}`);
    expect((await row()).approval_status).toBe("waiting");
    expect(ops.find((op) => op.op === "answer")?.text).toMatch(STALE_TEXT);
  });

  it("the next run replaces it with a card showing the new wording", async () => {
    await outbox({ action: "edit", subject: "New wording", body: `New wording. ${PAY_LINK}` });
    const ops = await run();
    expect(ops.map((op) => op.op)).toEqual(["editText", "sendCard"]);
    expect(ops[0]).toMatchObject({ messageId: MESSAGE });
    expect(ops[1]?.text).toContain("New wording");
    expect((await row()).telegram_message_id).toBeNull();
    expect(await run()).toEqual([]);
  });

  it("a new send time in the Outbox replaces the card too", async () => {
    await outbox({ action: "reschedule", at: "2026-12-28T11:30" });
    const ops = await run();
    expect(ops.map((op) => op.op)).toEqual(["editText", "sendCard"]);
    expect(ops[1]?.text).toContain("Mon 28 Dec");
  });

  it("an old copy of a card can't approve the current draft", async () => {
    const ops = await tap(`a:${REMINDER}`, CHAT_A, MESSAGE - 1);
    expect((await row()).approval_status).toBe("waiting");
    expect(ops.find((op) => op.op === "answer")?.text).toMatch(STALE_TEXT);
    expect(ops.find((op) => op.op === "editText")).toMatchObject({ messageId: MESSAGE - 1 });
  });

  it("a card whose replacement hasn't been confirmed can't approve either", async () => {
    await handle.db.query(
      `UPDATE public.reminders SET telegram_message_id = NULL WHERE id = '${REMINDER}'`,
    );
    await tap(`a:${REMINDER}`);
    expect((await row()).approval_status).toBe("waiting");
  });

  it("still approves from the current card once it's confirmed", async () => {
    await outbox({ action: "edit", subject: "New wording", body: `New wording. ${PAY_LINK}` });
    await run();
    await telegramCardHandlers(deps()).delivered(
      internal("/api/internal/telegram/delivered", { reminderId: REMINDER, messageId: 777 }),
    );
    await tap(`a:${REMINDER}`, CHAT_A, 777);
    expect(await row()).toMatchObject({ approval_status: "approved", approved_via: "telegram" });
  });
});

describe("the timeout", () => {
  const after = (hours: number) => {
    clock = new Date(NOW.getTime() + hours * HOUR);
  };

  it("doesn't nudge before 24 hours", async () => {
    after(23.9);
    expect(await run()).toEqual([]);
  });

  it("nudges once after 24 hours, then holds: nothing is ever sent on its own", async () => {
    after(24);
    const ops = await run();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "sendText", chatId: CHAT_A });
    expect(ops[0]?.text).toContain("Client a");
    expect(ops[0]?.text).toContain("won't go out");
    after(24 * 30);
    expect(await run()).toEqual([]);
    expect(await row()).toMatchObject({
      approval_status: "waiting",
      approved_via: null,
      sent_at: null,
    });
  });

  it("uses the freelancer's own setting", async () => {
    await handle.db.query(
      `UPDATE public.users SET default_settings = '{"nudgeHours": 6}' WHERE id = '${USER_A.userId}'`,
    );
    after(5.9);
    expect(await run()).toEqual([]);
    after(6);
    expect((await run()).map((op) => op.op)).toEqual(["sendText"]);
  });

  it("doesn't nudge about a handled draft", async () => {
    await tap(`s:${REMINDER}`);
    after(48);
    expect(await run()).toEqual([]);
  });

  it("doesn't nudge a card Telegram never confirmed; that card is sent again instead", async () => {
    await handle.db.query(
      `UPDATE public.reminders SET telegram_message_id = NULL WHERE id = '${REMINDER}'`,
    );
    after(48);
    expect((await run()).map((op) => op.op)).toEqual(["sendCard"]);
  });

  it("a new card starts its own timer", async () => {
    after(24);
    await run();
    await outbox({ action: "edit", subject: "New wording", body: `New wording. ${PAY_LINK}` });
    await run();
    await telegramCardHandlers(deps()).delivered(
      internal("/api/internal/telegram/delivered", { reminderId: REMINDER, messageId: 777 }),
    );
    after(47.9);
    expect(await run()).toEqual([]);
    after(48);
    expect((await run()).map((op) => op.op)).toEqual(["sendText"]);
  });

  it("does nothing for a freelancer who disconnected Telegram", async () => {
    await handle.db.query(
      `UPDATE public.users SET telegram_chat_id = NULL WHERE id = '${USER_A.userId}'`,
    );
    after(48);
    expect(await run()).toEqual([]);
  });
});

describe("settings", () => {
  it("rejects a nudge time that isn't sensible", async () => {
    const { scheduleSettingsSchema, DEFAULT_SETTINGS } = await import("@/lib/settings");
    expect(DEFAULT_SETTINGS.nudgeHours).toBe(24);
    const check = (nudgeHours: number) =>
      scheduleSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, nudgeHours }).success;
    expect(check(1)).toBe(true);
    expect(check(168)).toBe(true);
    expect(check(0)).toBe(false);
    expect(check(169)).toBe(false);
  });
});
