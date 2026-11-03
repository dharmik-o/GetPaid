import Link from "next/link";
import { notFound } from "next/navigation";
import { ClientForm } from "@/components/ClientForm";
import { DeleteClientButton } from "@/components/DeleteClientButton";
import { getClient } from "@/lib/clients";
import { allTimeZones, COUNTRIES } from "@/lib/countries";
import { isUuid } from "@/lib/db";
import { formatDay, formatMoney } from "@/lib/format";
import { listProjectsForClient } from "@/lib/projects";
import { runAsCurrentUser } from "@/lib/request-user";

// One client: details and totals. The history timeline (messages, replies, payments) comes in M10.

export const dynamic = "force-dynamic";

const ClientPage = async ({ params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { client, projects } = await runAsCurrentUser(async (db) => ({
    client: await getClient(db, id),
    projects: await listProjectsForClient(db, id),
  }));
  if (!client) notFound();

  return (
    <div className="page">
      <div className="page-header">
        <h1>{client.name}</h1>
        <Link href="/clients">Back to clients</Link>
      </div>

      <section className="card" aria-labelledby="summary">
        <h2 id="summary">Summary</h2>
        <dl className="details">
          <dt>Billing email</dt>
          <dd>{client.email}</dd>
          <dt>Country</dt>
          <dd>{client.countryName}</dd>
          <dt>Time zone</dt>
          <dd>{client.timeZone}</dd>
          <dt>Open balance</dt>
          <dd className="money" style={{ textAlign: "left" }}>
            {client.openBalances.length === 0
              ? "Nothing owed"
              : client.openBalances.map((b) => formatMoney(b.cents, b.currency)).join(", ")}
          </dd>
        </dl>
      </section>

      <section className="card" aria-labelledby="projects">
        <div className="page-header">
          <h2 id="projects">Projects</h2>
          <Link className="button button-secondary" href={`/projects/new?clientId=${client.id}`}>
            New project
          </Link>
        </div>
        {projects.length === 0 ? (
          <p className="muted">
            No projects yet. Create one to set the deadline, terms and reminders.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Deadline</th>
                <th scope="col" className="money">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id}>
                  <td>
                    <Link href={`/projects/${project.id}`}>{project.title}</Link>
                  </td>
                  <td>{project.deadline ? formatDay(project.deadline) : "Not set"}</td>
                  <td className="money">{formatMoney(project.totalCents, project.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" aria-labelledby="edit">
        <h2 id="edit">Edit details</h2>
        <ClientForm
          countries={[...COUNTRIES]}
          allTimeZones={allTimeZones()}
          initial={{
            id: client.id,
            name: client.name,
            email: client.email,
            country: client.country,
            timeZone: client.timeZone,
          }}
        />
      </section>

      <section className="card" aria-labelledby="danger">
        <h2 id="danger">Delete</h2>
        <p className="muted">Deletes the client with all their projects, invoices and messages.</p>
        <DeleteClientButton id={client.id} name={client.name} />
      </section>
    </div>
  );
};

export default ClientPage;
