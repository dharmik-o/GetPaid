import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser, type Db } from "@/lib/db";
import { formatMoney } from "@/lib/format";
import { loadUpcoming, totalsByCurrency, weekOf } from "@/lib/upcoming";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// The Upcoming list: real migrations and RLS (PGlite). Amounts come only from the database, and
// each currency keeps its own total: nothing is ever converted.

let handle: TestDatabase;

const A = USER_A.userId;
const PROJECT = USER_A.rows.projects;
const RETAINER = USER_A.rows.retainers;
/** Wednesday 23 Dec 2026. Ninety days on is 23 Mar 2027. */
const NOW = new Date("2026-12-23T15:00:00Z");

const upcoming = (now = NOW) => runAsUser(handle.db, A, (db: Db) => loadUpcoming(db, now));

const addTask = (values: {
  task: string;
  type?: string;
  due: string;
  months?: number;
  cents: number | null;
  currency?: string;
  status?: string;
}) =>
  handle.db.query(
    `INSERT INTO public.maintenance_tasks
       (user_id, project_id, type, task, repeat_months, next_due, est_cost_cents, currency, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      A,
      PROJECT,
      values.type ?? "maintenance",
      values.task,
      values.months ?? 12,
      values.due,
      values.cents,
      values.currency ?? "USD",
      values.status ?? "active",
    ],
  );

const items = async () => (await upcoming()).weeks.flatMap((week) => week.items);

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
}, 60_000);

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.query("DELETE FROM public.maintenance_tasks");
  await handle.db.query("DELETE FROM public.retainers WHERE id <> $1 AND id <> $2", [
    RETAINER,
    USER_B.rows.retainers,
  ]);
  await handle.db.query(`UPDATE public.retainers SET status = 'cancelled', ends_on = NULL`);
});

describe("what's listed", () => {
  it("is empty with nothing coming up", async () => {
    expect(await upcoming()).toMatchObject({ weeks: [], totals: [], withoutEstimate: 0 });
  });

  it("lists maintenance, renewals and retainer charges for the next 90 days, each with its type", async () => {
    await addTask({ task: "Security updates", due: "2027-01-10", cents: 20_000 });
    await addTask({ task: "Domain", type: "renewal", due: "2027-02-10", cents: 1500 });
    await handle.db.query(
      `UPDATE public.retainers SET status = 'active', starts_on = '2026-12-28',
         interval_unit = 'month', interval_count = 1, amount_cents = 5000 WHERE id = $1`,
      [RETAINER],
    );
    const listed = await items();
    expect(listed.map((item) => [item.kind, item.name, item.date, item.amountCents])).toEqual([
      ["retainer", "Monthly maintenance", "2026-12-28", 5000],
      ["maintenance", "Security updates", "2027-01-10", 20_000],
      ["retainer", "Monthly maintenance", "2027-01-28", 5000],
      ["renewal", "Domain", "2027-02-10", 1500],
      ["retainer", "Monthly maintenance", "2027-02-28", 5000],
    ]);
    expect(listed.every((item) => item.clientName === "Client a")).toBe(true);
  });

  it("includes day 90 and leaves out day 91", async () => {
    await addTask({ task: "Day 90", due: "2027-03-23", cents: 100 });
    await addTask({ task: "Day 91", due: "2027-03-24", cents: 100 });
    expect((await items()).map((item) => item.name)).toEqual(["Day 90"]);
  });

  it("lists every repeat inside the period", async () => {
    await addTask({ task: "Monthly job", due: "2027-01-05", months: 1, cents: 100 });
    expect((await items()).map((item) => item.date)).toEqual([
      "2027-01-05",
      "2027-02-05",
      "2027-03-05",
    ]);
  });

  it("shows an overdue job once, so it isn't forgotten", async () => {
    await addTask({ task: "Late job", due: "2026-12-01", months: 1, cents: 100 });
    expect((await items()).map((item) => item.date)).toEqual(["2026-12-01"]);
  });

  it.each(["pending_approval", "suspended", "cancelled", "ended"])(
    "leaves out charges from a %s retainer",
    async (status) => {
      await handle.db.query(
        `UPDATE public.retainers SET status = $1, starts_on = '2026-12-28' WHERE id = $2`,
        [status, RETAINER],
      );
      expect(await items()).toEqual([]);
    },
  );

  it("stops at a retainer's last charge", async () => {
    await handle.db.query(
      `UPDATE public.retainers SET status = 'active', starts_on = '2026-12-28', ends_on = '2027-01-28'
       WHERE id = $1`,
      [RETAINER],
    );
    expect((await items()).map((item) => item.date)).toEqual(["2026-12-28", "2027-01-28"]);
  });

  it("leaves out a stopped job", async () => {
    await addTask({ task: "Stopped", due: "2027-01-10", cents: 100, status: "cancelled" });
    expect(await items()).toEqual([]);
  });

  it("shows only your own", async () => {
    await handle.db.query(
      `UPDATE public.retainers SET status = 'active', starts_on = '2026-12-28' WHERE id = $1`,
      [USER_B.rows.retainers],
    );
    expect(await items()).toEqual([]);
  });

  it("groups by week, Monday first", async () => {
    await addTask({ task: "Sunday", due: "2027-01-10", cents: 100 });
    await addTask({ task: "Monday", due: "2027-01-11", cents: 100 });
    const { weeks } = await upcoming();
    expect(weeks.map((week) => week.weekOf)).toEqual(["2027-01-04", "2027-01-11"]);
    expect(weekOf("2027-01-10")).toBe("2027-01-04");
    expect(weekOf("2027-01-11")).toBe("2027-01-11");
  });
});

describe("expected income", () => {
  it("adds up each currency on its own and never converts", async () => {
    await addTask({ task: "One", due: "2027-01-10", cents: 20_000, currency: "USD" });
    await addTask({ task: "Two", due: "2027-01-11", cents: 5_050, currency: "USD" });
    await addTask({ task: "Three", due: "2027-01-12", cents: 9_900, currency: "EUR" });
    await addTask({ task: "Four", due: "2027-01-13", cents: 150_000, currency: "JPY" });
    expect((await upcoming()).totals).toEqual([
      { currency: "EUR", cents: 9_900 },
      { currency: "JPY", cents: 150_000 },
      { currency: "USD", cents: 25_050 },
    ]);
  });

  it("uses the amount stored for each charge, in whole minor units", async () => {
    await handle.db.query(
      `UPDATE public.retainers SET status = 'active', starts_on = '2026-12-28', amount_cents = 1999,
         currency = 'GBP' WHERE id = $1`,
      [RETAINER],
    );
    const { totals } = await upcoming();
    expect(totals).toEqual([{ currency: "GBP", cents: 1999 * 3 }]);
    expect(Number.isSafeInteger(totals[0]?.cents)).toBe(true);
  });

  it("counts a job with no estimate as unknown, not as zero", async () => {
    await addTask({ task: "No estimate", due: "2027-01-10", cents: null });
    await addTask({ task: "With estimate", due: "2027-01-11", cents: 100 });
    const result = await upcoming();
    expect(result.withoutEstimate).toBe(1);
    expect(result.totals).toEqual([{ currency: "USD", cents: 100 }]);
    expect(result.weeks[0]?.items[0]).toMatchObject({ amountCents: null, currency: null });
  });

  it("totals are a plain sum of what's listed", () => {
    expect(
      totalsByCurrency([
        { amountCents: 1, currency: "USD" },
        { amountCents: 2, currency: "USD" },
        { amountCents: null, currency: null },
      ]),
    ).toEqual([{ currency: "USD", cents: 3 }]);
  });

  it("formats through the one money formatter", () => {
    expect(formatMoney(150_000, "JPY")).toContain("150,000");
    expect(formatMoney(25_050, "USD")).toContain("250.50");
  });

  it("uses the freelancer's own date for the window", async () => {
    await handle.db.query(`UPDATE public.users SET time_zone = 'Pacific/Auckland' WHERE id = $1`, [
      A,
    ]);
    // 23 Dec 23:30 UTC is already 24 Dec in Auckland, so 91 days from 23 Dec is now in range.
    await addTask({ task: "Edge", due: "2027-03-24", cents: 100 });
    const later = await upcoming(new Date("2026-12-23T23:30:00Z"));
    await handle.db.query(`UPDATE public.users SET time_zone = 'UTC' WHERE id = $1`, [A]);
    expect(later.weeks.flatMap((week) => week.items).map((item) => item.name)).toEqual(["Edge"]);
  });
});
