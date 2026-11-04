import { RetainerAlerts } from "@/components/RetainerAlerts";
import { RetainerCard } from "@/components/RetainerCard";
import { RetainerForm, type RetainerClient } from "@/components/RetainerForm";
import { appNow } from "@/lib/clock";
import type { Db } from "@/lib/db";
import { runAsCurrentUser } from "@/lib/request-user";
import { listRetainerAlerts, listRetainers } from "@/lib/retainers";
import { todayIn } from "@/lib/schedule";

// Recurring fees: auto-pay (PayPal subscription) or invoice each cycle.

export const dynamic = "force-dynamic";

const loadClients = async (db: Db): Promise<RetainerClient[]> => {
  const { rows } = await db.query<{
    id: string;
    name: string;
    project_id: string | null;
    title: string | null;
  }>(
    `SELECT c.id::text, c.name, p.id::text AS project_id, p.title
     FROM public.clients c LEFT JOIN public.projects p ON p.client_id = c.id
     ORDER BY lower(c.name), c.id, p.created_at`,
  );
  const clients = new Map<string, RetainerClient>();
  for (const row of rows) {
    const client = clients.get(row.id) ?? { id: row.id, name: row.name, projects: [] };
    if (row.project_id && row.title) client.projects.push({ id: row.project_id, title: row.title });
    clients.set(row.id, client);
  }
  return [...clients.values()];
};

const RetainersPage = async () => {
  const now = appNow();
  const { retainers, alerts, clients, timeZone } = await runAsCurrentUser(async (db) => {
    const { rows } = await db.query<{ time_zone: string }>(
      "SELECT time_zone FROM public.users WHERE id = (SELECT auth.uid())",
    );
    return {
      retainers: await listRetainers(db, now),
      alerts: await listRetainerAlerts(db),
      clients: await loadClients(db),
      timeZone: rows[0]?.time_zone ?? "UTC",
    };
  });
  return (
    <div className="page">
      <div className="page-header">
        <h1>Retainers</h1>
      </div>
      <RetainerAlerts alerts={alerts} />
      {retainers.length === 0 ? (
        <div className="card empty">
          <p>
            No retainers yet. Add a recurring fee below: the client approves auto-pay once, or gets
            an invoice each cycle.
          </p>
        </div>
      ) : (
        retainers.map((retainer) => <RetainerCard key={retainer.id} retainer={retainer} />)
      )}
      {clients.length === 0 ? (
        <div className="card empty">
          <p>Add a client first: a retainer always belongs to one.</p>
        </div>
      ) : (
        <RetainerForm clients={clients} today={todayIn(now, timeZone)} />
      )}
    </div>
  );
};

export default RetainersPage;
