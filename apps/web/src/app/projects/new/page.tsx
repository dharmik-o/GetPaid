import Link from "next/link";
import { ProjectForm } from "@/components/ProjectForm";
import { listClientChoices } from "@/lib/projects";
import { runAsCurrentUser } from "@/lib/request-user";

// New project: step 1 details, step 2 schedule. Milestones are added on the project page.

export const dynamic = "force-dynamic";

const NewProjectPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string }>;
}) => {
  const { clientId } = await searchParams;
  const clients = await runAsCurrentUser((db) => listClientChoices(db));
  return (
    <div className="page">
      <div className="page-header">
        <h1>New project</h1>
        <Link href="/clients">Back to clients</Link>
      </div>
      {clients.length === 0 ? (
        <div className="card empty">
          <p>Projects belong to a client. Add your first client, then come back here.</p>
          <Link className="button" href="/clients/new">
            Add a client
          </Link>
        </div>
      ) : (
        <div className="card">
          <ProjectForm
            clients={clients}
            initialClientId={clients.some((c) => c.id === clientId) ? clientId : undefined}
          />
        </div>
      )}
    </div>
  );
};

export default NewProjectPage;
