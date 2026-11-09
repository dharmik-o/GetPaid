import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CalendarItem } from "@/lib/calendar-feed";
import { calendarHandlers } from "@/lib/calendar-handlers";
import { runAsUser, type Db } from "@/lib/db";
import { escapeIcsText, foldIcsLine, toIcs } from "@/lib/ics";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// A-S2: the .ics export. A title can't inject a property, long lines fold at 75 octets without
// splitting a character, only the owner's items go out, imported events never do, and notes only
// when asked for. Real migrations and RLS (PGlite).

let handle: TestDatabase;
const A = USER_A.userId;
const NOW = new Date("2026-12-01T10:00:00Z");
const INJECTION = "Review\r\nATTENDEE:mailto:x@evil.test";
const unfold = (text: string) => text.replaceAll("\r\n ", "");
const as = <T>(userId: string, work: (db: Db) => Promise<T>) => runAsUser(handle.db, userId, work);

const download = async (query: string) => {
  const handlers = calendarHandlers({
    runAsUser: (work) => as(A, work),
    now: () => NOW,
    appUrl: () => "https://app.example.test",
  });
  const response = await handlers.exportIcs(
    new Request(`http://x.test/api/calendar/export.ics${query}`),
  );
  return { response, text: await response.text() };
};

const item = (overrides: Partial<CalendarItem>): CalendarItem => ({
  key: "entry:1",
  type: "entry",
  title: "Plain",
  startsOn: "2026-12-02",
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
  href: "/calendar/1",
  editable: true,
  notes: null,
  ...overrides,
});

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  await handle.db.query(
    "UPDATE public.calendar_entries SET title = $1, notes = 'private note a' WHERE id = $2",
    [INJECTION, USER_A.rows.calendar_entries],
  );
  await handle.db.query(
    "UPDATE public.calendar_entries SET title = 'Other user entry', notes = 'private note b' WHERE id = $1",
    [USER_B.rows.calendar_entries],
  );
}, 60_000);

afterAll(async () => {
  await handle.close();
});

describe("escaping and folding", () => {
  it("turns a line break in a title into an escaped one, never a new property", () => {
    expect(escapeIcsText(INJECTION)).toBe("Review\\nATTENDEE:mailto:x@evil.test");
    expect(escapeIcsText("a\\b;c,d\u0007e")).toBe("a\\\\b\\;c\\,de");
  });

  it("folds at 75 octets, continues with one space, and never splits a character", () => {
    const line = `SUMMARY:${"héllo wörld 日本語 😀 ".repeat(12)}`;
    const folded = foldIcsLine(line);
    const physical = folded.split("\r\n");
    expect(physical.length).toBeGreaterThan(1);
    for (const part of physical) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
    for (const part of physical.slice(1)) expect(part.startsWith(" ")).toBe(true);
    expect(unfold(folded)).toBe(line);
  });
});

describe("the export", () => {
  it("writes one SUMMARY line for an injecting title, and the file is well formed", async () => {
    const { response, text } = await download("?from=2026-11-30&to=2026-12-31");
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain("getpaid-calendar.ics");
    const lines = unfold(text).split("\r\n");
    expect(lines.filter((line) => line.startsWith("SUMMARY:Review"))).toEqual([
      "SUMMARY:Review\\nATTENDEE:mailto:x@evil.test",
    ]);
    expect(lines.some((line) => line.startsWith("ATTENDEE"))).toBe(false);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("PRODID:-//GetPaid//Calendar//EN");
    for (const physical of text.split("\r\n"))
      expect(Buffer.byteLength(physical)).toBeLessThanOrEqual(75);
  });

  it("uses the entry's own id for a stable UID, a date for all-day and links back to the app", async () => {
    const { text } = await download("?from=2026-11-30&to=2026-12-31");
    expect(text).toContain(`UID:entry-${USER_A.rows.calendar_entries}@getpaid.local`);
    expect(text).toContain("DTSTART;VALUE=DATE:20261202\r\nDTEND;VALUE=DATE:20261203");
    expect(text).toContain(`URL:https://app.example.test/calendar/${USER_A.rows.calendar_entries}`);
  });

  it("contains only the owner's items", async () => {
    const { text } = await download("?from=2026-11-30&to=2026-12-31");
    expect(text).not.toContain("Other user entry");
    expect(text).not.toContain(USER_B.rows.calendar_entries);
    expect(text).not.toContain("Client b");
  });

  it("leaves notes out unless notes=1", async () => {
    const without = await download("?from=2026-11-30&to=2026-12-31");
    const withNotes = await download("?from=2026-11-30&to=2026-12-31&notes=1");
    expect(without.text).not.toContain("private note a");
    expect(unfold(withNotes.text)).toContain("private note a");
    expect(unfold(withNotes.text)).not.toContain("private note b");
  });

  it("never exports an imported event", () => {
    const text = toIcs(
      [
        item({ key: "imported:9", type: "imported", title: "Someone else's meeting" }),
        item({ title: "Mine" }),
      ],
      { notes: false, now: NOW, appUrl: undefined },
    );
    expect(text).toContain("SUMMARY:Mine");
    expect(text).not.toContain("Someone else's meeting");
  });

  it("refuses a range over 400 days", async () => {
    const { response } = await download("?from=2025-01-01&to=2027-01-01");
    expect(response.status).toBe(400);
  });
});
