import { z } from "zod";
import { REPLY_LABELS, type Classification } from "./ai-schemas";
import type { Db } from "./db";
import { formatDay, formatMoney } from "./format";

// Server-only: one client's evidence timeline, for disputes and for seeing where things stand. It
// reads events and replies as the signed-in user, so row-level security applies. Only what's listed
// here shows: a new event type stays hidden until someone decides what it should say.

export type TimelineKind = "sent" | "reply" | "payment" | "status";

export type TimelineEntry = {
  id: string;
  kind: TimelineKind;
  title: string;
  at: Date;
  /** The invoice it's about, when there is one. */
  reference: string | null;
  subject: string | null;
  /** A sent email's text, or a reply's. A reply is untrusted, and React shows it as plain text. */
  body: string | null;
  /** The AI's reading of a reply: a suggestion, never a fact. */
  aiLabel: Classification["label"] | null;
};

const TIMELINE_LIMIT = 200;

type EventRow = {
  id: string;
  type: string;
  payload: unknown;
  created_at: Date | string;
  tier: string | null;
  subject: string | null;
  body: string | null;
  invoice_number: string | null;
  currency: string | null;
};

const payloadSchema = z
  .object({
    via: z.string(),
    until: z.string(),
    count: z.number(),
    amountPaidCents: z.number(),
    amountCents: z.number(),
  })
  .partial();

type Payload = z.infer<typeof payloadSchema>;

const SENT_NAMES: Record<string, string> = {
  courtesy: "Courtesy reminder sent",
  tier1: "Friendly reminder sent (Tier 1)",
  tier2: "Firm reminder sent (Tier 2)",
  tier3: "Final notice sent (Tier 3)",
  maintenance: "Maintenance heads-up sent",
  auto_pay_approval: "Auto-pay approval email sent",
  hold_approval: "Hold approval email sent",
};

const APPROVED_VIA: Record<string, string> = {
  telegram: "Approved on Telegram",
  outbox: "Approved in the Outbox",
  auto_send_tier1: "Approved automatically: you chose auto-send for Tier 1",
};

type Described = { kind: TimelineKind; title: string };

const money = (cents: number | undefined, currency: string | null): string | null =>
  cents === undefined || currency === null ? null : formatMoney(cents, currency);

const status = (title: string): Described => ({ kind: "status", title });

/** Words for each event worth keeping as evidence. Anything else is left out. */
const DESCRIBE: Record<string, (row: EventRow, payload: Payload) => Described> = {
  "reminder.sent": ({ tier }) => ({
    kind: "sent",
    title: SENT_NAMES[tier ?? ""] ?? "Email sent",
  }),
  "reminder.approved": (_row, { via }) => status(APPROVED_VIA[via ?? ""] ?? "Approved"),
  "reminder.skipped": () => status("Draft skipped: not sent"),
  "reminder.edited": () => status("Draft edited by hand"),
  "reminder.redrafted": () => status("Draft reworded from your note"),
  "reminder.stopped": () => status("Reminder stopped before sending"),
  "reminder.rescheduled": () => status("Send time changed"),
  "reminders.paused": (_row, { until }) =>
    status(until ? `Reminders paused until ${formatDay(until)}` : "Reminders paused"),
  "reminders.kept_on_hold": () => status("Reminders kept on hold"),
  "reminders.resumed": () => status("Reminders resumed"),
  "invoice.sent": () => status("Invoice sent"),
  "invoice.cancelled": () => status("Invoice cancelled"),
  "invoice.disputed": () => status("The client opened a dispute"),
  "invoice.split": (_row, { count }) =>
    status(count ? `Split into ${String(count)} installments` : "Split into installments"),
  "invoice.paid": ({ currency }, { amountPaidCents }) => ({
    kind: "payment",
    title: `${money(amountPaidCents, currency) ?? "Payment"} paid`,
  }),
  "invoice.partially_paid": ({ currency }, { amountPaidCents }) => ({
    kind: "payment",
    title: `${money(amountPaidCents, currency) ?? "Part"} paid so far`,
  }),
  "invoice.refunded": ({ currency }, { amountPaidCents }) => ({
    kind: "payment",
    title: `Refunded: ${money(amountPaidCents, currency) ?? "an amount"} is kept`,
  }),
  "hold.started": () => status("Hold requested"),
  "hold.authorized": () => status("Hold authorized by the client"),
  "hold.reauthorized": () => status("Hold reauthorized"),
  "hold.captured": ({ currency }, { amountCents }) => ({
    kind: "payment",
    title: `Hold captured: ${money(amountCents, currency) ?? "the full amount"}`,
  }),
  "hold.capture_denied": () => status("PayPal denied the capture"),
  "hold.voided": () => status("Hold voided: the money is released"),
  "hold.expired": () => status("Hold expired"),
  "retainer.created": () => status("Retainer set up"),
  "retainer.cancelled": () => status("Retainer cancelled"),
  "maintenance.done": () => status("Maintenance job done"),
};

