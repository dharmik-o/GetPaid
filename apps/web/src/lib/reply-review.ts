import { classificationSchema, type Classification } from "./ai-schemas";
import type { Db } from "./db";
import { toCents } from "./db-values";
import { formatMoney } from "./format";
import type { ReplySuggestion } from "./reply-labels";
import { RECORDABLE_STATUSES } from "./invoice-closing";
import { addCalendarDays, todayIn } from "./schedule";

// Server-only (types are safe to import anywhere): replies waiting for the freelancer, and what
// each decision does. Runs as the freelancer (RLS). The AI's reading only ever shapes the
// suggestion. A change happens when the freelancer chooses it, and dates are checked first.

export type ReplyItem = {
  id: string;
  clientId: string;
  clientName: string;
  /** "Website · Build · FPR-000042 · Installment 2 of 3" */
  what: string;
  label: Classification["label"];
  summary: string;
  /** The client's own words: untrusted, and only ever shown as text. */
  text: string;
  invoiceId: string;
  invoiceNumber: string;
  /** What is still owed, in minor units, and whether the invoice is open to a payment record. */
  owedCents: number;
  recordable: boolean;
  /** Null for a retainer invoice, which can't be split: each cycle stands alone. */
  milestoneId: string | null;
  currency: string;
  amountDue: string;
  today: string;
  /** A date the client named, checked, for the split's first offer. */
  splitLastDate: string | null;
  suggestion: ReplySuggestion;
};

const LATEST_PAUSE_DAYS = 366;

const FALLBACK: Classification = {
  label: "unclear",
  promisedDate: null,
  returnDate: null,
  summary: "Read this reply and decide what to do.",
};

const classificationOf = (raw: unknown): Classification => {
  const parsed = classificationSchema.safeParse(raw);
  return parsed.success ? parsed.data : FALLBACK;
};

/** A date the AI read can only be offered if it's soon and in the future. */
const isOfferable = (date: string | null, today: string): date is string =>
  date !== null && date > today && date <= addCalendarDays(today, LATEST_PAUSE_DAYS);

export const suggestionFor = (
  classification: Classification,
  today: string,
  canSplit = true,
): ReplySuggestion => {
  const { label, promisedDate, returnDate } = classification;
  if (label === "installments" && canSplit) return { kind: "split" };
  if (label === "promise" && isOfferable(promisedDate, today)) {
    return { kind: "pause", until: addCalendarDays(promisedDate, 1) };
  }
  if (label === "out_of_office" && isOfferable(returnDate, today)) {
    return { kind: "pause", until: returnDate };
  }
  return { kind: "hold" };
};

type ReplyRow = {
  id: string;
  body: string;
  ai_classification: unknown;
  thread_id: string | null;
  review_status: string | null;
  split_plan_id: string | null;
  invoice_id: string;
  milestone_id: string | null;
  invoice_number: string;
  amount_cents: unknown;
  amount_paid_cents: unknown;
  invoice_status: string;
  currency: string;
  installment_number: number | null;
  installment_count: number | null;
  milestone_name: string | null;
  title: string | null;
  client_id: string;
  client_name: string;
  time_zone: string;
};

export const REPLY_SELECT = `
  SELECT msg.id::text, msg.body, msg.ai_classification, msg.thread_id, msg.review_status,
    msg.split_plan_id::text, i.id::text AS invoice_id, m.id::text AS milestone_id, i.invoice_number,
    i.amount_cents::text, i.amount_paid_cents::text, i.status AS invoice_status, i.currency,
    i.installment_number,
    i.installment_count, coalesce(m.name, rt.name) AS milestone_name, p.title, c.id::text AS client_id,
    c.name AS client_name, c.time_zone
  FROM public.messages msg
  JOIN public.invoices i ON i.id = msg.invoice_id
  LEFT JOIN public.milestones m ON m.id = i.milestone_id
  LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
  LEFT JOIN public.projects p ON p.id = coalesce(m.project_id, rt.project_id)
  JOIN public.clients c ON c.id = coalesce(p.client_id, rt.client_id)
  WHERE msg.direction = 'in' AND msg.review_status IS NOT NULL`;

