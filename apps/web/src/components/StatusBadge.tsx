import type { ReactNode } from "react";

type BadgeKind = "paid" | "sent" | "overdue" | "draft";

const KINDS: Partial<Record<string, BadgeKind>> = {
  paid: "paid",
  overdue: "overdue",
  draft: "draft",
  planned: "draft",
  cancelled: "draft",
  refunded: "draft",
};

/** How an invoice or milestone status looks. Only a real "paid" is ever yellow. */
export const statusBadgeKind = (status: string): BadgeKind => KINDS[status] ?? "sent";

type Props = { status: string; children: ReactNode };

/** A status pill. The label is always there, so colour is never the only signal. */
export const StatusBadge = ({ status, children }: Props) => (
  <span className={`badge badge-${statusBadgeKind(status)}`}>{children}</span>
);
