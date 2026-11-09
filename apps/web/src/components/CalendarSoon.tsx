import Link from "next/link";
import { formatDay } from "@/lib/format";
import type { CalendarEntry } from "@/lib/calendar-entries";

// Home: the freelancer's own calendar entries for the next 7 days.

export const CalendarSoon = ({ entries, days }: { entries: CalendarEntry[]; days: number }) => (
  <section className="card" aria-label="On your calendar">
    <h2>On your calendar</h2>
    {entries.length === 0 ? (
      <p className="muted">
        Nothing of yours in the next {days} days. <Link href="/calendar/new">Add an entry</Link>, or
        open the <Link href="/calendar">calendar</Link>.
      </p>
    ) : (
      <ul>
        {entries.map((entry) => (
          <li key={entry.id}>
            {formatDay(entry.startsOn)}
            {entry.startTime ? ` ${entry.startTime}` : ""}:{" "}
            <Link href={`/calendar/${entry.id}`}>{entry.title}</Link>
          </li>
        ))}
      </ul>
    )}
  </section>
);
