"use client";

import { useState, type ReactNode } from "react";
import { formatAmountInput, parseAmount } from "@/lib/currencies";
import { describeSchedule } from "@/lib/schedule-preview";
import {
  formatPercent,
  parseDateList,
  parsePercent,
  setOverride,
  withoutOverride,
} from "@/lib/schedule-form";
import type { ScheduleSettings, SettingsOverride } from "@/lib/settings";
import { validateSettings } from "@/lib/settings-validation";

// All timing settings for one layer (here: a project). Shows the inherited value of every
// group, stores only what the freelancer changes, validates inline and previews the schedule.

type Props = {
  inherited: ScheduleSettings;
  value: SettingsOverride;
  onChange: (next: SettingsOverride) => void;
  deadline: string;
  timeZone: string;
  currency: string;
  /** False when the contract has no late-fee clause: then no late fee may be set. */
  lateFeeAllowed: boolean;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const NET_DAYS = [7, 14, 30, 45, 60] as const;

const termsKey = (terms: ScheduleSettings["paymentTerms"]): string =>
  terms.kind === "net" ? `net_${String(terms.days)}` : terms.kind;

/** Friendly names for the parts of grouped settings, used in error messages. */
const SUBFIELD_LABELS: Record<string, string> = {
  tier1: "Tier 1",
  tier2: "Tier 2",
  tier3: "Tier 3",
  start: "The start time",
  end: "The end time",
  days: "This",
  date: "The date",
  dates: "Dates",
  amountCents: "The amount",
  basisPoints: "The rate",
};

const toInt = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));

type GroupProps = {
  title: string;
  changed: boolean;
  onReset: () => void;
  error?: string | undefined;
  children: ReactNode;
};

const Group = ({ title, changed, onReset, error, children }: GroupProps) => (
  <fieldset className="field schedule-group">
    <legend>{title}</legend>
    {children}
    <div className="field-hint">
      {changed ? (
        <>
          Changed for this project.{" "}
          <button type="button" className="link-button" onClick={onReset}>
            Use the default
          </button>
        </>
      ) : (
        "Default"
      )}
    </div>
    {error ? (
      <div className="field-error" role="alert">
        {error}
      </div>
    ) : null}
  </fieldset>
);

