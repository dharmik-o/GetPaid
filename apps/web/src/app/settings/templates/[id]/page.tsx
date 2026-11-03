import Link from "next/link";
import { notFound } from "next/navigation";
import { TemplateEditor, type EditableTemplate } from "@/components/TemplateEditor";
import { isUuid } from "@/lib/db";
import { getTemplate } from "@/lib/invoice-templates";
import { runAsCurrentUser } from "@/lib/request-user";

// The template editor (/settings/templates/new for a new one). Built-ins open read-only.

export const dynamic = "force-dynamic";

const STARTER: EditableTemplate = {
  id: null,
  name: "My template",
  kind: "custom",
  html: `<h1>Invoice {{invoice.number}}</h1>
<p>{{freelancer.name}} · {{freelancer.email}}</p>
<p>Bill to {{client.name}}</p>
<p>{{greeting}}</p>
<table>
  {{#items}}<tr><td>{{name}}</td><td>{{amount}}</td></tr>{{/items}}
</table>
<p><strong>Total {{totals.total}}</strong>, due {{invoice.due_date}}</p>
<p><a href="{{invoice.pay_link}}">Pay online</a></p>
<p>{{thank_you_note}}</p>`,
  css: `body { font-family: Arial, sans-serif; font-size: 12px; color: #222222; }
h1 { font-size: 20px; }`,
};

const TemplatePage = async ({ params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  let template: EditableTemplate | undefined = STARTER;
  if (id !== "new") {
    if (!isUuid(id)) notFound();
    template = await runAsCurrentUser((db) => getTemplate(db, id));
  }
  if (!template) notFound();
  return (
    <div className="page page-wide">
      <div className="page-header">
        <h1>{id === "new" ? "New template" : template.name}</h1>
        <Link href="/settings/templates">All templates</Link>
      </div>
      <p className="muted">
        Use only the tags listed below; values are filled from your records and escaped. Scripts,
        event handlers and forms are removed, and nothing may load from the network: embed images,
        and use {"{{freelancer.logo}}"} for your logo.
      </p>
      <section className="card">
        <TemplateEditor initial={template} />
      </section>
    </div>
  );
};

export default TemplatePage;
