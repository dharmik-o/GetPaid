import Link from "next/link";
import { formatMoney } from "@/lib/format";
import type { Metrics } from "@/lib/metrics";

// Home: what the reminders recovered. Each currency keeps its own total, and a rate always shows
// its counts. Days saved needs the delay the freelancer says is usual, and is never assumed.

const days = (count: number): string => `${String(count)} ${count === 1 ? "day" : "days"}`;

const Tile = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="metric-tile">
    <p className="muted">{label}</p>
    {children}
  </div>
);

const DaysSaved = ({ metrics }: { metrics: Metrics }) => {
  if (metrics.usualDaysLate === null) {
    return (
      <p className="muted">
        <Link href="/settings">Tell us how late clients usually pay you</Link> to see this.
      </p>
    );
  }
  if (metrics.daysSaved === null) return <p className="muted">Nothing paid late to compare yet.</p>;
  return (
    <>
      <p className="metric-value">{days(metrics.daysSaved)}</p>
      <p className="muted">
        Per invoice, against the {days(metrics.usualDaysLate)} you said is usual.
      </p>
    </>
  );
};

export const RecoveryMetrics = ({ metrics }: { metrics: Metrics }) => {
  const { recovered, daysLate, medianDaysLate, recovery } = metrics;
  if (recovered.length === 0 && daysLate.length === 0 && recovery.total === 0) {
    return (
      <section className="card empty" aria-labelledby="recovery">
        <h2 id="recovery">Recovery</h2>
        <p>Nothing has gone overdue yet. Money you recover on late invoices shows here.</p>
      </section>
    );
  }
  return (
    <section className="card" aria-labelledby="recovery">
      <h2 id="recovery">Recovery</h2>
      <div className="metric-tiles">
        <Tile label="Amount recovered">
          {recovered.length === 0 ? (
            <p className="muted">Nothing yet.</p>
          ) : (
            recovered.map(({ currency, cents }) => (
              <p className="metric-value money-left" key={currency}>
                {formatMoney(cents, currency)}
              </p>
            ))
          )}
        </Tile>
        <Tile label="Days saved">
          <DaysSaved metrics={metrics} />
        </Tile>
        <Tile label="Typical days late">
          {medianDaysLate === null ? (
            <p className="muted">Nothing paid late yet.</p>
          ) : (
            <p className="metric-value">{`${String(medianDaysLate)} ${medianDaysLate === 1 ? "day" : "days"}`}</p>
          )}
        </Tile>
        <Tile label="Recovery rate">
          {recovery.total === 0 ? (
            <p className="muted">None to count yet.</p>
          ) : (
            <>
              <p className="metric-value">{Math.round((recovery.paid / recovery.total) * 100)}%</p>
              <p className="muted">
                {recovery.paid} of {recovery.total} paid within 30 days of the first reminder.
              </p>
            </>
          )}
        </Tile>
      </div>
      {daysLate.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <caption className="muted">Days late per invoice</caption>
            <thead>
              <tr>
                <th scope="col">Invoice</th>
                <th scope="col">Client</th>
                <th scope="col">Paid</th>
                <th scope="col" className="money">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {daysLate.map((line) => (
                <tr key={line.id}>
                  <td>{line.invoiceNumber}</td>
                  <td>
                    <Link href={`/clients/${line.clientId}#timeline`}>{line.clientName}</Link>
                  </td>
                  <td>{days(line.days)} late</td>
                  <td className="money">{formatMoney(line.amountCents, line.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
};
