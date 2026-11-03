import pg from "pg";
import { loadServerEnv } from "./env";

// Server-only. Dashboard code reaches the database only through `runAsUser`, which acts as
// the `authenticated` role with the user's id in the JWT claims, so row-level security applies.
// Never use the service role here (.claude/rules/web.md).

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  query<T extends object = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

/** Runs work as the signed-in user, in one transaction. */
export type UserDbRunner = <T>(work: (db: Db) => Promise<T>) => Promise<T>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value);

/** One transaction as `authenticated` with `sub = userId`; committed on success, rolled back on error. */
export const runAsUser = async <T>(
  conn: Db,
  userId: string,
  work: (db: Db) => Promise<T>,
): Promise<T> => {
  if (!isUuid(userId)) throw new Error("The signed-in user is not a valid user id. Sign in again.");
  await conn.query("BEGIN");
  try {
    await conn.query("SET LOCAL ROLE authenticated");
    await conn.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    const result = await work(conn);
    await conn.query("COMMIT");
    return result;
  } catch (error) {
    await conn.query("ROLLBACK");
    throw error;
  }
};

const fromPgClient = (client: pg.PoolClient): Db => ({
  query: async (sql, params) => {
    const result = await client.query(sql, params ? [...params] : undefined);
    // Row shapes are the caller's claim about its own SQL; the driver can't check them.
    return { rows: result.rows as never[], rowCount: result.rowCount ?? 0 };
  },
});

let pool: pg.Pool | undefined;

const getPool = (): pg.Pool =>
  (pool ??= new pg.Pool({ connectionString: loadServerEnv().DATABASE_URL, max: 5 }));

/** A runner for this user on the shared pool. A failed transaction discards its connection. */
export const withUserDb =
  (userId: string): UserDbRunner =>
  async (work) => {
    const client = await getPool().connect();
    let failed = false;
    try {
      return await runAsUser(fromPgClient(client), userId, work);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      client.release(failed);
    }
  };
