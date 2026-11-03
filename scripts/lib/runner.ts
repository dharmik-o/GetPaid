import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { orderMigrations, pendingMigrations } from "./migrations";
import type { SqlClient } from "./sql-client";

// Fixed key for pg_advisory_lock so two runners never apply migrations at once.
const MIGRATION_LOCK_ID = 727_001;

export const inTransaction = async (db: SqlClient, work: () => Promise<void>): Promise<void> => {
  await db.query("BEGIN");
  try {
    await work();
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
};

/** Only the migration owner reads this table; RLS with no policy hides it from API roles. */
const ensureMigrationsTable = async (db: SqlClient): Promise<void> => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
  `);
};

const appliedMigrations = async (db: SqlClient): Promise<Set<string>> => {
  const { rows } = await db.query<{ name: string }>("SELECT name FROM public.schema_migrations");
  return new Set(rows.map((row) => row.name));
};

const applyMigration = async (db: SqlClient, dir: string, name: string): Promise<void> => {
  const sql = await readFile(join(dir, name), "utf8");
  try {
    await inTransaction(db, async () => {
      await db.query(sql);
      await db.query("INSERT INTO public.schema_migrations (name) VALUES ($1)", [name]);
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Migration ${name} failed and was rolled back: ${reason}. Fix the SQL, then run npm run db:migrate again.`,
      { cause: error },
    );
  }
};

/** Applies pending `NNN_name.sql` files in order, each in its own transaction. Returns their names. */
export const migrate = async (db: SqlClient, dir: string): Promise<string[]> => {
  await db.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
  try {
    await ensureMigrationsTable(db);
    const ordered = orderMigrations(await readdir(dir));
    const pending = pendingMigrations(ordered, await appliedMigrations(db));
    for (const name of pending) await applyMigration(db, dir, name);
    return pending;
  } finally {
    await db.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
  }
};

/** Runs one SQL file in a single transaction (seed data, the dev auth stub). */
export const runSqlFile = async (db: SqlClient, path: string): Promise<void> => {
  const sql = await readFile(path, "utf8");
  await inTransaction(db, async () => {
    await db.query(sql);
  });
};
