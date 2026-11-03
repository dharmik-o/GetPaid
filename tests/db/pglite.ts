import { PGlite } from "@electric-sql/pglite";
import { AUTH_STUB_FILE, MIGRATIONS_DIR } from "../../scripts/lib/paths";
import { migrate, runSqlFile } from "../../scripts/lib/runner";
import type { SqlClient } from "../../scripts/lib/sql-client";

export interface TestDatabase {
  db: SqlClient;
  close: () => Promise<void>;
}

/** Without params, runs the text as a script (many statements), like pg's simple protocol. */
const pgliteClient = (pg: PGlite): SqlClient => ({
  query: async (sql, params) => {
    const result =
      params === undefined ? (await pg.exec(sql)).at(-1) : await pg.query(sql, [...params]);
    // Row shapes are the caller's claim about its own SQL; the driver can't check them.
    return { rows: (result?.rows ?? []) as never[], rowCount: result?.affectedRows ?? 0 };
  },
});

export const openPglite = async (): Promise<TestDatabase> => {
  const pg = await PGlite.create();
  return { db: pgliteClient(pg), close: () => pg.close() };
};

/** Fresh in-memory Postgres with the dev auth stub and every migration applied by the real runner. */
export const openMigratedPglite = async (): Promise<TestDatabase> => {
  const handle = await openPglite();
  await runSqlFile(handle.db, AUTH_STUB_FILE);
  await migrate(handle.db, MIGRATIONS_DIR);
  return handle;
};

/** Runs `work` in a transaction that is always rolled back. */
export const inRollback = async <T>(db: SqlClient, work: () => Promise<T>): Promise<T> => {
  await db.query("BEGIN");
  try {
    return await work();
  } finally {
    await db.query("ROLLBACK");
  }
};
