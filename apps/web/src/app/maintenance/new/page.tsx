import Link from "next/link";
import { MaintenanceForm, type MaintenanceProject } from "@/components/MaintenanceForm";
import { getOwnTimeZone } from "@/lib/account";
import { appNow } from "@/lib/clock";
import type { Db } from "@/lib/db";
import { runAsCurrentUser } from "@/lib/request-user";
import { todayIn } from "@/lib/schedule";

// Add a maintenance job or renewal: its own page, opened from the Maintenance list.

export const dynamic = "force-dynamic";

const loadProjects = async (db: Db): Promise<MaintenanceProject[]> => {
  const { rows } = await db.query<{
    id: string;
    title: string;
    client_name: string;
    currency: string;
  }>(
    `SELECT p.id::text, p.title, c.name AS client_name, p.currency
     FROM public.projects p JOIN public.clients c ON c.id = p.client_id
     ORDER BY lower(c.name), p.created_at`,
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    clientName: row.client_name,
    currency: row.currency,
  }));
};

const NewMaintenancePage = async () => {
  const { projects, timeZone } = await runAsCurrentUser(async (db) => ({
    projects: await loadProjects(db),
    timeZone: await getOwnTimeZone(db),
  }));
  return (
    <div className="page">
      <div className="page-header">
        <h1>Add maintenance job</h1>
        <Link href="/maintenance">Back to maintenance</Link>
      </div>
      {projects.length === 0 ? (
        <div className="card empty">
          <p>A job belongs to a project. Add your first project, then come back here.</p>
          <Link className="button" href="/projects/new">
            New project
          </Link>
        </div>
      ) : (
        <MaintenanceForm projects={projects} today={todayIn(appNow(), timeZone)} />
      )}
    </div>
  );
};

export default NewMaintenancePage;
