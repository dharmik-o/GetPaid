"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";
import { sendJson } from "@/lib/api-client";
import { parseAmount, PAYPAL_CURRENCIES } from "@/lib/currencies";

// A maintenance job or a renewal: when it's next due, how often it repeats, what it costs, and how
// long before it the freelancer wants to hear about it.

export type MaintenanceProject = {
  id: string;
  title: string;
  clientName: string;
  currency: string;
};

const FIELD_NAMES: Record<string, string> = {
  projectId: "Project",
  type: "Type",
  task: "Task",
  repeatMonths: "Repeat",
  nextDue: "Next due",
  estCostCents: "Estimated cost",
  currency: "Currency",
  leadDays: "Reminders",
  repeatFrom: "Next date counts from",
  checklist: "Checklist",
};

const parseLeadDays = (text: string): number[] =>
  text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map(Number);

export const MaintenanceForm = ({
  projects,
  today,
}: {
  projects: MaintenanceProject[];
  today: string;
}) => {
  const router = useRouter();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [type, setType] = useState("maintenance");
  const [task, setTask] = useState("");
  const [repeatMonths, setRepeatMonths] = useState("6");
  const [nextDue, setNextDue] = useState(today);
  const [cost, setCost] = useState("");
  const [currency, setCurrency] = useState(projects[0]?.currency ?? "USD");
  const [leadDays, setLeadDays] = useState("14, 1");
  const [repeatFrom, setRepeatFrom] = useState("scheduled");
  const [checklist, setChecklist] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const parsed = cost.trim() === "" ? null : parseAmount(cost, currency);
    if (parsed && !parsed.ok) {
      setError(`Estimated cost ${parsed.message}`);
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await sendJson(
      "/api/maintenance",
      "POST",
      {
        projectId,
        type,
        task,
        repeatMonths: Number(repeatMonths),
        nextDue,
        estCostCents: parsed ? parsed.minor : null,
        currency,
        leadDays: parseLeadDays(leadDays),
        repeatFrom,
        checklist: checklist
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      },
      FIELD_NAMES,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.push("/maintenance");
    router.refresh();
  };

  return (
    <form className="card form" onSubmit={(event) => void submit(event)}>
      <p className="muted">
        These reminders come to you. Nothing reaches the client unless you approve it.
      </p>
      <div className="field">
        <label htmlFor="maintenance-project">Project</label>
        <select
          id="maintenance-project"
          value={projectId}
          onChange={(event) => {
            setProjectId(event.target.value);
            const picked = projects.find((project) => project.id === event.target.value);
            if (picked) setCurrency(picked.currency);
          }}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.clientName}: {project.title}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="maintenance-type">Type</label>
        <select
          id="maintenance-type"
          value={type}
          onChange={(event) => {
            setType(event.target.value);
          }}
        >
          <option value="maintenance">Maintenance job</option>
          <option value="renewal">Renewal (domain, hosting, SSL)</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="maintenance-task">Task</label>
        <input
          id="maintenance-task"
          value={task}
          placeholder="Security updates and backups"
          required
          onChange={(event) => {
            setTask(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="maintenance-repeat">Repeat every (months)</label>
        <input
          id="maintenance-repeat"
          type="number"
          min={1}
          max={120}
          value={repeatMonths}
          required
          onChange={(event) => {
            setRepeatMonths(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="maintenance-due">Next due</label>
        <input
          id="maintenance-due"
          type="date"
          value={nextDue}
          required
          onChange={(event) => {
            setNextDue(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="maintenance-cost">Estimated cost (optional)</label>
        <input
          id="maintenance-cost"
          inputMode="decimal"
          value={cost}
          onChange={(event) => {
            setCost(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="maintenance-currency">Currency</label>
        <select
          id="maintenance-currency"
          value={currency}
          onChange={(event) => {
            setCurrency(event.target.value);
          }}
        >
          {PAYPAL_CURRENCIES.map(({ code, name }) => (
            <option key={code} value={code}>
              {code}: {name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="maintenance-lead">Remind me this many days before</label>
        <input
          id="maintenance-lead"
          value={leadDays}
          required
          onChange={(event) => {
            setLeadDays(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="maintenance-from">When it&apos;s done, count the next date from</label>
        <select
          id="maintenance-from"
          value={repeatFrom}
          onChange={(event) => {
            setRepeatFrom(event.target.value);
          }}
        >
          <option value="scheduled">The date it was due</option>
          <option value="done">The date it was done</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="maintenance-checklist">Checklist (optional, one item per line)</label>
        <textarea
          id="maintenance-checklist"
          rows={3}
          value={checklist}
          onChange={(event) => {
            setChecklist(event.target.value);
          }}
        />
      </div>
      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button className="button" type="submit" disabled={busy || projects.length === 0}>
          {busy ? "Saving…" : type === "renewal" ? "Add renewal" : "Add maintenance job"}
        </button>
        <Link className="button button-secondary" href="/maintenance">
          Cancel
        </Link>
      </div>
    </form>
  );
};
