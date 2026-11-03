"use client";

import { useState } from "react";
import type { InvoiceText } from "@/lib/ai-schemas";

// On Create invoice: pick the invoice document's template, and see (and edit) its text. The AI
// writes only these four text parts; names, amounts, dates and the pay link come from your
// records. Leaving the text empty uses the fixed wording.

export type TemplateChoice = { id: string; name: string };

export type DocumentFields = { templateId: string; text: InvoiceText | null };

type Props = {
  milestoneId: string;
  templates: TemplateChoice[];
  value: DocumentFields;
  onChange: (value: DocumentFields) => void;
};

const LABELS: Record<keyof InvoiceText, string> = {
  greeting: "Greeting",
  thank_you_note: "Thank-you note",
  project_summary: "Project summary",
  notes: "Notes (optional)",
};

const FIELDS = Object.keys(LABELS) as (keyof InvoiceText)[];

export const InvoiceDocumentFields = ({ milestoneId, templates, value, onChange }: Props) => {
  const [state, setState] = useState<"idle" | "writing" | "failed">("idle");
  const [via, setVia] = useState<string>();

  const writeWithAi = async () => {
    setState("writing");
    try {
      const response = await fetch(`/api/milestones/${milestoneId}/invoice-text`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("not ok");
      const body = (await response.json()) as { text: InvoiceText; via: string };
      onChange({ ...value, text: body.text });
      setVia(body.via);
      setState("idle");
    } catch {
      setState("failed");
    }
  };

  const id = (field: string) => `invoice-${milestoneId}-${field}`;

  return (
    <details className="details editor-form">
      <summary>Invoice document (PDF)</summary>
      <label htmlFor={id("template")}>Template</label>
      <select
        id={id("template")}
        value={value.templateId}
        onChange={(e) => {
          onChange({ ...value, templateId: e.target.value });
        }}
      >
        <option value="">Default for this client</option>
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
          </option>
        ))}
      </select>
      <p className="field-hint">
        Text without amounts or dates: those come from your records. Leave it empty for the fixed
        wording.
      </p>
      <button
        type="button"
        className="button button-secondary"
        disabled={state === "writing"}
        onClick={() => {
          void writeWithAi();
        }}
      >
        {state === "writing"
          ? "Writing…"
          : value.text
            ? "Write again with AI"
            : "Write the text with AI"}
      </button>
      {state === "failed" ? (
        <p className="field-error" role="alert">
          The text couldn&apos;t be written. Try again, or write it yourself below.
        </p>
      ) : null}
      {via === "template" ? (
        <p className="field-hint">No model gave usable text, so this is the fixed wording.</p>
      ) : null}
      {value.text
        ? FIELDS.map((field) => (
            <div key={field}>
              <label htmlFor={id(field)}>{LABELS[field]}</label>
              <textarea
                id={id(field)}
                rows={field === "project_summary" ? 3 : 2}
                value={value.text?.[field] ?? ""}
                onChange={(e) => {
                  if (!value.text) return;
                  onChange({ ...value, text: { ...value.text, [field]: e.target.value } });
                }}
              />
            </div>
          ))
        : null}
    </details>
  );
};
