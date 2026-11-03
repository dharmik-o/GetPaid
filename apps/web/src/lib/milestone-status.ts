// The milestone lifecycle from the spec: Planned, In progress, Delivered, Accepted, Invoiced,
// then Paid; a milestone can also be Partially paid, Overdue or Disputed.
// People move the work forward; money statuses are set only by the invoice flow and PayPal
// webhooks, never by a person or by text in an email. Pure: safe in client components.

export const MILESTONE_STATUSES = [
  "planned",
  "in_progress",
  "delivered",
  "accepted",
  "invoiced",
  "paid",
  "partially_paid",
  "overdue",
  "disputed",
] as const;

export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

const LABELS: Record<MilestoneStatus, string> = {
  planned: "Planned",
  in_progress: "In progress",
  delivered: "Delivered",
  accepted: "Accepted",
  invoiced: "Invoiced",
  paid: "Paid",
  partially_paid: "Partially paid",
  overdue: "Overdue",
  disputed: "Disputed",
};

export const statusLabel = (status: MilestoneStatus): string => LABELS[status];

export const isMilestoneStatus = (value: string): value is MilestoneStatus =>
  (MILESTONE_STATUSES as readonly string[]).includes(value);

/** The changes a freelancer may make by hand. Delivered can go back when changes are requested. */
const MANUAL: Partial<Record<MilestoneStatus, readonly MilestoneStatus[]>> = {
  planned: ["in_progress"],
  in_progress: ["delivered"],
  delivered: ["accepted", "in_progress"],
};

export const canMarkManually = (from: MilestoneStatus, to: MilestoneStatus): boolean =>
  MANUAL[from]?.includes(to) ?? false;

export const manualNextStatuses = (from: MilestoneStatus): readonly MilestoneStatus[] =>
  MANUAL[from] ?? [];

/** From Invoiced on, a PayPal invoice exists: its amount can't change and it can't be removed. */
export const hasInvoice = (status: MilestoneStatus): boolean =>
  ["invoiced", "paid", "partially_paid", "overdue", "disputed"].includes(status);
