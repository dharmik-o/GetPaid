import { DateTime } from "luxon";
import type { PaymentTerms, ScheduleSettings, SendWindow } from "./settings";

// The one place reminder timing is worked out. Instants are UTC `Date`s; calendar dates are
// `YYYY-MM-DD` strings in the client's time zone. "Day n" means n days after the due date.

export const OVERDUE_TIERS = ["tier1", "tier2", "tier3"] as const;
export type OverdueTier = (typeof OVERDUE_TIERS)[number];
export type Tier = "courtesy" | OverdueTier;

/** A reminder that was sent or skipped. A reminder still waiting for approval blocks the next one. */
export type PastReminder = { tier: Tier; at: Date };

export type NextSendInput = {
  settings: ScheduleSettings;
  /** The invoice due date, in the client's time zone. */
  dueDate: string;
  /** The client's IANA time zone, e.g. America/New_York. */
  timeZone: string;
  history: readonly PastReminder[];
  now: Date;
};

export type NextSend =
  { status: "scheduled"; tier: Tier; sendAt: Date } | { status: "paused" } | { status: "done" };

const DONE: NextSend = { status: "done" };

const isoDateOf = (value: DateTime): string => {
  const iso = value.toISODate();
  if (!iso) throw new Error(`Could not work out a date: ${value.invalidExplanation ?? "invalid"}.`);
  return iso;
};

const calendarDate = (iso: string): DateTime => DateTime.fromISO(iso, { zone: "utc" });

const addDays = (iso: string, days: number): string => isoDateOf(calendarDate(iso).plus({ days }));

const daysBetween = (from: string, to: string): number =>
  Math.round(calendarDate(to).diff(calendarDate(from), "days").days);

const assertTimeZone = (zone: string): void => {
  if (!DateTime.now().setZone(zone).isValid) {
    throw new Error(
      `Unknown time zone "${zone}". Pick an IANA zone (for example America/New_York) on the client.`,
    );
  }
};

const localDateOf = (instant: Date, zone: string): string =>
  isoDateOf(DateTime.fromJSDate(instant, { zone }));

const startOfLocalDay = (iso: string, zone: string): Date =>
  DateTime.fromISO(iso, { zone }).startOf("day").toJSDate();

const laterOf = (a: Date, b: Date): Date => (a > b ? a : b);

const parseClock = (clock: string): { hour: number; minute: number } => {
  const [hour = 0, minute = 0] = clock.split(":").map(Number);
  return { hour, minute };
};

/** When the invoice is due, from the payment terms and the date it was issued. */
export const computeDueDate = (terms: PaymentTerms, issuedOn: string): string => {
  switch (terms.kind) {
    case "on_receipt":
      return issuedOn;
    case "net":
      return addDays(issuedOn, terms.days);
    case "date":
      return terms.date;
  }
};

/** The first instant at or after `from` that is inside the send window, in the client's zone. */
export const nextWindowSlot = (from: Date, window: SendWindow, timeZone: string): Date => {
  assertTimeZone(timeZone);
  const local = DateTime.fromJSDate(from, { zone: timeZone });
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = local.startOf("day").plus({ days: offset });
    if (!window.days.includes(day.weekday)) continue;
    const start = day.set(parseClock(window.start));
    const end = day.set(parseClock(window.end));
    if (offset > 0 || local < start) return start.toJSDate();
    if (local < end) return local.toJSDate();
  }
  throw new Error("The send window has no open days. Pick at least one day in the schedule.");
};

type Plan = {
  settings: ScheduleSettings;
  dueDate: string;
  timeZone: string;
  earliest: Date;
};

const dayOf = (plan: Plan, instant: Date): number =>
  daysBetween(plan.dueDate, localDateOf(instant, plan.timeZone));

const slotFrom = (plan: Plan, from: Date): Date =>
  nextWindowSlot(laterOf(from, plan.earliest), plan.settings.sendWindow, plan.timeZone);

const slotOnDay = (plan: Plan, day: number): Date =>
  slotFrom(plan, startOfLocalDay(addDays(plan.dueDate, day), plan.timeZone));

const tierForDay = (day: number, { tierBoundaries }: ScheduleSettings): OverdueTier => {
  if (day >= tierBoundaries.tier3) return "tier3";
  if (day >= tierBoundaries.tier2) return "tier2";
  return "tier1";
};

const rank = (tier: OverdueTier): number => OVERDUE_TIERS.indexOf(tier);

