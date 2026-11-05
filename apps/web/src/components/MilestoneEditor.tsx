"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { formatAmountInput, parseAmount } from "@/lib/currencies";
import { formatMoney } from "@/lib/format";
import { checkPlan, milestoneCents, type PlanItem } from "@/lib/milestone-plan";
import {
  hasInvoice,
  manualNextStatuses,
  statusLabel,
  type MilestoneStatus,
} from "@/lib/milestone-status";
import { formatPercent, parsePercent } from "@/lib/schedule-form";

// Step 3 of a project: optional milestones. Rows with name, amount or %, deadline and mode;
// a running total that must equal the project total; status buttons for saved milestones.

export type SavedMilestone = {
  id: string;
  name: string;
  amountCents: number | null;
  percentBp: number | null;
  deadline: string;
  paymentMode: "pay_on_invoice" | "deposit" | "hold";
  status: MilestoneStatus;
};

type Row = {
  key: string;
  id?: string;
  name: string;
  kind: "percent" | "amount";
  share: string;
  deadline: string;
  paymentMode: SavedMilestone["paymentMode"];
  status?: MilestoneStatus;
};

type Props = {
  projectId: string;
  totalCents: number;
  currency: string;
  initial: SavedMilestone[];
};

type FieldIssue = { field: string; message: string };

const MODES: { value: Row["paymentMode"]; label: string }[] = [
  { value: "pay_on_invoice", label: "Pay on invoice" },
  { value: "deposit", label: "Deposit" },
  { value: "hold", label: "Milestone hold" },
];

let nextKey = 0;
const newKey = () => `row-${String((nextKey += 1))}`;

const toRow = (m: SavedMilestone, currency: string): Row => ({
  key: m.id,
  id: m.id,
  name: m.name,
  kind: m.amountCents === null ? "percent" : "amount",
  share:
    m.amountCents === null
      ? formatPercent(m.percentBp ?? 0)
      : formatAmountInput(m.amountCents, currency),
  deadline: m.deadline,
  paymentMode: m.paymentMode,
  status: m.status,
});

/** The share typed in a row, or a message when it can't be read. */
const shareOf = (
  row: Row,
  currency: string,
): { amountCents: number } | { percentBp: number } | string => {
  if (row.kind === "amount") {
    const amount = parseAmount(row.share, currency);
    return amount.ok ? { amountCents: amount.minor } : amount.message;
  }
  const bp = parsePercent(row.share);
  return Number.isNaN(bp) || bp < 1 || bp > 10000
    ? "must be a percentage like 30 or 33.33"
    : { percentBp: bp };
};

