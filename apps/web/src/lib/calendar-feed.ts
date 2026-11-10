import { DateTime } from "luxon";
import { linkValueOf } from "./calendar-link-options";
import { listEntries, type CalendarEntry } from "./calendar-entries";
import type { Db } from "./db";
import { toCents, toIso } from "./db-values";
import { formatMoney } from "./format";
import { isCharging, retainerDates, SELECT_RETAINERS, type RetainerStatus } from "./retainers";
import {
  addCalendarDays,
  maintenanceOccurrences,
  retainerCyclesBetween,
  startOfLocalDay,
  todayIn,
} from "./schedule";

// Server-only: one list of everything on the calendar between two dates, as the signed-in user sees
// it (RLS). The freelancer's own entries are stored; every other date is read live from the table that
// owns it and never copied (decision F2), so nothing here can drift.

export const MAX_RANGE_DAYS = 400;

export type CalendarItemType =
  | "entry"
  | "milestone_deadline"
  | "invoice_due"
  | "reminder_send"
  | "maintenance"
  | "renewal"
  | "retainer_charge"
  | "hold_expiry"
  | "agreement_deadline"
  | "imported";

export type OwnEntryFields = {
  kind: string;
  startsOn: string;
  startTime: string | null;
  endTime: string | null;
  remindOnDay: boolean;
  linkValue: string;
};

export type CalendarItem = {
  /** "entry:<id>", "milestone:<id>", "invoice:<id>", "imported:<id>", ... */
  key: string;
  type: CalendarItemType;
  title: string;
  /** ISO date in the viewer's zone. */
  startsOn: string;
  endsOn: string | null;
  /** ISO datetime in UTC for timed items. */
  startAt: string | null;
  endAt: string | null;
  allDay: boolean;
  clientId: string | null;
  clientName: string | null;
  projectId: string | null;
  milestoneId: string | null;
  status: string | null;
  /** Imported items only, e.g. "Work (Google)". */
  sourceName: string | null;
  /** An imported event with a matched client, or an entry of kind "call" with a client. */
  isClientMeeting: boolean;
  href: string;
  /** True only for the freelancer's own entries. */
  editable: boolean;
  /** Entries only. */
  notes: string | null;
  /** One plain line saying what this is: built here from stored fields, never from message bodies. */
  summary: string;
  /** Own entries only: the stored fields the edit form needs (the entry's own date and zone). */
  own: OwnEntryFields | null;
};

export type FeedRange = { from: string; to: string; zone: string };

const base = {
  endsOn: null,
  startAt: null,
  endAt: null,
  allDay: true,
  clientId: null,
  clientName: null,
  projectId: null,
  milestoneId: null,
  status: null,
  sourceName: null,
  isClientMeeting: false,
  editable: false,
  notes: null,
  summary: "",
  own: null,
} satisfies Partial<CalendarItem>;

const KIND_LABEL: Record<string, string> = {
  task: "Task",
  event: "Event",
  deadline: "Deadline",
  call: "Call",
};
const INVOICE_STATE: Record<string, string> = { sent: "unpaid", partially_paid: "partly paid" };
const APPROVAL_STATE: Record<string, string> = {
  waiting: "waiting for your approval",
  approved: "approved, goes out at the planned time",
};
const joinParts = (parts: (string | null)[]): string =>
  parts.filter((part) => part !== null && part !== "").join(" · ");

const HOLD_MAX_DAYS = 29;
const TIER_LABEL: Record<string, string> = {
  courtesy: "Courtesy reminder",
  tier1: "First reminder",
  tier2: "Second reminder",
  tier3: "Final notice",
  maintenance: "Maintenance reminder",
  auto_pay_approval: "Auto-pay approval email",
  hold_approval: "Hold approval email",
  agreement_request: "Agreement email",
  agreement_signed_copy: "Signed agreement email",
  final_demand: "Final demand letter",
};

/** True when both are real dates and `to` is not before `from` or more than 400 days after it. */
export const validRange = (from: string, to: string): boolean => {
  const a = DateTime.fromISO(from, { zone: "utc" });
  const b = DateTime.fromISO(to, { zone: "utc" });
  return a.isValid && b.isValid && b >= a && b.diff(a, "days").days <= MAX_RANGE_DAYS;
};

const inRange = (date: string, { from, to }: FeedRange): boolean => date >= from && date <= to;

