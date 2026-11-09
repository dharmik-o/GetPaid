import Link from "next/link";
import { formatDay } from "@/lib/format";
import type { CalendarItem } from "@/lib/calendar-feed";

// The next 30 days as a plain list: what, when, for whom.

const when = (item: CalendarItem, zone: string): string =>
  item.startAt === null
    ? "All day"
    : new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: zone,
      }).format(new Date(item.startAt));

export const CalendarAgenda = ({
  items,
  zone,
  days,
}: {
  items: CalendarItem[];
  zone: string;
  days: number;
}) => (
  <section className="card" aria-label="Agenda">
    <h2>Next {days} days</h2>
    {items.length === 0 ? (
      <p className="muted">
        Nothing in the next {days} days. <Link href="/calendar/new">Add an entry</Link>, or bill a
        milestone and its dates appear here.
      </p>
    ) : (
      <div className="table-scroll">
        <table className="table table-stack">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Time ({zone})</th>
              <th scope="col">What</th>
              <th scope="col">Client</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key}>
                <td data-label="Date">{formatDay(item.startsOn)}</td>
                <td data-label="Time">{when(item, zone)}</td>
                <td data-label="What">
                  <Link href={item.href}>{item.title}</Link>
                  {item.isClientMeeting ? <span className="badge chip">Client meeting</span> : null}
                  {item.status === "done" ? (
                    <span className="badge chip badge-draft">Done</span>
                  ) : null}
                </td>
                <td data-label="Client">{item.clientName ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </section>
);
