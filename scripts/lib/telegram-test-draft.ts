import type { SqlClient } from "./sql-client";

// A fake waiting draft for checking real Telegram cards by hand. It has its own fake client, so it
// never touches a real one, and fixed ids, so a repeat run replaces it and removal is exact. Local
// databases only: the command checks that before calling anything here.

const ids = {
  client: "c1000000-0000-4000-8000-0000000000f1",
  project: "d1000000-0000-4000-8000-0000000000f1",
  milestone: "e1000000-0000-4000-8000-0000000000f1",
  invoice: "f1000000-0000-4000-8000-0000000000f1",
} as const;

export const TEST_REMINDER_ID = "a1000000-0000-4000-8000-0000000000f1";

/** `.example` is reserved and never receives mail, so approving this draft can't email anyone. */
export const TEST_CLIENT_EMAIL = "telegram-test@client.example";

const PAY_LINK = "https://www.sandbox.paypal.com/invoice/p/#INV2-FAKE-TELE-0001";
const AMOUNT_CENTS = 50000;

export type TestDraftRow = {
  approvalStatus: string;
  cardSentAt: Date | null;
  messageId: string | null;
  editing: boolean;
};

export type DeliveryStage = "not_collected" | "handed_over" | "delivered";

export const deliveryStage = ({
  cardSentAt,
  messageId,
}: Pick<TestDraftRow, "cardSentAt" | "messageId">): DeliveryStage => {
  if (messageId !== null) return "delivered";
  return cardSentAt === null ? "not_collected" : "handed_over";
};

export const linkedUserId = async (db: SqlClient): Promise<string | undefined> => {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id::text FROM public.users WHERE telegram_chat_id IS NOT NULL ORDER BY created_at LIMIT 1",
  );
  return rows[0]?.id;
};

const inTransaction = async <T>(db: SqlClient, work: () => Promise<T>): Promise<T> => {
  await db.query("BEGIN");
  try {
    const result = await work();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
};

const deleteRows = async (db: SqlClient): Promise<boolean> => {
  await db.query("DELETE FROM public.events WHERE entity_id = ANY($1::uuid[])", [
    [TEST_REMINDER_ID, ids.invoice, ids.milestone, ids.project, ids.client],
  ]);
  const { rowCount } = await db.query("DELETE FROM public.projects WHERE id = $1", [ids.project]);
  await db.query("DELETE FROM public.clients WHERE id = $1", [ids.client]);
  return rowCount > 0;
};

export const removeTestDraft = (db: SqlClient): Promise<boolean> =>
  inTransaction(db, () => deleteRows(db));

const draftFor = (now: Date, dueDate: string) => ({
  subject: "TEST: invoice for Test milestone is overdue",
  body: `Hello,\n\nThis is a test draft from npm run telegram:test, sent to a fake client. The invoice for USD 500.00 was due on ${dueDate}. You can pay here:\n${PAY_LINK}\n\nThanks`,
  kind: "tier1",
  via: "template",
  model: null,
  isLocal: null,
  citation: null,
  lawId: null,
  notLegalAdvice: false,
  draftedAt: now.toISOString(),
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** A UTC calendar day. These dates only have to look overdue: no send time depends on them. */
const dayFrom = (now: Date, days: number): string =>
  new Date(now.getTime() + days * DAY_MS).toISOString().slice(0, 10);

const insertRows = async (db: SqlClient, userId: string, now: Date): Promise<void> => {
  const dueDate = dayFrom(now, -7);
  await db.query(
    `INSERT INTO public.clients (id, user_id, name, email, country, time_zone)
     VALUES ($1, $2, 'Test Client (fake)', $3, 'GB', 'Europe/London')`,
    [ids.client, userId, TEST_CLIENT_EMAIL],
  );
  await db.query(
    `INSERT INTO public.projects (id, user_id, client_id, title, total_cents, currency)
     VALUES ($1, $2, $3, 'Telegram test (fake)', $4, 'USD')`,
    [ids.project, userId, ids.client, AMOUNT_CENTS],
  );
  await db.query(
    `INSERT INTO public.milestones
       (id, user_id, project_id, currency, position, name, amount_cents, deadline, status)
     VALUES ($1, $2, $3, 'USD', 1, 'Test milestone', $4, $5, 'invoiced')`,
    [ids.milestone, userId, ids.project, AMOUNT_CENTS, dayFrom(now, -14)],
  );
  await db.query(
    `INSERT INTO public.invoices
       (id, user_id, milestone_id, link, amount_cents, currency, due_date, status)
     VALUES ($1, $2, $3, $4, $5, 'USD', $6, 'sent')`,
    [ids.invoice, userId, ids.milestone, PAY_LINK, AMOUNT_CENTS, dueDate],
  );
  await db.query(
    `INSERT INTO public.reminders (id, user_id, invoice_id, tier, scheduled_at, draft)
     VALUES ($1, $2, $3, 'tier1', $4, $5)`,
    [
      TEST_REMINDER_ID,
      userId,
      ids.invoice,
      new Date(now.getTime() + DAY_MS).toISOString(),
      JSON.stringify(draftFor(now, dueDate)),
    ],
  );
};

/** Replaces any earlier test draft, so a handled one never stops a new card going out. */
export const createTestDraft = (db: SqlClient, userId: string, now: Date): Promise<void> =>
  inTransaction(db, async () => {
    await deleteRows(db);
    await insertRows(db, userId, now);
  });

export const readTestDraft = async (db: SqlClient): Promise<TestDraftRow | undefined> => {
  const { rows } = await db.query<{
    approval_status: string;
    telegram_card_sent_at: Date | string | null;
    telegram_message_id: string | null;
    editing: boolean;
  }>(
    `SELECT r.approval_status, r.telegram_card_sent_at, r.telegram_message_id::text,
       coalesce(u.telegram_editing_reminder_id = r.id, false) AS editing
     FROM public.reminders r JOIN public.users u ON u.id = r.user_id
     WHERE r.id = $1`,
    [TEST_REMINDER_ID],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    approvalStatus: row.approval_status,
    cardSentAt: row.telegram_card_sent_at === null ? null : new Date(row.telegram_card_sent_at),
    messageId: row.telegram_message_id,
    editing: row.editing,
  };
};
