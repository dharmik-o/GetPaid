import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountHandlers, getOwnTimeZone } from "@/lib/account";
import { runAsUser, type Db } from "@/lib/db";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// The freelancer's own time zone: real migrations and RLS (PGlite).

let handle: TestDatabase;

const as =
  (userId: string) =>
  <T>(work: (db: Db) => Promise<T>): Promise<T> =>
    runAsUser(handle.db, userId, work);

const save = (payload: unknown) =>
  accountHandlers({ runAsUser: as(USER_A.userId) }).put(
    new Request("http://127.0.0.1:3000/api/settings/account", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
});

afterAll(async () => {
  await handle.close();
});

describe("own time zone", () => {
  it("starts on UTC", async () => {
    expect(await as(USER_A.userId)((db) => getOwnTimeZone(db))).toBe("UTC");
  });

  it("saves a real zone, for this user only", async () => {
    expect((await save({ timeZone: "Asia/Kolkata" })).status).toBe(200);
    expect(await as(USER_A.userId)((db) => getOwnTimeZone(db))).toBe("Asia/Kolkata");
    expect(await as(USER_B.userId)((db) => getOwnTimeZone(db))).toBe("UTC");
  });

  it("refuses a zone that doesn't exist, and extra fields", async () => {
    expect((await save({ timeZone: "Mars/Olympus" })).status).toBe(400);
    expect((await save({ timeZone: "UTC", name: "Someone else" })).status).toBe(400);
  });
});
