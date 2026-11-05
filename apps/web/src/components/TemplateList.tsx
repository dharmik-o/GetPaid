"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { sendJson } from "@/lib/api-client";
import { BUILTIN_TEMPLATE_NOTES } from "@/lib/invoice-template-notes";

// Settings > Invoice templates: a gallery of the built-ins, each with a thumbnail rendered from
// sample data, then your own in a table. Preview opens the editor, read-only for a built-in. A
// thumbnail is a sandboxed frame that can't run anything or load anything from outside.

export type TemplateRow = { id: string; name: string; kind: "builtin" | "custom" };

type Props = {
  templates: TemplateRow[];
  /** The account default; null = Classic. */
  defaultTemplateId: string | null;
  classicId: string;
};

export const TemplateList = ({ templates, defaultTemplateId, classicId }: Props) => {
  const router = useRouter();
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  const current = defaultTemplateId ?? classicId;

  const run = async (
    key: string,
    work: () => Promise<{ ok: boolean; message?: string }>,
    done: string,
  ) => {
    setBusy(key);
    setMessage(undefined);
    const result = await work();
    setBusy(undefined);
    setMessage(
      result.ok ? { text: done, error: false } : { text: result.message ?? "", error: true },
    );
    if (result.ok) router.refresh();
  };

  const duplicate = (template: TemplateRow) =>
    run(
      template.id,
      () => sendJson("/api/invoice-templates", "POST", { duplicateOf: template.id }, {}),
      `Copied ${template.name}. Open the copy to edit it.`,
    );

  const makeDefault = (template: TemplateRow) =>
    run(
      template.id,
      () => sendJson("/api/settings/invoice", "PUT", { defaultTemplateId: template.id }, {}),
      `${template.name} is now the default for new invoices.`,
    );

  const actions = (template: TemplateRow) => (
    <>
      <Link href={`/settings/templates/${template.id}`}>
        {template.kind === "builtin" ? "Preview" : "Edit"}
      </Link>
      <button
        type="button"
        className="link-button"
        disabled={busy !== undefined}
        onClick={() => {
          void duplicate(template);
        }}
      >
        Duplicate
      </button>
      {template.id === current ? null : (
        <button
          type="button"
          className="link-button"
          disabled={busy !== undefined}
          onClick={() => {
            void makeDefault(template);
          }}
        >
          Set as default
        </button>
      )}
    </>
  );

  const builtins = templates.filter((template) => template.kind === "builtin");
  const own = templates.filter((template) => template.kind === "custom");

  return (
    <div>
      <ul className="template-gallery" aria-label="Built-in templates">
        {builtins.map((template) => (
          <li key={template.id} className="template-tile">
            <div className="template-thumb">
              <iframe
                title={`${template.name}, with sample data`}
                src={`/api/invoice-templates/${template.id}/thumbnail`}
                sandbox=""
                loading="lazy"
                tabIndex={-1}
              />
            </div>
            <div className="template-name">
              <strong>{template.name}</strong>
              {template.id === current ? <span className="chip chip-after">Default</span> : null}
            </div>
            {BUILTIN_TEMPLATE_NOTES[template.id] ? (
              <p className="field-hint">{BUILTIN_TEMPLATE_NOTES[template.id]}</p>
            ) : null}
            <div className="template-actions">{actions(template)}</div>
          </li>
        ))}
      </ul>
      {own.length > 0 ? (
        <table className="table table-stack">
          <thead>
            <tr>
              <th scope="col">Template</th>
              <th scope="col" className="hide-small">
                Kind
              </th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {own.map((template) => (
              <tr key={template.id}>
                <td data-label="Template">
                  {template.name}
                  {template.id === current ? (
                    <span className="chip chip-after">Default</span>
                  ) : null}
                </td>
                <td className="hide-small">{template.kind === "builtin" ? "Built-in" : "Yours"}</td>
                <td className="row-actions" data-label="Actions">
                  {actions(template)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {message ? (
        <div className={message.error ? "banner banner-error" : "banner"} role="status">
          {message.text}
        </div>
      ) : null}
    </div>
  );
};
