import { withConnection, type Db } from "./db";

// Server-only. The service role bypasses row-level security, so it is for webhook handlers
// (and n8n) only: never import this into dashboard pages, components or user-facing routes
// (.claude/rules/web.md). Callers must have verified the request's source first.

export type ServiceDbRunner = <T>(work: (db: Db) => Promise<T>) => Promise<T>;

/** One transaction as `service_role`; committed on success, rolled back on error. */
export const runAsService = async <T>(conn: Db, work: (db: Db) => Promise<T>): Promise<T> => {
  await conn.query("BEGIN");
  try {
    await conn.query("SET LOCAL ROLE service_role");
    const result = await work(conn);
    await conn.query("COMMIT");
    return result;
  } catch (error) {
    await conn.query("ROLLBACK");
    throw error;
  }
};

export const withServiceDb: ServiceDbRunner = (work) =>
  withConnection((conn) => runAsService(conn, work));