const EVENT_TYPES = Object.keys(DESCRIBE);

/** Each event finds its client through whichever record it's about. */
const eventRows = async (db: Db, clientId: string): Promise<EventRow[]> => {
  const { rows } = await db.query<EventRow>(
    `SELECT e.id::text, e.type, e.payload, e.created_at, r.tier,
       r.draft ->> 'subject' AS subject, r.draft ->> 'body' AS body,
       i.invoice_number, coalesce(i.currency, h.currency) AS currency
     FROM public.events e
     LEFT JOIN public.reminders r ON e.entity = 'reminder' AND r.id = e.entity_id
     LEFT JOIN public.invoices i
       ON i.id = coalesce(r.invoice_id, CASE WHEN e.entity = 'invoice' THEN e.entity_id END)
     LEFT JOIN public.milestone_holds h
       ON h.id = coalesce(r.hold_id, CASE WHEN e.entity = 'hold' THEN e.entity_id END)
     LEFT JOIN public.retainers rt
       ON rt.id = coalesce(r.retainer_id, i.retainer_id,
         CASE WHEN e.entity = 'retainer' THEN e.entity_id END)
     LEFT JOIN public.maintenance_tasks mt
       ON mt.id = coalesce(r.maintenance_task_id,
         CASE WHEN e.entity = 'maintenance' THEN e.entity_id END)
     LEFT JOIN public.milestones m ON m.id = coalesce(i.milestone_id, h.milestone_id)
     LEFT JOIN public.projects p ON p.id = coalesce(m.project_id, rt.project_id, mt.project_id)
     WHERE coalesce(p.client_id, rt.client_id) = $1 AND e.type = ANY($2::text[])
     ORDER BY e.created_at DESC LIMIT ${String(TIMELINE_LIMIT)}`,
    [clientId, EVENT_TYPES],
  );
  return rows;
};

type ReplyRow = {
  id: string;
  body: string;
  ai_classification: unknown;
  created_at: Date | string;
  invoice_number: string | null;
};

const replyRows = async (db: Db, clientId: string): Promise<ReplyRow[]> => {
  const { rows } = await db.query<ReplyRow>(
    `SELECT msg.id::text, msg.body, msg.ai_classification, msg.created_at, i.invoice_number
     FROM public.messages msg
     JOIN public.invoices i ON i.id = msg.invoice_id
     LEFT JOIN public.milestones m ON m.id = i.milestone_id
     LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
     LEFT JOIN public.projects p ON p.id = coalesce(m.project_id, rt.project_id)
     WHERE msg.direction = 'in' AND coalesce(p.client_id, rt.client_id) = $1
     ORDER BY msg.created_at DESC LIMIT ${String(TIMELINE_LIMIT)}`,
    [clientId],
  );
  return rows;
};

const classificationSchema = z.object({ label: z.enum(REPLY_LABELS) });

const fromEvent = (row: EventRow): TimelineEntry | undefined => {
  const describe = DESCRIBE[row.type];
  if (!describe) return undefined;
  const described = describe(row, payloadSchema.catch({}).parse(row.payload));
  const isSend = described.kind === "sent";
  return {
    id: row.id,
    ...described,
    at: new Date(row.created_at),
    reference: row.invoice_number,
    subject: isSend ? row.subject : null,
    body: isSend ? row.body : null,
    aiLabel: null,
  };
};

const fromReply = (row: ReplyRow): TimelineEntry => ({
  id: row.id,
  kind: "reply",
  title: "The client replied",
  at: new Date(row.created_at),
  reference: row.invoice_number,
  subject: null,
  body: row.body,
  aiLabel: classificationSchema.safeParse(row.ai_classification).data?.label ?? null,
});

/** Newest first. Empty for a client that isn't this freelancer's. */
export const loadClientTimeline = async (db: Db, clientId: string): Promise<TimelineEntry[]> => {
  const events = (await eventRows(db, clientId)).flatMap((row) => fromEvent(row) ?? []);
  const replies = (await replyRows(db, clientId)).map(fromReply);
  return [...events, ...replies]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, TIMELINE_LIMIT);
};
