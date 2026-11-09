import Link from "next/link";
import { monthGrid, shiftMonth } from "@/lib/calendar-month";
import type { CalendarItem, CalendarItemType } from "@/lib/calendar-feed";

// A month of the calendar: the six weeks that cover it, with each day's items as links. Colour is a
// hint only; every item's title says what it is.

const GROUP: Record<CalendarItemType, string> = {
  entry: "own",
  milestone_deadline: "deadline",
  hold_expiry: "deadline",
  agreement_deadline: "deadline",
  invoice_due: "money",
  retainer_charge: "money",
  reminder_send: "quiet",
  maintenance: "quiet",
  renewal: "quiet",
  imported: "quiet",
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SHOWN_PER_DAY = 3;

const monthName = (month: string): string =>
  new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${month}-01T00:00:00Z`),
  );

const onDay = (items: CalendarItem[], day: string): CalendarItem[] =>
  items.filter((item) => item.startsOn <= day && day <= (item.endsOn ?? item.startsOn));

export const CalendarMonth = ({
  month,
  today,
  items,
}: {
  month: string;
  today: string;
  items: CalendarItem[];
}) => (
  <section className="card" aria-label="Month">
    <div className="page-header">
      <h2>{monthName(month)}</h2>
      <div className="actions">
        <Link className="button button-secondary" href={`/calendar?month=${shiftMonth(month, -1)}`}>
          Previous
        </Link>
        <Link className="button button-secondary" href="/calendar">
          Today
        </Link>
        <Link className="button button-secondary" href={`/calendar?month=${shiftMonth(month, 1)}`}>
          Next
        </Link>
      </div>
    </div>
    <div className="cal-grid" role="grid" aria-label={monthName(month)}>
      {WEEKDAYS.map((name) => (
        <div key={name} className="cal-weekday" role="columnheader">
          {name}
        </div>
      ))}
      {monthGrid(month)
        .flat()
        .map((day) => {
          const dayItems = onDay(items, day);
          return (
            <div
              key={day}
              role="gridcell"
              className={`cal-day${day.slice(0, 7) === month ? "" : " cal-outside"}${day === today ? " cal-today" : ""}`}
            >
              <div className="cal-daynum">{Number(day.slice(8))}</div>
              {dayItems.slice(0, SHOWN_PER_DAY).map((item) => (
                <Link
                  key={`${item.key}:${day}`}
                  href={item.href}
                  className={`cal-item cal-${GROUP[item.type]}${item.status === "done" ? " cal-done" : ""}`}
                  title={item.title}
                >
                  {item.isClientMeeting ? "● " : ""}
                  {item.title}
                </Link>
              ))}
              {dayItems.length > SHOWN_PER_DAY ? (
                <span className="cal-more">+{dayItems.length - SHOWN_PER_DAY} more</span>
              ) : null}
            </div>
          );
        })}
    </div>
    <p className="field-hint">
      ● marks a client meeting. Gold: your entries. Red: deadlines. White: money. Grey: reminders
      and jobs.
    </p>
  </section>
);
