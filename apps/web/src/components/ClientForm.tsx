"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

export type CountryChoice = {
  code: string;
  name: string;
  timeZones: string[];
  defaultTimeZone: string;
};

export type ClientFormValues = {
  id?: string;
  name: string;
  email: string;
  country: string;
  timeZone: string;
};

type FieldIssue = { field: string; message: string };

type Props = {
  countries: CountryChoice[];
  /** Every IANA zone, for clients who live outside their country's usual zones. */
  allTimeZones: string[];
  initial?: ClientFormValues;
};

const LABELS: Record<string, string> = {
  name: "Name",
  email: "Billing email",
  country: "Country",
  timeZone: "Time zone",
};

const errorMessage = async (
  response: Response,
): Promise<{ text: string; fields: FieldIssue[] }> => {
  try {
    const body = (await response.json()) as { error?: string; errors?: FieldIssue[] };
    return { text: body.error ?? "Saving failed. Try again.", fields: body.errors ?? [] };
  } catch {
    return { text: "Saving failed. Check your connection and try again.", fields: [] };
  }
};

/** Add or edit a client. Changing the country moves the time zone to that country's default. */
export const ClientForm = ({ countries, allTimeZones, initial }: Props) => {
  const router = useRouter();
  const [values, setValues] = useState<ClientFormValues>(
    initial ?? { name: "", email: "", country: "", timeZone: "" },
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const country = countries.find((c) => c.code === values.country);
  const ownZones = country?.timeZones ?? [];
  const otherZones = allTimeZones.filter((zone) => !ownZones.includes(zone));

  const setCountry = (code: string) => {
    const next = countries.find((c) => c.code === code);
    setValues((v) => ({
      ...v,
      country: code,
      // Keep the zone only if it's one of the new country's; otherwise use its default.
      timeZone: next && !next.timeZones.includes(v.timeZone) ? next.defaultTimeZone : v.timeZone,
    }));
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setFormError(undefined);
    setFieldErrors({});
    const { id, timeZone, ...rest } = values;
    // A blank time zone means "use the country's default".
    const fields = timeZone ? { ...rest, timeZone } : rest;
    try {
      const response = await fetch(id ? `/api/clients/${id}` : "/api/clients", {
        method: id ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (!response.ok) {
        const { text, fields: issues } = await errorMessage(response);
        setFormError(text);
        setFieldErrors(Object.fromEntries(issues.map((issue) => [issue.field, issue.message])));
        return;
      }
      const { client } = (await response.json()) as { client: { id: string } };
      router.push(`/clients/${client.id}`);
      router.refresh();
    } catch {
      setFormError("Saving failed. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  const describedBy = (field: string, hint?: boolean) =>
    [hint ? `${field}-hint` : "", fieldErrors[field] ? `${field}-error` : ""]
      .filter(Boolean)
      .join(" ") || undefined;

  const errorFor = (field: string) =>
    fieldErrors[field] ? (
      <div id={`${field}-error`} className="field-error">
        {LABELS[field]} {fieldErrors[field]}
      </div>
    ) : null;

  return (
    <form className="form" onSubmit={(event) => void submit(event)} noValidate>
      {formError ? (
        <div className="banner banner-error" role="alert">
          {formError}
        </div>
      ) : null}

      <div className="field">
        <label htmlFor="name">{LABELS.name}</label>
        <input
          id="name"
          value={values.name}
          onChange={(e) => {
            setValues((v) => ({ ...v, name: e.target.value }));
          }}
          aria-invalid={Boolean(fieldErrors.name)}
          aria-describedby={describedBy("name")}
          autoComplete="organization"
          required
        />
        {errorFor("name")}
      </div>

      <div className="field">
        <label htmlFor="email">{LABELS.email}</label>
        <input
          id="email"
          type="email"
          value={values.email}
          onChange={(e) => {
            setValues((v) => ({ ...v, email: e.target.value }));
          }}
          aria-invalid={Boolean(fieldErrors.email)}
          aria-describedby={describedBy("email", true)}
          autoComplete="email"
          required
        />
        <div id="email-hint" className="field-hint">
          Reminders go to this address, on the invoice thread.
        </div>
        {errorFor("email")}
      </div>

      <div className="field">
        <label htmlFor="country">{LABELS.country}</label>
        <select
          id="country"
          value={values.country}
          onChange={(e) => {
            setCountry(e.target.value);
          }}
          aria-invalid={Boolean(fieldErrors.country)}
          aria-describedby={describedBy("country")}
          required
        >
          <option value="">Pick a country</option>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
        {errorFor("country")}
      </div>

      <div className="field">
        <label htmlFor="timeZone">{LABELS.timeZone}</label>
        <select
          id="timeZone"
          value={values.timeZone}
          onChange={(e) => {
            setValues((v) => ({ ...v, timeZone: e.target.value }));
          }}
          aria-invalid={Boolean(fieldErrors.timeZone)}
          aria-describedby={describedBy("timeZone", true)}
        >
          <option value="">{country ? "Pick a time zone" : "Pick a country first"}</option>
          {ownZones.length > 0 ? (
            <optgroup label={`In ${country?.name ?? "this country"}`}>
              {ownZones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </optgroup>
          ) : null}
          <optgroup label="Other time zones">
            {otherZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </optgroup>
        </select>
        <div id="timeZone-hint" className="field-hint">
          Set from the country. Reminders go out in the client&apos;s working hours in this zone.
        </div>
        {errorFor("timeZone")}
      </div>

      <div className="actions">
        <button className="button" type="submit" disabled={saving}>
          {saving ? "Saving…" : values.id ? "Save changes" : "Add client"}
        </button>
      </div>
    </form>
  );
};