const toItem = (row: ReplyRow, now: Date): ReplyItem => {
  const classification = classificationOf(row.ai_classification);
  const today = todayIn(now, row.time_zone);
  const installment =
    row.installment_number === null || row.installment_count === null
      ? []
      : [`Installment ${String(row.installment_number)} of ${String(row.installment_count)}`];
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    what: [row.title, row.milestone_name, row.invoice_number, ...installment]
      .filter((part) => part !== null)
      .join(" · "),
    label: classification.label,
    summary: classification.summary,
    text: row.body,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    owedCents: toCents(row.amount_cents) - toCents(row.amount_paid_cents),
    recordable: row.milestone_id !== null && RECORDABLE_STATUSES.includes(row.invoice_status),
    milestoneId: row.milestone_id,
    currency: row.currency,
    amountDue: formatMoney(
      toCents(row.amount_cents) - toCents(row.amount_paid_cents),
      row.currency,
    ),
    today,
    splitLastDate: isOfferable(classification.promisedDate, today)
      ? classification.promisedDate
      : null,
    suggestion: suggestionFor(classification, today, row.milestone_id !== null),
  };
};

export const listPendingReplies = async (db: Db, now: Date): Promise<ReplyItem[]> => {
  const { rows } = await db.query<ReplyRow>(
    `${REPLY_SELECT} AND msg.review_status = 'pending' ORDER BY msg.created_at LIMIT 100`,
  );
  return rows.map((row) => toItem(row, now));
};

/** For the Telegram run, which covers every freelancer as the service role. */
export const loadRepliesById = async (
  db: Db,
  ids: readonly string[],
  now: Date,
): Promise<Map<string, ReplyItem>> => {
  const { rows } = await db.query<ReplyRow>(`${REPLY_SELECT} AND msg.id = ANY($1::uuid[])`, [ids]);
  return new Map(rows.map((row) => [row.id, toItem(row, now)]));
};

export const countPendingReplies = async (db: Db): Promise<number> => {
  const { rows } = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM public.messages WHERE review_status = 'pending'",
  );
  return rows[0]?.count ?? 0;
};

export type HeldInvoice = {
  id: string;
  clientName: string;
  what: string;
  pausedUntil: string | null;
};

/** Invoices still on hold after their replies were reviewed, or paused until a later date. */
export const listHeldInvoices = async (db: Db, now: Date): Promise<HeldInvoice[]> => {
  const { rows } = await db.query<{
    id: string;
    client_name: string;
    title: string | null;
    milestone_name: string | null;
    invoice_number: string;
    paused_until: string | null;
    held: boolean;
    time_zone: string;
  }>(
    `SELECT i.id::text, c.name AS client_name, p.title, coalesce(m.name, rt.name) AS milestone_name, i.invoice_number,
       i.reminders_paused_until::text AS paused_until, i.reminders_held_at IS NOT NULL AS held,
       c.time_zone
     FROM public.invoices i
     LEFT JOIN public.milestones m ON m.id = i.milestone_id
     LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
     LEFT JOIN public.projects p ON p.id = coalesce(m.project_id, rt.project_id)
     JOIN public.clients c ON c.id = coalesce(p.client_id, rt.client_id)
     WHERE i.status IN ('sent', 'partially_paid')
       AND (i.reminders_held_at IS NOT NULL OR i.reminders_paused_until IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM public.messages msg
         WHERE msg.invoice_id = i.id AND msg.review_status = 'pending')
     ORDER BY i.due_date LIMIT 100`,
  );
  return rows
    .filter((row) => row.held || (row.paused_until ?? "") > todayIn(now, row.time_zone))
    .map((row) => ({
      id: row.id,
      clientName: row.client_name,
      what: [row.title, row.milestone_name, row.invoice_number]
        .filter((part) => part !== null)
        .join(" · "),
      pausedUntil: row.paused_until,
    }));
};

