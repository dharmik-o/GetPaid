import Link from "next/link";
import { InvoiceDetailsForm } from "@/components/InvoiceDetailsForm";
import { TemplateList } from "@/components/TemplateList";
import { getFreelancerDetails } from "@/lib/invoice-details";
import { CLASSIC_TEMPLATE_ID, listTemplates } from "@/lib/invoice-templates";
import { runAsCurrentUser } from "@/lib/request-user";

// Settings > Invoice templates: a gallery of the built-ins and your own (Preview, Duplicate, Set
// as default), and your details on every invoice document.

export const dynamic = "force-dynamic";

const TemplatesPage = async () => {
  const { templates, details } = await runAsCurrentUser(async (db) => ({
    templates: await listTemplates(db),
    details: await getFreelancerDetails(db),
  }));
  if (!details) throw new Error("Your account wasn't found. Run npm run db:seed, then reload.");
  const own = templates.filter((t) => t.kind === "custom");
  return (
    <div className="page">
      <div className="page-header">
        <h1>Invoice templates</h1>
        <Link className="button" href="/settings/templates/new">
          New template
        </Link>
      </div>
      <p className="muted">
        Each invoice also gets a PDF from one of these templates, with the same PayPal pay link. It
        goes with every reminder email and can be downloaded from the project page.
      </p>
      <section className="card" aria-labelledby="templates">
        <h2 id="templates">Templates</h2>
        <TemplateList
          templates={templates}
          defaultTemplateId={details.defaultTemplateId}
          classicId={CLASSIC_TEMPLATE_ID}
        />
        {own.length === 0 ? (
          <p className="empty">
            No templates of your own yet. Duplicate a built-in to start from it, or make a new one
            with your own HTML and CSS.
          </p>
        ) : null}
      </section>
      <section className="card" aria-labelledby="details">
        <h2 id="details">Your invoice details</h2>
        <InvoiceDetailsForm
          name={details.name}
          initial={{
            businessName: details.businessName,
            address: details.address,
            logoDataUrl: details.logoDataUrl,
            invoicePaper: details.invoicePaper,
            invoiceShowQr: details.invoiceShowQr,
            signatureSource: details.signatureSource,
            signatureImageDataUrl: details.signatureImageDataUrl,
            signatureTypedName: details.signatureTypedName,
            signatureName: details.signatureName,
            signatureTitle: details.signatureTitle,
            signatureDefault: details.signatureDefault,
          }}
        />
      </section>
    </div>
  );
};

export default TemplatesPage;