const dateIn = (instant: Date | string, zone: string): string =>
  todayIn(instant instanceof Date ? instant : new Date(instant), zone);

const entryItem = (
  entry: CalendarEntry,
  zone: string,
  clientNames: Map<string, string>,
): CalendarItem => {
  const timed = entry.startTime !== null;
  const at = (time: string | null): string | null =>
    time === null
      ? null
      : toIso(DateTime.fromISO(`${entry.startsOn}T${time}`, { zone: entry.timeZone }).toJSDate());
  const startAt = at(entry.startTime);
  return {
    ...base,
    key: `entry:${entry.id}`,
    type: "entry",
    title: entry.title,
    startsOn: startAt === null ? entry.startsOn : dateIn(startAt, zone),
    endsOn: entry.endsOn,
    startAt,
    endAt: at(entry.endTime),
    allDay: !timed,
    clientId: entry.clientId,
    clientName: entry.clientId === null ? null : (clientNames.get(entry.clientId) ?? null),
    projectId: entry.projectId,
    milestoneId: entry.milestoneId,
    status: entry.status,
    isClientMeeting: entry.kind === "call" && entry.clientId !== null,
    href: `/calendar/${entry.id}`,
    editable: true,
    notes: entry.notes,
    own: {
      kind: entry.kind,
      startsOn: entry.startsOn,
      startTime: entry.startTime,
      endTime: entry.endTime,
      remindOnDay: entry.remindOnDay,
      linkValue: linkValueOf(entry),
    },
    summary: joinParts([
      KIND_LABEL[entry.kind] ?? "Entry",
      entry.clientId === null ? null : (clientNames.get(entry.clientId) ?? null),
      entry.status === "done" ? "done" : null,
    ]),
  };
};

const loadEntries = async (db: Db, range: FeedRange): Promise<CalendarItem[]> => {
  // An entry's own zone can put it a day either side of the viewer's, so ask for a day more.
  const entries = await listEntries(
    db,
    addCalendarDays(range.from, -1),
    addCalendarDays(range.to, 1),
  );
  const { rows } = await db.query<{ id: string; name: string }>(
    "SELECT id::text, name FROM public.clients",
  );
  const names = new Map(rows.map((row) => [row.id, row.name]));
  return entries
    .map((entry) => entryItem(entry, range.zone, names))
    .filter((item) => item.startsOn <= range.to && (item.endsOn ?? item.startsOn) >= range.from);
};

const loadMilestones = async (db: Db, range: FeedRange): Promise<CalendarItem[]> => {
  const { rows } = await db.query<{
    id: string;
    name: string;
    deadline: string;
    position: number;
    amount_cents: string | null;
    percent_bp: number | null;
    currency: string;
    status: string;
    project_id: string;
    project_title: string;
    client_id: string;
    client_name: string;
  }>(
    `SELECT m.id::text, m.name, m.deadline::text, m.position, m.amount_cents::text, m.percent_bp,
       m.currency, m.status, p.id::text AS project_id,
       p.title AS project_title, c.id::text AS client_id, c.name AS client_name
     FROM public.milestones m
     JOIN public.projects p ON p.id = m.project_id
     JOIN public.clients c ON c.id = p.client_id
     WHERE m.deadline BETWEEN $1 AND $2 AND m.status <> 'paid' AND p.status <> 'cancelled'`,
    [range.from, range.to],
  );
  return rows.map((row) => ({
    ...base,
    key: `milestone:${row.id}`,
    type: "milestone_deadline",
    title: `Deadline: ${row.name} (${row.project_title})`,
    startsOn: row.deadline,
    clientId: row.client_id,
    clientName: row.client_name,
    projectId: row.project_id,
    milestoneId: row.id,
    status: row.status,
    href: `/projects/${row.project_id}`,
    summary: joinParts([
      `Milestone ${String(row.position)} of ${row.project_title} for ${row.client_name}`,
      row.amount_cents === null
        ? `${String((row.percent_bp ?? 0) / 100)}% of the project`
        : formatMoney(toCents(row.amount_cents), row.currency),
      "due",
    ]),
  }));
};