export type ReviewResult =
  | { status: "ok"; done: "pause" | "hold" | "resume"; until?: string }
  | { status: "split_needed" }
  | { status: "not_found" }
  | { status: "handled" };

const loadReply = async (db: Db, id: string): Promise<ReplyRow | undefined> => {
  const { rows } = await db.query<ReplyRow>(`${REPLY_SELECT} AND msg.id = $1`, [id]);
  return rows[0];
};

/** Done once: of two racing decisions, only the first counts. */
const markDone = async (db: Db, id: string, action: string, now: Date): Promise<boolean> => {
  const { rowCount } = await db.query(
    `UPDATE public.messages SET review_status = 'done', reviewed_at = $2, reviewed_action = $3
     WHERE id = $1 AND review_status = 'pending'`,
    [id, now.toISOString(), action],
  );
  return rowCount > 0;
};

const record = (db: Db, invoiceId: string, type: string, payload: object) =>
  db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
     VALUES ((SELECT auth.uid()), 'invoice', $1, $2, $3)`,
    [invoiceId, type, JSON.stringify(payload)],
  );

/** A reply covers every invoice on its thread. Without a thread, just its own invoice. */
const setHold = async (
  db: Db,
  row: ReplyRow,
  sets: { held: boolean; pausedUntil: string | null },
): Promise<void> => {
  await db.query(
    `UPDATE public.invoices
     SET reminders_held_at = CASE WHEN $3 THEN reminders_held_at END, reminders_paused_until = $4
     WHERE id = $1 OR (gmail_thread_id = $2 AND status IN ('sent', 'partially_paid'))`,
    [row.invoice_id, row.thread_id, sets.held, sets.pausedUntil],
  );
};

/** The freelancer accepted what's suggested. A split is settled in the dashboard. */
export const applyReply = async (db: Db, id: string, now: Date): Promise<ReviewResult> => {
  const row = await loadReply(db, id);
  if (!row) return { status: "not_found" };
  if (row.review_status !== "pending") return { status: "handled" };
  const suggestion = suggestionFor(
    classificationOf(row.ai_classification),
    todayIn(now, row.time_zone),
    row.milestone_id !== null,
  );
  if (suggestion.kind === "split") return { status: "split_needed" };
  if (!(await markDone(db, id, suggestion.kind, now))) return { status: "handled" };
  if (suggestion.kind === "pause") {
    await setHold(db, row, { held: false, pausedUntil: suggestion.until });
    await record(db, row.invoice_id, "reminders.paused", { until: suggestion.until });
    return { status: "ok", done: "pause", until: suggestion.until };
  }
  await record(db, row.invoice_id, "reminders.kept_on_hold", {});
  return { status: "ok", done: "hold" };
};

/** The freelancer wants reminders to carry on: this clears the hold and any pause. */
export const resumeReply = async (db: Db, id: string, now: Date): Promise<ReviewResult> => {
  const row = await loadReply(db, id);
  if (!row) return { status: "not_found" };
  if (row.review_status !== "pending") return { status: "handled" };
  if (!(await markDone(db, id, "resume", now))) return { status: "handled" };
  await setHold(db, row, { held: false, pausedUntil: null });
  await record(db, row.invoice_id, "reminders.resumed", {});
  return { status: "ok", done: "resume" };
};

/** Resumes an invoice later on, after the hold was kept or a pause was set. */
export const resumeInvoice = async (db: Db, invoiceId: string): Promise<boolean> => {
  const { rows } = await db.query<{ gmail_thread_id: string | null }>(
    "SELECT gmail_thread_id FROM public.invoices WHERE id = $1",
    [invoiceId],
  );
  const invoice = rows[0];
  if (!invoice) return false;
  await db.query(
    `UPDATE public.invoices SET reminders_held_at = NULL, reminders_paused_until = NULL
     WHERE id = $1 OR (gmail_thread_id = $2 AND status IN ('sent', 'partially_paid'))`,
    [invoiceId, invoice.gmail_thread_id],
  );
  await record(db, invoiceId, "reminders.resumed", {});
  return true;
};
