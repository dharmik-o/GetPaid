import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SqlClient } from "../../scripts/lib/sql-client";
import { OWNED_TABLES, USER_A, USER_B, ownerColumn, seedOwnerSql } from "./fixtures";
import { inRollback, type TestDatabase } from "./pglite";

type Role = "authenticated" | "anon" | "service_role";

/** Acts as `role` with `userId` in the JWT claims (or no claims), inside a rolled-back transaction. */
const actingAs = <T>(
  db: SqlClient,
  role: Role,
  userId: string | null,
  work: () => Promise<T>,
): Promise<T> =>
  inRollback(db, async () => {
    await db.query(`SET LOCAL ROLE ${role}`);
    if (userId !== null) {
      await db.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role }),
      ]);
    }
    return work();
  });

/**
 * Events are append-only, and the archive nearly so: tests/api/invoice-archive.test.ts covers it.
 * The calendar source and event tables have no updated_at: tests/phase2/calendar-rls.test.ts covers them.
 * Agreements can't be deleted (voided instead): tests/phase2/agreements.test.ts covers them.
 * Recorded payments are append-only: tests/api/invoice-payments.test.ts covers them.
 */
const UNTOUCHED_BY_THIS_CHECK = new Set<string>([
  "events",
  "invoice_archive_files",
  "calendar_sources",
  "calendar_events",
  "agreements",
  "invoice_payments",
]);
const MUTABLE_TABLES = OWNED_TABLES.filter((table) => !UNTOUCHED_BY_THIS_CHECK.has(table));

/** The same isolation checks run on PGlite (npm test) and on Docker Postgres (npm run test:db:docker). */
export const defineRlsIsolationSuite = (
  engine: string,
  open: () => Promise<TestDatabase>,
): void => {
  describe(`RLS isolation on ${engine}`, () => {
    let handle: TestDatabase | undefined;
    const db = (): SqlClient => {
      if (!handle) throw new Error("Test database is not open; see the beforeAll error above.");
      return handle.db;
    };
    const asA = <T>(work: () => Promise<T>): Promise<T> =>
      actingAs(db(), "authenticated", USER_A.userId, work);

    beforeAll(async () => {
      handle = await open();
      await handle.db.query(seedOwnerSql(USER_A));
      await handle.db.query(seedOwnerSql(USER_B));
    }, 60_000);

    afterAll(async () => {
      await handle?.close();
    });

    it.each(OWNED_TABLES)("user A reads only their own rows in %s", async (table) => {
      const { rows } = await asA(() =>
        db().query<{ owner: string }>(
          `SELECT ${ownerColumn(table)}::text AS owner FROM public.${table}`,
        ),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.owner))).toEqual(new Set([USER_A.userId]));
    });

    it.each(OWNED_TABLES)("user A can't read user B's row in %s by id", async (table) => {
      const { rows } = await asA(() =>
        db().query(`SELECT id FROM public.${table} WHERE id = $1`, [USER_B.rows[table]]),
      );
      expect(rows).toHaveLength(0);
    });

    it.each(MUTABLE_TABLES)("user A can't update user B's row in %s", async (table) => {
      const { rowCount } = await asA(() =>
        db().query(`UPDATE public.${table} SET updated_at = now() WHERE id = $1`, [
          USER_B.rows[table],
        ]),
      );
      expect(rowCount).toBe(0);
    });

    it.each(MUTABLE_TABLES)("user A can't delete user B's row in %s", async (table) => {
      const { rowCount } = await asA(() =>
        db().query(`DELETE FROM public.${table} WHERE id = $1`, [USER_B.rows[table]]),
      );
      expect(rowCount).toBe(0);
    });

    it("user A can't insert a row owned by user B", async () => {
      await expect(
        asA(() =>
          db().query(
            "INSERT INTO public.clients (user_id, name, email, country, time_zone) VALUES ($1, 'Mallory', 'mallory@example.test', 'US', 'UTC')",
            [USER_B.userId],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("user A can't attach their project to user B's client", async () => {
      await expect(
        asA(() =>
          db().query(
            "INSERT INTO public.projects (user_id, client_id, title, total_cents, currency) VALUES ($1, $2, 'Stolen', 100, 'USD')",
            [USER_A.userId, USER_B.rows.clients],
          ),
        ),
      ).rejects.toThrow(/foreign key/);
    });

    it("events are append-only, even for their owner", async () => {
      await expect(
        asA(() =>
          db().query("UPDATE public.events SET type = 'edited' WHERE id = $1", [
            USER_A.rows.events,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asA(() => db().query("DELETE FROM public.events WHERE id = $1", [USER_A.rows.events])),
      ).rejects.toThrow(/permission denied/);
    });

    it.each(OWNED_TABLES)("a session with no user sees nothing in %s", async (table) => {
      const { rows } = await actingAs(db(), "authenticated", null, () =>
        db().query(`SELECT 1 FROM public.${table}`),
      );
      expect(rows).toHaveLength(0);
    });

    it.each(OWNED_TABLES)("anon has no access to %s", async (table) => {
      await expect(
        actingAs(db(), "anon", null, () => db().query(`SELECT 1 FROM public.${table}`)),
      ).rejects.toThrow(/permission denied/);
    });

    it("service_role bypasses RLS and sees both users' rows", async () => {
      const { rows } = await actingAs(db(), "service_role", null, () =>
        db().query<{ user_id: string }>("SELECT user_id::text AS user_id FROM public.clients"),
      );
      expect(new Set(rows.map((row) => row.user_id))).toEqual(
        new Set([USER_A.userId, USER_B.userId]),
      );
    });
  });
};
