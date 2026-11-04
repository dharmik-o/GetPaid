import Link from "next/link";
import { RetainerAlerts } from "@/components/RetainerAlerts";
import { UpcomingList } from "@/components/UpcomingList";
import { runAsCurrentUser } from "@/lib/request-user";
import { listRetainerAlerts } from "@/lib/retainers";
import { loadUpcoming } from "@/lib/upcoming";

// Home: what needs attention first, then the next 90 days. Recovery metrics join in M10.

export const dynamic = "force-dynamic";

const HomePage = async () => {
  const now = new Date();
  const { alerts, upcoming, clientCount } = await runAsCurrentUser(async (db) => {
    const { rows } = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.clients",
    );
    return {
      alerts: await listRetainerAlerts(db),
      upcoming: await loadUpcoming(db, now),
      clientCount: rows[0]?.count ?? 0,
    };
  });
  return (
    <div className="page">
      <div className="page-header">
        <h1>Home</h1>
      </div>
      <RetainerAlerts alerts={alerts} />
      {clientCount === 0 ? (
        <div className="card empty">
          <p>Nothing needs your attention yet. Start by adding a client.</p>
          <Link className="button" href="/clients">
            Go to clients
          </Link>
        </div>
      ) : (
        <UpcomingList upcoming={upcoming} />
      )}
    </div>
  );
};

export default HomePage;
