import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH_STUB_FILE } from "../../scripts/lib/paths";
import { runSqlFile } from "../../scripts/lib/runner";
import type { SqlClient } from "../../scripts/lib/sql-client";
import { inRollback, openPglite, type TestDatabase } from "./pglite";

const USER_ID = "aaaaaaaa-0000-4000-8000-000000000000";

let handle: TestDatabase | undefined;
const db = (): SqlClient => {
  if (!handle) throw new Error("Test database is not open; see the beforeAll error above.");
  return handle.db;
};

beforeAll(async () => {
  handle = await openPglite();
  await runSqlFile(handle.db, AUTH_STUB_FILE);
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

const uidWith = (setting: string, value: string | null): Promise<string | null> =>
  inRollback(db(), async () => {
    if (value !== null) await db().query("SELECT set_config($1, $2, true)", [setting, value]);
    const { rows } = await db().query<{ uid: string | null }>("SELECT auth.uid()::text AS uid");
    return rows[0]?.uid ?? null;
  });

describe("db/dev/000_supabase_auth_stub.sql", () => {
  it("reads the user id from the sub in request.jwt.claims", async () => {
    expect(await uidWith("request.jwt.claims", JSON.stringify({ sub: USER_ID }))).toBe(USER_ID);
  });

  it("returns NULL when no claims are set", async () => {
    expect(await uidWith("request.jwt.claims", null)).toBeNull();
  });

  it("returns NULL when the claims have no sub", async () => {
    expect(await uidWith("request.jwt.claims", JSON.stringify({ role: "anon" }))).toBeNull();
  });

  it("ignores the legacy request.jwt.claim.sub setting (no fallback)", async () => {
    expect(await uidWith("request.jwt.claim.sub", USER_ID)).toBeNull();
  });

  it("creates anon, authenticated and service_role; only service_role bypasses RLS", async () => {
    const { rows } = await db().query<{ rolname: string; rolbypassrls: boolean }>(
      `SELECT rolname, rolbypassrls FROM pg_roles
       WHERE rolname IN ('anon', 'authenticated', 'service_role') ORDER BY rolname`,
    );
    expect(rows).toEqual([
      { rolname: "anon", rolbypassrls: false },
      { rolname: "authenticated", rolbypassrls: false },
      { rolname: "service_role", rolbypassrls: true },
    ]);
  });

  it("can be applied again", async () => {
    await expect(runSqlFile(db(), AUTH_STUB_FILE)).resolves.toBeUndefined();
  });

  it("refuses to replace an auth.uid() it didn't create (a real Supabase database)", async () => {
    const other = await openPglite();
    try {
      await other.db.query(
        "CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;",
      );
      await expect(runSqlFile(other.db, AUTH_STUB_FILE)).rejects.toThrow(/not the dev stub/);
    } finally {
      await other.close();
    }
  });
});
