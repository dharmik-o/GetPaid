import type { Db } from "./db";
import { toCents } from "./db-values";
import { formatMoney, formatSendTime } from "./format";
import { effectiveSendAt, localTimeInput, type Tier } from "./schedule";
import { mergeSettings, type SendWindow } from "./settings";
import { storedDraftSchema, type StoredDraft } from "./stored-draft";

// Server-only (types are safe to import anywhere): the Outbox's four lists, read as the signed-in
// user (RLS). A reminder appears once it has a draft.

export const OUTBOX_TABS = ["waiting", "scheduled", "sent", "skipped"] as const;
export type OutboxTab = (typeof OUTBOX_TABS)[number];

export type OutboxItem = {
  id: string;
  tab: OutboxTab;
  clientName: string;
  /** "Website · Build · FPR-000042 · Installment 2 of 3" */
  what: string;
  amountDue: string;
  tier: Tier;
  /** Both zones; null for a skipped draft, which has no send time. */
  sendTime: string | null;
  /** The send time as the reschedule input's value, in the client's zone. */
  sendAtInput: string;
  clientTimeZone: string;
  window: SendWindow;
  nudgeHours: number;
  payLink: string | null;
  /** null: the stored draft fails the schema, so it can only be skipped. */
  draft: StoredDraft | null;
  approvedVia: "outbox" | "telegram" | null;
};

const CONDITIONS: Record<OutboxTab, string> = {
  waiting: "r.approval_status = 'waiting'",
  scheduled: "r.approval_status = 'approved' AND r.sent_at IS NULL",
  sent: "r.sent_at IS NOT NULL",
  skipped: "r.approval_status = 'skipped'",
};

/** What to act on next comes first; history is newest first. */
const ORDER: Record<OutboxTab, string> = {
  waiting: "r.scheduled_at ASC",
  scheduled: "r.scheduled_at ASC",
  sent: "r.sent_at DESC",
  skipped: "r.updated_at DESC",
};

const LIST_LIMIT = 200;

type Row = {
  id: string;
  tier: Tier;
  approval_status: "waiting" | "approved" | "skipped";
  chat_id: string | null;
  message_id: string | null;
  card_sent_at: Date | string | null;
  scheduled_at: Date | string;
  sent_at: Date | string | null;
  draft: unknown;
  approved_via: OutboxItem["approvedVia"];
  invoice_number: string;
  amount_cents: unknown;
  amount_paid_cents: unknown;
  currency: string;
  link: string | null;
  installment_number: number | null;
  installment_count: number | null;
  milestone_name: string | null;
  milestone_settings: unknown;
  title: string | null;
  project_settings: unknown;
  retainer_name: string | null;
  client_name: string;
  time_zone: string;
  client_settings: unknown;
  own_time_zone: string;
  account_settings: unknown;
};

const SELECT = `
  SELECT r.id::text, r.tier, r.approval_status, r.scheduled_at, r.sent_at, r.draft, r.approved_via,
    u.telegram_chat_id::text AS chat_id, r.telegram_message_id::text AS message_id, r.telegram_card_sent_at AS card_sent_at,
    i.invoice_number, i.amount_cents::text, i.amount_paid_cents::text, i.currency, i.link,
    i.installment_number, i.installment_count,
    m.name AS milestone_name, m.settings AS milestone_settings,
    p.title, p.settings AS project_settings, rt.name AS retainer_name,
    c.name AS client_name, c.time_zone, c.settings AS client_settings,
    u.time_zone AS own_time_zone, u.default_settings AS account_settings
  FROM public.reminders r
  JOIN public.invoices i ON i.id = r.invoice_id
  LEFT JOIN public.milestones m ON m.id = i.milestone_id
  LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
  LEFT JOIN public.projects p ON p.id = m.project_id
  JOIN public.clients c ON c.id = coalesce(p.client_id, rt.client_id)
  JOIN public.users u ON u.id = r.user_id
  WHERE r.draft IS NOT NULL`;

