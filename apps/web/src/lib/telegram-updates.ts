import { z } from "zod";
import type { Db } from "./db";
import { logEvent } from "./log";
import { loadOutboxItem } from "./outbox";
import { ALREADY_HANDLED, approveDraft, skipDraft, type ActionResult } from "./outbox-actions";
import { redraftReminder, type RedraftDeps } from "./redraft";
import type { ServiceDbRunner } from "./service-db";
import { storedDraftSchema } from "./stored-draft";
import {
  ALREADY_HANDLED_TEXT,
  outboxPointer,
  parseCardData,
  type CardAction,
  type TelegramOp,
} from "./telegram-card";
import { cardsToSend } from "./telegram-cards";
import { completeTelegramLink, type LinkOutcome } from "./telegram-link";

// Server-only: one Telegram update, relayed by n8n, turned into what n8n should send back.
// Telegram text is untrusted (security rule 4): a chat is matched to a freelancer only through
// its linked chat ID, buttons act through the same checks as the Outbox, and a typed message can
// only ask for new wording, which then waits for approval like any draft.

/** Telegram adds fields over time, so unknown ones are ignored rather than refused. */
export const updateSchema = z.object({
  message: z
    .object({
      chat: z.object({ id: z.int(), type: z.string() }),
      text: z.string().optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().optional(),
      message: z.object({ message_id: z.int(), chat: z.object({ id: z.int() }) }).optional(),
    })
    .optional(),
});

export type TelegramUpdate = z.infer<typeof updateSchema>;

export type UpdateDeps = RedraftDeps & {
  runAsService: ServiceDbRunner;
  outboxUrl: () => string | undefined;
};

/** Telegram's deep-link parameter: up to 64 of A-Z a-z 0-9 _ - */
const START = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?$/;

const FEEDBACK_MAX = 1000;

const LINK_REPLIES: Readonly<Record<LinkOutcome, string>> = {
  connected: "Connected. Reminder drafts will arrive here for you to approve.",
  invalid:
    "That link has expired or was already used. Open Settings > Integrations in the dashboard and tap Connect Telegram again.",
  taken:
    "This Telegram chat is linked to another account. Disconnect it there first, then tap Connect Telegram again.",
};

const NO_CODE_REPLY =
  "To connect, open Settings > Integrations in the dashboard and tap Connect Telegram.";

type LinkedUser = { id: string; editing: string | null };

const findLinkedUser = (deps: UpdateDeps, chatId: number): Promise<LinkedUser | undefined> =>
  deps.runAsService(async (db) => {
    const { rows } = await db.query<{ id: string; editing: string | null }>(
      `SELECT id::text, telegram_editing_reminder_id::text AS editing
       FROM public.users WHERE telegram_chat_id = $1`,
      [chatId],
    );
    return rows[0];
  });

const setEditing = (db: Db, reminderId: string | null) =>
  db.query(
    "UPDATE public.users SET telegram_editing_reminder_id = $1 WHERE id = (SELECT auth.uid())",
    [reminderId],
  );

const startEdit = async (db: Db, id: string): Promise<ActionResult> => {
  const { rows } = await db.query<{ draft: unknown; approval_status: string }>(
    "SELECT draft, approval_status FROM public.reminders WHERE id = $1 AND draft IS NOT NULL",
    [id],
  );
  const state = rows[0];
  if (!state) return { status: "not_found" };
  if (state.approval_status !== "waiting") return ALREADY_HANDLED;
  if (!storedDraftSchema.safeParse(state.draft).success) {
    return { status: "conflict", message: "This draft failed its checks. Skip it." };
  }
  await setEditing(db, id);
  return { status: "ok" };
};

const runAction = (db: Db, action: CardAction, id: string): Promise<ActionResult> => {
  switch (action) {
    case "approve":
      return approveDraft(db, id, "telegram");
    case "skip":
      return skipDraft(db, id, "telegram");
    case "edit":
      return startEdit(db, id);
  }
};

const answer = (callbackQueryId: string, text: string): TelegramOp => ({
  op: "answer",
  callbackQueryId,
  text,
});

/** What the freelancer sees after a button worked. */
const successOps = async (
  deps: UpdateDeps,
  userId: string,
  action: CardAction,
  id: string,
  chatId: number,
  messageId: number,
): Promise<TelegramOp[]> => {
  if (action === "edit") {
    const text = `Reply with what to change, like "make it softer and mention the 15th". Or edit it by hand in ${outboxPointer(deps.outboxUrl())}`;
    return [{ op: "sendText", chatId, text }];
  }
  if (action === "skip") return [{ op: "editText", chatId, messageId, text: "Skipped" }];
  const item = await deps.runAsUser(userId)((db) => loadOutboxItem(db, id, deps.now()));
  const text = `Approved. Sends ${item?.sendTime ?? "inside the send window"}.`;
  return [{ op: "editText", chatId, messageId, text }];
};

