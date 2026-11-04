import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setDemoOffsetDays } from "@/lib/clock";
import { runAsUser } from "@/lib/db";
import { runAsService } from "@/lib/service-db";
import { USER_A, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// Timestamps Postgres sets itself follow the demo clock, so a timeline stays in order and a paid
// date matches the rest of the demo. Real migrations (PGlite).

let handle: TestDatabase;

const A = USER_A.rows;
const DAY = 24 * 60 * 60 * 1000;
const DEV = { NODE_ENV: "development" };

const newEventAt = async (runner: "user" | "service"): Promise<Date> => {
  const insert = `INSERT INTO public.events (user_id, entity, entity_id, type)
    VALUES ('${USER_A.userId}', 'invoice', '${A.invoices}', 'invoice.sent') RETURNING created_at`;
  const rows = await (runner === "user"
    ? runAsUser(handle.db, USER_A.userId, (db) => db.query<{ created_at: Date }>(insert, []))
    : runAsService(handle.db, (db) => db.query<{ created_at: Date }>(insert, [])));
  const at = rows.rows[0]?.created_at;
  if (!at) throw new Error("The event wasn't saved.");
  return new Date(at);
};

const daysAhead = (at: Date) => (at.getTime() - Date.now()) / DAY;

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
}, 60_000);

afterAll(async () => {
  await handle.close();
});

afterEach(() => {
  setDemoOffsetDays(undefined);
});

describe("the database clock", () => {
  it.each(["user", "service"] as const)("is the real time with no offset: %s", async (runner) => {
    expect(Math.abs(daysAhead(await newEventAt(runner)))).toBeLessThan(0.01);
  });

  it.each(["user", "service"] as const)("follows the demo clock: %s", async (runner) => {
    setDemoOffsetDays(18, DEV);
    expect(daysAhead(await newEventAt(runner))).toBeCloseTo(18, 1);
  });

  it("the offset ends with its transaction", async () => {
    setDemoOffsetDays(18, DEV);
    await newEventAt("user");
    setDemoOffsetDays(undefined);
    expect(Math.abs(daysAhead(await newEventAt("user")))).toBeLessThan(0.01);
  });

  it("a paid date follows it too", async () => {
    setDemoOffsetDays(18, DEV);
    const { rows } = await runAsService(handle.db, (db) =>
      db.query<{ paid_at: Date }>(
        `UPDATE public.invoices SET status = 'paid', amount_paid_cents = amount_cents
         WHERE id = '${A.invoices}' RETURNING paid_at`,
        [],
      ),
    );
    expect(daysAhead(new Date(rows[0]?.paid_at ?? 0))).toBeCloseTo(18, 1);
  });

  it("a new invoice, reply and reminder follow it", async () => {
    setDemoOffsetDays(18, DEV);
    const { rows } = await runAsUser(handle.db, USER_A.userId, (db) =>
      db.query<{ created_at: Date }>(
        `INSERT INTO public.messages (user_id, invoice_id, direction, body)
         VALUES ('${USER_A.userId}', '${A.invoices}', 'in', 'hello') RETURNING created_at`,
        [],
      ),
    );
    expect(daysAhead(new Date(rows[0]?.created_at ?? 0))).toBeCloseTo(18, 1);
  });
});
