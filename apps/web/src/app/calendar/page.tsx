import Link from "next/link";
import { CalendarAgenda } from "@/components/CalendarAgenda";
import { CalendarMonth } from "@/components/CalendarMonth";
import { getOwnTimeZone } from "@/lib/account";
import { calendarItems } from "@/lib/calendar-feed";
import { monthGrid, monthOrToday } from "@/lib/calendar-month";
import { appNow } from "@/lib/clock";
import { runAsCurrentUser } from "@/lib/request-user";
import { addCalendarDays, todayIn } from "@/lib/schedule";

// The calendar: a month view and the next 30 days, from the freelancer's own entries and every date
// the app already knows about. App-made dates open their own pages.

export const dynamic = "force-dynamic";

const AGENDA_DAYS = 30;

const CalendarPage = async ({ searchParams }: { searchParams: Promise<{ month?: string }> }) => {
  const { month: monthParam } = await searchParams;
  const now = appNow();
  const { zone, today, month, monthItems, agendaItems } = await runAsCurrentUser(async (db) => {
    const ownZone = await getOwnTimeZone(db);
    const todayDate = todayIn(now, ownZone);
    const shown = monthOrToday(monthParam, todayDate);
    const grid = monthGrid(shown).flat();
    return {
      zone: ownZone,
      today: todayDate,
      month: shown,
      monthItems: await calendarItems(db, {
        from: grid[0] ?? todayDate,
        to: grid.at(-1) ?? todayDate,
        zone: ownZone,
      }),
      agendaItems: await calendarItems(db, {
        from: todayDate,
        to: addCalendarDays(todayDate, AGENDA_DAYS),
        zone: ownZone,
      }),
    };
  });
  return (
    <div className="page">
      <div className="page-header">
        <h1>Calendar</h1>
        <Link className="button" href="/calendar/new">
          Add entry
        </Link>
      </div>
      <CalendarMonth month={month} today={today} items={monthItems} />
      <CalendarAgenda items={agendaItems} zone={zone} days={AGENDA_DAYS} />
    </div>
  );
};

export default CalendarPage;
