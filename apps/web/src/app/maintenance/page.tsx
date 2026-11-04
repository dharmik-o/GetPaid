import Link from "next/link";
import { MaintenanceCard } from "@/components/MaintenanceCard";
import { MaintenanceForm, type MaintenanceProject } from "@/components/MaintenanceForm";
import type { Db } from "@/lib/db";
import { listMaintenanceTasks } from "@/lib/maintenance";
import { runAsCurrentUser } from "@/lib/request-user";
import { todayIn } from "@/lib/schedule";

// Maintenance jobs and renewals (domain, hosting, SSL) with their next dates and costs.

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

const MaintenancePage = async () => {
  const now = new Date();
  const { tasks, projects, timeZone } = await runAsCurrentUser(async (db) => {
    const { rows } = await db.query<{ time_zone: string }>(
      "SELECT time_zone FROM public.users WHERE id = (SELECT auth.uid())",
    );
    return {
      tasks: await listMaintenanceTasks(db, now),
      projects: await loadProjects(db),
      timeZone: rows[0]?.time_zone ?? "UTC",
    };
  });
  const today = todayIn(now, timeZone);
  return (
    <div className="page">
      <div className="page-header">
        <h1>Maintenance</h1>
      </div>
      {tasks.length === 0 ? (
        <div className="card empty">
          <p>
            No jobs or renewals yet. Add one below and you&apos;ll be reminded before it&apos;s due,
            so recurring work doesn&apos;t depend on remembering it.
          </p>
        </div>
      ) : (
        tasks.map((task) => <MaintenanceCard key={task.id} task={task} today={today} />)
      )}
      {projects.length === 0 ? (
        <div className="card empty">
          <p>A job belongs to a project, so add one first.</p>
          <Link className="button" href="/projects/new">
            Add a project
          </Link>
        </div>
      ) : (
        <MaintenanceForm projects={projects} today={today} />
      )}
    </div>
  );
};

export default MaintenancePage;
