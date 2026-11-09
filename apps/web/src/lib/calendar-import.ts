import { createHash } from "node:crypto";
import ICAL from "ical.js";
import { z } from "zod";
import type { SecretBox } from "./crypto";
import { isUuid, type Db } from "./db";
import { toIso } from "./db-values";
import { toFieldIssues, type FieldIssue } from "./field-issues";
import { looksLikeIcs, safeFetchText, type FetchFailure, type SafeFetchResult } from "./safe-fetch";
import { addCalendarDays, todayIn } from "./schedule";

// Server-only: imported calendars, as the signed-in user sees them (RLS). A source is a secret iCal
// address (stored encrypted, never returned, never logged) or an uploaded file. Its events are read-
// only and replaced on every sync. Descriptions and attendee lists are not stored: attendee emails
// are used in memory to mark client meetings, and only the matched client id is kept.

export const SOURCE_COLORS = ["gray", "blue", "green", "purple", "orange", "pink"] as const;
export type SourceColor = (typeof SOURCE_COLORS)[number];

/** How far around today events are kept: 30 days back, 365 ahead. */
export const IMPORT_DAYS_BACK = 30;
export const IMPORT_DAYS_AHEAD = 365;
export const MAX_OCCURRENCES = 5000;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ITERATIONS_PER_EVENT = 20_000;
const COOL_DOWN_SECONDS = 60;
const INSERT_BATCH = 500;
const URL_MAX = 2000;

export type SyncFailure = FetchFailure | "too_soon";
export type SyncResult = { ok: true; count: number } | { ok: false; reason: SyncFailure };

// Parsing ------------------------------------------------------------------------------------

export type ParsedEvent = {
  uid: string;
  start: Date;
  end: Date | null;
  allDay: boolean;
  title: string;
  location: string | null;
  status: "confirmed" | "tentative";
  /** Attendee and organizer emails, lowercase. Used to match clients, never stored. */
  emails: string[];
};

/** Text from someone else's calendar: control characters become spaces, then it's cut to length. */
const cleanText = (text: string, max: number): string =>
  Array.from(text)
    .map((char) => (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f ? " " : char))
    .join("")
    .trim()
    .slice(0, max);

const emailsOf = (component: ICAL.Component): string[] =>
  [...component.getAllProperties("attendee"), ...component.getAllProperties("organizer")].flatMap(
    (property) => {
      const value = property.getFirstValue();
      return typeof value === "string" && /^mailto:/i.test(value)
        ? [value.slice(7).trim().toLowerCase()]
        : [];
    },
  );

const dateUtc = (time: ICAL.Time): Date => new Date(Date.UTC(time.year, time.month - 1, time.day));

const stableUid = (uid: string): string =>
  uid.length <= 255 ? uid : createHash("sha256").update(uid).digest("hex");

const statusOf = (component: ICAL.Component): string =>
  String(component.getFirstPropertyValue("status") ?? "").toUpperCase();

/**
 * The occurrences of every event in an iCalendar file between two ISO dates, recurring events
 * expanded (EXDATE skipped, moved occurrences applied), cancelled ones left out, at most 5,000.
 * Shortcuts: a time with no zone is read as UTC; an occurrence moved from outside the window into it
 * is missed, because expansion stops at the window's end by its original time.
 * Throws when the text isn't iCalendar.
 */
