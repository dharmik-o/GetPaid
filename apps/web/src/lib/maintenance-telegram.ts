import type { Db } from "./db";
import { toCents } from "./db-values";
import { formatFullDay, formatMoney } from "./format";
import { maintenanceNoticeDue, todayIn } from "./schedule";
import type { ServiceDbRunner } from "./service-db";
import { ALREADY_HANDLED_TEXT, CARD_REPLACED_TEXT, type TelegramOp } from "./telegram-card";

// Server-only: when the freelancer hears about maintenance and renewals on Telegram, and the cards
// that say so. Their buttons are handled in maintenance-tap.ts.

const RETRY_AFTER_MS = 10 * 60 * 1000;
const RUN_LIMIT = 200;
const CHECKLIST_SHOWN = 10;

type NoticeRow = {
  id: string;
  next_due: string;
  lead_days: number[];
  snoozed_until: string | null;
  last_notice_on: string | null;
  own_zone: string;
};

/** The scheduler's part: marks which tasks need a card now. Safe to re-run. */
export const planMaintenanceNotices = async (
  runAsService: ServiceDbRunner,
  now: Date,
): Promise<number> =>
  runAsService(async (db) => {
    const { rows } = await db.query<NoticeRow>(
      `SELECT mt.id::text, mt.next_due::text, mt.lead_days, mt.snoozed_until::text,
         mt.last_notice_on::text, u.time_zone AS own_zone
       FROM public.maintenance_tasks mt JOIN public.users u ON u.id = mt.user_id
       WHERE mt.status = 'active' ORDER BY mt.next_due LIMIT ${String(RUN_LIMIT)}`,
    );
    const due = rows.filter((row) =>
      maintenanceNoticeDue({
        nextDue: row.next_due,
        leadDays: row.lead_days,
        snoozedUntil: row.snoozed_until,
        lastNoticeOn: row.last_notice_on,
        now,
        timeZone: row.own_zone,
      }),
    );
    for (const row of due) {
      await db.query(
        `UPDATE public.maintenance_tasks
         SET notice_pending = true, last_notice_on = $2, telegram_card_sent_at = NULL,
           telegram_stale_message_id = coalesce(telegram_message_id, telegram_stale_message_id),
           telegram_message_id = NULL
         WHERE id = $1`,
        [row.id, todayIn(now, row.own_zone)],
      );
    }
    return due.length;
  });

type CardRow = {
  id: string;
  chat_id: string;
  type: "maintenance" | "renewal";
  task: string;
  next_due: string;
  est_cost_cents: string | null;
  currency: string;
  checklist: unknown;
  title: string;
  client_name: string;
};

const cardText = (row: CardRow): string => {
  const kind = row.type === "renewal" ? "Renewal" : "Maintenance";
  const cost =
    row.est_cost_cents === null
      ? ""
      : `, estimated ${formatMoney(toCents(row.est_cost_cents), row.currency)}`;
  const items = Array.isArray(row.checklist)
    ? row.checklist.filter((item): item is string => typeof item === "string")
    : [];
  return [
    `${kind} for ${row.title} is due on ${formatFullDay(row.next_due)}${cost}.`,
    `${row.task} · ${row.client_name}`,
    ...(items.length > 0
      ? ["", ...items.slice(0, CHECKLIST_SHOWN).map((item) => `- ${item}`)]
      : []),
  ].join("\n");
};

/** Button data: under Telegram's 64-byte limit, and only an action and a task id. */
const maintenanceData = (id: string) => ({
  tell: `mt:${id}`,
  invoice: `mi:${id}`,
  snooze: `ms:${id}`,
  done: `md:${id}`,
});

/** What n8n's one-minute run should do for maintenance: close old cards, send new ones. */
export const maintenanceRun = async (db: Db, now: Date): Promise<TelegramOp[]> => {
  const { rows: stale } = await db.query<{
    chat_id: string;
    message_id: string;
    pending: boolean;
  }>(
    `WITH stale AS (
       SELECT mt.id, u.telegram_chat_id AS chat_id, mt.telegram_stale_message_id AS message_id,
         mt.notice_pending AS pending
       FROM public.maintenance_tasks mt JOIN public.users u ON u.id = mt.user_id
       WHERE mt.telegram_stale_message_id IS NOT NULL AND u.telegram_chat_id IS NOT NULL
     ), cleared AS (
       UPDATE public.maintenance_tasks mt SET telegram_stale_message_id = NULL
       FROM stale WHERE mt.id = stale.id
     )
     SELECT chat_id::text, message_id::text, pending FROM stale`,
  );
  const retryBefore = new Date(now.getTime() - RETRY_AFTER_MS).toISOString();
  const { rows: cards } = await db.query<CardRow>(
    `SELECT mt.id::text, u.telegram_chat_id::text AS chat_id, mt.type, mt.task, mt.next_due::text,
       mt.est_cost_cents::text, mt.currency, mt.checklist, p.title, c.name AS client_name
     FROM public.maintenance_tasks mt
     JOIN public.users u ON u.id = mt.user_id
     JOIN public.projects p ON p.id = mt.project_id
     JOIN public.clients c ON c.id = p.client_id
     WHERE mt.notice_pending AND mt.status = 'active' AND u.telegram_chat_id IS NOT NULL
       AND (mt.telegram_card_sent_at IS NULL OR mt.telegram_card_sent_at < $1)
     LIMIT 50`,
    [retryBefore],
  );
  if (cards.length > 0) {
    await db.query(
      "UPDATE public.maintenance_tasks SET telegram_card_sent_at = $1 WHERE id = ANY($2::uuid[])",
      [now.toISOString(), cards.map((card) => card.id)],
    );
  }
  return [
    ...stale.map((row): TelegramOp => ({
      op: "editText",
      chatId: Number(row.chat_id),
      messageId: Number(row.message_id),
      text: row.pending ? CARD_REPLACED_TEXT : ALREADY_HANDLED_TEXT,
    })),
    ...cards.map((card): TelegramOp => ({
      op: "sendMaintenance",
      chatId: Number(card.chat_id),
      taskId: card.id,
      text: cardText(card),
      data: maintenanceData(card.id),
    })),
  ];
};

/** Telegram confirmed the card. Only the first answer counts, so a repeat changes nothing. */
export const recordMaintenanceCard = async (
  db: Db,
  taskId: string,
  messageId: number,
): Promise<boolean> => {
  const { rowCount } = await db.query(
    `UPDATE public.maintenance_tasks SET telegram_message_id = $2, notice_pending = false
     WHERE id = $1 AND telegram_message_id IS NULL AND notice_pending`,
    [taskId, messageId],
  );
  return rowCount > 0;
};
