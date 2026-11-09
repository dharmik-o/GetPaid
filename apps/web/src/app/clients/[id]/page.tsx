import Link from "next/link";
import { notFound } from "next/navigation";
import { ClientForm } from "@/components/ClientForm";
import { ClientInvoiceDetailsForm } from "@/components/ClientInvoiceDetailsForm";
import { DeleteClientButton } from "@/components/DeleteClientButton";
import { ClientInvoices } from "@/components/InvoiceHistory";
import { Timeline } from "@/components/Timeline";
import { getOwnTimeZone } from "@/lib/account";
import { appNow } from "@/lib/clock";
import { getClient } from "@/lib/clients";
import { allTimeZones, COUNTRIES } from "@/lib/countries";
import { isUuid } from "@/lib/db";
import { formatDay, formatMoney } from "@/lib/format";
import { getClientDetails } from "@/lib/invoice-details";
import { listClientInvoices, parseHistoryFilters } from "@/lib/invoice-history";
import { listTemplates } from "@/lib/invoice-templates";
import { listProjectsForClient } from "@/lib/projects";
import { runAsCurrentUser } from "@/lib/request-user";
import { loadClientTimeline } from "@/lib/timeline";

// One client: details, totals and the evidence timeline (messages, replies, payments, events).

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const ClientPage = async ({ params, searchParams }: Props) => {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const query = await searchParams;
  const onInvoices = query.tab === "invoices";
  const now = appNow();
  const data = await runAsCurrentUser(async (db) => ({
    client: await getClient(db, id),
    projects: await listProjectsForClient(db, id),
    invoiceDetails: await getClientDetails(db, id),
    templates: await listTemplates(db),
    timeline: await loadClientTimeline(db, id),
    ownZone: await getOwnTimeZone(db),
    invoices: onInvoices ? await listClientInvoices(db, id, now) : [],
  }));
  const { client, projects, invoiceDetails, templates, timeline, ownZone, invoices } = data;
  if (!client) notFound();

  return (
    <div className="page">
      <div className="page-header">
        <h1>{client.name}</h1>
        <Link href="/clients">Back to clients</Link>
      </div>

      <nav className="tabs" aria-label="This client">
        <Link href={`/clients/${client.id}`} aria-current={onInvoices ? undefined : "page"}>
          Overview
        </Link>
        <Link
          href={`/clients/${client.id}?tab=invoices`}
          aria-current={onInvoices ? "page" : undefined}
        >
          Invoices
        </Link>
      </nav>

      {onInvoices ? (
        <ClientInvoices
          clientId={client.id}
          invoices={invoices}
          filters={parseHistoryFilters(query)}
          zone={ownZone}
        />
      ) : (
        <>
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
              <dd className="balance-value">
                {client.openBalances.length === 0
                  ? "Nothing owed"
                  : client.openBalances.map((b) => formatMoney(b.cents, b.currency)).join(", ")}
              </dd>
            </dl>
          </section>

          <section className="card" aria-labelledby="projects">
            <div className="page-header">
              <h2 id="projects">Projects</h2>
              <Link
                className="button button-secondary"
                href={`/projects/new?clientId=${client.id}`}
              >
                New project
              </Link>
            </div>
            {projects.length === 0 ? (
              <p className="muted">
                No projects yet. Create one to set the deadline, terms and reminders.
              </p>
            ) : (
              <div className="table-scroll">
                <table className="table table-stack">
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
                        <td data-label="Project">
                          <Link href={`/projects/${project.id}`}>{project.title}</Link>
                        </td>
                        <td data-label="Deadline">
                          {project.deadline ? formatDay(project.deadline) : "Not set"}
                        </td>
                        <td className="money" data-label="Total">
                          {formatMoney(project.totalCents, project.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <Timeline entries={timeline} clientZone={client.timeZone} ownZone={ownZone} />

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
                region: client.region ?? "",
                isBusiness: client.isBusiness,
              }}
            />
          </section>

          <section className="card" aria-labelledby="invoice-details">
            <h2 id="invoice-details">Invoice details</h2>
            <ClientInvoiceDetailsForm
              clientId={client.id}
              initial={invoiceDetails ?? { company: null, address: null, defaultTemplateId: null }}
              templates={templates.map(({ id: templateId, name }) => ({ id: templateId, name }))}
            />
          </section>

          <section className="card" aria-labelledby="danger">
            <h2 id="danger">Delete</h2>
            <p className="muted">
              Deletes the client with all their projects, invoices and messages. PDFs already saved
              in your invoice archive stay there.
            </p>
            <DeleteClientButton id={client.id} name={client.name} />
          </section>
        </>
      )}
    </div>
  );
};

export default ClientPage;
