import type { Db } from "./db";
import { toCents } from "./db-values";
import { isCharging, retainerDates, SELECT_RETAINERS, type RetainerStatus } from "./retainers";
import {
  addCalendarDays,
  maintenanceOccurrences,
  retainerCyclesBetween,
  startOfWeekDate,
  todayIn,
} from "./schedule";

// Server-only: the next 90 days of maintenance jobs, renewals and retainer charges, with the expected
// income. Every amount comes straight from the database in integer minor units, and each currency
// keeps its own total: nothing is ever converted, because no rate here could be trusted.

const WINDOW_DAYS = 90;

export type UpcomingItem = {
  key: string;
  kind: "maintenance" | "renewal" | "retainer";
  name: string;
  clientName: string;
  date: string;
  /** Null: a job with no estimate. Unknown, not zero. */
  amountCents: number | null;
  currency: string | null;
};

export type UpcomingWeek = { weekOf: string; items: UpcomingItem[] };

export type CurrencyTotal = { currency: string; cents: number };

export type Upcoming = {
  until: string;
  weeks: UpcomingWeek[];
  totals: CurrencyTotal[];
  /** Jobs in the list with no estimate, so the totals may be low. */
  withoutEstimate: number;
};

/** The Monday of a date's week. */
export const weekOf = startOfWeekDate;

/** A plain sum per currency, alphabetical. Items with no amount aren't guessed at. */
export const totalsByCurrency = (
  items: readonly Pick<UpcomingItem, "amountCents" | "currency">[],
): CurrencyTotal[] => {
  const totals = new Map<string, number>();
  for (const { amountCents, currency } of items) {
    if (amountCents === null || currency === null) continue;
    totals.set(currency, (totals.get(currency) ?? 0) + amountCents);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => ({ currency, cents }));
};

const loadMaintenance = async (db: Db, from: string, to: string): Promise<UpcomingItem[]> => {
  const { rows } = await db.query<{
    id: string;
    type: "maintenance" | "renewal";
    task: string;
    client_name: string;
    next_due: string;
    repeat_months: number;
    est_cost_cents: string | null;
    currency: string;
  }>(
    `SELECT mt.id::text, mt.type, mt.task, c.name AS client_name, mt.next_due::text, mt.repeat_months,
       mt.est_cost_cents::text, mt.currency
     FROM public.maintenance_tasks mt
     JOIN public.projects p ON p.id = mt.project_id
     JOIN public.clients c ON c.id = p.client_id
     WHERE mt.status = 'active' AND p.archived_at IS NULL`,
  );
  return rows.flatMap((row) =>
    maintenanceOccurrences(row.next_due, row.repeat_months, from, to).map((date): UpcomingItem => ({
      key: `task-${row.id}-${date}`,
      kind: row.type,
      name: row.task,
      clientName: row.client_name,
      date,
      amountCents: row.est_cost_cents === null ? null : toCents(row.est_cost_cents),
      currency: row.est_cost_cents === null ? null : row.currency,
    })),
  );
};

const loadRetainerCharges = async (db: Db, from: string, to: string): Promise<UpcomingItem[]> => {
  const { rows } = await db.query<{
    id: string;
    name: string;
    client_name: string;
    amount_cents: string;
    currency: string;
    status: RetainerStatus;
    interval_unit: "week" | "month";
    interval_count: number;
    starts_on: string;
    ends_on: string | null;
  }>(SELECT_RETAINERS);
  return rows
    .filter((row) => isCharging(row.status))
    .flatMap((row) =>
      retainerCyclesBetween(retainerDates(row), from, to).map((date): UpcomingItem => ({
        key: `retainer-${row.id}-${date}`,
        kind: "retainer",
        name: row.name,
        clientName: row.client_name,
        date,
        amountCents: toCents(row.amount_cents),
        currency: row.currency,
      })),
    );
};

const groupByWeek = (items: UpcomingItem[]): UpcomingWeek[] => {
  const weeks = new Map<string, UpcomingItem[]>();
  for (const item of items) {
    const week = weekOf(item.date);
    weeks.set(week, [...(weeks.get(week) ?? []), item]);
  }
  return [...weeks.entries()].map(([week, list]) => ({ weekOf: week, items: list }));
};

export const loadUpcoming = async (db: Db, now: Date): Promise<Upcoming> => {
  const { rows } = await db.query<{ time_zone: string }>(
    "SELECT time_zone FROM public.users WHERE id = (SELECT auth.uid())",
  );
  const today = todayIn(now, rows[0]?.time_zone ?? "UTC");
  const until = addCalendarDays(today, WINDOW_DAYS);
  const items = [
    ...(await loadMaintenance(db, today, until)),
    ...(await loadRetainerCharges(db, today, until)),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return {
    until,
    weeks: groupByWeek(items),
    totals: totalsByCurrency(items),
    withoutEstimate: items.filter((item) => item.amountCents === null).length,
  };
};
