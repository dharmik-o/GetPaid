import { z } from "zod";
import { isValidTimeZone } from "./countries";
import { isUuid, type Db } from "./db";
import { toIso } from "./db-values";
import { toFieldIssues, type FieldIssue } from "./field-issues";

// Server-only: the freelancer's own calendar entries, as they see them (RLS). Milestone deadlines,
// invoice due dates and the like are not entries: calendar-feed.ts reads them from their own tables.

export const ENTRY_KINDS = ["task", "event", "deadline", "call"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export type CalendarEntry = {
  id: string;
  title: string;
  notes: string | null;
  kind: EntryKind;
  startsOn: string;
  endsOn: string | null;
  /** HH:mm in `timeZone`; null for an all-day entry. */
  startTime: string | null;
  endTime: string | null;
  timeZone: string;
  clientId: string | null;
  projectId: string | null;
  milestoneId: string | null;
  status: "open" | "done";
  doneAt: string | null;
  remindOnDay: boolean;
  createdBy: "user" | "assistant";
};

const hhmm = z
  .string({ error: "must be a time like 14:30" })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be a time like 14:30");
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `must be ${String(max)} characters or fewer`);

const fieldsSchema = z.strictObject({
  title: z
    .string({ error: "is required" })
    .trim()
    .min(1, "is required")
    .max(200, "must be 200 characters or fewer"),
  notes: optionalText(5000).nullable(),
  kind: z.enum(ENTRY_KINDS, { error: "must be task, event, deadline or call" }),
  startsOn: z.iso.date({ error: "must be a date like 2026-12-31" }),
  endsOn: z.iso.date({ error: "must be a date like 2026-12-31" }).nullable(),
  startTime: hhmm.nullable(),
  endTime: hhmm.nullable(),
  timeZone: z
    .string({ error: "must be a time zone like Europe/London" })
    .refine(isValidTimeZone, "must be a time zone like Europe/London"),
  clientId: z.string({ error: "must be one of your clients" }).nullable(),
  projectId: z.string({ error: "must be one of your projects" }).nullable(),
  milestoneId: z.string({ error: "must be one of your milestones" }).nullable(),
  remindOnDay: z.boolean({ error: "must be true or false" }),
});

type Fields = z.infer<typeof fieldsSchema>;

const LINK_KEYS = ["clientId", "projectId", "milestoneId"] as const;

/** Rules that look at several fields at once. */
const crossIssues = (v: Fields): FieldIssue[] => {
  const issues: FieldIssue[] = [];
  if (v.endsOn !== null && v.endsOn < v.startsOn) {
    issues.push({ field: "endsOn", message: "can't be before the start date" });
  }
  if (v.endTime !== null && v.startTime === null) {
    issues.push({ field: "endTime", message: "needs a start time too" });
  }
  if (v.startTime !== null && v.endsOn !== null) {
    issues.push({
      field: "endsOn",
      message: "is only for all-day entries; a timed entry is one day",
    });
  }
  if (v.startTime !== null && v.endTime !== null && v.endTime <= v.startTime) {
    issues.push({ field: "endTime", message: "must be after the start time" });
  }
  return issues;
};

export type EntryInput = Fields;
type Parsed<T> = { ok: true; value: T } | { ok: false; errors: FieldIssue[] };

const withDefaults = (raw: unknown, defaultZone: string): unknown =>
  raw && typeof raw === "object" && !Array.isArray(raw)
    ? {
        kind: "task",
        notes: null,
        endsOn: null,
        startTime: null,
        endTime: null,
        clientId: null,
        projectId: null,
        milestoneId: null,
        remindOnDay: false,
        timeZone: defaultZone,
        ...raw,
      }
    : raw;

/** Checks a whole entry. Omitted optional fields get their defaults; the zone defaults to the user's. */
export const parseEntryInput = (raw: unknown, defaultZone: string): Parsed<EntryInput> => {
  const parsed = fieldsSchema.safeParse(withDefaults(raw, defaultZone));
  if (!parsed.success) return { ok: false, errors: toFieldIssues(parsed.error, { noun: "field" }) };
  const errors = crossIssues(parsed.data);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: parsed.data };
};

type Links = Pick<Fields, (typeof LINK_KEYS)[number]>;

const notFoundIssue = (field: (typeof LINK_KEYS)[number]): FieldIssue => ({
  field,
  message: "wasn't found. Pick one of your own from the list",
});

