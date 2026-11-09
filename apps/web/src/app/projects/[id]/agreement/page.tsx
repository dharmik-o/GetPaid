import Link from "next/link";
import { notFound } from "next/navigation";
import { AgreementBuilder } from "@/components/AgreementBuilder";
import { getLegalFacts } from "@/lib/account";
import { valuesFromOptions } from "@/lib/agreement-form";
import { getAgreement, listAgreements } from "@/lib/agreements";
import { COUNTRIES } from "@/lib/countries";
import { isUuid } from "@/lib/db";
import { getProject } from "@/lib/projects";
import { runAsCurrentUser } from "@/lib/request-user";

// The agreement builder for one project: the live agreement if there is one, else the latest.

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

const AgreementPage = async ({ params }: Props) => {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { project, agreement, legal } = await runAsCurrentUser(async (db) => {
    const found = await getProject(db, id);
    const list = found ? await listAgreements(db, id) : [];
    const shown = list.find((a) => a.status === "draft" || a.status === "sent") ?? list[0];
    return {
      project: found,
      agreement: shown ? await getAgreement(db, shown.id) : undefined,
      legal: await getLegalFacts(db),
    };
  });
  if (!project) notFound();
  return (
    <div className="page">
      <div className="page-header">
        <h1>Agreement for {project.title}</h1>
        <Link href={`/projects/${project.id}`}>Back to the project</Link>
      </div>
      <section className="card" aria-labelledby="agreement">
        <h2 id="agreement">
          {agreement
            ? `${agreement.number}, version ${String(agreement.version)} (${agreement.status})`
            : "New agreement"}
        </h2>
        <AgreementBuilder
          key={agreement?.id ?? "new"}
          projectId={project.id}
          currency={project.currency}
          agreement={
            agreement
              ? {
                  id: agreement.id,
                  number: agreement.number,
                  version: agreement.version,
                  status: agreement.status,
                }
              : null
          }
          initial={valuesFromOptions(
            agreement?.options ?? null,
            project.currency,
            legal.governingLawCountry ?? "",
          )}
          savedHtml={agreement?.bodyHtml ?? null}
          countries={COUNTRIES.map(({ code, name }) => ({ code, name }))}
        />
      </section>
    </div>
  );
};

export default AgreementPage;
