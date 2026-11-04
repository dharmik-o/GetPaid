import Link from "next/link";
import { notFound } from "next/navigation";
import { HoldPanel } from "@/components/HoldPanel";
import { InvoicePanel } from "@/components/InvoicePanel";
import { MilestoneEditor } from "@/components/MilestoneEditor";
import { ProjectForm } from "@/components/ProjectForm";
import { isUuid } from "@/lib/db";
import { formatDay, formatMoney } from "@/lib/format";
import { listActivePlansForProject } from "@/lib/installment-plans";
import { listInvoicesForProject } from "@/lib/invoices";
import { listHoldsForProject } from "@/lib/milestone-holds";
import { listMilestones } from "@/lib/milestones";
import { getProject, listClientChoices } from "@/lib/projects";
import { listTemplates } from "@/lib/invoice-templates";
import { runAsCurrentUser } from "@/lib/request-user";
import { holdDeadlineTooFar, todayIn } from "@/lib/schedule";
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
  const now = new Date();
  const { project, clients, milestones, invoices, plans, templates, holds } = await runAsCurrentUser(
    async (db) => {
      const found = await getProject(db, id);
      return {
        project: found,
        clients: await listClientChoices(db),
        milestones: found ? await listMilestones(db, found) : [],
        invoices: found ? await listInvoicesForProject(db, found.id) : [],
        plans: found ? await listActivePlansForProject(db, found.id) : [],
        templates: await listTemplates(db),
        holds: found ? await listHoldsForProject(db, found.id, now) : [],
      };
    },
  );
  if (!project) notFound();

  const schedule = { ...project.inherited, ...project.settings };
  const today = todayIn(now, project.clientTimeZone);
  const holdMilestones = milestones.filter((m) => m.paymentMode === "hold");

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

      {holdMilestones.length > 0 ? (
        <section className="card" aria-labelledby="holds">
          <h2 id="holds">Milestone holds</h2>
          <HoldPanel
            currency={project.currency}
            rows={holdMilestones.map((m) => ({
              milestoneId: m.id,
              name: m.name,
              cents: m.cents,
              status: m.status,
              deadlineTooFar: holdDeadlineTooFar(m.deadline, today),
              hold: holds.find((hold) => hold.milestoneId === m.id) ?? null,
            }))}
          />
        </section>
      ) : null}

      <section className="card" aria-labelledby="invoices">
        <h2 id="invoices">Invoices</h2>
        <InvoicePanel
          templates={templates.map(({ id: templateId, name }) => ({ id: templateId, name }))}
          currency={project.currency}
          today={today}
          rows={milestones.map((m) => {
            const plan = plans.find((p) => p.milestoneId === m.id);
            return {
              milestoneId: m.id,
              name: m.name,
              cents: m.cents,
              paymentMode: m.paymentMode,
              status: m.status,
              invoices: invoices
                .filter((i) => i.milestoneId === m.id)
                .map((i) => ({
                  id: i.id,
                  invoiceNumber: i.invoiceNumber,
                  status: i.status,
                  amountCents: i.amountCents,
                  amountPaidCents: i.amountPaidCents,
                  dueDate: i.dueDate,
                  link: i.link,
                  installment: i.installment,
                })),
              plan: plan ? { createdFrom: plan.createdFrom, items: plan.items } : null,
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
