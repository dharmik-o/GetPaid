import Link from "next/link";
import { MaintenanceCard } from "@/components/MaintenanceCard";
import { getOwnTimeZone } from "@/lib/account";
import { appNow } from "@/lib/clock";
import { listMaintenanceTasks } from "@/lib/maintenance";
import { runAsCurrentUser } from "@/lib/request-user";
import { todayIn } from "@/lib/schedule";

// Maintenance jobs and renewals (domain, hosting, SSL) with their next dates and costs.

export const dynamic = "force-dynamic";

const MaintenancePage = async () => {
  const now = appNow();
  const { tasks, timeZone } = await runAsCurrentUser(async (db) => ({
    tasks: await listMaintenanceTasks(db, now),
    timeZone: await getOwnTimeZone(db),
  }));
  const today = todayIn(now, timeZone);
  return (
    <div className="page">
      <div className="page-header">
        <h1>Maintenance</h1>
        {tasks.length > 0 ? (
          <Link className="button" href="/maintenance/new">
            Add maintenance job
          </Link>
        ) : null}
      </div>
      {tasks.length === 0 ? (
        <div className="card empty">
          <p>
            No jobs or renewals yet. Add one and you&apos;ll be reminded before it&apos;s due, so
            recurring work doesn&apos;t depend on remembering it.
          </p>
          <Link className="button" href="/maintenance/new">
            Add maintenance job
          </Link>
        </div>
      ) : (
        tasks.map((task) => <MaintenanceCard key={task.id} task={task} today={today} />)
      )}
    </div>
  );
};

export default MaintenancePage;
