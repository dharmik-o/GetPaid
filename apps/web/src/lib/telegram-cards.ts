import type { Db } from "./db";
import { listForTelegram } from "./outbox";
import {
  ALREADY_HANDLED_TEXT,
  CARD_REPLACED_TEXT,
  cardData,
  cardText,
  type TelegramOp,
} from "./telegram-card";

// Server-only, as the service role (n8n's card run covers every freelancer; callers must have
// checked the internal token). Works out which cards to send from the database, so a repeated run
// is safe. A card is handed over once, then again only if Telegram never confirmed it.

const RETRY_AFTER_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Cards for waiting drafts that have none, for everyone or for one freelancer. */
export const cardsToSend = async (
  db: Db,
  now: Date,
  outboxUrl: string | undefined,
  userId?: string,
): Promise<TelegramOp[]> => {
  const retryBefore = new Date(now.getTime() - RETRY_AFTER_MS).toISOString();
  const rows = await listForTelegram(
    db,
    `r.approval_status = 'waiting' AND r.telegram_message_id IS NULL
     AND u.telegram_chat_id IS NOT NULL
     AND (r.telegram_card_sent_at IS NULL OR r.telegram_card_sent_at < $1)
     AND ($2::uuid IS NULL OR r.user_id = $2)`,
    [retryBefore, userId ?? null],
    now,
  );
  const ops: TelegramOp[] = [];
  for (const { item, chatId } of rows) {
    if (!item.draft || chatId === null) continue;
    ops.push({
      op: "sendCard",
      chatId,
      reminderId: item.id,
      text: cardText(item, item.draft, outboxUrl),
      data: cardData(item.id),
    });
  }
  if (ops.length > 0) {
    await db.query(
      "UPDATE public.reminders SET telegram_card_sent_at = $1 WHERE id = ANY($2::uuid[])",
      [now.toISOString(), ops.flatMap((op) => (op.op === "sendCard" ? [op.reminderId] : []))],
    );
  }
  return ops;
};

/** Cards whose draft was handled somewhere else: they say so, once. */
const closeHandled = async (db: Db, now: Date): Promise<TelegramOp[]> => {
  const { rows } = await db.query<{ id: string; chat_id: string; message_id: string }>(
    `SELECT r.id::text, u.telegram_chat_id::text AS chat_id, r.telegram_message_id::text AS message_id
     FROM public.reminders r JOIN public.users u ON u.id = r.user_id
     WHERE r.approval_status <> 'waiting' AND r.telegram_message_id IS NOT NULL
       AND r.telegram_card_closed_at IS NULL AND u.telegram_chat_id IS NOT NULL`,
  );
  if (rows.length === 0) return [];
  await db.query(
    "UPDATE public.reminders SET telegram_card_closed_at = $1 WHERE id = ANY($2::uuid[])",
    [now.toISOString(), rows.map((row) => row.id)],
  );
  return rows.map((row) => ({
    op: "editText",
    chatId: Number(row.chat_id),
    messageId: Number(row.message_id),
    text: ALREADY_HANDLED_TEXT,
  }));
};

/** Cards showing old wording or an old time: closed here, and sent again by `cardsToSend`. */
const replaceStale = async (db: Db): Promise<TelegramOp[]> => {
  const { rows } = await db.query<{ chat_id: string; message_id: string }>(
    `WITH stale AS (
       SELECT r.id, u.telegram_chat_id AS chat_id, r.telegram_message_id AS message_id
       FROM public.reminders r JOIN public.users u ON u.id = r.user_id
       WHERE r.telegram_card_stale AND r.approval_status = 'waiting'
         AND r.telegram_message_id IS NOT NULL AND u.telegram_chat_id IS NOT NULL
     ), cleared AS (
       UPDATE public.reminders r
       SET telegram_message_id = NULL, telegram_card_sent_at = NULL,
           telegram_card_stale = false, telegram_nudged_at = NULL
       FROM stale WHERE r.id = stale.id
     )
     SELECT chat_id::text, message_id::text FROM stale`,
  );
  return rows.map((row) => ({
    op: "editText",
    chatId: Number(row.chat_id),
    messageId: Number(row.message_id),
    text: CARD_REPLACED_TEXT,
  }));
};

/** One nudge per card. The draft stays held: this only tells the freelancer it's waiting. */
const nudges = async (db: Db, now: Date): Promise<TelegramOp[]> => {
  const rows = await listForTelegram(
    db,
    `r.approval_status = 'waiting' AND r.telegram_message_id IS NOT NULL
     AND r.telegram_nudged_at IS NULL AND NOT r.telegram_card_stale
     AND u.telegram_chat_id IS NOT NULL`,
    [],
    now,
  );
  const due = rows.filter(
    ({ item, cardSentAt }) =>
      cardSentAt !== null && now.getTime() - cardSentAt.getTime() >= item.nudgeHours * HOUR_MS,
  );
  if (due.length === 0) return [];
  await db.query("UPDATE public.reminders SET telegram_nudged_at = $1 WHERE id = ANY($2::uuid[])", [
    now.toISOString(),
    due.map(({ item }) => item.id),
  ]);
  return due.flatMap(({ item, chatId }) =>
    chatId === null
      ? []
      : [
          {
            op: "sendText" as const,
            chatId,
            text: `Still waiting for you: the reminder to ${item.clientName} (${item.what}, ${item.amountDue}). It won't go out until you approve it.`,
          },
        ],
  );
};

/** What n8n's one-minute run should send. Safe to repeat: each step is marked as it's handed over. */
export const telegramRun = async (
  db: Db,
  now: Date,
  outboxUrl: string | undefined,
): Promise<TelegramOp[]> => [
  ...(await closeHandled(db, now)),
  ...(await replaceStale(db)),
  ...(await nudges(db, now)),
  ...(await cardsToSend(db, now, outboxUrl)),
];

/** Telegram confirmed the card. Only the first answer counts, so a repeat changes nothing. */
export const recordCardDelivered = async (
  db: Db,
  reminderId: string,
  messageId: number,
): Promise<boolean> => {
  const { rowCount } = await db.query(
    `UPDATE public.reminders SET telegram_message_id = $2
     WHERE id = $1 AND telegram_message_id IS NULL AND draft IS NOT NULL`,
    [reminderId, messageId],
  );
  return rowCount > 0;
};
