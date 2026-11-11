import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { formatMoney } from "@/lib/format";
import type { Metrics } from "@/lib/metrics";

// Home's first card: what needs the freelancer now. The state is in words as well as on the badge.

type Props = { waiting: number; overdue: Metrics["overdue"] };

export const NeedsAttention = ({ waiting, overdue }: Props) => {
  if (waiting === 0 && overdue.length === 0) {
    return (
      <section className="card" aria-labelledby="attention" data-tour="needs-attention">
        <h2 id="attention">Needs attention</h2>
        <p className="muted">Nothing needs you right now.</p>
      </section>
    );
  }
  return (
    <section className="card" aria-labelledby="attention" data-tour="needs-attention">
      <h2 id="attention">Needs attention</h2>
      {waiting > 0 ? (
        <p>
          <Link className="button" href="/outbox">
            {waiting} {waiting === 1 ? "draft" : "drafts"} waiting for approval
          </Link>
        </p>
      ) : null}
      {overdue.length > 0 ? (
        <ul className="attention-list">
          {overdue.map((line) => (
            <li key={line.id}>
              <Link href={`/clients/${line.clientId}#timeline`}>{line.clientName}</Link>
              <span className="muted"> · {line.invoiceNumber}</span>
              <span className="money-left"> {formatMoney(line.remainingCents, line.currency)}</span>
              <StatusBadge status="overdue">
                {line.days} {line.days === 1 ? "day" : "days"} overdue
              </StatusBadge>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};
