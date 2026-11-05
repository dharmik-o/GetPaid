import Link from "next/link";
import { RetainerForm, type RetainerClient } from "@/components/RetainerForm";
import { getOwnTimeZone } from "@/lib/account";
import { appNow } from "@/lib/clock";
import { getFreelancerDetails, signatureChoiceFrom } from "@/lib/invoice-details";
import type { Db } from "@/lib/db";
import { runAsCurrentUser } from "@/lib/request-user";
import { todayIn } from "@/lib/schedule";

// Add a retainer: its own page, opened from the Retainers list.

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

const NewRetainerPage = async () => {
  const { clients, timeZone, details } = await runAsCurrentUser(async (db) => ({
    clients: await loadClients(db),
    timeZone: await getOwnTimeZone(db),
    details: await getFreelancerDetails(db),
  }));
  return (
    <div className="page">
      <div className="page-header">
        <h1>Add retainer</h1>
        <Link href="/retainers">Back to retainers</Link>
      </div>
      {clients.length === 0 ? (
        <div className="card empty">
          <p>A retainer always belongs to a client. Add your first client, then come back here.</p>
          <Link className="button" href="/clients/new">
            Add client
          </Link>
        </div>
      ) : (
        <RetainerForm
          clients={clients}
          today={todayIn(appNow(), timeZone)}
          signature={signatureChoiceFrom(details)}
        />
      )}
    </div>
  );
};

export default NewRetainerPage;
