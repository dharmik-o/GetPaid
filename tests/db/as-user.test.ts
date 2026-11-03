import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentUserId, DEMO_USER_ID } from "@/lib/auth";
import { runAsUser } from "@/lib/db";
import { openMigratedPglite, type TestDatabase } from "./pglite";
import { USER_A, USER_B, seedOwnerSql } from "./fixtures";

describe("runAsUser", () => {
  let handle: TestDatabase;

  beforeAll(async () => {
    handle = await openMigratedPglite();
    await handle.db.query(seedOwnerSql(USER_A));
    await handle.db.query(seedOwnerSql(USER_B));
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  it("acts as the authenticated role, so RLS shows only the user's own rows", async () => {
    const rows = await runAsUser(handle.db, USER_A.userId, async (db) => {
      const role = await db.query<{ role: string }>("SELECT current_user AS role");
      const clients = await db.query<{ user_id: string }>(
        "SELECT user_id::text FROM public.clients",
      );
      return { role: role.rows[0]?.role, owners: clients.rows.map((row) => row.user_id) };
    });
    expect(rows).toEqual({ role: "authenticated", owners: [USER_A.userId] });
  });

  it("commits the work and drops the role afterwards", async () => {
    await runAsUser(handle.db, USER_A.userId, (db) =>
      db.query("UPDATE public.clients SET name = 'Renamed' WHERE id = $1", [USER_A.rows.clients]),
    );
    const after = await handle.db.query<{ name: string; role: string }>(
      "SELECT name, current_user AS role FROM public.clients WHERE id = $1",
      [USER_A.rows.clients],
    );
    expect(after.rows[0]?.name).toBe("Renamed");
    expect(after.rows[0]?.role).not.toBe("authenticated");
  });

  it("rolls back everything when the work throws", async () => {
    await expect(
      runAsUser(handle.db, USER_A.userId, async (db) => {
        await db.query("UPDATE public.clients SET name = 'Lost' WHERE id = $1", [
          USER_A.rows.clients,
        ]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const after = await handle.db.query<{ name: string }>(
      "SELECT name FROM public.clients WHERE id = $1",
      [USER_A.rows.clients],
    );
    expect(after.rows[0]?.name).not.toBe("Lost");
  });

  it("refuses a user id that isn't a UUID, before touching the database", async () => {
    await expect(runAsUser(handle.db, "1 OR 1=1", () => Promise.resolve())).rejects.toThrow(
      /not a valid user id/,
    );
  });
});

describe("currentUserId", () => {
  it("uses the demo user in development when no dev user is set", () => {
    expect(currentUserId({ NODE_ENV: "development" })).toBe(DEMO_USER_ID);
  });

  it("uses DEV_USER_ID when set", () => {
    expect(currentUserId({ NODE_ENV: "development", DEV_USER_ID: USER_B.userId })).toBe(
      USER_B.userId,
    );
  });

  it("refuses to run in production, where real sign-in is needed", () => {
    expect(() => currentUserId({ NODE_ENV: "production" })).toThrow(/sign-in/i);
  });
});