export const parseIcsEvents = (
  text: string,
  { from, to }: { from: string; to: string },
): ParsedEvent[] => {
  const windowStart = new Date(`${from}T00:00:00Z`);
  const windowEnd = new Date(`${addCalendarDays(to, 1)}T00:00:00Z`);
  const found: ParsedEvent[] = [];
  // The zone registry is global: start clean and leave clean, so one file's zone definitions can
  // never change how another user's file is read.
  ICAL.TimezoneService.reset();
  try {
    const root = new ICAL.Component(ICAL.parse(text) as unknown[]);
    for (const zone of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(zone);
    const byUid = new Map<string, ICAL.Component[]>();
    for (const vevent of root.getAllSubcomponents("vevent")) {
      const uid = String(vevent.getFirstPropertyValue("uid") ?? "");
      if (uid === "") continue;
      byUid.set(uid, [...(byUid.get(uid) ?? []), vevent]);
    }
    const push = (
      item: ICAL.Event,
      start: ICAL.Time,
      end: ICAL.Time | null,
      uid: string,
    ): boolean => {
      if (statusOf(item.component) === "CANCELLED") return true;
      const allDay = start.isDate;
      const startsAt = allDay ? dateUtc(start) : start.toJSDate();
      const endsAt = end === null ? null : allDay ? dateUtc(end) : end.toJSDate();
      const overlaps = startsAt < windowEnd && (endsAt ?? startsAt) >= windowStart;
      if (!overlaps || (allDay && endsAt !== null && endsAt <= windowStart)) return true;
      found.push({
        uid: stableUid(uid),
        start: startsAt,
        end: endsAt,
        allDay,
        title: cleanText(item.summary || "", 200) || "(no title)",
        location: cleanText(item.location || "", 200) || null,
        status: statusOf(item.component) === "TENTATIVE" ? "tentative" : "confirmed",
        emails: emailsOf(item.component),
      });
      return found.length < MAX_OCCURRENCES;
    };
    for (const [uid, group] of byUid) {
      const masters = group.filter((vevent) => !vevent.hasProperty("recurrence-id"));
      const overrides = group.filter((vevent) => vevent.hasProperty("recurrence-id"));
      const [master] = masters;
      if (!master) {
        // Overrides with no series in this file: show each as the event it is.
        for (const vevent of overrides) {
          const item = new ICAL.Event(vevent);
          if (!push(item, item.startDate, item.endDate, uid)) return found;
        }
        continue;
      }
      const series = new ICAL.Event(master);
      for (const vevent of overrides) series.relateException(new ICAL.Event(vevent));
      if (statusOf(master) === "CANCELLED") continue;
      if (!series.isRecurring()) {
        if (!push(series, series.startDate, series.endDate, uid)) return found;
        continue;
      }
      const iterator = series.iterator();
      for (let step = 0; step < MAX_ITERATIONS_PER_EVENT; step += 1) {
        const occurrence = iterator.next() as ICAL.Time | undefined;
        if (!occurrence || allDayOrZoned(occurrence) >= windowEnd) break;
        const details = series.getOccurrenceDetails(occurrence);
        if (!push(details.item, details.startDate, details.endDate, uid)) return found;
      }
    }
    return found;
  } finally {
    ICAL.TimezoneService.reset();
  }
};

/** The instant of a recurrence's original time, for knowing when to stop expanding. */
const allDayOrZoned = (time: ICAL.Time): Date => (time.isDate ? dateUtc(time) : time.toJSDate());

// Sources -------------------------------------------------------------------------------------

export type CalendarSource = {
  id: string;
  name: string;
  kind: "url" | "file";
  /** Only the host, like calendar.google.com. The address itself never leaves the server. */
  urlHost: string | null;
  color: SourceColor;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastError: FetchFailure | null;
  eventCount: number;
};

type SourceRow = {
  id: string;
  name: string;
  kind: "url" | "file";
  url_host: string | null;
  color: SourceColor;
  enabled: boolean;
  last_synced_at: unknown;
  last_error: FetchFailure | null;
  event_count: number;
};

const toSource = (row: SourceRow): CalendarSource => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  urlHost: row.url_host,
  color: row.color,
  enabled: row.enabled,
  lastSyncedAt: row.last_synced_at === null ? null : toIso(row.last_synced_at),
  lastError: row.last_error,
  eventCount: row.event_count,
});

// url_enc is never selected here: nothing that lists sources can leak it.
const SELECT_SOURCES = `SELECT id::text, name, kind, url_host, color, enabled, last_synced_at, last_error, event_count
  FROM public.calendar_sources`;

export const listSources = async (db: Db): Promise<CalendarSource[]> => {
  const { rows } = await db.query<SourceRow>(`${SELECT_SOURCES} ORDER BY created_at`);
  return rows.map(toSource);
};

