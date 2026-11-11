import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAsUser, type Db } from "@/lib/db";
import { tourHandlers } from "@/lib/tour";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// T1: the tour's saved progress. The route refuses bad input, and each freelancer's progress is
// theirs alone: real migrations and RLS (PGlite).

let handle: TestDatabase;

const as =
  (userId: string) =>
  <T>(work: (db: Db) => Promise<T>): Promise<T> =>
    runAsUser(handle.db, userId, work);

const post = (userId: string, body: unknown) =>
  tourHandlers({ runAsUser: as(userId) }).post(
    new Request("http://127.0.0.1:3000/api/tour", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const get = (userId: string) => tourHandlers({ runAsUser: as(userId) }).get();

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
}, 60_000);

afterAll(async () => {
  await handle.close();
});

describe("POST /api/tour", () => {
  it.each([
    ["an unknown event", { event: "explode" }],
    ["no event", {}],
    ["a tip that doesn't exist", { event: "tip-seen", tip: "billing" }],
    ["a tip event without a tip", { event: "tip-seen" }],
    ["extra fields", { event: "skip", userId: USER_B.userId }],
    ["a tip on a plain event", { event: "complete", tip: "calendar" }],
  ])("refuses %s with a 400", async (_label, body) => {
    expect((await post(USER_A.userId, body)).status).toBe(400);
  });

  it("refuses a body that isn't JSON", async () => {
    const response = await tourHandlers({ runAsUser: as(USER_A.userId) }).post(
      new Request("http://127.0.0.1:3000/api/tour", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "skip",
      }),
    );
    expect(response.status).toBe(415);
  });

  it("saves the end of the tour and the tips seen, and replay and reset undo them", async () => {
    expect(await (await get(USER_A.userId)).json()).toMatchObject({
      mainDone: false,
      tipsSeen: [],
    });
    await post(USER_A.userId, { event: "tip-seen", tip: "calendar" });
    await post(USER_A.userId, { event: "tip-seen", tip: "calendar" });
    const done = await post(USER_A.userId, { event: "complete" });
    expect(await done.json()).toMatchObject({ mainDone: true, tipsSeen: ["calendar"] });
    const replayed = await post(USER_A.userId, { event: "replay" });
    expect(await replayed.json()).toMatchObject({ mainDone: false, tipsSeen: ["calendar"] });
    const reset = await post(USER_A.userId, { event: "reset-tips" });
    expect(await reset.json()).toMatchObject({ tipsSeen: [] });
  });
});

describe("another user's progress (RLS)", () => {
  it("is never changed by acting as someone else", async () => {
    await post(USER_A.userId, { event: "skip" });
    await post(USER_A.userId, { event: "tip-seen", tip: "client" });
    expect(await (await get(USER_B.userId)).json()).toMatchObject({
      mainDone: false,
      tipsSeen: [],
    });
  });

  it("can't be read or written straight through the database", async () => {
    const read = await as(USER_A.userId)((db) =>
      db.query("SELECT tour_tips_seen FROM public.users WHERE id = $1", [USER_B.userId]),
    );
    expect(read.rows).toHaveLength(0);
    const write = await as(USER_A.userId)((db) =>
      db.query(
        "UPDATE public.users SET tour_completed_at = now(), tour_tips_seen = '{project}' WHERE id = $1",
        [USER_B.userId],
      ),
    );
    expect(write.rowCount).toBe(0);
    const { rows } = await handle.db.query<{
      tour_completed_at: string | null;
      tour_tips_seen: string[];
    }>(`SELECT tour_completed_at, tour_tips_seen FROM public.users WHERE id = '${USER_B.userId}'`);
    expect(rows[0]).toEqual({ tour_completed_at: null, tour_tips_seen: [] });
  });
});
