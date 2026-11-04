import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser } from "@/lib/db";
import { approveDraft } from "@/lib/outbox-actions";
import { runAsService } from "@/lib/service-db";
import { storedDraftSchema } from "@/lib/stored-draft";
import { cardsToSend } from "@/lib/telegram-cards";
import {
  TEST_CLIENT_EMAIL,
  TEST_REMINDER_ID,
  createTestDraft,
  deliveryStage,
  linkedUserId,
  readTestDraft,
  removeTestDraft,
} from "../scripts/lib/telegram-test-draft";
import { USER_A, USER_B, seedOwnerSql } from "./db/fixtures";
import { openMigratedPglite, type TestDatabase } from "./db/pglite";

// `npm run telegram:test`, on real migrations: the draft it makes has to be one the real card code
// picks up and the real approve accepts, and removing it must touch nothing else.

const NOW = new Date("2026-12-22T20:00:00Z");
const CHAT = 7001;

let handle: TestDatabase;

const count = async (table: string): Promise<number> => {
  const { rows } = await handle.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.${table}`,
  );
  return rows[0]?.n ?? 0;
};

const link = (userId: string, chat: number | null) =>
  handle.db.query("UPDATE public.users SET telegram_chat_id = $2 WHERE id = $1", [userId, chat]);

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await removeTestDraft(handle.db);
  await link(USER_A.userId, null);
  await link(USER_B.userId, null);
});

describe("finding who gets the card", () => {
  it("finds nobody until a chat is linked", async () => {
    expect(await linkedUserId(handle.db)).toBeUndefined();
  });

  it("finds the freelancer whose chat is linked", async () => {
    await link(USER_B.userId, CHAT);
    expect(await linkedUserId(handle.db)).toBe(USER_B.userId);
  });
});

describe("the test draft", () => {
  beforeEach(async () => {
    await link(USER_A.userId, CHAT);
  });

  it("is waiting, passes the stored draft schema, and says it's a test", async () => {
    await createTestDraft(handle.db, USER_A.userId, NOW);
    const { rows } = await handle.db.query<{ draft: unknown; approval_status: string }>(
      "SELECT draft, approval_status FROM public.reminders WHERE id = $1",
      [TEST_REMINDER_ID],
    );
    expect(rows[0]?.approval_status).toBe("waiting");
    const draft = storedDraftSchema.parse(rows[0]?.draft);
    expect(draft.subject).toContain("TEST");
    expect(draft.body).toContain("test draft");
  });

  it("can only belong to an address that can't receive mail", () => {
    expect(TEST_CLIENT_EMAIL.endsWith(".example")).toBe(true);
  });

  it("becomes one approval card for the linked chat, through the real card code", async () => {
    await createTestDraft(handle.db, USER_A.userId, NOW);
    const ops = await runAsService(handle.db, (db) =>
      cardsToSend(db, NOW, "https://app.example.test/outbox"),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "sendCard", chatId: CHAT, reminderId: TEST_REMINDER_ID });
    expect(ops[0]?.text).toContain("TEST");
  });

  it("the real approve accepts it, as the freelancer who owns it", async () => {
    await createTestDraft(handle.db, USER_A.userId, NOW);
    const result = await runAsUser(handle.db, USER_A.userId, (db) =>
      approveDraft(db, TEST_REMINDER_ID, "telegram"),
    );
    expect(result.status).toBe("ok");
    expect((await readTestDraft(handle.db))?.approvalStatus).toBe("approved");
  });

  it("starts fresh on a repeat run, so a handled draft doesn't block a new card", async () => {
    await createTestDraft(handle.db, USER_A.userId, NOW);
    await runAsUser(handle.db, USER_A.userId, (db) =>
      approveDraft(db, TEST_REMINDER_ID, "telegram"),
    );
    await createTestDraft(handle.db, USER_A.userId, NOW);
    expect(await readTestDraft(handle.db)).toMatchObject({
      approvalStatus: "waiting",
      cardSentAt: null,
      messageId: null,
    });
    expect(await count("reminders")).toBe(3);
  });

  it("leaves nothing half made when a step fails", async () => {
    await expect(
      createTestDraft(handle.db, "00000000-0000-4000-8000-00000000dead", NOW),
    ).rejects.toThrow();
    expect(await readTestDraft(handle.db)).toBeUndefined();
    expect(await count("clients")).toBe(2);
  });
});

describe("removing it", () => {
  beforeEach(async () => {
    await link(USER_A.userId, CHAT);
  });

  it("removes its rows and events, and nobody else's", async () => {
    const before = {
      clients: await count("clients"),
      projects: await count("projects"),
      milestones: await count("milestones"),
      invoices: await count("invoices"),
      reminders: await count("reminders"),
    };
    await handle.db.query(
      `INSERT INTO public.events (user_id, entity, entity_id, type)
       VALUES ($1, 'reminder', $2, 'keep.me')`,
      [USER_A.userId, USER_A.rows.reminders],
    );
    await createTestDraft(handle.db, USER_A.userId, NOW);
    await runAsUser(handle.db, USER_A.userId, (db) =>
      approveDraft(db, TEST_REMINDER_ID, "telegram"),
    );

    expect(await removeTestDraft(handle.db)).toBe(true);

    expect({
      clients: await count("clients"),
      projects: await count("projects"),
      milestones: await count("milestones"),
      invoices: await count("invoices"),
      reminders: await count("reminders"),
    }).toEqual(before);
    const { rows } = await handle.db.query<{ type: string; entity_id: string }>(
      "SELECT type, entity_id::text FROM public.events WHERE entity_id = ANY($1::uuid[])",
      [[TEST_REMINDER_ID, USER_A.rows.reminders]],
    );
    expect(rows).toEqual([{ type: "keep.me", entity_id: USER_A.rows.reminders }]);
  });

  it("works while the freelancer is part way through Edit on it", async () => {
    await createTestDraft(handle.db, USER_A.userId, NOW);
    await handle.db.query(
      "UPDATE public.users SET telegram_editing_reminder_id = $2 WHERE id = $1",
      [USER_A.userId, TEST_REMINDER_ID],
    );
    expect(await removeTestDraft(handle.db)).toBe(true);
    const { rows } = await handle.db.query<{ editing: string | null }>(
      "SELECT telegram_editing_reminder_id::text AS editing FROM public.users WHERE id = $1",
      [USER_A.userId],
    );
    expect(rows[0]?.editing).toBeNull();
  });

  it("says when there was nothing to remove", async () => {
    expect(await removeTestDraft(handle.db)).toBe(false);
  });
});

describe("how far the card got", () => {
  const row = { approvalStatus: "waiting", editing: false };

  it("not collected until n8n has taken it", () => {
    expect(deliveryStage({ ...row, cardSentAt: null, messageId: null })).toBe("not_collected");
  });

  it("handed over once n8n has it, though Telegram hasn't confirmed", () => {
    expect(deliveryStage({ ...row, cardSentAt: NOW, messageId: null })).toBe("handed_over");
  });

  it("delivered only when Telegram confirmed a message", () => {
    expect(deliveryStage({ ...row, cardSentAt: NOW, messageId: "42" })).toBe("delivered");
  });
});