export const MilestoneEditor = ({ projectId, totalCents, currency, initial }: Props) => {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(initial.map((m) => toRow(m, currency)));
  const [serverErrors, setServerErrors] = useState<FieldIssue[]>([]);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  const shares = rows.map((row) => shareOf(row, currency));
  const shareErrors = shares.map((share) => (typeof share === "string" ? share : undefined));
  const items: PlanItem[] | undefined = shares.every((s) => typeof s !== "string")
    ? rows.map(
        (row, i) =>
          ({
            name: row.name || `Milestone ${String(i + 1)}`,
            deadline: row.deadline,
            ...(shares[i] as object),
          }) as PlanItem,
      )
    : undefined;
  const plan = items ? checkPlan(items, totalCents, currency) : undefined;
  const cents = items && plan?.errors.length === 0 ? milestoneCents(items, totalCents) : undefined;

  const update = (index: number, change: Partial<Row>) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...change } : row)));
  };
  const move = (index: number, by: number) => {
    setRows((current) => {
      const next = [...current];
      const [row] = next.splice(index, 1);
      if (row) next.splice(index + by, 0, row);
      return next;
    });
  };
  const add = () => {
    setRows((current) => [
      ...current,
      {
        key: newKey(),
        name: "",
        kind: "percent",
        share: "",
        deadline: "",
        paymentMode: "pay_on_invoice",
      },
    ]);
  };

  const errorAt = (index: number, field: string): string | undefined =>
    serverErrors.find((e) => e.field === `milestones.${String(index)}.${field}`)?.message;

  const save = async () => {
    if (!items) return;
    setBusy(true);
    setMessage(undefined);
    setServerErrors([]);
    try {
      const response = await fetch(`/api/projects/${projectId}/milestones`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          milestones: rows.map((row, i) => ({
            ...(row.id ? { id: row.id } : {}),
            name: row.name,
            deadline: row.deadline,
            paymentMode: row.paymentMode,
            ...(shares[i] as object),
          })),
        }),
      });
      const body = (await response.json()) as {
        error?: string;
        errors?: FieldIssue[];
        milestones?: SavedMilestone[];
      };
      if (!response.ok || !body.milestones) {
        setMessage(body.error ?? "Saving failed. Try again.");
        setServerErrors(body.errors ?? []);
        return;
      }
      setRows(body.milestones.map((m) => toRow(m, currency)));
      setMessage("Milestones saved.");
      router.refresh();
    } catch {
      setMessage("Saving failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const markStatus = async (id: string, status: MilestoneStatus) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/milestones/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const body = (await response.json()) as {
        error?: string;
        errors?: FieldIssue[];
        milestone?: SavedMilestone;
      };
      if (!response.ok || !body.milestone) {
        setMessage(
          body.errors?.[0]
            ? `Status ${body.errors[0].message}`
            : (body.error ?? "That didn't work. Try again."),
        );
        return;
      }
      const saved = body.milestone;
      setRows((current) =>
        current.map((row) => (row.id === saved.id ? { ...row, status: saved.status } : row)),
      );
      router.refresh();
    } catch {
      setMessage("That didn't work. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const planErrors = [
    ...(plan?.errors ?? []),
    ...serverErrors.filter((e) => e.field === "milestones"),
  ];

  return (
    <div className="milestones">
      {rows.length === 0 ? (
        <p className="muted">
          No milestones: the project is billed as one invoice of {formatMoney(totalCents, currency)}
          . Add milestones to split it, for example a deposit first.
        </p>
      ) : (
        <table className="table milestone-table stack-wide">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Share</th>
              <th scope="col">Deadline</th>
              <th scope="col">Payment</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const locked = row.status !== undefined && hasInvoice(row.status);
              const label = row.name || `milestone ${String(index + 1)}`;
              const shareError =
                shareErrors[index] ??
                errorAt(index, row.kind === "amount" ? "amountCents" : "percentBp");
              const warning = plan?.warnings.find(
                (w) => w.field === `milestones.${String(index)}.deadline`,
              );
              return (
                <tr key={row.key}>
                  <td data-label="Name">
                    <input
                      aria-label={`Name of ${label}`}
                      value={row.name}
                      onChange={(e) => {
                        update(index, { name: e.target.value });
                      }}
                      aria-invalid={Boolean(errorAt(index, "name"))}
                    />
                    {errorAt(index, "name") ? (
                      <div className="field-error">Name {errorAt(index, "name")}</div>
                    ) : null}
                  </td>
                  <td data-label="Share">
                    <div className="share">
                      <input
                        aria-label={`Share of ${label}`}
                        inputMode="decimal"
                        value={row.share}
                        disabled={locked}
                        onChange={(e) => {
                          update(index, { share: e.target.value });
                        }}
                        aria-invalid={Boolean(row.share && shareError)}
                      />
                      <select
                        aria-label={`Share type of ${label}`}
                        value={row.kind}
                        disabled={locked}
                        onChange={(e) => {
                          update(index, {
                            kind: e.target.value === "amount" ? "amount" : "percent",
                            share: "",
                          });
                        }}
                      >
                        <option value="percent">%</option>
                        <option value="amount">{currency}</option>
                      </select>
                    </div>
                    {row.share && shareError ? (
                      <div className="field-error">Share {shareError}</div>
                    ) : null}
                    {cents?.[index] !== undefined ? (
                      <div className="field-hint money-hint">
                        {formatMoney(cents[index], currency)}
                      </div>
                    ) : null}
                  </td>
                  <td data-label="Deadline">
                    <input
                      aria-label={`Deadline of ${label}`}
                      type="date"
                      value={row.deadline}
                      onChange={(e) => {
                        update(index, { deadline: e.target.value });
                      }}
                      aria-invalid={Boolean(errorAt(index, "deadline"))}
                    />
                    {errorAt(index, "deadline") ? (
                      <div className="field-error">Deadline {errorAt(index, "deadline")}</div>
                    ) : null}
                    {warning ? (
                      <div className="field-hint warning-text">{warning.message}</div>
                    ) : null}
                  </td>
                  <td data-label="Payment">
                    <select
                      aria-label={`Payment mode of ${label}`}
                      value={row.paymentMode}
                      onChange={(e) => {
                        update(index, { paymentMode: e.target.value as Row["paymentMode"] });
                      }}
                    >
                      {MODES.map((mode) => (
                        <option key={mode.value} value={mode.value}>
                          {mode.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td data-label="Status">
                    {row.status && row.id ? (
                      <>
                        <StatusBadge status={row.status}>{statusLabel(row.status)}</StatusBadge>
                        {manualNextStatuses(row.status).map((next) => (
                          <button
                            key={next}
                            type="button"
                            className="link-button status-button"
                            disabled={busy}
                            onClick={() => void markStatus(row.id ?? "", next)}
                          >
                            Mark {statusLabel(next).toLowerCase()}
                          </button>
                        ))}
                      </>
                    ) : (
                      <span className="muted">Not saved yet</span>
                    )}
                  </td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="link-button"
                      aria-label={`Move ${label} up`}
                      disabled={index === 0}
                      onClick={() => {
                        move(index, -1);
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      aria-label={`Move ${label} down`}
                      disabled={index === rows.length - 1}
                      onClick={() => {
                        move(index, 1);
                      }}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      aria-label={`Remove ${label}`}
                      disabled={locked}
                      onClick={() => {
                        setRows((current) => current.filter((_, i) => i !== index));
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="milestone-total" aria-live="polite">
        {rows.length === 0 ? null : planErrors.length > 0 ? (
          planErrors.map((e) => (
            <div key={e.message} className="field-error">
              {e.message}
            </div>
          ))
        ) : items ? (
          <div>Adds up to {formatMoney(totalCents, currency)}, the project total.</div>
        ) : (
          <div className="muted">Fill in every share to see the total.</div>
        )}
      </div>

      {message ? (
        <div className={serverErrors.length > 0 ? "banner banner-error" : "banner"} role="status">
          {message}
        </div>
      ) : null}

      <div className="actions">
        <button type="button" className="button button-secondary" onClick={add}>
          Add milestone
        </button>
        <button
          type="button"
          className="button"
          disabled={busy || (rows.length > 0 && (!items || (plan?.errors.length ?? 0) > 0))}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save milestones"}
        </button>
      </div>
    </div>
  );
};