const higherTier = (a: OverdueTier, b: OverdueTier): OverdueTier => (rank(a) >= rank(b) ? a : b);

const tierAfter = (tier: OverdueTier): OverdueTier | undefined => OVERDUE_TIERS[rank(tier) + 1];

/** Tier 1 starts at its boundary, and never before the grace period is over. */
const firstOverdueDay = ({ tierBoundaries, graceDays }: ScheduleSettings): number =>
  Math.max(tierBoundaries.tier1, graceDays + 1);

type OverdueReminder = { tier: OverdueTier; at: Date };

const scheduled = (tier: Tier, sendAt: Date): NextSend => ({ status: "scheduled", tier, sendAt });

/** The courtesy note, if it can still land on or before the due date. */
const planCourtesy = (plan: Plan): NextSend | undefined => {
  const { preDueDays } = plan.settings;
  if (preDueDays === null) return undefined;
  const sendAt = slotOnDay(plan, -preDueDays);
  return dayOf(plan, sendAt) <= 0 ? scheduled("courtesy", sendAt) : undefined;
};

/** Every N days: the interval is the minimum gap, each tier gets at most `maxPerTier`. */
const planEveryNDays = (plan: Plan, intervalDays: number, overdue: OverdueReminder[]): NextSend => {
  const { settings } = plan;
  const last = overdue.at(-1);
  const countIn = (tier: OverdueTier): number => overdue.filter((r) => r.tier === tier).length;
  let minDay = firstOverdueDay(settings);
  if (last) minDay = Math.max(minDay, dayOf(plan, last.at) + intervalDays);
  let floor: OverdueTier = last?.tier ?? "tier1";

  // Each pass either returns or raises `floor`, so this ends within one pass per tier.
  for (let pass = 0; pass <= OVERDUE_TIERS.length; pass += 1) {
    if (countIn(floor) >= settings.maxPerTier) {
      const next = tierAfter(floor);
      if (!next) return DONE;
      floor = next;
      minDay = Math.max(minDay, settings.tierBoundaries[next]);
      continue;
    }
    const sendAt = slotOnDay(plan, minDay);
    const tier = higherTier(tierForDay(dayOf(plan, sendAt), settings), floor);
    if (countIn(tier) >= settings.maxPerTier) {
      floor = tier;
      continue;
    }
    return scheduled(tier, sendAt);
  }
  return DONE;
};

/** Specific dates: each listed date once, in order; missed dates are skipped. */
const planListedDates = (
  plan: Plan,
  dates: readonly string[],
  overdue: OverdueReminder[],
): NextSend => {
  const last = overdue.at(-1);
  const lastDate = last ? localDateOf(last.at, plan.timeZone) : undefined;
  const today = localDateOf(plan.earliest, plan.timeZone);
  const firstDay = firstOverdueDay(plan.settings);
  const next = [...new Set(dates)]
    .sort()
    .find(
      (date) =>
        daysBetween(plan.dueDate, date) >= firstDay &&
        date >= today &&
        (lastDate === undefined || date > lastDate),
    );
  if (!next) return DONE;
  const sendAt = slotFrom(plan, startOfLocalDay(next, plan.timeZone));
  const tier = higherTier(tierForDay(dayOf(plan, sendAt), plan.settings), last?.tier ?? "tier1");
  return scheduled(tier, sendAt);
};

const isOverdueReminder = (reminder: PastReminder): reminder is OverdueReminder =>
  reminder.tier !== "courtesy";

/** The next reminder for one invoice: its tier and send time, or why there isn't one. */
export const nextSend = ({
  settings,
  dueDate,
  timeZone,
  history,
  now,
}: NextSendInput): NextSend => {
  assertTimeZone(timeZone);
  if (settings.paused) return { status: "paused" };
  const snoozeEnd = settings.snoozeUntil ? startOfLocalDay(settings.snoozeUntil, timeZone) : now;
  const plan: Plan = { settings, dueDate, timeZone, earliest: laterOf(now, snoozeEnd) };

  const overdue = history.filter(isOverdueReminder).sort((a, b) => a.at.getTime() - b.at.getTime());
  const courtesySent = history.some((reminder) => reminder.tier === "courtesy");
  if (overdue.length === 0 && !courtesySent) {
    const courtesy = planCourtesy(plan);
    if (courtesy) return courtesy;
  }

  const { interval } = settings;
  return interval.kind === "every"
    ? planEveryNDays(plan, interval.days, overdue)
    : planListedDates(plan, interval.dates, overdue);
};
