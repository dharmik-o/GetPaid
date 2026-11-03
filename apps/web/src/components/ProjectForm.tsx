"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";
import { ScheduleForm } from "@/components/ScheduleForm";
import { formatAmountInput, parseAmount, PAYPAL_CURRENCIES } from "@/lib/currencies";
import type { ScheduleSettings, SettingsOverride } from "@/lib/settings";

// New project (step 1 details, step 2 schedule) or edit an existing one.
// Step 3, milestones, is on the project page once the project exists.

export type ClientOption = {
  id: string;
  name: string;
  timeZone: string;
  inherited: ScheduleSettings;
};

export type ProjectFormValues = {
  id: string;
  clientId: string;
  title: string;
  totalCents: number;
  currency: string;
  deadline: string;
  contractTerms: string | null;
  lateFeeClause: string | null;
  settings: SettingsOverride;
};

type Props = {
  clients: ClientOption[];
  initialClientId?: string | undefined;
  initial?: ProjectFormValues;
};

type FieldIssue = { field: string; message: string };

const LABELS: Record<string, string> = {
  clientId: "Client",
  title: "Project name",
  totalCents: "Total",
  currency: "Currency",
  deadline: "Delivery deadline",
  contractTerms: "Contract terms",
  lateFeeClause: "Late-fee clause",
};

export const ProjectForm = ({ clients, initialClientId, initial }: Props) => {
  const router = useRouter();
  const [clientId, setClientId] = useState(
    initial?.clientId ?? initialClientId ?? clients[0]?.id ?? "",
  );
  const [title, setTitle] = useState(initial?.title ?? "");
  const [currency, setCurrency] = useState(initial?.currency ?? "USD");
  const [total, setTotal] = useState(
    initial ? formatAmountInput(initial.totalCents, initial.currency) : "",
  );
  const [deadline, setDeadline] = useState(initial?.deadline ?? "");
  const [contractTerms, setContractTerms] = useState(initial?.contractTerms ?? "");
  const [lateFeeClause, setLateFeeClause] = useState(initial?.lateFeeClause ?? "");
  const [settings, setSettings] = useState<SettingsOverride>(initial?.settings ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const client = clients.find((c) => c.id === clientId);

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(undefined);
    setErrors({});
    const amount = parseAmount(total, currency);
    if (!amount.ok) {
      setErrors({ totalCents: amount.message });
      setFormError("Some fields need fixing. Check the messages and try again.");
      return;
    }
    const fields = {
      title,
      totalCents: amount.minor,
      currency,
      deadline,
      contractTerms,
      lateFeeClause,
      settings,
    };
    setSaving(true);
    try {
      const response = await fetch(initial ? `/api/projects/${initial.id}` : "/api/projects", {
        method: initial ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(initial ? fields : { ...fields, clientId }),
      });
      const body = (await response.json()) as {
        project?: { id: string };
        error?: string;
        errors?: FieldIssue[];
      };
      if (!response.ok || !body.project) {
        setFormError(body.error ?? "Saving failed. Try again.");
        setErrors(Object.fromEntries((body.errors ?? []).map((e) => [e.field, e.message])));
        return;
      }
      router.push(`/projects/${body.project.id}`);
      router.refresh();
    } catch {
      setFormError("Saving failed. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  const errorFor = (field: string) =>
    errors[field] ? (
      <div id={`${field}-error`} className="field-error">
        {LABELS[field] ?? "This"} {errors[field]}
      </div>
    ) : null;

  const invalid = (field: string) => ({
    "aria-invalid": Boolean(errors[field]),
    "aria-describedby": errors[field] ? `${field}-error` : undefined,
  });

  const settingsErrors = Object.entries(errors).filter(([field]) => field.startsWith("settings"));

  return (
    <form className="form form-wide" onSubmit={(event) => void submit(event)} noValidate>
      {formError ? (
        <div className="banner banner-error" role="alert">
          {formError}
          {settingsErrors.map(([field, message]) => (
            <div key={field}>
              {field.replace(/^settings\.?/, "Schedule: ")} {message}
            </div>
          ))}
        </div>
      ) : null}

      <h2>1. Details</h2>
      <div className="field">
        <label htmlFor="clientId">{LABELS.clientId}</label>
        <select
          id="clientId"
          value={clientId}
          onChange={(e) => {
            setClientId(e.target.value);
          }}
          disabled={Boolean(initial)}
          {...invalid("clientId")}
        >
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {errorFor("clientId")}
      </div>

      <div className="field">
        <label htmlFor="title">{LABELS.title}</label>
        <input
          id="title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
          }}
          {...invalid("title")}
        />
        {errorFor("title")}
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="total">{LABELS.totalCents}</label>
          <input
            id="total"
            inputMode="decimal"
            placeholder="3000.00"
            value={total}
            onChange={(e) => {
              setTotal(e.target.value);
            }}
            {...invalid("totalCents")}
          />
          {errorFor("totalCents")}
        </div>
        <div className="field">
          <label htmlFor="currency">{LABELS.currency}</label>
          <select
            id="currency"
            value={currency}
            onChange={(e) => {
              setCurrency(e.target.value);
            }}
            {...invalid("currency")}
          >
            {PAYPAL_CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}: {c.name}
                {c.inCountryOnly ? " (in-country PayPal accounts only)" : ""}
              </option>
            ))}
          </select>
          {errorFor("currency")}
        </div>
      </div>

      <div className="field">
        <label htmlFor="deadline">{LABELS.deadline}</label>
        <input
          id="deadline"
          type="date"
          value={deadline}
          onChange={(e) => {
            setDeadline(e.target.value);
          }}
          {...invalid("deadline")}
        />
        {errorFor("deadline")}
      </div>

      <div className="field">
        <label htmlFor="contractTerms">{LABELS.contractTerms} (optional)</label>
        <textarea
          id="contractTerms"
          rows={3}
          value={contractTerms}
          onChange={(e) => {
            setContractTerms(e.target.value);
          }}
          {...invalid("contractTerms")}
        />
        <div className="field-hint">Firm reminders (Tier 2) may quote these agreed terms.</div>
        {errorFor("contractTerms")}
      </div>

      <div className="field">
        <label htmlFor="lateFeeClause">{LABELS.lateFeeClause} (optional)</label>
        <textarea
          id="lateFeeClause"
          rows={2}
          value={lateFeeClause}
          onChange={(e) => {
            setLateFeeClause(e.target.value);
          }}
          {...invalid("lateFeeClause")}
        />
        <div className="field-hint">
          Copy it exactly from the contract. Reminders mention a late fee only if this is filled in.
        </div>
        {errorFor("lateFeeClause")}
      </div>

      <h2>2. Schedule</h2>
      {client ? (
        <ScheduleForm
          key={client.id}
          inherited={client.inherited}
          value={settings}
          onChange={setSettings}
          deadline={deadline}
          timeZone={client.timeZone}
          currency={currency}
          lateFeeAllowed={lateFeeClause.trim().length > 0}
        />
      ) : (
        <p className="muted">Pick a client to set the schedule.</p>
      )}

      <div className="actions">
        <button className="button" type="submit" disabled={saving}>
          {saving ? "Saving…" : initial ? "Save changes" : "Create project"}
        </button>
      </div>
    </form>
  );
};