const getSource = async (db: Db, id: string): Promise<CalendarSource | null> => {
  if (!isUuid(id)) return null;
  const { rows } = await db.query<SourceRow>(`${SELECT_SOURCES} WHERE id = $1`, [id]);
  return rows[0] ? toSource(rows[0]) : null;
};

const nameSchema = z
  .string({ error: "is required" })
  .trim()
  .min(1, "is required")
  .max(80, "must be 80 characters or fewer");
const colorSchema = z.enum(SOURCE_COLORS, { error: "must be one of the listed colours" });

const addSchema = z.strictObject({
  name: nameSchema,
  url: z.string({ error: "is required" }),
  color: colorSchema.default("gray"),
});
const updateSchema = z
  .strictObject({
    name: nameSchema,
    color: colorSchema,
    enabled: z.boolean({ error: "must be true or false" }),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { error: "Nothing to save." });

type Parsed<T> = { ok: true; value: T } | { ok: false; errors: FieldIssue[] };

/** The address, with webcal:// read as https://. The messages never repeat what was typed. */
export const normaliseCalendarUrl = (
  raw: string,
): { ok: true; url: string; host: string } | { ok: false; message: string } => {
  const trimmed = raw.trim().replace(/^webcals?:\/\//i, "https://");
  if (trimmed.length === 0 || trimmed.length > URL_MAX) {
    return { ok: false, message: `must be an address of up to ${String(URL_MAX)} characters` };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      message: "must be a full address, like https://calendar.google.com/…/basic.ics",
    };
  }
  if (url.protocol !== "https:")
    return { ok: false, message: "must start with https:// (or webcal://)" };
  if (url.username || url.password) {
    return { ok: false, message: "can't contain a user name or password" };
  }
  return { ok: true, url: url.toString(), host: url.hostname.slice(0, 255) };
};

export const parseSourceAdd = (
  raw: unknown,
): Parsed<{ name: string; url: string; host: string; color: SourceColor }> => {
  const parsed = addSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: toFieldIssues(parsed.error, { noun: "field" }) };
  const address = normaliseCalendarUrl(parsed.data.url);
  if (!address.ok) return { ok: false, errors: [{ field: "url", message: address.message }] };
  return {
    ok: true,
    value: {
      name: parsed.data.name,
      url: address.url,
      host: address.host,
      color: parsed.data.color,
    },
  };
};

export const parseFileSource = (
  name: string | null,
  color: string | null,
): Parsed<{ name: string; color: SourceColor }> => {
  const parsed = z
    .strictObject({ name: nameSchema, color: colorSchema.default("gray") })
    .safeParse({ name: name ?? undefined, color: color ?? undefined });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: toFieldIssues(parsed.error, { noun: "field" }) };
};

export const updateSource = async (
  db: Db,
  id: string,
  raw: unknown,
): Promise<Parsed<CalendarSource> | null> => {
  if (!(await getSource(db, id))) return null;
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: toFieldIssues(parsed.error, { noun: "field" }) };
  const { name, color, enabled } = parsed.data;
  await db.query(
    `UPDATE public.calendar_sources
     SET name = coalesce($2, name), color = coalesce($3, color), enabled = coalesce($4, enabled)
     WHERE id = $1`,
    [id, name ?? null, color ?? null, enabled ?? null],
  );
  const source = await getSource(db, id);
  return source ? { ok: true, value: source } : null;
};

export const removeSource = async (db: Db, id: string): Promise<boolean> => {
  if (!isUuid(id)) return false;
  const { rowCount } = await db.query("DELETE FROM public.calendar_sources WHERE id = $1", [id]);
  return rowCount > 0;
};

// Syncing ---------------------------------------------------------------------------------------

export type ImportDeps = {
  box: () => SecretBox;
  now: () => Date;
  fetchText?: (address: string) => Promise<SafeFetchResult>;
};

const secretContext = (userId: string): string => `calendar-source:${userId}`;