const loadInvoices = async (db: Db, range: FeedRange): Promise<CalendarItem[]> => {
  const { rows } = await db.query<{
    id: string;
    invoice_number: string | null;
    due_date: string;
    owed_cents: string;
    currency: string;
    status: string;
    milestone_id: string | null;
    project_id: string | null;
    client_id: string;
    client_name: string;
  }>(
    `SELECT i.id::text, i.invoice_number, i.due_date::text, (i.amount_cents - i.amount_paid_cents)::text AS owed_cents,
       i.currency, i.status, m.id::text AS milestone_id, p.id::text AS project_id,
       c.id::text AS client_id, c.name AS client_name
     FROM public.invoices i
     LEFT JOIN public.milestones m ON m.id = i.milestone_id
     LEFT JOIN public.retainers r ON r.id = i.retainer_id
     LEFT JOIN public.projects p ON p.id = coalesce(m.project_id, r.project_id)
     JOIN public.clients c ON c.id = coalesce(p.client_id, r.client_id)
     WHERE i.status IN ('sent', 'partially_paid') AND i.due_date BETWEEN $1 AND $2`,
    [range.from, range.to],
  );
  return rows.map((row) => ({
    ...base,
    key: `invoice:${row.id}`,
    type: "invoice_due",
    title: `Invoice due: ${formatMoney(toCents(row.owed_cents), row.currency)} from ${row.client_name}`,
    startsOn: row.due_date,
    clientId: row.client_id,
    clientName: row.client_name,
    projectId: row.project_id,
    milestoneId: row.milestone_id,
    status: row.status,
    href: row.project_id ? `/projects/${row.project_id}` : "/retainers",
    summary: joinParts([
      row.invoice_number === null ? "Invoice" : `Invoice ${row.invoice_number}`,
      formatMoney(toCents(row.owed_cents), row.currency),
      INVOICE_STATE[row.status] ?? row.status,
    ]),
  }));
};

const loadReminders = async (db: Db, range: FeedRange): Promise<CalendarItem[]> => {
  const { rows } = await db.query<{
    id: string;
    tier: string;
    scheduled_at: unknown;
    project_id: string | null;
    client_id: string | null;
    client_name: string | null;
    approval_status: string;
  }>(
    `WITH rem AS (
       SELECT rm.id, rm.tier, rm.scheduled_at, rm.approval_status,
         coalesce(im.project_id, mt.project_id, hm.project_id, ir.project_id, rr.project_id, ag.project_id) AS project_id,
         coalesce(ir.client_id, rr.client_id) AS retainer_client_id
       FROM public.reminders rm
       LEFT JOIN public.invoices i ON i.id = rm.invoice_id
       LEFT JOIN public.milestones im ON im.id = i.milestone_id
       LEFT JOIN public.retainers ir ON ir.id = i.retainer_id
       LEFT JOIN public.maintenance_tasks mt ON mt.id = rm.maintenance_task_id
       LEFT JOIN public.retainers rr ON rr.id = rm.retainer_id
       LEFT JOIN public.milestone_holds h ON h.id = rm.hold_id
       LEFT JOIN public.milestones hm ON hm.id = h.milestone_id
       LEFT JOIN public.agreements ag ON ag.id = rm.agreement_id
       WHERE rm.sent_at IS NULL AND rm.approval_status IN ('waiting', 'approved')
         AND rm.scheduled_at >= $1 AND rm.scheduled_at < $2
     )
     SELECT rem.id::text, rem.tier, rem.scheduled_at, rem.approval_status, rem.project_id::text,
       c.id::text AS client_id, c.name AS client_name
     FROM rem
     LEFT JOIN public.projects p ON p.id = rem.project_id
     LEFT JOIN public.clients c ON c.id = coalesce(p.client_id, rem.retainer_client_id)`,
    [
      startOfLocalDay(range.from, range.zone),
      startOfLocalDay(addCalendarDays(range.to, 1), range.zone),
    ],
  );
  return rows.map((row) => {
    const startAt = toIso(row.scheduled_at);
    return {
      ...base,
      key: `reminder:${row.id}`,
      type: "reminder_send",
      title: `${TIER_LABEL[row.tier] ?? "Reminder"} planned${row.client_name ? ` for ${row.client_name}` : ""}`,
      startsOn: dateIn(startAt, range.zone),
      startAt,
      allDay: false,
      clientId: row.client_id,
      clientName: row.client_name,
      projectId: row.project_id,
      status: row.approval_status,
      href: "/outbox",
      summary: joinParts([
        `${TIER_LABEL[row.tier] ?? "Reminder"}${row.client_name ? ` to ${row.client_name}` : ""}`,
        APPROVAL_STATE[row.approval_status] ?? row.approval_status,
      ]),
    };
  });
};

