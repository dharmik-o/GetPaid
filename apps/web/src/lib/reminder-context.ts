import type { Db } from "./db";
import { toCents } from "./db-values";
import { mergeSettings, type ScheduleSettings } from "./settings";
import type { Tier } from "./schedule";

// Server-only: everything a reminder's draft is written from, read as the reminder's owner
// (RLS), so another user's reminder is simply not found.

export type ReminderContext = {
  reminderId: string;
  tier: Tier;
  approvalStatus: "waiting" | "approved" | "skipped";
  hasDraft: boolean;
  invoice: {
    id: string;
    number: string;
    status: string;
    amountCents: number;
    amountPaidCents: number;
    currency: string;
    dueDate: string;
    link: string | null;
    installment: { number: number; count: number } | null;
    /** A client's reply put this invoice on hold. */
    held: boolean;
    /** The freelancer paused it until this date, in the client's zone. */
    pausedUntil: string | null;
  };
  /** null for a retainer invoice: it has `retainerName` instead. */
  milestone: { name: string; deliverable: string | null } | null;
  retainerName: string | null;
  /** null for a retainer that isn't tied to a project. */
  project: { title: string; contractTerms: string | null; lateFeeClause: string | null } | null;
  client: {
    name: string;
    country: string;
    timeZone: string;
    region: string | null;
    isBusiness: boolean;
  };
  freelancerName: string;
  /** The freelancer has an Udyam (MSME) number, which the MSMED Act needs. */
  freelancerHasUdyam: boolean;
  settings: ScheduleSettings;
};

type Row = {
  id: string;
  tier: Tier;
  approval_status: ReminderContext["approvalStatus"];
  has_draft: boolean;
  invoice_id: string;
  invoice_number: string;
  invoice_status: string;
  amount_cents: unknown;
  amount_paid_cents: unknown;
  currency: string;
  due_date: string;
  link: string | null;
  installment_number: number | null;
  installment_count: number | null;
  held: boolean;
  paused_until: string | null;
  milestone_name: string | null;
  retainer_name: string | null;
  deliverable: string | null;
  milestone_settings: unknown;
  title: string | null;
  contract_terms: string | null;
  late_fee_clause: string | null;
  project_settings: unknown;
  client_name: string;
  country: string;
  time_zone: string;
  client_settings: unknown;
  region: string | null;
  is_business: boolean;
  freelancer_name: string;
  has_udyam: boolean;
  account_settings: unknown;
};

const SELECT = `
  SELECT r.id::text, r.tier, r.approval_status, r.draft IS NOT NULL AS has_draft,
    i.id::text AS invoice_id, i.invoice_number, i.status AS invoice_status,
    i.amount_cents::text, i.amount_paid_cents::text, i.currency, i.due_date::text, i.link,
    i.installment_number, i.installment_count, i.reminders_held_at IS NOT NULL AS held,
    i.reminders_paused_until::text AS paused_until,
    m.name AS milestone_name, rt.name AS retainer_name, m.deliverable,
    m.settings AS milestone_settings,
    p.title, p.contract_terms,
    coalesce(
      (SELECT ag.facts ->> 'lateFeeClauseText' FROM public.agreements ag
       WHERE ag.project_id = p.id AND ag.status = 'signed'
       ORDER BY ag.version DESC LIMIT 1),
      p.late_fee_clause) AS late_fee_clause,
    p.settings AS project_settings,
    c.name AS client_name, c.country, c.time_zone, c.region, c.is_business, c.settings AS client_settings,
    u.name AS freelancer_name, u.udyam_number IS NOT NULL AS has_udyam, u.default_settings AS account_settings
  FROM public.reminders r
  JOIN public.invoices i ON i.id = r.invoice_id
  LEFT JOIN public.milestones m ON m.id = i.milestone_id
  LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
  LEFT JOIN public.projects p ON p.id = coalesce(m.project_id, rt.project_id)
  JOIN public.clients c ON c.id = coalesce(p.client_id, rt.client_id)
  JOIN public.users u ON u.id = r.user_id
  WHERE r.id = $1`;

export const loadReminderContext = async (
  db: Db,
  reminderId: string,
): Promise<ReminderContext | undefined> => {
  const { rows } = await db.query<Row>(SELECT, [reminderId]);
  const row = rows[0];
  if (!row) return undefined;
  const installment =
    row.installment_number === null || row.installment_count === null
      ? null
      : { number: row.installment_number, count: row.installment_count };
  return {
    reminderId: row.id,
    tier: row.tier,
    approvalStatus: row.approval_status,
    hasDraft: row.has_draft,
    invoice: {
      id: row.invoice_id,
      number: row.invoice_number,
      status: row.invoice_status,
      amountCents: toCents(row.amount_cents),
      amountPaidCents: toCents(row.amount_paid_cents),
      currency: row.currency,
      dueDate: row.due_date,
      link: row.link,
      installment,
      held: row.held,
      pausedUntil: row.paused_until,
    },
    milestone:
      row.milestone_name === null
        ? null
        : { name: row.milestone_name, deliverable: row.deliverable },
    retainerName: row.retainer_name,
    project:
      row.title === null
        ? null
        : {
            title: row.title,
            contractTerms: row.contract_terms,
            lateFeeClause: row.late_fee_clause,
          },
    client: {
      name: row.client_name,
      country: row.country,
      timeZone: row.time_zone,
      region: row.region,
      isBusiness: row.is_business,
    },
    freelancerName: row.freelancer_name,
    freelancerHasUdyam: row.has_udyam,
    settings: mergeSettings({
      account: row.account_settings,
      client: row.client_settings,
      project: row.project_settings,
      milestone: row.milestone_settings,
    }),
  };
};