const handleTap = async (
  deps: UpdateDeps,
  tap: NonNullable<TelegramUpdate["callback_query"]>,
): Promise<TelegramOp[]> => {
  const chatId = tap.message?.chat.id;
  const messageId = tap.message?.message_id;
  if (chatId === undefined || messageId === undefined) return [];
  const user = await findLinkedUser(deps, chatId);
  if (!user) {
    logEvent("telegram.ignored", { reason: "chat_not_linked" });
    return [];
  }
  const parsed = parseCardData(tap.data ?? "");
  if (!parsed) return [answer(tap.id, "That button isn't recognised.")];
  const { action, id } = parsed;
  const result = await deps.runAsUser(user.id)((db) => runAction(db, action, id));
  logEvent("telegram.tap", { reminderId: id, action, status: result.status });
  switch (result.status) {
    case "ok":
      return [
        answer(tap.id, "Done"),
        ...(await successOps(deps, user.id, action, id, chatId, messageId)),
      ];
    case "not_found":
      return [answer(tap.id, "This draft is no longer available.")];
    case "conflict":
    case "invalid":
      return result === ALREADY_HANDLED
        ? [
            answer(tap.id, ALREADY_HANDLED_TEXT),
            { op: "editText", chatId, messageId, text: ALREADY_HANDLED_TEXT },
          ]
        : [answer(tap.id, result.message.slice(0, 200))];
  }
};

const handleFeedback = async (
  deps: UpdateDeps,
  user: LinkedUser & { editing: string },
  chatId: number,
  feedback: string,
): Promise<TelegramOp[]> => {
  if (feedback.length > FEEDBACK_MAX) {
    const text = `That's too long to work from. Send it in under ${String(FEEDBACK_MAX)} characters, shorter if you can.`;
    return [{ op: "sendText", chatId, text }];
  }
  await deps.runAsUser(user.id)((db) => setEditing(db, null));
  const outcome = await redraftReminder(deps, {
    userId: user.id,
    reminderId: user.editing,
    feedback,
  });
  switch (outcome.status) {
    case "handled":
      return [{ op: "sendText", chatId, text: ALREADY_HANDLED_TEXT }];
    case "failed": {
      const text = `I couldn't redraft that, so the draft is unchanged. Tap Edit to try other words, or edit it by hand in ${outboxPointer(deps.outboxUrl())}`;
      return [{ op: "sendText", chatId, text }];
    }
    case "redrafted": {
      const cards = await deps.runAsService((db) =>
        cardsToSend(db, deps.now(), deps.outboxUrl(), user.id),
      );
      const close: TelegramOp[] =
        outcome.oldMessageId === null
          ? []
          : [
              {
                op: "editText",
                chatId,
                messageId: outcome.oldMessageId,
                text: "Replaced by the new draft below.",
              },
            ];
      return [...close, ...cards];
    }
  }
};

const handleMessage = async (
  deps: UpdateDeps,
  message: NonNullable<TelegramUpdate["message"]>,
): Promise<TelegramOp[]> => {
  // Private chats only: anyone in a group would see the cards.
  if (message.chat.type !== "private" || message.text === undefined) return [];
  const chatId = message.chat.id;
  const text = message.text.trim();
  const start = START.exec(text);
  if (start) {
    const code = start[1];
    if (!code) return [{ op: "sendText", chatId, text: NO_CODE_REPLY }];
    const outcome = await deps.runAsService((db) =>
      completeTelegramLink(db, code, chatId, deps.now()),
    );
    logEvent("telegram.link", { outcome });
    return [{ op: "sendText", chatId, text: LINK_REPLIES[outcome] }];
  }
  const user = await findLinkedUser(deps, chatId);
  if (!user?.editing || text === "") return [];
  return handleFeedback(deps, { ...user, editing: user.editing }, chatId, text);
};

export const handleTelegramUpdate = async (
  deps: UpdateDeps,
  update: TelegramUpdate,
): Promise<TelegramOp[]> => {
  if (update.callback_query) return handleTap(deps, update.callback_query);
  if (update.message) return handleMessage(deps, update.message);
  return [];
};
