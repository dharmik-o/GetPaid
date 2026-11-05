"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { sendJson } from "@/lib/api-client";

// Settings > Invoice templates: the built-ins and your own, with Preview (opens the editor,
// read-only for a built-in), Duplicate and Set as default.

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

  return (
    <div>
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
          {templates.map((template) => (
            <tr key={template.id}>
              <td data-label="Template">
                {template.name}
                {template.id === current ? <span className="chip chip-after">Default</span> : null}
              </td>
              <td className="hide-small">{template.kind === "builtin" ? "Built-in" : "Yours"}</td>
              <td className="row-actions" data-label="Actions">
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
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {message ? (
        <div className={message.error ? "banner banner-error" : "banner"} role="status">
          {message.text}
        </div>
      ) : null}
    </div>
  );
};
