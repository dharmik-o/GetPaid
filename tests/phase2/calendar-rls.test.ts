import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEntry, parseEntryInput, updateEntry } from "@/lib/calendar-entries";
import { calendarItems } from "@/lib/calendar-feed";
import { calendarHandlers } from "@/lib/calendar-handlers";
import { runAsUser, type Db } from "@/lib/db";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// A-S1: calendar tables are private to their owner, an entry can't be linked to someone else's
// records, and the feed never shows another user's items. Also the A1 "done when": the items route
// returns entries plus the app-made dates, as the owner. Real migrations and RLS (PGlite).

let handle: TestDatabase;
const A = USER_A.userId;
const B = USER_B.userId;
const RANGE = { from: "2026-11-30", to: "2027-06-30", zone: "UTC" };

const as = <T>(userId: string, work: (db: Db) => Promise<T>) => runAsUser(handle.db, userId, work);

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  await handle.db.query(
    `UPDATE public.invoices SET status = 'sent' WHERE user_id IN ('${A}', '${B}');
     UPDATE public.milestone_holds SET status = 'authorized', authorized_at = '2026-12-05T10:00:00Z'
       WHERE user_id IN ('${A}', '${B}');`,
  );
}, 60_000);

afterAll(async () => {
  await handle.close();
});

describe.each([
  ["calendar_entries", USER_B.rows.calendar_entries, "title = 'Hijacked'"],
  ["calendar_sources", USER_B.rows.calendar_sources, "name = 'Hijacked'"],
  ["calendar_events", USER_B.rows.calendar_events, "title = 'Hijacked'"],
])("%s", (table, otherId, change) => {
  it("is invisible to another user", async () => {
    const { rows } = await as(A, (db) =>
      db.query(`SELECT 1 FROM public.${table} WHERE id = $1`, [otherId]),
    );
    expect(rows).toHaveLength(0);
  });

  it("can't be changed or deleted by another user", async () => {
    const changed = await as(A, (db) =>
      db.query(`UPDATE public.${table} SET ${change} WHERE id = $1`, [otherId]),
    );
    const deleted = await as(A, (db) =>
      db.query(`DELETE FROM public.${table} WHERE id = $1`, [otherId]),
    );
    expect([changed.rowCount, deleted.rowCount]).toEqual([0, 0]);
    const { rows } = await handle.db.query(`SELECT 1 FROM public.${table} WHERE id = '${otherId}'`);
    expect(rows).toHaveLength(1);
  });
});

describe("linking an entry", () => {
  const input = (links: Record<string, string>) => {
    const parsed = parseEntryInput({ title: "Kick-off", startsOn: "2026-12-10", ...links }, "UTC");
    if (!parsed.ok) throw new Error("test input should be valid");
    return parsed.value;
  };

  it.each([
    ["client", { clientId: USER_B.rows.clients }, "clientId"],
    ["project", { projectId: USER_B.rows.projects }, "projectId"],
    ["milestone", { milestoneId: USER_B.rows.milestones }, "milestoneId"],
  ])("refuses another user's %s with a field error", async (_label, links, field) => {
    const result = await as(A, (db) => createEntry(db, input(links)));
    expect(result).toEqual({ ok: false, errors: [expect.objectContaining({ field })] });
  });

  it("refuses the same links written straight to the database", async () => {
    await expect(
      as(A, (db) =>
        db.query(
          "INSERT INTO public.calendar_entries (user_id, title, starts_on, time_zone, client_id) VALUES ($1, 'x', '2026-12-10', 'UTC', $2)",
          [A, USER_B.rows.clients],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("refuses a client that isn't the project's client", async () => {
    const other = await as(A, (db) =>
      db.query<{ id: string }>(
        `INSERT INTO public.clients (user_id, name, email, country, time_zone)
         VALUES ($1, 'Second', 'second@example.test', 'US', 'UTC') RETURNING id::text`,
        [A],
      ),
    );
    const result = await as(A, (db) =>
      createEntry(
        db,
        input({ projectId: USER_A.rows.projects, clientId: other.rows[0]?.id ?? "" }),
      ),
    );
    expect(result).toEqual({ ok: false, errors: [expect.objectContaining({ field: "clientId" })] });
  });

  it("fills in the project and client from a milestone, and moving keeps the links", async () => {
    const created = await as(A, (db) =>
      createEntry(db, input({ milestoneId: USER_A.rows.milestones })),
    );
    if (!created.ok) throw new Error("expected the entry to be created");
    expect(created.entry).toMatchObject({
      milestoneId: USER_A.rows.milestones,
      projectId: USER_A.rows.projects,
      clientId: USER_A.rows.clients,
    });
    const moved = await as(A, (db) =>
      updateEntry(db, created.entry.id, { startsOn: "2026-12-11" }),
    );
    expect(moved).toMatchObject({
      ok: true,
      entry: { startsOn: "2026-12-11", milestoneId: USER_A.rows.milestones },
    });
  });
});

describe("the calendar feed", () => {
  it("returns the owner's entry and every app-made date in range", async () => {
    const items = await as(A, (db) => calendarItems(db, RANGE));
    expect(items.map((item) => item.type)).toEqual(
      expect.arrayContaining([
        "entry",
        "milestone_deadline",
        "invoice_due",
        "reminder_send",
        "maintenance",
        "retainer_charge",
        "hold_expiry",
      ]),
    );
    expect(
      items.find((item) => item.key === `entry:${USER_A.rows.calendar_entries}`),
    ).toMatchObject({
      editable: true,
      startsOn: "2026-12-02",
    });
    expect(items.filter((item) => item.type !== "entry").every((item) => !item.editable)).toBe(
      true,
    );
    expect(items.map((item) => item.startsOn)).toEqual(
      [...items.map((item) => item.startsOn)].sort(),
    );
  });

  it("never includes another user's items", async () => {
    const mine = await as(A, (db) => calendarItems(db, RANGE));
    const theirs = await as(B, (db) => calendarItems(db, RANGE));
    const ids = new Set(mine.map((item) => item.key));
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.filter((item) => ids.has(item.key))).toEqual([]);
    expect(JSON.stringify(mine)).not.toContain(USER_B.rows.calendar_entries);
    expect(JSON.stringify(mine)).not.toContain("Client b");
  });

  it("answers the items route and refuses a range over 400 days", async () => {
    const handlers = calendarHandlers({ runAsUser: (work) => as(A, work) });
    const ok = await handlers.items(
      new Request("http://x.test/api/calendar?from=2026-11-30&to=2027-06-30"),
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { items: unknown[] }).items.length).toBeGreaterThan(5);
    const tooLong = await handlers.items(
      new Request("http://x.test/api/calendar?from=2025-01-01&to=2027-01-01"),
    );
    expect(tooLong.status).toBe(400);
  });
});
