import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "../../scripts/lib/paths";
import { migrate } from "../../scripts/lib/runner";
import type { SqlClient } from "../../scripts/lib/sql-client";
import { OWNED_TABLES, SHARED_TABLES, USER_A, ownerColumn, seedOwnerSql } from "./fixtures";
import { inRollback, openMigratedPglite, type TestDatabase } from "./pglite";

let handle: TestDatabase | undefined;
const db = (): SqlClient => {
  if (!handle) throw new Error("Test database is not open; see the beforeAll error above.");
  return handle.db;
};

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

interface ColumnRow {
  table_name: string;
  column_name: string;
}

const columnsWhere = async (condition: string): Promise<string[]> => {
  const { rows } = await db().query<ColumnRow>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND ${condition} ORDER BY 1, 2`,
  );
  return rows.map((row) => `${row.table_name}.${row.column_name}`);
};

describe("001_init and 002_indexes", () => {
  it("applies every migration once; a re-run applies nothing", async () => {
    expect(await migrate(db(), MIGRATIONS_DIR)).toEqual([]);
  });

  it("creates exactly the tables from the data model built so far", async () => {
    const { rows } = await db().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'`,
    );
    expect(rows.map((row) => row.table_name).sort()).toEqual(
      [...OWNED_TABLES, ...SHARED_TABLES].sort(),
    );
  });

  it.each(OWNED_TABLES)("%s has row-level security and an owner policy", async (table) => {
    const { rows } = await db().query<{ rls: boolean; policies: number }>(
      `SELECT c.relrowsecurity AS rls,
              (SELECT count(*)::int FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
       FROM pg_class c WHERE c.oid = to_regclass($1)`,
      [`public.${table}`],
    );
    expect(rows[0]).toEqual({ rls: true, policies: expect.any(Number) as number });
    expect(rows[0]?.policies).toBeGreaterThan(0);
  });

  it("stores no value as a float or numeric", async () => {
    expect(await columnsWhere("data_type IN ('real', 'double precision', 'numeric')")).toEqual([]);
  });

  it("stores every *_cents column as bigint", async () => {
    expect(await columnsWhere("column_name LIKE '%\\_cents' AND data_type <> 'bigint'")).toEqual(
      [],
    );
  });

  it("gives every table with money a currency column", async () => {
    const { rows } = await db().query<{ table_name: string }>(
      `SELECT DISTINCT c.table_name FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.column_name LIKE '%\\_cents'
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns k
                         WHERE k.table_schema = 'public' AND k.table_name = c.table_name
                           AND k.column_name = 'currency')`,
    );
    expect(rows).toEqual([]);
  });

  it("stores every timestamp as timestamptz", async () => {
    expect(await columnsWhere("data_type = 'timestamp without time zone'")).toEqual([]);
  });

  it("indexes the leading column of every foreign key", async () => {
    const { rows } = await db().query<{ fk: string }>(
      `SELECT c.conrelid::regclass::text || '.' || a.attname AS fk
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
         AND NOT EXISTS (SELECT 1 FROM pg_index i
                         WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1]
                           AND i.indpred IS NULL)`,
    );
    expect(rows.map((row) => row.fk)).toEqual([]);
  });

  it.each(OWNED_TABLES)("indexes the owner column of %s for the RLS filter", async (table) => {
    const { rows } = await db().query(
      `SELECT 1 FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
       WHERE i.indrelid = to_regclass($1) AND a.attname = $2 AND i.indpred IS NULL`,
      [`public.${table}`, ownerColumn(table)],
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("constraints", () => {
  const rejects = (sql: string, params: readonly unknown[], pattern: RegExp) =>
    expect(inRollback(db(), () => db().query(sql, params))).rejects.toThrow(pattern);

  it("refuses to record a send for a reminder that isn't approved", async () => {
    await rejects(
      "UPDATE public.reminders SET sent_at = now(), draft = '{}' WHERE id = $1",
      [USER_A.rows.reminders],
      /reminders_sent_only_when_approved/,
    );
  });

  it("refuses to record a send for a reminder with no draft", async () => {
    await rejects(
      "UPDATE public.reminders SET approval_status = 'approved', approved_via = 'outbox', sent_at = now() WHERE id = $1",
      [USER_A.rows.reminders],
      /reminders_sent_only_when_approved/,
    );
  });

  it("records a send once the reminder is approved and drafted", async () => {
    const { rowCount } = await inRollback(db(), () =>
      db().query(
        `UPDATE public.reminders
         SET approval_status = 'approved', approved_via = 'telegram', draft = '{"subject": "Reminder"}', sent_at = now()
         WHERE id = $1`,
        [USER_A.rows.reminders],
      ),
    );
    expect(rowCount).toBe(1);
  });

  it("sets approved_via only on approved reminders", async () => {
    await rejects(
      "UPDATE public.reminders SET approved_via = 'outbox' WHERE id = $1",
      [USER_A.rows.reminders],
      /reminders_via_only_when_approved/,
    );
  });

  it.each([
    ["both amount and percent", "10000, 3000"],
    ["neither amount nor percent", "NULL, NULL"],
  ])("refuses a milestone with %s", async (_label, values) => {
    await rejects(
      `INSERT INTO public.milestones (user_id, project_id, currency, position, name, amount_cents, percent_bp, deadline)
       VALUES ($1, $2, 'USD', 2, 'Build', ${values}, '2027-01-01')`,
      [USER_A.userId, USER_A.rows.projects],
      /milestones_amount_or_percent/,
    );
  });

  it("keeps a milestone's currency equal to its project's", async () => {
    await rejects(
      `INSERT INTO public.milestones (user_id, project_id, currency, position, name, percent_bp, deadline)
       VALUES ($1, $2, 'EUR', 2, 'Build', 5000, '2027-01-01')`,
      [USER_A.userId, USER_A.rows.projects],
      /foreign key/,
    );
  });

  it.each([
    ["both a milestone and a retainer", "$2, $3"],
    ["neither a milestone nor a retainer", "NULL, NULL"],
  ])("refuses an invoice tied to %s", async (_label, values) => {
    await rejects(
      `INSERT INTO public.invoices (user_id, milestone_id, retainer_id, amount_cents, currency)
       VALUES ($1, ${values}, 100, 'USD')`,
      values.startsWith("$")
        ? [USER_A.userId, USER_A.rows.milestones, USER_A.rows.retainers]
        : [USER_A.userId],
      /invoices_one_source/,
    );
  });

  it("allows one open invoice per milestone, and a new one after cancelling", async () => {
    const insert = `INSERT INTO public.invoices (user_id, milestone_id, amount_cents, currency) VALUES ($1, $2, 90000, 'USD')`;
    const params = [USER_A.userId, USER_A.rows.milestones];
    await rejects(insert, params, /invoices_one_open_per_installment/);
    const { rowCount } = await inRollback(db(), async () => {
      await db().query("UPDATE public.invoices SET status = 'cancelled' WHERE id = $1", [
        USER_A.rows.invoices,
      ]);
      return db().query(insert, params);
    });
    expect(rowCount).toBe(1);
  });

  it("gives every invoice its own PayPal-Request-Id", async () => {
    const { rows } = await db().query<{ request_id: string | null }>(
      "SELECT paypal_request_id::text AS request_id FROM public.invoices WHERE id = $1",
      [USER_A.rows.invoices],
    );
    expect(rows[0]?.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// Invoice numbers are what stop duplicate PayPal invoices (PayPal refuses a repeated number),
// so they must stay unique however large the sequence gets.
describe("004 and 005: invoice numbers", () => {
  const newNumber = async (): Promise<string> => {
    const { rows } = await db().query<{ invoice_number: string }>(
      `INSERT INTO public.invoices (user_id, retainer_id, amount_cents, currency)
       VALUES ($1, $2, 100, 'USD') RETURNING invoice_number`,
      [USER_A.userId, USER_A.rows.retainers],
    );
    return rows[0]?.invoice_number ?? "";
  };

  it("are FPR- and at least six digits", async () => {
    await inRollback(db(), async () => {
      await db().query("SELECT setval('public.invoice_number_seq', 41)");
      expect(await newNumber()).toBe("FPR-000042");
    });
  });

  it("keep every digit past 999999, so they never repeat", async () => {
    await inRollback(db(), async () => {
      await db().query("SELECT setval('public.invoice_number_seq', 999999)");
      expect(await newNumber()).toBe("FPR-1000000");
      expect(await newNumber()).toBe("FPR-1000001");
      await db().query("SELECT setval('public.invoice_number_seq', 1234567889)");
      expect(await newNumber()).toBe("FPR-1234567890");
    });
  });
});

// Installments replace PayPal partial payments: one invoice per installment, numbered within
// a plan of 2 to 12, and at most one open invoice per installment number.
describe("007: installments", () => {
  const rejects = (sql: string, params: readonly unknown[], pattern: RegExp) =>
    expect(inRollback(db(), () => db().query(sql, params))).rejects.toThrow(pattern);

  const installment = (number: number | null, count: number | null, plan: string | null) =>
    db().query(
      `INSERT INTO public.invoices (user_id, milestone_id, amount_cents, currency,
         installment_number, installment_count, installment_plan_id)
       VALUES ($1, $2, 30000, 'USD', $3, $4, $5)`,
      [USER_A.userId, USER_A.rows.milestones, number, count, plan],
    );

  const cancelPlainInvoice = () =>
    db().query("UPDATE public.invoices SET status = 'cancelled' WHERE id = $1", [
      USER_A.rows.invoices,
    ]);

  it("has no PayPal minimum amount due any more", async () => {
    expect(await columnsWhere("column_name = 'minimum_due_cents'")).toEqual([]);
  });

  it("allows installments 1 and 2 of a plan side by side", async () => {
    const plan = USER_A.rows.installment_plans;
    const inserted = await inRollback(db(), async () => {
      await cancelPlainInvoice();
      await installment(1, 2, plan);
      return installment(2, 2, plan);
    });
    expect(inserted.rowCount).toBe(1);
  });

  it("refuses a second open invoice for the same installment", async () => {
    const plan = USER_A.rows.installment_plans;
    await expect(
      inRollback(db(), async () => {
        await cancelPlainInvoice();
        await installment(1, 2, plan);
        return installment(1, 2, plan);
      }),
    ).rejects.toThrow(/invoices_one_open_per_installment/);
  });

  it("refuses an installment number above its count", async () => {
    await expect(
      inRollback(db(), () => installment(3, 2, USER_A.rows.installment_plans)),
    ).rejects.toThrow(/invoices_installment_within_count/);
  });

  it("refuses installment fields that are only partly set", async () => {
    await expect(inRollback(db(), () => installment(1, 2, null))).rejects.toThrow(
      /invoices_installment_all_or_none/,
    );
  });

  it.each([
    ["1 installment", 1, '[{"amountCents": 90000, "dueDate": null}]'],
    ["13 installments", 13, JSON.stringify(Array(13).fill({ amountCents: 1, dueDate: null }))],
  ])("refuses a plan of %s", async (_label, count, items) => {
    await rejects(
      `INSERT INTO public.installment_plans (user_id, milestone_id, count, total_cents, currency, items, created_from)
       VALUES ($1, $2, $3, 90000, 'USD', $4, 'setup')`,
      [USER_A.userId, USER_A.rows.milestones, count, items],
      /installment_plans_count_check/,
    );
  });

  it("refuses a plan whose items don't match its count", async () => {
    await rejects(
      `INSERT INTO public.installment_plans (user_id, milestone_id, count, total_cents, currency, items, created_from)
       VALUES ($1, $2, 3, 90000, 'USD', '[{"amountCents": 1, "dueDate": null}]', 'setup')`,
      [USER_A.userId, USER_A.rows.milestones],
      /installment_plans_items_match_count/,
    );
  });

  it("allows one active plan per milestone", async () => {
    await rejects(
      `INSERT INTO public.installment_plans (user_id, milestone_id, count, total_cents, currency, items, created_from)
       VALUES ($1, $2, 2, 90000, 'USD', '[{"amountCents": 1, "dueDate": null}, {"amountCents": 2, "dueDate": null}]', 'setup')`,
      [USER_A.userId, USER_A.rows.milestones],
      /installment_plans_one_active_per_milestone/,
    );
  });
});

describe("008: AI settings", () => {
  it("accepts only http(s) base URLs for a model", async () => {
    await expect(
      inRollback(db(), () =>
        db().query(
          `INSERT INTO public.ai_providers (user_id, task, provider, base_url, model, fallback_order)
           VALUES ($1, 'sort', 'custom', 'file:///etc/passwd', 'm1', 1)`,
          [USER_A.userId],
        ),
      ),
    ).rejects.toThrow(/ai_providers_base_url_http/);
  });

  it("marks models as cloud unless saved as local", async () => {
    const { rows } = await db().query<{ is_local: boolean }>(
      "SELECT is_local FROM public.ai_providers WHERE id = $1",
      [USER_A.rows.ai_providers],
    );
    expect(rows[0]?.is_local).toBe(false);
  });
});