/**
 * A milestone sets its project and client; a project sets its client. A client or project that
 * doesn't match is refused, and an id the user can't see (RLS) is "not found".
 */
export const resolveLinks = async (db: Db, links: Links): Promise<Parsed<Links>> => {
  for (const key of LINK_KEYS) {
    const id = links[key];
    if (id !== null && !isUuid(id)) return { ok: false, errors: [notFoundIssue(key)] };
  }
  const resolved: Links = { ...links };
  const errors: FieldIssue[] = [];
  if (links.milestoneId !== null) {
    const { rows } = await db.query<{ project_id: string; client_id: string }>(
      `SELECT m.project_id::text, p.client_id::text FROM public.milestones m
       JOIN public.projects p ON p.id = m.project_id WHERE m.id = $1`,
      [links.milestoneId],
    );
    const row = rows[0];
    if (!row) return { ok: false, errors: [notFoundIssue("milestoneId")] };
    if (links.projectId !== null && links.projectId !== row.project_id) {
      errors.push({ field: "projectId", message: "isn't the project of that milestone" });
    }
    if (links.clientId !== null && links.clientId !== row.client_id) {
      errors.push({ field: "clientId", message: "isn't the client of that milestone" });
    }
    resolved.projectId = row.project_id;
    resolved.clientId = row.client_id;
  } else if (links.projectId !== null) {
    const { rows } = await db.query<{ client_id: string }>(
      "SELECT client_id::text FROM public.projects WHERE id = $1",
      [links.projectId],
    );
    const row = rows[0];
    if (!row) return { ok: false, errors: [notFoundIssue("projectId")] };
    if (links.clientId !== null && links.clientId !== row.client_id) {
      errors.push({ field: "clientId", message: "isn't the client of that project" });
    }
    resolved.clientId = row.client_id;
  } else if (links.clientId !== null) {
    const { rows } = await db.query("SELECT 1 FROM public.clients WHERE id = $1", [links.clientId]);
    if (rows.length === 0) return { ok: false, errors: [notFoundIssue("clientId")] };
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: resolved };
};

type EntryRow = {
  id: string;
  title: string;
  notes: string | null;
  kind: EntryKind;
  starts_on: string;
  ends_on: string | null;
  start_time: string | null;
  end_time: string | null;
  time_zone: string;
  client_id: string | null;
  project_id: string | null;
  milestone_id: string | null;
  status: "open" | "done";
  done_at: unknown;
  remind_on_day: boolean;
  created_by: "user" | "assistant";
};

const SELECT_ENTRIES = `
  SELECT id::text, title, notes, kind, starts_on::text, ends_on::text,
    to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time,
    time_zone, client_id::text, project_id::text, milestone_id::text, status, done_at,
    remind_on_day, created_by
  FROM public.calendar_entries`;

const toEntry = (row: EntryRow): CalendarEntry => ({
  id: row.id,
  title: row.title,
  notes: row.notes,
  kind: row.kind,
  startsOn: row.starts_on,
  endsOn: row.ends_on,
  startTime: row.start_time,
  endTime: row.end_time,
  timeZone: row.time_zone,
  clientId: row.client_id,
  projectId: row.project_id,
  milestoneId: row.milestone_id,
  status: row.status,
  doneAt: row.done_at === null ? null : toIso(row.done_at),
  remindOnDay: row.remind_on_day,
  createdBy: row.created_by,
});

export const getEntry = async (db: Db, id: string): Promise<CalendarEntry | null> => {
  if (!isUuid(id)) return null;
  const { rows } = await db.query<EntryRow>(`${SELECT_ENTRIES} WHERE id = $1`, [id]);
  return rows[0] ? toEntry(rows[0]) : null;
};

/** Entries that touch the range [from, to] (ISO dates), earliest first. */
export const listEntries = async (db: Db, from: string, to: string): Promise<CalendarEntry[]> => {
  const { rows } = await db.query<EntryRow>(
    `${SELECT_ENTRIES} WHERE starts_on <= $2 AND coalesce(ends_on, starts_on) >= $1
     ORDER BY starts_on, start_time NULLS FIRST, created_at`,
    [from, to],
  );
  return rows.map(toEntry);
};

export type WriteResult = { ok: true; entry: CalendarEntry } | { ok: false; errors: FieldIssue[] };

