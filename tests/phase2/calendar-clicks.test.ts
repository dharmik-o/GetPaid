import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CalendarDayPanel } from "@/components/CalendarDayPanel";
import { calendarItems, type CalendarItem } from "@/lib/calendar-feed";
import { calendarHandlers } from "@/lib/calendar-handlers";
import { runAsUser, type Db } from "@/lib/db";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// A6: the month grid fetches /api/calendar for one month at a time, and the day panel shows each
// item's one-line summary. The route refuses bad ranges, shows only the signed-in user's items, and
// a summary never carries a message body or a float amount. Real migrations and RLS (PGlite).

let handle: TestDatabase;
const A = USER_A.userId;
const B = USER_B.userId;
const SECRET_BODY = "SECRET-MESSAGE-BODY-do-not-show";
// What the month view asks for: the six weeks that cover December 2026.
const DECEMBER = "from=2026-11-30&to=2027-01-10";

const as = <T>(userId: string, work: (db: Db) => Promise<T>) => runAsUser(handle.db, userId, work);
const get = (userId: string, query: string) =>
  calendarHandlers({ runAsUser: (work) => as(userId, work) }).items(
    new Request(`http://x.test/api/calendar?${query}`),
  );

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  await handle.db.query(
    `UPDATE public.invoices SET status = 'sent' WHERE user_id IN ('${A}', '${B}');
     UPDATE public.messages SET body = '${SECRET_BODY}';`,
  );
}, 60_000);

afterAll(async () => {
  await handle.close();
});

describe("GET /api/calendar for one month", () => {
  it.each([
    ["no dates", ""],
    ["a month that isn't real", "from=2026-13-01&to=2026-13-31"],
    ["a word instead of a date", "from=next&to=2026-12-31"],
    ["to before from", "from=2026-12-31&to=2026-12-01"],
    ["a range over 400 days", "from=2025-01-01&to=2026-12-31"],
  ])("answers 400 with a clear message for %s", async (_label, query) => {
    const response = await get(A, query);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { errors: { field: string; message: string }[] };
    expect(body.errors[0]?.message).toMatch(/dates like 2026-12-31/);
  });

  it("returns only the signed-in user's items", async () => {
    const mine = (await (await get(A, DECEMBER)).json()) as { items: CalendarItem[] };
    const theirs = (await (await get(B, DECEMBER)).json()) as { items: CalendarItem[] };
    expect(mine.items.length).toBeGreaterThan(3);
    expect(mine.items.map((item) => item.startsOn).every((day) => day >= "2026-11-30")).toBe(true);
    const text = JSON.stringify(mine);
    expect(text).not.toContain(USER_B.rows.calendar_entries);
    expect(text).not.toContain("Client b");
    const ids = new Set(mine.items.map((item) => item.key));
    expect(theirs.items.filter((item) => ids.has(item.key))).toEqual([]);
  });
});

describe("an item's summary", () => {
  it("never carries message text, and shows money from integer minor units", async () => {
    const items = await as(A, (db) =>
      calendarItems(db, { from: "2026-11-30", to: "2027-01-10", zone: "UTC" }),
    );
    expect(items.every((item) => item.summary !== "")).toBe(true);
    expect(JSON.stringify(items)).not.toContain(SECRET_BODY);
    // 90000 minor units of USD is 900.00, written from whole cents.
    const invoice = items.find((item) => item.type === "invoice_due");
    expect(invoice?.summary).toMatch(/USD\s900\.00/);
    expect(invoice?.summary).toContain("unpaid");
    expect(items.find((item) => item.type === "milestone_deadline")?.summary).toBe(
      "Milestone 1 of Website redesign for Client a · 30% of the project · due",
    );
  });
});

describe("the day panel", () => {
  const imported: CalendarItem = {
    key: "imported:1",
    type: "imported",
    title: "<img src=x onerror=alert(1)>",
    startsOn: "2026-12-03",
    endsOn: null,
    startAt: null,
    endAt: null,
    allDay: true,
    clientId: null,
    clientName: null,
    projectId: null,
    milestoneId: null,
    status: null,
    sourceName: "Work (Google)",
    isClientMeeting: false,
    href: "/calendar/sources",
    editable: false,
    notes: null,
    summary: "From Work (Google) <script>alert(2)</script> https://evil.example/x",
    own: null,
  };
  const html = renderToStaticMarkup(
    createElement(CalendarDayPanel, {
      day: "2026-12-03",
      dayLabel: "Thursday 3 December 2026",
      items: [imported],
      zone: "UTC",
      links: [],
      focusKey: null,
      onChanged: () => undefined,
    }),
  );

  it("shows an imported event's text as text, never as markup", () => {
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });

  it("is read-only, names the calendar, and makes no links from imported text", () => {
    expect(html).toContain("Work (Google)");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain(">Delete<");
  });
});
