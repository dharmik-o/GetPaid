import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser, type Db } from "@/lib/db";
import { loadMetrics } from "@/lib/metrics";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// The metrics query and the paid date: real migrations and row-level security (PGlite).

let handle: TestDatabase;

const A = USER_A.rows;
const NOW = new Date("2026-12-20T15:00:00Z");
const INVOICE = A.invoices;
const asA = <T>(work: (db: Db) => Promise<T>) => runAsUser(handle.db, USER_A.userId, work);
const load = () => asA((db) => loadMetrics(db, NOW));

const invoiceRow = async (id = INVOICE) => {
  const { rows } = await handle.db.query<{ paid_at: Date | null }>(
    "SELECT paid_at FROM public.invoices WHERE id = $1",
    [id],
  );
  return rows[0];
};

const setStatus = (status: string, paid: number) =>
  handle.db.query("UPDATE public.invoices SET status = $2, amount_paid_cents = $3 WHERE id = $1", [
    INVOICE,
    status,
    paid,
  ]);

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
}, 60_000);

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.query(
    `UPDATE public.invoices SET status = 'sent', amount_paid_cents = 0, paid_at = NULL,
       due_date = '2026-12-08'`,
  );
  await handle.db.query("DELETE FROM public.invoices WHERE installment_plan_id IS NOT NULL");
  await handle.db.query("UPDATE public.reminders SET approval_status = 'waiting', sent_at = NULL");
  await handle.db.query("UPDATE public.users SET usual_days_late = NULL");
});

describe("the paid date", () => {
  it("is set when an invoice turns paid, however it got there", async () => {
    expect((await invoiceRow())?.paid_at).toBeNull();
    await setStatus("paid", 90000);
    expect((await invoiceRow())?.paid_at).toBeInstanceOf(Date);
  });

  it("keeps the first date through a refund", async () => {
    await setStatus("paid", 90000);
    await handle.db.query(
      "UPDATE public.invoices SET paid_at = '2026-12-10T00:00:00Z' WHERE id = $1",
      [INVOICE],
    );
    await setStatus("refunded", 0);
    expect((await invoiceRow())?.paid_at).toEqual(new Date("2026-12-10T00:00:00Z"));
  });

  it("stays empty for a part payment or a cancellation", async () => {
    await setStatus("partially_paid", 100);
    expect((await invoiceRow())?.paid_at).toBeNull();
    await setStatus("cancelled", 0);
    expect((await invoiceRow())?.paid_at).toBeNull();
  });

  it("is a column the app can't be asked to fake: paying twice keeps the first", async () => {
    await setStatus("paid", 90000);
    const first = (await invoiceRow())?.paid_at;
    await setStatus("paid", 90000);
    expect((await invoiceRow())?.paid_at).toEqual(first);
  });
});

describe("loadMetrics", () => {
  const paidLate = async () => {
    await setStatus("paid", 90000);
    await handle.db.query(
      "UPDATE public.invoices SET paid_at = '2026-12-18T15:00:00Z' WHERE id = $1",
      [INVOICE],
    );
  };

  it("reads a paid-late invoice with its client and its first reminder", async () => {
    await paidLate();
    await handle.db.query(
      `UPDATE public.reminders SET approval_status = 'approved',
         draft = '{"subject":"s","body":"b"}', sent_at = '2026-12-10T15:00:00Z' WHERE id = $1`,
      [A.reminders],
    );
    const metrics = await load();
    expect(metrics.recovered).toEqual([{ currency: "USD", cents: 90000 }]);
    expect(metrics.daysLate).toEqual([
      expect.objectContaining({ clientId: A.clients, clientName: "Client a", days: 10 }),
    ]);
    expect(metrics.recovery).toEqual({ paid: 1, total: 1 });
  });

  it("reads the usual delay from the account", async () => {
    await paidLate();
    await handle.db.query("UPDATE public.users SET usual_days_late = 25 WHERE id = $1", [
      USER_A.userId,
    ]);
    expect(await load()).toMatchObject({ usualDaysLate: 25, daysSaved: 15 });
  });

  it("an installment from a client's request counts from the invoice it replaced", async () => {
    await setStatus("cancelled", 0);
    await handle.db.query(
      `UPDATE public.reminders SET approval_status = 'approved',
         draft = '{"subject":"s","body":"b"}', sent_at = '2026-12-10T15:00:00Z' WHERE id = $1`,
      [A.reminders],
    );
    await handle.db.query(
      "UPDATE public.installment_plans SET created_from = 'client_request' WHERE id = $1",
      [A.installment_plans],
    );
    await handle.db.query(
      `INSERT INTO public.invoices (user_id, milestone_id, amount_cents, amount_paid_cents, currency,
         due_date, status, paid_at, installment_number, installment_count, installment_plan_id)
       VALUES ($1, $2, 45000, 45000, 'USD', '2026-12-18', 'paid', '2026-12-18T15:00:00Z', 1, 2, $3)`,
      [USER_A.userId, A.milestones, A.installment_plans],
    );
    const metrics = await load();
    expect(metrics.recovered).toEqual([{ currency: "USD", cents: 45000 }]);
    expect(metrics.daysLate).toEqual([expect.objectContaining({ days: 10 })]);
    expect(metrics.recovery).toEqual({ paid: 1, total: 1 });
    await handle.db.query(
      "UPDATE public.installment_plans SET created_from = 'deposit' WHERE id = $1",
      [A.installment_plans],
    );
  });

  it("shows nothing from another freelancer", async () => {
    await handle.db.query(
      `UPDATE public.invoices SET status = 'paid', amount_paid_cents = 90000,
         paid_at = '2026-12-18T15:00:00Z' WHERE user_id = $1`,
      [USER_B.userId],
    );
    expect((await load()).recovered).toEqual([]);
  });
});