export const createEntry = async (
  db: Db,
  input: EntryInput,
  createdBy: "user" | "assistant" = "user",
): Promise<WriteResult> => {
  const links = await resolveLinks(db, input);
  if (!links.ok) return links;
  const v = { ...input, ...links.value };
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.calendar_entries (user_id, title, notes, kind, starts_on, ends_on, start_time,
       end_time, time_zone, client_id, project_id, milestone_id, remind_on_day, created_by)
     VALUES ((SELECT auth.uid()), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id::text`,
    [
      v.title,
      v.notes,
      v.kind,
      v.startsOn,
      v.endsOn,
      v.startTime,
      v.endTime,
      v.timeZone,
      v.clientId,
      v.projectId,
      v.milestoneId,
      v.remindOnDay,
      createdBy,
    ],
  );
  const entry = rows[0] ? await getEntry(db, rows[0].id) : null;
  if (!entry) throw new Error("Saving the calendar entry returned no row.");
  return { ok: true, entry };
};

/**
 * Changes some fields of an entry, then checks the whole result. Sending any of clientId,
 * projectId or milestoneId replaces all three links (the ones left out are cleared, then filled
 * in from the most specific one sent); sending none keeps the links as they are.
 * Returns null when the entry isn't the user's.
 */
export const updateEntry = async (
  db: Db,
  id: string,
  patch: unknown,
): Promise<WriteResult | null> => {
  const current = await getEntry(db, id);
  if (!current) return null;
  if (
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    Object.keys(patch).length === 0
  ) {
    return { ok: false, errors: [{ field: "fields", message: "Nothing to save." }] };
  }
  const touchesLinks = LINK_KEYS.some((key) => key in patch);
  const base: Record<string, unknown> = {
    title: current.title,
    notes: current.notes,
    kind: current.kind,
    startsOn: current.startsOn,
    endsOn: current.endsOn,
    startTime: current.startTime,
    endTime: current.endTime,
    timeZone: current.timeZone,
    remindOnDay: current.remindOnDay,
    clientId: touchesLinks ? null : current.clientId,
    projectId: touchesLinks ? null : current.projectId,
    milestoneId: touchesLinks ? null : current.milestoneId,
  };
  // A timed entry moved to all-day must say so: sending startTime null without endTime clears both.
  if ("startTime" in patch && !("endTime" in patch) && patch.startTime === null)
    base.endTime = null;
  const parsed = parseEntryInput({ ...base, ...patch }, current.timeZone);
  if (!parsed.ok) return parsed;
  const links = await resolveLinks(db, parsed.value);
  if (!links.ok) return links;
  const v = { ...parsed.value, ...links.value };
  await db.query(
    `UPDATE public.calendar_entries SET title = $2, notes = $3, kind = $4, starts_on = $5, ends_on = $6,
       start_time = $7, end_time = $8, time_zone = $9, client_id = $10, project_id = $11,
       milestone_id = $12, remind_on_day = $13,
       telegram_notified_at = CASE WHEN starts_on IS DISTINCT FROM $5::date THEN NULL ELSE telegram_notified_at END
     WHERE id = $1`,
    [
      id,
      v.title,
      v.notes,
      v.kind,
      v.startsOn,
      v.endsOn,
      v.startTime,
      v.endTime,
      v.timeZone,
      v.clientId,
      v.projectId,
      v.milestoneId,
      v.remindOnDay,
    ],
  );
  const entry = await getEntry(db, id);
  if (!entry) throw new Error("The calendar entry vanished while saving it.");
  return { ok: true, entry };
};

/** Sets status and done_at together (the database refuses one without the other). */
export const markEntryDone = async (
  db: Db,
  id: string,
  done = true,
): Promise<CalendarEntry | null> => {
  if (!isUuid(id)) return null;
  const { rowCount } = await db.query(
    `UPDATE public.calendar_entries
     SET status = $2::text, done_at = CASE WHEN $2::text = 'done' THEN public.demo_clock_now() ELSE NULL END
     WHERE id = $1`,
    [id, done ? "done" : "open"],
  );
  return rowCount === 0 ? null : getEntry(db, id);
};

export const deleteEntry = async (db: Db, id: string): Promise<boolean> => {
  if (!isUuid(id)) return false;
  const { rowCount } = await db.query("DELETE FROM public.calendar_entries WHERE id = $1", [id]);
  return rowCount > 0;
};
