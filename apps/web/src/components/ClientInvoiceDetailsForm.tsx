"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { sendJson } from "@/lib/api-client";

// A client's details on their invoice documents (company, address) and the template their
// invoices use by default, overriding the account default.

type Details = { company: string | null; address: string | null; defaultTemplateId: string | null };

type Props = {
  clientId: string;
  initial: Details;
  templates: { id: string; name: string }[];
};

const NAMES = { company: "Company", address: "Address", defaultTemplateId: "Template" };

export const ClientInvoiceDetailsForm = ({ clientId, initial, templates }: Props) => {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean }>();

  const save = async () => {
    setSaving(true);
    const result = await sendJson(`/api/clients/${clientId}/invoice-details`, "PUT", values, NAMES);
    setSaving(false);
    setMessage(
      result.ok
        ? { text: "Saved. New invoices for this client use these details.", error: false }
        : { text: result.message, error: true },
    );
    if (result.ok) router.refresh();
  };

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor="client-company">Company</label>
      <input
        id="client-company"
        maxLength={120}
        value={values.company ?? ""}
        onChange={(e) => {
          setValues((v) => ({ ...v, company: e.target.value }));
        }}
      />
      <label htmlFor="client-address">Address</label>
      <textarea
        id="client-address"
        rows={3}
        maxLength={500}
        value={values.address ?? ""}
        onChange={(e) => {
          setValues((v) => ({ ...v, address: e.target.value }));
        }}
      />
      <label htmlFor="client-template">Invoice template</label>
      <select
        id="client-template"
        value={values.defaultTemplateId ?? ""}
        onChange={(e) => {
          setValues((v) => ({ ...v, defaultTemplateId: e.target.value || null }));
        }}
      >
        <option value="">Your account default</option>
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
          </option>
        ))}
      </select>
      <div className="actions">
        <button className="button" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save invoice details"}
        </button>
      </div>
      {message ? (
        <div className={message.error ? "banner banner-error" : "banner"} role="status">
          {message.text}
        </div>
      ) : null}
    </form>
  );
};
