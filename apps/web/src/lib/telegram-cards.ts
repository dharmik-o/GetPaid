import type { Db } from "./db";
import { listForTelegram } from "./outbox";
import { cardData, cardText, type TelegramOp } from "./telegram-card";

// Server-only, as the service role (n8n's card run covers every freelancer; callers must have
// checked the internal token). Works out which cards to send from the database, so a repeated run
// is safe. A card is handed over once, then again only if Telegram never confirmed it.

const RETRY_AFTER_MS = 10 * 60 * 1000;

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