export const ScheduleForm = ({
  inherited,
  value,
  onChange,
  deadline,
  timeZone,
  currency,
  lateFeeAllowed,
}: Props) => {
  const effective: ScheduleSettings = { ...inherited, ...value };
  const [datesText, setDatesText] = useState(
    effective.interval.kind === "dates" ? effective.interval.dates.join(", ") : "",
  );
  const [feeText, setFeeText] = useState(() => {
    const fee = effective.lateFee;
    if (!fee) return "";
    return fee.kind === "flat"
      ? formatAmountInput(fee.amountCents, currency)
      : formatPercent(fee.basisPoints);
  });

  const validation = validateSettings(value, {
    parent: inherited,
    ...(deadline ? { deadline } : {}),
    contractHasLateFee: lateFeeAllowed,
  });
  const errors = validation.ok ? [] : validation.errors;
  const errorFor = (prefix: string): string | undefined => {
    const issue = errors.find((e) => e.field === prefix || e.field.startsWith(`${prefix}.`));
    if (!issue) return undefined;
    const part = issue.field.split(".")[1];
    return `${(part && SUBFIELD_LABELS[part]) ?? "This"} ${issue.message}`;
  };

  const set = <K extends keyof ScheduleSettings>(key: K, next: ScheduleSettings[K]) => {
    onChange(setOverride(value, inherited, key, next));
  };
  const reset = (key: keyof ScheduleSettings) => () => {
    onChange(withoutOverride(value, key));
  };
  const changed = (key: keyof ScheduleSettings) => key in value;

  const setTerms = (key: string) => {
    if (key === "on_receipt") set("paymentTerms", { kind: "on_receipt" });
    else if (key === "date") set("paymentTerms", { kind: "date", date: deadline || "" });
    else
      set("paymentTerms", { kind: "net", days: Number(key.slice(4)) as (typeof NET_DAYS)[number] });
  };

  const setFee = (kind: string, text: string) => {
    setFeeText(text);
    if (kind === "none") set("lateFee", null);
    else if (kind === "flat") {
      const amount = parseAmount(text, currency);
      set("lateFee", { kind: "flat", amountCents: amount.ok ? amount.minor : Number.NaN });
    } else set("lateFee", { kind: "percent_per_month", basisPoints: parsePercent(text) });
  };

  const preview = validation.ok
    ? describeSchedule({ ...inherited, ...validation.settings }, { deadline, timeZone })
    : "Fix the highlighted settings to see when reminders go out.";

  const window = effective.sendWindow;
  const tiers = effective.tierBoundaries;

  return (
    <div className="schedule-form">
      <p className="schedule-preview" aria-live="polite">
        {preview}
      </p>
      {validation.warnings.map((warning) => (
        <div key={warning.field} className="banner banner-warning">
          {warning.message}
        </div>
      ))}

      <Group
        title="Payment terms"
        changed={changed("paymentTerms")}
        onReset={reset("paymentTerms")}
        error={errorFor("paymentTerms")}
      >
        <label className="visually-hidden" htmlFor="terms">
          Payment terms
        </label>
        <select
          id="terms"
          value={termsKey(effective.paymentTerms)}
          onChange={(e) => {
            setTerms(e.target.value);
          }}
        >
          <option value="on_receipt">Due on receipt</option>
          {NET_DAYS.map((days) => (
            <option key={days} value={`net_${String(days)}`}>
              Net {days}
            </option>
          ))}
          <option value="date">A specific date</option>
        </select>
        {effective.paymentTerms.kind === "date" ? (
          <input
            aria-label="Due date"
            type="date"
            value={effective.paymentTerms.date}
            onChange={(e) => {
              set("paymentTerms", { kind: "date", date: e.target.value });
            }}
          />
        ) : null}
      </Group>

      <Group
        title="Courtesy note before the due date"
        changed={changed("preDueDays")}
        onReset={reset("preDueDays")}
        error={errorFor("preDueDays")}
      >
        <label className="inline">
          <input
            type="checkbox"
            checked={effective.preDueDays !== null}
            onChange={(e) => {
              set("preDueDays", e.target.checked ? 2 : null);
            }}
          />{" "}
          Send a friendly heads-up
        </label>
        {effective.preDueDays !== null ? (
          <label className="inline">
            <input
              type="number"
              min={1}
              max={30}
              value={Number.isNaN(effective.preDueDays) ? "" : effective.preDueDays}
              onChange={(e) => {
                set("preDueDays", toInt(e.target.value));
              }}
            />{" "}
            days before
          </label>
        ) : null}
      </Group>

      <Group
        title="Grace period"
        changed={changed("graceDays")}
        onReset={reset("graceDays")}
        error={errorFor("graceDays")}
      >
        <label className="inline">
          <input
            type="number"
            min={0}
            max={14}
            value={Number.isNaN(effective.graceDays) ? "" : effective.graceDays}
            onChange={(e) => {
              set("graceDays", toInt(e.target.value));
            }}
          />{" "}
          days after the due date before the first reminder
        </label>
      </Group>

      <Group
        title="Reminder interval"
        changed={changed("interval")}
        onReset={reset("interval")}
        error={errorFor("interval")}
      >
        <label className="inline">
          <input
            type="radio"
            name="interval"
            checked={effective.interval.kind === "every"}
            onChange={() => {
              set("interval", { kind: "every", days: 3 });
            }}
          />{" "}
          Every
        </label>{" "}
        {effective.interval.kind === "every" ? (
          <label className="inline">
            <input
              type="number"
              min={1}
              max={90}
              value={Number.isNaN(effective.interval.days) ? "" : effective.interval.days}
              onChange={(e) => {
                set("interval", { kind: "every", days: toInt(e.target.value) });
              }}
            />{" "}
            days
          </label>
        ) : null}
        <label className="inline">
          <input
            type="radio"
            name="interval"
            checked={effective.interval.kind === "dates"}
            onChange={() => {
              set("interval", { kind: "dates", dates: parseDateList(datesText) });
            }}
          />{" "}
          On specific dates
        </label>
        {effective.interval.kind === "dates" ? (
          <input
            aria-label="Reminder dates"
            placeholder="2026-12-04, 2026-12-11"
            value={datesText}
            onChange={(e) => {
              setDatesText(e.target.value);
              set("interval", { kind: "dates", dates: parseDateList(e.target.value) });
            }}
          />
        ) : null}
      </Group>

      <Group
        title="Reminders per tier"
        changed={changed("maxPerTier")}
        onReset={reset("maxPerTier")}
        error={errorFor("maxPerTier")}
      >
        <label className="inline">
          <input
            type="number"
            min={1}
            max={5}
            value={Number.isNaN(effective.maxPerTier) ? "" : effective.maxPerTier}
            onChange={(e) => {
              set("maxPerTier", toInt(e.target.value));
            }}
          />{" "}
          before moving up a tier
        </label>
      </Group>

      <Group
        title="Nudge me about an unanswered draft"
        changed={changed("nudgeHours")}
        onReset={reset("nudgeHours")}
        error={errorFor("nudgeHours")}
      >
        <label className="inline">
          Once, after{" "}
          <input
            type="number"
            min={1}
            max={168}
            value={Number.isNaN(effective.nudgeHours) ? "" : effective.nudgeHours}
            onChange={(e) => {
              set("nudgeHours", toInt(e.target.value));
            }}
          />{" "}
          hours on Telegram. The draft stays held and never sends on its own.
        </label>
      </Group>

      <Group
        title="Tiers start on day overdue"
        changed={changed("tierBoundaries")}
        onReset={reset("tierBoundaries")}
        error={errorFor("tierBoundaries")}
      >
        <div className="actions">
          {(["tier1", "tier2", "tier3"] as const).map((tier, index) => (
            <label key={tier} className="inline">
              Tier {index + 1}{" "}
              <input
                type="number"
                min={1}
                max={365}
                value={Number.isNaN(tiers[tier]) ? "" : tiers[tier]}
                onChange={(e) => {
                  set("tierBoundaries", { ...tiers, [tier]: toInt(e.target.value) });
                }}
              />
            </label>
          ))}
        </div>
      </Group>

      <Group
        title="Send window (client time)"
        changed={changed("sendWindow")}
        onReset={reset("sendWindow")}
        error={errorFor("sendWindow")}
      >
        <div className="actions">
          {WEEKDAYS.map((label, index) => {
            const day = index + 1;
            return (
              <label key={label} className="inline">
                <input
                  type="checkbox"
                  checked={window.days.includes(day)}
                  onChange={(e) => {
                    const days = e.target.checked
                      ? [...window.days, day].sort((a, b) => a - b)
                      : window.days.filter((d) => d !== day);
                    set("sendWindow", { ...window, days });
                  }}
                />{" "}
                {label}
              </label>
            );
          })}
        </div>
        <div className="actions">
          <label className="inline">
            From{" "}
            <input
              type="time"
              value={window.start}
              onChange={(e) => {
                set("sendWindow", { ...window, start: e.target.value });
              }}
            />
          </label>
          <label className="inline">
            to{" "}
            <input
              type="time"
              value={window.end}
              onChange={(e) => {
                set("sendWindow", { ...window, end: e.target.value });
              }}
            />
          </label>
        </div>
      </Group>

      <Group
        title="Late fee"
        changed={changed("lateFee")}
        onReset={reset("lateFee")}
        error={errorFor("lateFee")}
      >
        {!lateFeeAllowed && effective.lateFee === null ? (
          <p className="field-hint">
            Add the contract&apos;s late-fee clause above to mention a late fee.
          </p>
        ) : (
          <div className="actions">
            <select
              aria-label="Late fee type"
              value={effective.lateFee?.kind ?? "none"}
              onChange={(e) => {
                setFee(e.target.value, "");
              }}
            >
              <option value="none">None</option>
              <option value="percent_per_month">% per month</option>
              <option value="flat">Flat amount</option>
            </select>
            {effective.lateFee ? (
              <input
                aria-label={
                  effective.lateFee.kind === "flat"
                    ? `Late fee in ${currency}`
                    : "Late fee, % per month"
                }
                inputMode="decimal"
                value={feeText}
                onChange={(e) => {
                  setFee(effective.lateFee?.kind ?? "none", e.target.value);
                }}
              />
            ) : null}
          </div>
        )}
      </Group>

      <Group
        title="Approval"
        changed={changed("approvalMode")}
        onReset={reset("approvalMode")}
        error={errorFor("approvalMode")}
      >
        <label className="visually-hidden" htmlFor="approval">
          Approval
        </label>
        <select
          id="approval"
          value={effective.approvalMode}
          onChange={(e) => {
            set(
              "approvalMode",
              e.target.value === "auto_send_tier1" ? "auto_send_tier1" : "approve_all",
            );
          }}
        >
          <option value="approve_all">Approve every message</option>
          <option value="auto_send_tier1">Send Tier 1 without asking</option>
        </select>
        <div className="field-hint">Final notices (Tier 3) always wait for your approval.</div>
      </Group>
    </div>
  );
};
