import type { Db } from "./db";
import { toCents } from "./db-values";
import { formatMoney } from "./format";
import { holdWindow } from "./schedule";

// Server-only: milestone holds as the dashboard and flows read them. PayPal's ids and the approval
// link stay on the server: the link reaches the browser only inside its email draft.

export const LIVE_HOLD_STATUSES = [
  "creating",
  "pending_approval",
  "authorized",
  "capturing",
] as const;

export type HoldStatus =
  (typeof LIVE_HOLD_STATUSES)[number] | "captured" | "voided" | "expired" | "failed";

export const isLiveHold = (status: HoldStatus): boolean =>
  (LIVE_HOLD_STATUSES as readonly string[]).includes(status);

/** SQL: fixed values, safe to place in a query. */
export const LIVE_HOLD_SQL = LIVE_HOLD_STATUSES.map((status) => `'${status}'`).join(", ");

export type HoldNoticeKind =
  "authorized" | "captured" | "capture_failed" | "capture_denied" | "expired" | "voided_in_paypal";

export type HoldView = {
  id: string;
  milestoneId: string;
  status: HoldStatus;
  amountCents: number;
  currency: string;
  /** Past the 3-day honor period, so capture reauthorizes first. */
  pastHonor: boolean;
  captureFailed: boolean;
  approvalEmail: "none" | "waiting" | "scheduled" | "sent";
};

type ViewRow = {
  id: string;
  milestone_id: string;
  status: HoldStatus;
  amount_cents: string;
  currency: string;
  authorized_at: Date | string | null;
  reauthorized_at: Date | string | null;
  capture_failed_at: Date | string | null;
  email_status: string | null;
  email_sent: boolean | null;
};

const emailState = (row: ViewRow): HoldView["approvalEmail"] => {
  if (row.email_sent) return "sent";
  if (row.email_status === "waiting") return "waiting";
  return row.email_status === "approved" ? "scheduled" : "none";
};

/** Each milestone's latest hold, in this project. */
export const listHoldsForProject = async (
  db: Db,
  projectId: string,
  now: Date,
): Promise<HoldView[]> => {
  const { rows } = await db.query<ViewRow>(
    `SELECT DISTINCT ON (h.milestone_id) h.id::text, h.milestone_id::text, h.status,
       h.amount_cents::text, h.currency, h.authorized_at, h.reauthorized_at, h.capture_failed_at,
       e.approval_status AS email_status, e.sent_at IS NOT NULL AS email_sent
     FROM public.milestone_holds h
     JOIN public.milestones m ON m.id = h.milestone_id
     LEFT JOIN LATERAL (
       SELECT r.approval_status, r.sent_at FROM public.reminders r
       WHERE r.hold_id = h.id ORDER BY r.created_at DESC LIMIT 1
     ) e ON true
     WHERE m.project_id = $1
     ORDER BY h.milestone_id, h.created_at DESC`,
    [projectId],
  );
  return rows.map((row) => ({
    id: row.id,
    milestoneId: row.milestone_id,
    status: row.status,
    amountCents: toCents(row.amount_cents),
    currency: row.currency,
    pastHonor:
      row.authorized_at !== null &&
      holdWindow({
        authorizedAt: new Date(row.authorized_at),
        reauthorizedAt: row.reauthorized_at === null ? null : new Date(row.reauthorized_at),
        now,
      }).pastHonor,
    captureFailed: row.capture_failed_at !== null,
    approvalEmail: emailState(row),
  }));
};

export type NoticeFacts = {
  clientName: string;
  milestoneName: string;
  amountCents: number;
  currency: string;
};

/** What the freelancer hears on Telegram, built only from the database. */
export const holdNoticeText = (kind: HoldNoticeKind, facts: NoticeFacts): string => {
  const what = `${facts.milestoneName} (${facts.clientName})`;
  const amount = formatMoney(facts.amountCents, facts.currency);
  switch (kind) {
    case "authorized":
      return `The client authorized ${amount} for ${what}. The money is on hold, so the work can start. It's captured when you mark the milestone Accepted.`;
    case "captured":
      return `${amount} captured for ${what}. The milestone is paid.`;
    case "capture_failed":
      return `PayPal didn't capture ${amount} for ${what}. The hold is still in place, and this tries again each hour. You can also try from the project page.`;
    case "capture_denied":
      return `PayPal denied the capture of ${amount} for ${what}, so no money was taken. Talk to the client, then start a new hold or change how this milestone is paid.`;
    case "expired":
      return `The hold of ${amount} for ${what} expired after 29 days, so no money was taken. Start a new hold or change how this milestone is paid.`;
    case "voided_in_paypal":
      return `The hold of ${amount} for ${what} was voided in PayPal, so no money was taken. Start a new hold or change how this milestone is paid.`;
  }
};
