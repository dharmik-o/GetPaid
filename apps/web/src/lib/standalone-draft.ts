import type { Db } from "./db";
import { toCents } from "./db-values";
import type { DraftRequest } from "./draft-facts";
import { formatFullDay, formatMoney } from "./format";
import { loadMaintenanceContext } from "./maintenance-context";
import { mergeSettings, type ScheduleSettings } from "./settings";

// Server-only: emails with no invoice behind them: a maintenance heads-up and the auto-pay approval
// email. They share the normal approval, Outbox, Telegram card and sender, and this says what each
// is about, read as its owner (RLS). Every value comes from the database, already formatted.

export type StandaloneSource =
  | { kind: "maintenance"; taskId: string }
  | { kind: "auto_pay_approval"; retainerId: string }
  | { kind: "hold_approval"; holdId: string };

export type StandaloneContext = {
  reminderId: string;
  approvalStatus: "waiting" | "approved" | "skipped";
  hasDraft: boolean;
  source: StandaloneSource;
  tier: "maintenance" | "auto_pay_approval" | "hold_approval";
  request: DraftRequest;
  /** The one link the email must carry, or null when it has none. */
  requiredLink: string | null;
  /** Why it mustn't go out any more, if so. */
  stopReason: string | undefined;
  client: { name: string; timeZone: string };
  freelancerName: string;
  settings: ScheduleSettings;
};

type ApprovalRow = {
  retainer_id: string;
  approval_status: StandaloneContext["approvalStatus"];
  has_draft: boolean;
  name: string;
  amount_cents: string;
  currency: string;
  interval_unit: "week" | "month";
  interval_count: number;
  starts_on: string;
  ends_on: string | null;
  status: string;
  link: string | null;
  client_name: string;
  time_zone: string;
  client_settings: unknown;
  project_settings: unknown;
  freelancer_name: string;
  account_settings: unknown;
};

const repeatText = (unit: string, count: number): string =>
  count === 1 ? `every ${unit}` : `every ${String(count)} ${unit}s`;

const loadApprovalContext = async (
  db: Db,
  reminderId: string,
): Promise<StandaloneContext | undefined> => {
  const { rows } = await db.query<ApprovalRow>(
    `SELECT rt.id::text AS retainer_id, r.approval_status, r.draft IS NOT NULL AS has_draft, rt.name,
       rt.amount_cents::text, rt.currency, rt.interval_unit, rt.interval_count,
       rt.starts_on::text, rt.ends_on::text, rt.status, rt.paypal_approval_link AS link,
       c.name AS client_name, c.time_zone, c.settings AS client_settings,
       p.settings AS project_settings, u.name AS freelancer_name,
       u.default_settings AS account_settings
     FROM public.reminders r
     JOIN public.retainers rt ON rt.id = r.retainer_id
     JOIN public.clients c ON c.id = rt.client_id
     JOIN public.users u ON u.id = r.user_id
     LEFT JOIN public.projects p ON p.id = rt.project_id
     WHERE r.id = $1`,
    [reminderId],
  );
  const row = rows[0];
  if (!row) return undefined;
  const waiting = row.status === "pending_approval" && row.link !== null;
  return {
    reminderId,
    approvalStatus: row.approval_status,
    hasDraft: row.has_draft,
    source: { kind: "auto_pay_approval", retainerId: row.retainer_id },
    tier: "auto_pay_approval",
    request: {
      kind: "auto_pay_approval",
      facts: {
        freelancerName: row.freelancer_name,
        clientName: row.client_name,
        retainerName: row.name,
        amount: formatMoney(toCents(row.amount_cents), row.currency),
        repeat: repeatText(row.interval_unit, row.interval_count),
        firstCharge: formatFullDay(row.starts_on),
        lastCharge: row.ends_on === null ? null : formatFullDay(row.ends_on),
        approvalLink: row.link ?? "",
      },
    },
    requiredLink: row.link,
    stopReason: waiting ? undefined : "the retainer is no longer waiting for the client's approval",
    client: { name: row.client_name, timeZone: row.time_zone },
    freelancerName: row.freelancer_name,
    settings: mergeSettings({
      account: row.account_settings,
      client: row.client_settings,
      project: row.project_settings,
    }),
  };
};

