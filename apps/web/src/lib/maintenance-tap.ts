import { formatDay, formatFullDay, formatMoney } from "./format";
import { errorKind, logEvent } from "./log";
import { markDone, snooze } from "./maintenance";
import { createJobInvoice, tellClient } from "./maintenance-actions";
import { cardsToSend } from "./telegram-cards";
import { CARD_OUT_OF_DATE_TEXT, type MaintenanceAction, type TelegramOp } from "./telegram-card";
import type { UpdateDeps } from "./telegram-updates";

// Server-only: the buttons on a maintenance card. They act only for the linked chat (checked by the
// caller) and only on the current card. Tell the client makes a draft for approval: no button sends
// anything to a client.

const answer = (callbackQueryId: string, text: string): TelegramOp => ({
  op: "answer",
  callbackQueryId,
  text,
});

type Tap = { id: string; chatId: number; messageId: number };

const isCurrentCard = (deps: UpdateDeps, userId: string, taskId: string, messageId: number) =>
  deps.runAsUser(userId)(async (db) => {
    const { rows } = await db.query<{ message_id: string | null }>(
      `SELECT telegram_message_id::text AS message_id FROM public.maintenance_tasks
       WHERE id = $1 AND status = 'active'`,
      [taskId],
    );
    return rows[0]?.message_id === String(messageId);
  });

const tell = async (
  deps: UpdateDeps,
  userId: string,
  taskId: string,
  tap: Tap,
): Promise<TelegramOp[]> => {
  const result = await tellClient(deps, { userId, taskId });
  if (result.status === "not_found") return [answer(tap.id, "This job is no longer available.")];
  if (result.status === "already_open") {
    return [answer(tap.id, "A heads-up for this job is already in the Outbox.")];
  }
  // The new draft's card, with its own Approve, Edit and Skip. Nothing has gone to the client.
  const cards = await deps.runAsService((db) =>
    cardsToSend(db, deps.now(), deps.outboxUrl(), userId),
  );
  return [answer(tap.id, "Draft ready for your approval"), ...cards];
};

const invoice = async (
  deps: UpdateDeps,
  userId: string,
  taskId: string,
  tap: Tap,
): Promise<TelegramOp[]> => {
  const result = await createJobInvoice(
    { runAsUser: deps.runAsUser(userId), paypal: deps.paypal(), now: deps.now() },
    taskId,
  );
  if (!result.ok) {
    if ("conflict" in result) return [answer(tap.id, result.conflict.slice(0, 200))];
    return [answer(tap.id, "Couldn't create it here. Open Maintenance in the dashboard.")];
  }
  const [first] = result.invoices;
  const text = first
    ? `Invoice ${first.invoiceNumber} for ${formatMoney(first.amountCents, first.currency)} is ready. PayPal hasn't emailed it: its reminders wait for your approval as usual. Pay link: ${first.link ?? "being created"}`
    : "The invoice is ready.";
  return [
    answer(tap.id, result.sentNow ? "Invoice created" : "It was already invoiced"),
    { op: "sendText", chatId: tap.chatId, text },
  ];
};

const closeWith = (tap: Tap, text: string): TelegramOp[] => [
  answer(tap.id, "Done"),
  { op: "editText", chatId: tap.chatId, messageId: tap.messageId, text },
];

const clearCard = (deps: UpdateDeps, userId: string, taskId: string) =>
  // Telegram's card is being edited right now by the steps returned, so there's nothing stale.
  deps.runAsUser(userId)((db) =>
    db.query("UPDATE public.maintenance_tasks SET telegram_stale_message_id = NULL WHERE id = $1", [
      taskId,
    ]),
  );

export const handleMaintenanceTap = async (
  deps: UpdateDeps,
  userId: string,
  tap: Tap,
  { action, id }: { action: MaintenanceAction; id: string },
): Promise<TelegramOp[]> => {
  if (!(await isCurrentCard(deps, userId, id, tap.messageId))) {
    return [
      answer(tap.id, CARD_OUT_OF_DATE_TEXT),
      {
        op: "editText",
        chatId: tap.chatId,
        messageId: tap.messageId,
        text: CARD_OUT_OF_DATE_TEXT,
      },
    ];
  }
  logEvent("telegram.maintenance_tap", { taskId: id, action });
  try {
    switch (action) {
      case "tell":
        return await tell(deps, userId, id, tap);
      case "invoice":
        return await invoice(deps, userId, id, tap);
      case "snooze": {
        const result = await deps.runAsUser(userId)((db) => snooze(db, id, deps.now()));
        await clearCard(deps, userId, id);
        return result.status === "ok"
          ? closeWith(tap, `Snoozed until ${formatDay(result.date)}. I'll remind you then.`)
          : [answer(tap.id, "This job is no longer available.")];
      }
      case "done": {
        const result = await deps.runAsUser(userId)((db) => markDone(db, id, deps.now()));
        await clearCard(deps, userId, id);
        return result.status === "ok"
          ? closeWith(tap, `Marked done. Next due ${formatFullDay(result.date)}.`)
          : [answer(tap.id, "This job is no longer available.")];
      }
    }
  } catch (error) {
    logEvent("telegram.maintenance_tap_failed", { taskId: id, action, error: errorKind(error) });
    return [
      answer(
        tap.id,
        "That didn't work. Try again, or use Maintenance in the dashboard.",
      ),
    ];
  }
};