const currentUserId = async (db: Db): Promise<string> => {
  const { rows } = await db.query<{ id: string }>("SELECT (SELECT auth.uid())::text AS id");
  const id = rows[0]?.id;
  if (!id) throw new Error("There is no signed-in user for this calendar work.");
  return id;
};

/** Emails of the user's clients, to mark meetings; the user's own addresses never count. */
const clientIdsByEmail = async (db: Db): Promise<Map<string, string>> => {
  const { rows } = await db.query<{ id: string; email: string }>(
    "SELECT id::text, lower(email) AS email FROM public.clients",
  );
  const { rows: own } = await db.query<{ email: string | null; gmail: string | null }>(
    "SELECT lower(email) AS email, lower(gmail_email) AS gmail FROM public.users WHERE id = (SELECT auth.uid())",
  );
  const ignore = new Set([own[0]?.email, own[0]?.gmail]);
  return new Map(rows.filter((row) => !ignore.has(row.email)).map((row) => [row.email, row.id]));
};

const importWindow = (now: Date, zone: string): { from: string; to: string } => {
  const today = todayIn(now, zone);
  return {
    from: addCalendarDays(today, -IMPORT_DAYS_BACK),
    to: addCalendarDays(today, IMPORT_DAYS_AHEAD),
  };
};

/** Replaces a source's events with these ones. Runs inside the caller's transaction. */
const replaceEvents = async (
  db: Db,
  sourceId: string,
  events: ParsedEvent[],
  clients: Map<string, string>,
): Promise<number> => {
  await db.query("DELETE FROM public.calendar_events WHERE source_id = $1", [sourceId]);
  let stored = 0;
  for (let offset = 0; offset < events.length; offset += INSERT_BATCH) {
    const batch = events.slice(offset, offset + INSERT_BATCH);
    const { rowCount } = await db.query(
      `INSERT INTO public.calendar_events
         (user_id, source_id, uid, occurrence_start, occurrence_end, all_day, title, location, client_id, status)
       SELECT (SELECT auth.uid()), $1::uuid, t.* FROM unnest($2::text[], $3::timestamptz[], $4::timestamptz[],
         $5::boolean[], $6::text[], $7::text[], $8::uuid[], $9::text[]) AS t
       ON CONFLICT (source_id, uid, occurrence_start) DO NOTHING`,
      [
        sourceId,
        batch.map((event) => event.uid),
        batch.map((event) => event.start.toISOString()),
        batch.map((event) => event.end?.toISOString() ?? null),
        batch.map((event) => event.allDay),
        batch.map((event) => event.title),
        batch.map((event) => event.location),
        batch.map((event) => event.emails.map((email) => clients.get(email)).find(Boolean) ?? null),
        batch.map((event) => event.status),
      ],
    );
    stored += rowCount;
  }
  return stored;
};

const markSynced = async (db: Db, sourceId: string, now: Date, count: number): Promise<void> => {
  await db.query(
    `UPDATE public.calendar_sources
     SET last_synced_at = $2, last_error = NULL, event_count = $3, sync_locked_until = $4
     WHERE id = $1`,
    [
      sourceId,
      now.toISOString(),
      count,
      new Date(now.getTime() + COOL_DOWN_SECONDS * 1000).toISOString(),
    ],
  );
};

const markFailed = async (
  db: Db,
  sourceId: string,
  now: Date,
  reason: FetchFailure,
): Promise<void> => {
  // The old events stay: a calendar that is briefly down doesn't go blank.
  await db.query(
    "UPDATE public.calendar_sources SET last_error = $2, sync_locked_until = $3 WHERE id = $1",
    [sourceId, reason, new Date(now.getTime() + COOL_DOWN_SECONDS * 1000).toISOString()],
  );
};

