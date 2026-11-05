"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";
import { CurrencyNote } from "@/components/CurrencyNote";
import {
  IncludeSignature,
  NO_SIGNATURE,
  startsTicked,
  type SignatureChoice,
} from "@/components/IncludeSignature";
import { sendJson } from "@/lib/api-client";
import { parseAmount, PAYPAL_CURRENCIES } from "@/lib/currencies";

// A recurring fee: amount, interval, and how it's paid. Auto-pay needs the client's approval once;
// invoice each cycle uses the normal reminders.

export type RetainerClient = {
  id: string;
  name: string;
  projects: { id: string; title: string }[];
};

const FIELD_NAMES: Record<string, string> = {
  clientId: "Client",
  projectId: "Project",
  name: "Name",
  amountCents: "Amount",
  currency: "Currency",
  unit: "Repeat",
  count: "Repeat",
  startsOn: "First charge",
  endsOn: "Last charge",
  method: "Payment method",
};

export const RetainerForm = ({
  clients,
  today,
  signature = NO_SIGNATURE,
}: {
  clients: RetainerClient[];
  today: string;
  signature?: SignatureChoice;
}) => {
  const router = useRouter();
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [count, setCount] = useState("1");
  const [unit, setUnit] = useState("month");
  const [startsOn, setStartsOn] = useState(today);
  const [endsOn, setEndsOn] = useState("");
  const [method, setMethod] = useState("invoice");
  const [includeSignature, setIncludeSignature] = useState(startsTicked(signature));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const projects = clients.find((client) => client.id === clientId)?.projects ?? [];

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const parsed = parseAmount(amount, currency);
    if (!parsed.ok) {
      setError(`Amount ${parsed.message}`);
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await sendJson(
      "/api/retainers",
      "POST",
      {
        clientId,
        projectId: projectId || null,
        name,
        amountCents: parsed.minor,
        currency,
        unit,
        count: Number(count),
        startsOn,
        endsOn: endsOn || null,
        method,
        includeSignature,
      },
      FIELD_NAMES,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      router.refresh();
      return;
    }
    router.push("/retainers");
    router.refresh();
  };

  return (
    <form className="card form" onSubmit={(event) => void submit(event)}>
      <div className="field">
        <label htmlFor="retainer-client">Client</label>
        <select
          id="retainer-client"
          value={clientId}
          onChange={(event) => {
            setClientId(event.target.value);
            setProjectId("");
          }}
        >
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="retainer-project">Project (optional)</label>
        <select
          id="retainer-project"
          value={projectId}
          onChange={(event) => {
            setProjectId(event.target.value);
          }}
        >
          <option value="">None</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="retainer-name">Name</label>
        <input
          id="retainer-name"
          value={name}
          placeholder="Monthly website maintenance"
          required
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="retainer-amount">Amount</label>
        <input
          id="retainer-amount"
          inputMode="decimal"
          value={amount}
          required
          onChange={(event) => {
            setAmount(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="retainer-currency">Currency</label>
        <select
          id="retainer-currency"
          value={currency}
          aria-describedby="retainer-currency-note"
          onChange={(event) => {
            setCurrency(event.target.value);
          }}
        >
          {PAYPAL_CURRENCIES.map(({ code, name: label }) => (
            <option key={code} value={code}>
              {code}: {label}
            </option>
          ))}
        </select>
        <CurrencyNote id="retainer-currency-note" />
      </div>
      <div className="field">
        <label htmlFor="retainer-count">Repeat every</label>
        <input
          id="retainer-count"
          type="number"
          min={1}
          value={count}
          required
          onChange={(event) => {
            setCount(event.target.value);
          }}
        />
        <label htmlFor="retainer-unit" className="visually-hidden">
          Weeks or months
        </label>
        <select
          id="retainer-unit"
          value={unit}
          onChange={(event) => {
            setUnit(event.target.value);
          }}
        >
          <option value="month">months</option>
          <option value="week">weeks</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="retainer-start">First charge</label>
        <input
          id="retainer-start"
          type="date"
          min={today}
          value={startsOn}
          required
          onChange={(event) => {
            setStartsOn(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="retainer-end">Last charge (leave empty for until cancelled)</label>
        <input
          id="retainer-end"
          type="date"
          value={endsOn}
          onChange={(event) => {
            setEndsOn(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="retainer-method">Payment method</label>
        <select
          id="retainer-method"
          value={method}
          onChange={(event) => {
            setMethod(event.target.value);
          }}
        >
          <option value="invoice">Invoice each cycle: normal reminders</option>
          <option value="auto_pay">Auto-pay: the client approves once in PayPal</option>
        </select>
      </div>
      {method === "invoice" ? (
        <IncludeSignature
          available={signature.available}
          checked={includeSignature}
          onChange={setIncludeSignature}
        />
      ) : null}
      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button className="button" type="submit" disabled={busy || clients.length === 0}>
          {busy ? "Saving…" : "Add retainer"}
        </button>
        <Link className="button button-secondary" href="/retainers">
          Cancel
        </Link>
      </div>
    </form>
  );
};