const loadMaintenance = async (db: Db, range: FeedRange): Promise<CalendarItem[]> => {
  const { rows } = await db.query<{
    id: string;
    type: "maintenance" | "renewal";
    task: string;
    next_due: string;
    repeat_months: number;
    project_id: string;
    client_id: string;
    client_name: string;
  }>(
    `SELECT mt.id::text, mt.type, mt.task, mt.next_due::text, mt.repeat_months,
       p.id::text AS project_id, c.id::text AS client_id, c.name AS client_name
     FROM public.maintenance_tasks mt
     JOIN public.projects p ON p.id = mt.project_id
     JOIN public.clients c ON c.id = p.client_id
     WHERE mt.status = 'active'`,
  );
  return rows.flatMap((row) =>
    maintenanceOccurrences(row.next_due, row.repeat_months, range.from, range.to)
      .filter((date) => inRange(date, range))
      .map((date): CalendarItem => ({
        ...base,
        key: `${row.type}:${row.id}:${date}`,
        type: row.type,
        title: `${row.type === "renewal" ? "Renewal" : "Maintenance"}: ${row.task}`,
        startsOn: date,
        clientId: row.client_id,
        clientName: row.client_name,
        projectId: row.project_id,
        href: "/maintenance",
        summary: joinParts([
          `${row.type === "renewal" ? "Renewal" : "Maintenance job"} for ${row.client_name}`,
          `repeats every ${row.repeat_months === 1 ? "month" : `${String(row.repeat_months)} months`}`,
        ]),
      })),
  );
};

const loadRetainers = async (db: Db, range: FeedRange): Promise<CalendarItem[]> => {
  const { rows } = await db.query<{
    id: string;
    client_id: string;
    client_name: string;
    name: string;
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
      retainerCyclesBetween(retainerDates(row), range.from, range.to).map((date): CalendarItem => ({
        ...base,
        key: `retainer:${row.id}:${date}`,
        type: "retainer_charge",
        title: `Retainer charge: ${row.name}, ${formatMoney(toCents(row.amount_cents), row.currency)}`,
        startsOn: date,
        clientId: row.client_id,
        clientName: row.client_name,
        href: "/retainers",
        summary: joinParts([
          `Retainer for ${row.client_name}`,
          formatMoney(toCents(row.amount_cents), row.currency),
          `every ${row.interval_count === 1 ? "" : `${String(row.interval_count)} `}${row.interval_unit}${row.interval_count === 1 ? "" : "s"}`,
        ]),
      })),
    );
};

const loadHolds = async (db: Db, range: FeedRange): Promise<CalendarItem[]> => {
  const { rows } = await db.query<{
    id: string;
    authorized_at: unknown;
    milestone_id: string;
    project_id: string;
    client_id: string;
    client_name: string;
    milestone_name: string;
  }>(
    `SELECT h.id::text, h.authorized_at, m.id::text AS milestone_id, m.name AS milestone_name,
       p.id::text AS project_id, c.id::text AS client_id, c.name AS client_name
     FROM public.milestone_holds h
     JOIN public.milestones m ON m.id = h.milestone_id
     JOIN public.projects p ON p.id = m.project_id
     JOIN public.clients c ON c.id = p.client_id
     WHERE h.status = 'authorized' AND h.authorized_at IS NOT NULL`,
  );
  return rows
    .map((row) => {
      const expiresAt = new Date(toIso(row.authorized_at));
      expiresAt.setUTCDate(expiresAt.getUTCDate() + HOLD_MAX_DAYS);
      return { row, startsOn: dateIn(expiresAt, range.zone) };
    })
    .filter(({ startsOn }) => inRange(startsOn, range))
    .map(({ row, startsOn }): CalendarItem => ({
      ...base,
      key: `hold:${row.id}`,
      type: "hold_expiry",
      title: `Payment hold expires: ${row.milestone_name}`,
      startsOn,
      clientId: row.client_id,
      clientName: row.client_name,
      projectId: row.project_id,
      milestoneId: row.milestone_id,
      status: "authorized",
      href: `/projects/${row.project_id}`,
      summary: `Authorised payment hold for ${row.milestone_name} (${row.client_name}) runs out today`,
    }));
};