/** Fetches a URL source, parses it and replaces its events. As the user; failures keep the old events. */
export const syncSource = async (
  db: Db,
  sourceId: string,
  deps: ImportDeps,
): Promise<SyncResult> => {
  const now = deps.now();
  const { rows } = await db.query<{ kind: string; url_enc: string | null }>(
    "SELECT kind, url_enc FROM public.calendar_sources WHERE id = $1",
    [sourceId],
  );
  const source = rows[0];
  if (!source?.url_enc) return { ok: false, reason: "unreachable" };
  let address: string;
  try {
    address = deps.box().decrypt(source.url_enc, secretContext(await currentUserId(db)));
  } catch {
    await markFailed(db, sourceId, now, "unreachable");
    return { ok: false, reason: "unreachable" };
  }
  const fetched = await (deps.fetchText ?? ((url) => safeFetchText(url)))(address);
  if (!fetched.ok) {
    await markFailed(db, sourceId, now, fetched.reason);
    return { ok: false, reason: fetched.reason };
  }
  const zone = await ownZone(db);
  let events: ParsedEvent[];
  try {
    events = parseIcsEvents(fetched.text, importWindow(now, zone));
  } catch {
    await markFailed(db, sourceId, now, "not_ics");
    return { ok: false, reason: "not_ics" };
  }
  const count = await replaceEvents(db, sourceId, events, await clientIdsByEmail(db));
  await markSynced(db, sourceId, now, count);
  return { ok: true, count };
};

const ownZone = async (db: Db): Promise<string> => {
  const { rows } = await db.query<{ time_zone: string }>(
    "SELECT time_zone FROM public.users WHERE id = (SELECT auth.uid())",
  );
  return rows[0]?.time_zone ?? "UTC";
};

/** "Refresh now": at most once a minute per source. */
export const refreshSource = async (
  db: Db,
  id: string,
  deps: ImportDeps,
): Promise<SyncResult | null> => {
  if (!isUuid(id)) return null;
  const { rows } = await db.query<{ locked: boolean; kind: string }>(
    "SELECT coalesce(sync_locked_until > $2, false) AS locked, kind FROM public.calendar_sources WHERE id = $1",
    [id, deps.now().toISOString()],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.kind !== "url") return { ok: false, reason: "unreachable" };
  if (row.locked) return { ok: false, reason: "too_soon" };
  return syncSource(db, id, deps);
};

export type AddResult =
  { ok: true; source: CalendarSource; sync: SyncResult } | { ok: false; errors: FieldIssue[] };

/** Adds a source by its secret address and syncs it once straight away. */
export const addSource = async (
  db: Db,
  input: { name: string; url: string; host: string; color: SourceColor },
  deps: ImportDeps,
): Promise<AddResult> => {
  const userId = await currentUserId(db);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.calendar_sources (user_id, name, kind, url_enc, url_host, color)
     VALUES ($1, $2, 'url', $3, $4, $5) RETURNING id::text`,
    [
      userId,
      input.name,
      deps.box().encrypt(input.url, secretContext(userId)),
      input.host,
      input.color,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Saving the calendar source returned no id.");
  const sync = await syncSource(db, id, deps);
  const source = await getSource(db, id);
  if (!source) throw new Error("The calendar source vanished while it was added.");
  return { ok: true, source, sync };
};

/** Adds a source from an uploaded .ics file: read once, never refreshed. */
export const addFileSource = async (
  db: Db,
  input: { name: string; color: SourceColor; text: string },
  deps: Pick<ImportDeps, "now">,
): Promise<AddResult> => {
  if (!looksLikeIcs(input.text)) {
    return { ok: false, errors: [{ field: "file", message: "isn't an iCalendar (.ics) file" }] };
  }
  let events: ParsedEvent[];
  try {
    events = parseIcsEvents(input.text, importWindow(deps.now(), await ownZone(db)));
  } catch {
    return {
      ok: false,
      errors: [{ field: "file", message: "couldn't be read as an iCalendar (.ics) file" }],
    };
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.calendar_sources (user_id, name, kind, color)
     VALUES ((SELECT auth.uid()), $1, 'file', $2) RETURNING id::text`,
    [input.name, input.color],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Saving the calendar source returned no id.");
  const count = await replaceEvents(db, id, events, await clientIdsByEmail(db));
  await markSynced(db, id, deps.now(), count);
  const source = await getSource(db, id);
  if (!source) throw new Error("The calendar source vanished while it was added.");
  return { ok: true, source, sync: { ok: true, count } };
};
