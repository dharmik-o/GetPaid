import Link from "next/link";
import { formatDay, formatMoney } from "@/lib/format";
import type { Upcoming, UpcomingItem } from "@/lib/upcoming";

// The next 90 days, grouped by week. A list, not a calendar. Each currency keeps its own total:
// amounts are as stored and never converted.

const KIND_NAMES: Record<UpcomingItem["kind"], string> = {
  maintenance: "Maintenance",
  renewal: "Renewal",
  retainer: "Retainer",
};

const LINKS: Record<UpcomingItem["kind"], string> = {
  maintenance: "/maintenance",
  renewal: "/maintenance",
  retainer: "/retainers",
};

export const UpcomingList = ({ upcoming }: { upcoming: Upcoming }) => {
  if (upcoming.weeks.length === 0) {
    return (
      <section className="card empty" aria-label="Upcoming">
        <h2>Upcoming</h2>
        <p>
          Nothing in the next 90 days. Add a <Link href="/retainers">retainer</Link> or a{" "}
          <Link href="/maintenance">maintenance job</Link>, and its dates and expected income appear
          here.
        </p>
      </section>
    );
  }
  return (
    <section className="card" aria-label="Upcoming">
      <h2>Upcoming</h2>
      <p className="muted">
        The next 90 days, up to {formatDay(upcoming.until)}. Expected income:{" "}
        {upcoming.totals.length === 0 ? "none estimated yet" : null}
      </p>
      {upcoming.totals.length > 0 ? (
        <ul aria-label="Expected income by currency" className="income-totals">
          {upcoming.totals.map((total) => (
            <li key={total.currency} className="metric-value">
              {formatMoney(total.cents, total.currency)}
            </li>
          ))}
        </ul>
      ) : null}
      {upcoming.withoutEstimate > 0 ? (
        <p className="muted">
          {upcoming.withoutEstimate === 1
            ? "1 job has no estimate, so it isn't counted."
            : `${String(upcoming.withoutEstimate)} jobs have no estimate, so they aren't counted.`}
        </p>
      ) : null}
      {upcoming.weeks.map((week) => (
        <div key={week.weekOf} className="table-scroll">
          <table className="table table-stack">
            <caption>Week of {formatDay(week.weekOf)}</caption>
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col">Date</th>
                <th scope="col" className="money">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {week.items.map((item) => (
                <tr key={item.key}>
                  <td data-label="What">
                    <Link href={LINKS[item.kind]}>{item.name}</Link>
                    <div className="muted">
                      {KIND_NAMES[item.kind]} · {item.clientName}
                    </div>
                  </td>
                  <td data-label="Date">{formatDay(item.date)}</td>
                  <td className="money" data-label="Amount">
                    {item.amountCents === null || item.currency === null
                      ? "No estimate"
                      : formatMoney(item.amountCents, item.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
};
