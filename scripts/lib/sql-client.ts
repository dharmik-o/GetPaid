import type pg from "pg";

export interface SqlResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * The one query method the db scripts need. Without params the text may hold many
 * statements (a whole migration file); with params it must be a single statement.
 */
export interface SqlClient {
  query<T extends object = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<SqlResult<T>>;
}

export const fromPg = (client: pg.Client): SqlClient => ({
  query: async (sql, params) => {
    // pg resolves a multi-statement script to one result per statement.
    const result = (await client.query(sql, params ? [...params] : undefined)) as
      pg.QueryResult | pg.QueryResult[];
    const last = Array.isArray(result) ? result.at(-1) : result;
    // Row shapes are the caller's claim about its own SQL; the driver can't check them.
    return { rows: (last?.rows ?? []) as never[], rowCount: last?.rowCount ?? 0 };
  },
});