/** Events from imported calendars that are switched on. All-day events keep their date, whatever the zone. */
/** The last day a sent agreement can be signed: its link stops working then. */
const loadAgreementDeadlines = async (db: Db, range: FeedRange): Promise<CalendarItem[]> => {
  const { rows } = await db.query<{
    id: string;
    number: string;
    token_expires_at: unknown;
    project_id: string;
    client_id: string;
    client_name: string;
  }>(
    `SELECT a.id::text, a.number, a.token_expires_at, a.project_id::text, c.id::text AS client_id,
       c.name AS client_name
     FROM public.agreements a JOIN public.clients c ON c.id = a.client_id
     WHERE a.status = 'sent' AND a.token_expires_at IS NOT NULL`,
  );
  return rows
    .map((row): CalendarItem => ({
      ...base,
      key: `agreement:${row.id}`,
      type: "agreement_deadline",
      title: `Last day to sign: agreement ${row.number} (${row.client_name})`,
      startsOn: dateIn(toIso(row.token_expires_at), range.zone),
      clientId: row.client_id,
      clientName: row.client_name,
      projectId: row.project_id,
      status: "sent",
      href: `/projects/${row.project_id}/agreement`,
      summary: `Agreement ${row.number} with ${row.client_name} · waiting for signature · the signing link stops working`,
    }))
    .filter((item) => inRange(item.startsOn, range));
};

const loadImported = async (db: Db, range: FeedRange): Promise<CalendarItem[]> => {
  const { rows } = await db.query<{
    id: string;
    title: string;
    all_day: boolean;
    occurrence_start: unknown;
    occurrence_end: unknown;
    status: string;
    client_id: string | null;
    client_name: string | null;
    source_name: string;
  }>(
    `SELECT e.id::text, e.title, e.all_day, e.occurrence_start, e.occurrence_end, e.status,
       e.client_id::text, c.name AS client_name, s.name AS source_name
     FROM public.calendar_events e
     JOIN public.calendar_sources s ON s.id = e.source_id AND s.enabled
     LEFT JOIN public.clients c ON c.id = e.client_id
     WHERE e.occurrence_start < $2 AND coalesce(e.occurrence_end, e.occurrence_start) >= $1`,
    [
      startOfLocalDay(range.from, range.zone),
      startOfLocalDay(addCalendarDays(range.to, 1), range.zone),
    ],
  );
  return rows
    .map((row): CalendarItem => {
      const start = toIso(row.occurrence_start);
      const end = row.occurrence_end === null ? null : toIso(row.occurrence_end);
      // An all-day end is the day after the last day.
      const lastDay = row.all_day && end !== null ? addCalendarDays(end.slice(0, 10), -1) : null;
      const startsOn = row.all_day ? start.slice(0, 10) : dateIn(start, range.zone);
      return {
        ...base,
        key: `imported:${row.id}`,
        type: "imported",
        title: row.title,
        startsOn,
        endsOn: lastDay !== null && lastDay > startsOn ? lastDay : null,
        startAt: row.all_day ? null : start,
        endAt: row.all_day ? null : end,
        allDay: row.all_day,
        clientId: row.client_id,
        clientName: row.client_name,
        status: row.status,
        sourceName: row.source_name,
        isClientMeeting: row.client_id !== null,
        href: "/calendar/sources",
        summary: joinParts([
          `From ${row.source_name}`,
          row.client_name === null ? null : `client meeting with ${row.client_name}`,
        ]),
      };
    })
    .filter((item) => item.startsOn <= range.to && (item.endsOn ?? item.startsOn) >= range.from);
};

const byStart = (a: CalendarItem, b: CalendarItem): number =>
  a.startsOn.localeCompare(b.startsOn) ||
  (a.startAt ?? "").localeCompare(b.startAt ?? "") ||
  a.title.localeCompare(b.title) ||
  a.key.localeCompare(b.key);

/** Everything on the calendar from `from` to `to` (ISO dates, both included, in `zone`), earliest first. */
export const calendarItems = async (db: Db, range: FeedRange): Promise<CalendarItem[]> => {
  if (!validRange(range.from, range.to)) {
    throw new Error(
      `The calendar range must be at most ${String(MAX_RANGE_DAYS)} days, from before to.`,
    );
  }
  const lists = [
    await loadEntries(db, range),
    await loadMilestones(db, range),
    await loadInvoices(db, range),
    await loadReminders(db, range),
    await loadMaintenance(db, range),
    await loadRetainers(db, range),
    await loadHolds(db, range),
    await loadAgreementDeadlines(db, range),
    await loadImported(db, range),
  ];
  return lists.flat().sort(byStart);
};
