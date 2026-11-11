import Link from "next/link";
import { CalendarSoon } from "@/components/CalendarSoon";
import { NeedsAttention } from "@/components/NeedsAttention";
import { RecoveryMetrics } from "@/components/RecoveryMetrics";
import { RetainerAlerts } from "@/components/RetainerAlerts";
import { UpcomingList } from "@/components/UpcomingList";
import { getOwnTimeZone } from "@/lib/account";
import { listEntries } from "@/lib/calendar-entries";
import { appNow } from "@/lib/clock";
import { loadMetrics } from "@/lib/metrics";
import { outboxCounts } from "@/lib/outbox";
import { runAsCurrentUser } from "@/lib/request-user";
import { listRetainerAlerts } from "@/lib/retainers";
import { addCalendarDays, todayIn } from "@/lib/schedule";
import { loadUpcoming } from "@/lib/upcoming";

// Home: what needs attention first, then what was recovered, then the next 90 days.

export const dynamic = "force-dynamic";

const CALENDAR_DAYS = 7;

const HomePage = async () => {
  const now = appNow();
  const { alerts, upcoming, clientCount, metrics, counts, entries } = await runAsCurrentUser(
    async (db) => {
      const { rows } = await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM public.clients",
      );
      const today = todayIn(now, await getOwnTimeZone(db));
      return {
        alerts: await listRetainerAlerts(db),
        upcoming: await loadUpcoming(db, now),
        clientCount: rows[0]?.count ?? 0,
        metrics: await loadMetrics(db, now),
        counts: await outboxCounts(db),
        entries: await listEntries(db, today, addCalendarDays(today, CALENDAR_DAYS)),
      };
    },
  );
  return (
    <div className="page">
      <div className="page-header">
        <h1>Home</h1>
      </div>
      <RetainerAlerts alerts={alerts} />
      {clientCount === 0 ? (
        <div className="card empty" data-tour="needs-attention">
          <p>Nothing needs your attention yet. Start by adding a client.</p>
          <Link className="button" href="/clients">
            Go to clients
          </Link>
        </div>
      ) : (
        <>
          <NeedsAttention waiting={counts.waiting} overdue={metrics.overdue} />
          <RecoveryMetrics metrics={metrics} />
          <UpcomingList upcoming={upcoming} />
          <CalendarSoon entries={entries} days={CALENDAR_DAYS} />
        </>
      )}
    </div>
  );
};

export default HomePage;
