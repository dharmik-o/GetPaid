import Link from "next/link";
import { notFound } from "next/navigation";
import { InvoicePanel } from "@/components/InvoicePanel";
import { MilestoneEditor } from "@/components/MilestoneEditor";
import { ProjectForm } from "@/components/ProjectForm";
import { isUuid } from "@/lib/db";
import { formatDay, formatMoney } from "@/lib/format";
import { listInvoicesForProject } from "@/lib/invoices";
import { listMilestones } from "@/lib/milestones";
import { getProject, listClientChoices } from "@/lib/projects";
import { runAsCurrentUser } from "@/lib/request-user";
import { describeSchedule } from "@/lib/schedule-preview";

// One project: details, schedule, the optional milestone plan (step 3) and its invoices.

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  completed: "Completed",
  cancelled: "Cancelled",
};

const ProjectPage = async ({ params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { project, clients, milestones, invoices } = await runAsCurrentUser(async (db) => {
    const found = await getProject(db, id);
    return {
      project: found,
      clients: await listClientChoices(db),
      milestones: found ? await listMilestones(db, found) : [],
      invoices: found ? await listInvoicesForProject(db, found.id) : [],
    };
  });
  if (!project) notFound();

  const schedule = { ...project.inherited, ...project.settings };

  return (
    <div className="page">
      <div className="page-header">
        <h1>{project.title}</h1>
        <Link href={`/clients/${project.clientId}`}>Back to {project.clientName}</Link>
      </div>

      <section className="card" aria-labelledby="summary">
        <h2 id="summary">Summary</h2>
        <dl className="details">
          <dt>Client</dt>
          <dd>
            <Link href={`/clients/${project.clientId}`}>{project.clientName}</Link>
          </dd>
          <dt>Total</dt>
          <dd>{formatMoney(project.totalCents, project.currency)}</dd>
          <dt>Delivery deadline</dt>
          <dd>{project.deadline ? formatDay(project.deadline) : "Not set"}</dd>
          <dt>Status</dt>
          <dd>{STATUS_LABELS[project.status] ?? project.status}</dd>
          <dt>Schedule</dt>
          <dd>
            {describeSchedule(schedule, {
              deadline: project.deadline,
              timeZone: project.clientTimeZone,
            })}
          </dd>
        </dl>
      </section>

      <section className="card" aria-labelledby="milestones">
        <h2 id="milestones">Milestones (optional)</h2>
        <MilestoneEditor
          projectId={project.id}
          totalCents={project.totalCents}
          currency={project.currency}
          initial={milestones.map((m) => ({
            id: m.id,
            name: m.name,
            amountCents: m.amountCents,
            percentBp: m.percentBp,
            deadline: m.deadline,
            paymentMode: m.paymentMode,
            status: m.status,
          }))}
        />
      </section>

      <section className="card" aria-labelledby="invoices">
        <h2 id="invoices">Invoices</h2>
        <InvoicePanel
          currency={project.currency}
          rows={milestones.map((m) => {
            const invoice = invoices.find((i) => i.milestoneId === m.id);
            return {
              milestoneId: m.id,
              name: m.name,
              cents: m.cents,
              paymentMode: m.paymentMode,
              status: m.status,
              invoice: invoice
                ? {
                    id: invoice.id,
                    invoiceNumber: invoice.invoiceNumber,
                    status: invoice.status,
                    amountPaidCents: invoice.amountPaidCents,
                    minimumDueCents: invoice.minimumDueCents,
                    dueDate: invoice.dueDate,
                    link: invoice.link,
                  }
                : null,
            };
          })}
        />
      </section>

      <section className="card" aria-labelledby="edit">
        <h2 id="edit">Edit project</h2>
        <ProjectForm
          clients={clients}
          initial={{
            id: project.id,
            clientId: project.clientId,
            title: project.title,
            totalCents: project.totalCents,
            currency: project.currency,
            deadline: project.deadline,
            contractTerms: project.contractTerms,
            lateFeeClause: project.lateFeeClause,
            settings: project.settings,
          }}
        />
      </section>
    </div>
  );
};

export default ProjectPage;
