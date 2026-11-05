"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  IncludeSignature,
  NO_SIGNATURE,
  startsTicked,
  type SignatureChoice,
} from "@/components/IncludeSignature";
import { sendJson } from "@/lib/api-client";
import { parseAmount } from "@/lib/currencies";
import { formatDay, formatMoney } from "@/lib/format";
import type { MaintenanceTask } from "@/lib/maintenance";

// One job or renewal, with the same four choices as its Telegram card. Tell the client only makes
// a draft, which waits in the Outbox for approval.

type Mode = "view" | "invoice" | "reschedule";

const FIELD_NAMES: Record<string, string> = {
  depositCents: "Deposit",
  nextDue: "New date",
  status: "This job's invoice",
  paymentTerms: "Payment terms",
};

export const MaintenanceCard = ({
  task,
  today,
  signature = NO_SIGNATURE,
}: {
  task: MaintenanceTask;
  today: string;
  signature?: SignatureChoice;
}) => {
  const router = useRouter();
  const [includeSignature, setIncludeSignature] = useState(startsTicked(signature));
  const [mode, setMode] = useState<Mode>("view");
  const [deposit, setDeposit] = useState("");
  const [nextDue, setNextDue] = useState(task.nextDue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const act = async (payload: object, done?: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    const result = await sendJson(`/api/maintenance/${task.id}`, "POST", payload, FIELD_NAMES);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (done) setNotice(done);
    setMode("view");
    router.refresh();
  };

  const invoice = () => {
    if (deposit.trim() === "") {
      void act(
        { action: "invoice", includeSignature },
        "Invoice created. Its reminders wait for your approval.",
      );
      return;
    }
    const parsed = parseAmount(deposit, task.currency);
    if (!parsed.ok) {
      setError(`Deposit ${parsed.message}`);
      return;
    }
    void act(
      { action: "invoice", depositCents: parsed.minor, includeSignature },
      "Deposit invoice created. Invoice the rest from the job's project page.",
    );
  };

  return (
    <article className="card outbox-card" aria-label={task.task}>
      <div className="outbox-head">
        <div>
          <h2>{task.task}</h2>
          <p className="muted">
            {task.clientName} · {task.projectTitle}
          </p>
        </div>
        <div className="money">
          {task.estCostCents === null
            ? "No estimate"
            : formatMoney(task.estCostCents, task.currency)}
        </div>
      </div>
      <p className="outbox-meta">
        <span className="chip">{task.type === "renewal" ? "Renewal" : "Maintenance"}</span>{" "}
        {task.dueSoon ? <span className="chip">Due soon</span> : null}{" "}
        {task.snoozedUntil ? (
          <span className="chip">Snoozed until {formatDay(task.snoozedUntil)}</span>
        ) : null}
      </p>
      <p className="muted">
        Due {formatDay(task.nextDue)}, then every {String(task.repeatMonths)}{" "}
        {task.repeatMonths === 1 ? "month" : "months"}. Reminders{" "}
        {task.leadDays.map(String).join(" and ")} days before.
        {task.lastDoneOn ? ` Last done ${formatDay(task.lastDoneOn)}.` : ""}
      </p>
      {task.checklist.length > 0 ? (
        <ul className="checklist">
          {task.checklist.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
      {task.jobProjectId ? (
        <p>
          <Link href={`/projects/${task.jobProjectId}`}>This job&apos;s invoice</Link>
        </p>
      ) : null}
      {mode === "invoice" ? (
        <div className="field">
          <label htmlFor={`deposit-${task.id}`}>
            Deposit (optional, leave empty for the whole amount)
          </label>
          <input
            id={`deposit-${task.id}`}
            inputMode="decimal"
            value={deposit}
            onChange={(event) => {
              setDeposit(event.target.value);
            }}
          />
          <IncludeSignature
            available={signature.available}
            checked={includeSignature}
            onChange={setIncludeSignature}
          />
          <div className="actions">
            <button className="button" type="button" disabled={busy} onClick={invoice}>
              Create invoice
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => {
                setMode("view");
              }}
            >
              Back
            </button>
          </div>
        </div>
      ) : null}
      {mode === "reschedule" ? (
        <div className="field">
          <label htmlFor={`due-${task.id}`}>New date</label>
          <input
            id={`due-${task.id}`}
            type="date"
            min={today}
            value={nextDue}
            onChange={(event) => {
              setNextDue(event.target.value);
            }}
          />
          <div className="actions">
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => void act({ action: "reschedule", nextDue })}
            >
              Save date
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => {
                setMode("view");
              }}
            >
              Back
            </button>
          </div>
        </div>
      ) : null}
      {notice ? (
        <p className="banner" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}
      {mode === "view" ? (
        <div className="actions">
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() =>
              void act({ action: "tell" }, "Draft made. Review it in the Outbox before it goes.")
            }
          >
            Tell the client
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              setMode("invoice");
            }}
          >
            Create invoice
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => void act({ action: "snooze" })}
          >
            Snooze 7 days
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              setMode("reschedule");
            }}
          >
            Reschedule
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => void act({ action: "done", expectedDue: task.nextDue })}
          >
            Mark done
          </button>
          <button
            className="link-button"
            type="button"
            disabled={busy}
            onClick={() => void act({ action: "stop" })}
          >
            Stop reminders
          </button>
        </div>
      ) : null}
    </article>
  );
};
