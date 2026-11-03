import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectForm } from "@/components/ProjectForm";
import { isUuid } from "@/lib/db";
import { formatDay, formatMoney } from "@/lib/format";
import { getProject, listClientChoices } from "@/lib/projects";
import { runAsCurrentUser } from "@/lib/request-user";
import { describeSchedule } from "@/lib/schedule-preview";

// One project: details and schedule. Milestones come with the next feature.

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
  const { project, clients } = await runAsCurrentUser(async (db) => ({
    project: await getProject(db, id),
    clients: await listClientChoices(db),
  }));
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