const whatOf = (row: Row): string =>
  [
    row.title,
    row.milestone_name ?? row.retainer_name,
    row.invoice_number,
    row.installment_number === null || row.installment_count === null
      ? null
      : `Installment ${String(row.installment_number)} of ${String(row.installment_count)}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

const toItem = (row: Row, tab: OutboxTab, now: Date): OutboxItem => {
  const { sendWindow, nudgeHours } = mergeSettings({
    account: row.account_settings,
    client: row.client_settings,
    project: row.project_settings,
    milestone: row.milestone_settings,
  });
  const clientZone = row.time_zone;
  const planned = effectiveSendAt(new Date(row.scheduled_at), now, sendWindow, clientZone);
  const shown = row.sent_at ? new Date(row.sent_at) : planned;
  const draft = storedDraftSchema.safeParse(row.draft);
  return {
    id: row.id,
    tab,
    clientName: row.client_name,
    what: whatOf(row),
    amountDue: formatMoney(
      toCents(row.amount_cents) - toCents(row.amount_paid_cents),
      row.currency,
    ),
    tier: row.tier,
    sendTime: tab === "skipped" ? null : formatSendTime(shown, clientZone, row.own_time_zone),
    sendAtInput: localTimeInput(planned, clientZone),
    clientTimeZone: clientZone,
    window: sendWindow,
    nudgeHours,
    payLink: row.link,
    draft: draft.success ? draft.data : null,
    approvedVia: row.approved_via,
  };
};

export const listOutbox = async (db: Db, tab: OutboxTab, now: Date): Promise<OutboxItem[]> => {
  const { rows } = await db.query<Row>(
    `${SELECT} AND ${CONDITIONS[tab]} ORDER BY ${ORDER[tab]} LIMIT ${String(LIST_LIMIT)}`,
  );
  return rows.map((row) => toItem(row, tab, now));
};

const tabOf = (row: Row): OutboxTab => {
  if (row.sent_at) return "sent";
  if (row.approval_status === "approved") return "scheduled";
  return row.approval_status === "skipped" ? "skipped" : "waiting";
};

export const loadOutboxItem = async (
  db: Db,
  id: string,
  now: Date,
): Promise<OutboxItem | undefined> => {
  const { rows } = await db.query<Row>(`${SELECT} AND r.id = $1`, [id]);
  const row = rows[0];
  return row ? toItem(row, tabOf(row), now) : undefined;
};

export type TelegramRow = {
  item: OutboxItem;
  chatId: number | null;
  messageId: number | null;
  cardSentAt: Date | null;
};

const toNumber = (value: string | null): number | null => (value === null ? null : Number(value));

/**
 * For the Telegram steps only: the chat isn't part of OutboxItem, which reaches the browser.
 * `condition` is a fixed SQL fragment from the caller; values go in `params`.
 */
export const listForTelegram = async (
  db: Db,
  condition: string,
  params: readonly unknown[],
  now: Date,
): Promise<TelegramRow[]> => {
  const { rows } = await db.query<Row>(
    `${SELECT} AND ${condition} ORDER BY r.scheduled_at ASC LIMIT ${String(LIST_LIMIT)}`,
    params,
  );
  return rows.map((row) => ({
    item: toItem(row, tabOf(row), now),
    chatId: toNumber(row.chat_id),
    messageId: toNumber(row.message_id),
    cardSentAt: row.card_sent_at ? new Date(row.card_sent_at) : null,
  }));
};

/** How many drafts each tab holds, for the tabs and the sidebar badge. */
export const outboxCounts = async (db: Db): Promise<Record<OutboxTab, number>> => {
  const columns = OUTBOX_TABS.map(
    (tab) => `count(*) FILTER (WHERE ${CONDITIONS[tab]})::int AS ${tab}`,
  ).join(", ");
  const { rows } = await db.query<Record<OutboxTab, number>>(
    `SELECT ${columns} FROM public.reminders r WHERE r.draft IS NOT NULL`,
  );
  return rows[0] ?? { waiting: 0, scheduled: 0, sent: 0, skipped: 0 };
};
