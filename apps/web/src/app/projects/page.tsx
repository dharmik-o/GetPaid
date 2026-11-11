import Link from "next/link";
import { formatDay, formatMoney } from "@/lib/format";
import { listProjects } from "@/lib/projects";
import { runAsCurrentUser } from "@/lib/request-user";

// All projects across clients: name, client, delivery deadline, total.

export const dynamic = "force-dynamic";

const ProjectsPage = async () => {
  const projects = await runAsCurrentUser((db) => listProjects(db));
  return (
    <div className="page">
      <div className="page-header">
        <h1>Projects</h1>
        {projects.length > 0 ? (
          <Link className="button" href="/projects/new" data-tour="new-project">
            New project
          </Link>
        ) : null}
      </div>
      {projects.length === 0 ? (
        <div className="card empty">
          <p>No projects yet. Create one to set the deadline, terms and reminders.</p>
          <Link className="button" href="/projects/new" data-tour="new-project">
            New project
          </Link>
        </div>
      ) : (
        <table className="table table-stack">
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Client</th>
              <th scope="col" className="hide-small">
                Deadline
              </th>
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
                <td data-label="Client">
                  <Link href={`/clients/${project.clientId}`}>{project.clientName}</Link>
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
      )}
    </div>
  );
};

export default ProjectsPage;
