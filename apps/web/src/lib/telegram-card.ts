import { isUuid } from "./db";
import type { OutboxItem } from "./outbox";
import type { StoredDraft } from "./stored-draft";

// What a Telegram card says and which buttons it has, and the steps n8n carries out for the app.
// Sent as plain text, so nothing in a draft can act as Telegram formatting. Pure.

/** Telegram's limit on one message. */
export const TELEGRAM_TEXT_LIMIT = 4096;

export const ALREADY_HANDLED_TEXT = "Already handled in dashboard";

const TIER_NAMES: Record<OutboxItem["tier"], string> = {
  courtesy: "Courtesy",
  tier1: "Tier 1",
  tier2: "Tier 2",
  tier3: "Tier 3: final notice",
};

export type CardData = { approve: string; edit: string; skip: string };

/** One step for n8n. Its Telegram nodes are fixed by `op`, so a draft can't add a button. */
export type TelegramOp =
  | { op: "sendCard"; chatId: number; reminderId: string; text: string; data: CardData }
  | { op: "sendText"; chatId: number; text: string }
  | { op: "editText"; chatId: number; messageId: number; text: string }
  | { op: "answer"; callbackQueryId: string; text: string };

/** Button data: under Telegram's 64-byte limit, and only an action and a reminder id. */
export const cardData = (id: string): CardData => ({
  approve: `a:${id}`,
  edit: `e:${id}`,
  skip: `s:${id}`,
});

const ACTIONS = { a: "approve", e: "edit", s: "skip" } as const;

export type CardAction = (typeof ACTIONS)[keyof typeof ACTIONS];

export const parseCardData = (value: string): { action: CardAction; id: string } | undefined => {
  const [prefix, id, ...rest] = value.split(":");
  if (rest.length > 0 || !id || !isUuid(id)) return undefined;
  if (prefix !== "a" && prefix !== "e" && prefix !== "s") return undefined;
  return { action: ACTIONS[prefix], id };
};

export const outboxPointer = (outboxUrl: string | undefined): string =>
  outboxUrl ? `the Outbox: ${outboxUrl}` : "the Outbox in your dashboard";

/** Cut to a length without leaving half of an emoji at the end. */
const cut = (text: string, length: number): string => {
  const last = text.charCodeAt(length - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
};

export const cardText = (
  item: OutboxItem,
  draft: StoredDraft,
  outboxUrl: string | undefined,
): string => {
  const head = [
    item.clientName,
    item.what,
    `${item.amountDue} · ${TIER_NAMES[item.tier]}`,
    `Sends after approval: ${item.sendTime ?? "not scheduled"}`,
    ...(draft.notLegalAdvice ? ["A final notice is not legal advice. Read it closely."] : []),
    "",
    `Subject: ${draft.subject}`,
    "",
    "",
  ].join("\n");
  const tail = `\n\nTo edit it by hand, open ${outboxPointer(outboxUrl)}`;
  const whole = `${head}${draft.body}${tail}`;
  if (whole.length <= TELEGRAM_TEXT_LIMIT) return whole;
  const note = `…\n\nThis draft is too long for Telegram. Read all of it in ${outboxPointer(outboxUrl)}`;
  return `${head}${cut(draft.body, TELEGRAM_TEXT_LIMIT - head.length - note.length)}${note}`;
};