const maintenanceStop = (taskActive: boolean, aboutDue: string | null, nextDue: string) => {
  if (!taskActive) return "the job was stopped";
  return aboutDue === nextDue ? undefined : "the job's date has changed";
};

type HoldEmailRow = {
  hold_id: string;
  approval_status: StandaloneContext["approvalStatus"];
  has_draft: boolean;
  status: string;
  link: string | null;
  amount_cents: string;
  currency: string;
  milestone_name: string;
  milestone_settings: unknown;
  title: string;
  project_settings: unknown;
  client_name: string;
  time_zone: string;
  client_settings: unknown;
  freelancer_name: string;
  account_settings: unknown;
};

const loadHoldContext = async (
  db: Db,
  reminderId: string,
): Promise<StandaloneContext | undefined> => {
  const { rows } = await db.query<HoldEmailRow>(
    `SELECT h.id::text AS hold_id, r.approval_status, r.draft IS NOT NULL AS has_draft, h.status,
       h.approval_link AS link, h.amount_cents::text, h.currency, m.name AS milestone_name,
       m.settings AS milestone_settings, p.title, p.settings AS project_settings,
       c.name AS client_name, c.time_zone, c.settings AS client_settings,
       u.name AS freelancer_name, u.default_settings AS account_settings
     FROM public.reminders r
     JOIN public.milestone_holds h ON h.id = r.hold_id
     JOIN public.milestones m ON m.id = h.milestone_id
     JOIN public.projects p ON p.id = m.project_id
     JOIN public.clients c ON c.id = p.client_id
     JOIN public.users u ON u.id = r.user_id
     WHERE r.id = $1`,
    [reminderId],
  );
  const row = rows[0];
  if (!row) return undefined;
  const waiting = row.status === "pending_approval" && row.link !== null;
  return {
    reminderId,
    approvalStatus: row.approval_status,
    hasDraft: row.has_draft,
    source: { kind: "hold_approval", holdId: row.hold_id },
    tier: "hold_approval",
    request: {
      kind: "hold_approval",
      facts: {
        freelancerName: row.freelancer_name,
        clientName: row.client_name,
        projectTitle: row.title,
        milestoneName: row.milestone_name,
        amount: formatMoney(toCents(row.amount_cents), row.currency),
        approvalLink: row.link ?? "",
      },
    },
    requiredLink: row.link,
    stopReason: waiting ? undefined : "the hold is no longer waiting for the client",
    client: { name: row.client_name, timeZone: row.time_zone },
    freelancerName: row.freelancer_name,
    settings: mergeSettings({
      account: row.account_settings,
      client: row.client_settings,
      project: row.project_settings,
      milestone: row.milestone_settings,
    }),
  };
};

/** The email with no invoice behind it, or undefined if this reminder has an invoice. */
export const loadStandaloneContext = async (
  db: Db,
  reminderId: string,
): Promise<StandaloneContext | undefined> => {
  const job = await loadMaintenanceContext(db, reminderId);
  if (!job) {
    return (await loadApprovalContext(db, reminderId)) ?? loadHoldContext(db, reminderId);
  }
  return {
    reminderId,
    approvalStatus: job.approvalStatus,
    hasDraft: job.hasDraft,
    source: { kind: "maintenance", taskId: job.taskId },
    tier: "maintenance",
    request: { kind: "maintenance", facts: job.facts },
    requiredLink: null,
    stopReason: maintenanceStop(job.taskActive, job.aboutDue, job.nextDue),
    client: job.client,
    freelancerName: job.freelancerName,
    settings: job.settings,
  };
};
