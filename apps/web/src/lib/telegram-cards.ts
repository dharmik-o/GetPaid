import type { Db } from "./db";
import { formatSendTime } from "./format";
import { listForTelegram } from "./outbox";
import {
  ALREADY_HANDLED_TEXT,
  CARD_REPLACED_TEXT,
  cardData,
  cardText,
  replyData,
  type TelegramOp,
} from "./telegram-card";
import { toCents } from "./db-values";
import { maintenanceRun } from "./maintenance-telegram";
import { alertText, type AlertKind } from "./retainer-alerts";
import { primaryLabel } from "./reply-labels";
import { loadRepliesById } from "./reply-review";

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
     WHERE r.approval_status <> 'waiting' AND r.sent_at IS NULL
       AND r.telegram_message_id IS NOT NULL
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

/** A real send happened: the card says so, whatever it said before. Once per reminder. */
const sentNotices = async (db: Db, now: Date): Promise<TelegramOp[]> => {
  const { rows } = await db.query<{
    id: string;
    sent_at: Date | string;
    chat_id: string;
    message_id: string;
    client_zone: string;
    own_zone: string;
  }>(
    `SELECT r.id::text, r.sent_at, u.telegram_chat_id::text AS chat_id,
       r.telegram_message_id::text AS message_id, c.time_zone AS client_zone,
       u.time_zone AS own_zone
     FROM public.reminders r
     JOIN public.users u ON u.id = r.user_id
     LEFT JOIN public.invoices i ON i.id = r.invoice_id
     LEFT JOIN public.milestones m ON m.id = i.milestone_id
     LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
     LEFT JOIN public.maintenance_tasks mt ON mt.id = r.maintenance_task_id
     LEFT JOIN public.projects p ON p.id = coalesce(m.project_id, rt.project_id, mt.project_id)
     JOIN public.clients c ON c.id = coalesce(p.client_id, rt.client_id)
     WHERE r.sent_at IS NOT NULL AND r.telegram_sent_notified_at IS NULL
       AND r.telegram_message_id IS NOT NULL AND u.telegram_chat_id IS NOT NULL`,
  );
  if (rows.length === 0) return [];
  await db.query(
    `UPDATE public.reminders SET telegram_sent_notified_at = $1, telegram_card_closed_at = $1
     WHERE id = ANY($2::uuid[])`,
    [now.toISOString(), rows.map((row) => row.id)],
  );
  return rows.map((row) => ({
    op: "editText",
    chatId: Number(row.chat_id),
    messageId: Number(row.message_id),
    text: `Sent ✓ ${formatSendTime(new Date(row.sent_at), row.client_zone, row.own_zone)}`,
  }));
};

const RECONNECT_TEXT =
  "Reconnect Gmail: Google ended the connection, so your approved reminders are held, not lost. Open Settings > Integrations in the dashboard and press Reconnect Gmail. They go out once you do.";

/** Google ended the connection: one message, until it's reconnected and ends again. */
const reconnectNotices = async (db: Db, now: Date): Promise<TelegramOp[]> => {
  const { rows } = await db.query<{ chat_id: string }>(
    `UPDATE public.users SET gmail_reconnect_notified_at = $1
     WHERE gmail_status = 'needs_reconnect' AND gmail_reconnect_notified_at IS NULL
       AND telegram_chat_id IS NOT NULL
     RETURNING telegram_chat_id::text AS chat_id`,
    [now.toISOString()],
  );
  return rows.map((row) => ({ op: "sendText", chatId: Number(row.chat_id), text: RECONNECT_TEXT }));
};

/** Each retainer alert once: a cancellation, a suspension, a failed charge. */
const retainerAlerts = async (db: Db, now: Date): Promise<TelegramOp[]> => {
  const { rows } = await db.query<{
    id: string;
    kind: AlertKind;
    chat_id: string;
    name: string;
    client_name: string;
    amount_cents: string;
    currency: string;
  }>(
    `SELECT a.id::text, a.kind, u.telegram_chat_id::text AS chat_id, r.name, c.name AS client_name,
       r.amount_cents::text, r.currency
     FROM public.retainer_alerts a
     JOIN public.users u ON u.id = a.user_id
     JOIN public.retainers r ON r.id = a.retainer_id
     JOIN public.clients c ON c.id = r.client_id
     WHERE a.telegram_notified_at IS NULL AND u.telegram_chat_id IS NOT NULL
     ORDER BY a.created_at LIMIT 50`,
  );
  if (rows.length === 0) return [];
  await db.query(
    "UPDATE public.retainer_alerts SET telegram_notified_at = $1 WHERE id = ANY($2::uuid[])",
    [now.toISOString(), rows.map((row) => row.id)],
  );
  return rows.map((row) => ({
    op: "sendText",
    chatId: Number(row.chat_id),
    text: alertText(row.kind, {
      name: row.name,
      clientName: row.client_name,
      amountCents: toCents(row.amount_cents),
      currency: row.currency,
    }),
  }));
};

const REPLY_QUOTE_MAX = 1000;

/** One card per reply: the client's words, the AI's reading, and the freelancer's choice. */
const replyCards = async (db: Db, now: Date): Promise<TelegramOp[]> => {
  const { rows } = await db.query<{ id: string; user_id: string; chat_id: string }>(
    `SELECT msg.id::text, msg.user_id::text, u.telegram_chat_id::text AS chat_id
     FROM public.messages msg JOIN public.users u ON u.id = msg.user_id
     WHERE msg.review_status = 'pending' AND msg.telegram_notified_at IS NULL
       AND u.telegram_chat_id IS NOT NULL
     ORDER BY msg.created_at LIMIT 50`,
  );
  if (rows.length === 0) return [];
  await db.query(
    "UPDATE public.messages SET telegram_notified_at = $1 WHERE id = ANY($2::uuid[])",
    [now.toISOString(), rows.map((row) => row.id)],
  );
  const replies = await loadRepliesById(
    db,
    rows.map((row) => row.id),
    now,
  );
  return rows.flatMap((row): TelegramOp[] => {
    const reply = replies.get(row.id);
    if (!reply) return [];
    const data = replyData(reply.id);
    const quote = reply.text.slice(0, REPLY_QUOTE_MAX);
    const evidence =
      reply.label === "dispute"
        ? "\n\nThe evidence timeline is on the client's page in the dashboard."
        : "";
    return [
      {
        op: "sendReply",
        chatId: Number(row.chat_id),
        text: `${reply.clientName} replied about ${reply.what}:\n\n"${quote}"\n\nAI suggestion: ${reply.summary}\n\nThis invoice is on hold: no reminder goes out until you decide.${evidence}`,
        primaryText: primaryLabel(reply.suggestion),
        primaryData: data.primary,
        resumeData: data.resume,
      },
    ];
  });
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
  ...(await reconnectNotices(db, now)),
  ...(await retainerAlerts(db, now)),
  ...(await replyCards(db, now)),
  ...(await sentNotices(db, now)),
  ...(await closeHandled(db, now)),
  ...(await replaceStale(db)),
  ...(await nudges(db, now)),
  ...(await cardsToSend(db, now, outboxUrl)),
  ...(await maintenanceRun(db, now)),
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
