import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser, type Db } from "@/lib/db";
import { loadClientTimeline } from "@/lib/timeline";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// The evidence timeline: real migrations and row-level security (PGlite).

let handle: TestDatabase;

const A = USER_A.rows;
const B = USER_B.rows;

const asA = <T>(work: (db: Db) => Promise<T>) => runAsUser(handle.db, USER_A.userId, work);
const timeline = (clientId = A.clients) => asA((db) => loadClientTimeline(db, clientId));

const event = (
  entity: string,
  entityId: string,
  type: string,
  at: string,
  payload: object = {},
  userId = USER_A.userId,
) =>
  handle.db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, entity, entityId, type, JSON.stringify(payload), at],
  );

const reply = (body: string, at: string, classification: object | null) =>
  handle.db.query(
    `INSERT INTO public.messages (user_id, invoice_id, direction, body, ai_classification, created_at)
     VALUES ($1, $2, 'in', $3, $4, $5)`,
    [USER_A.userId, A.invoices, body, classification && JSON.stringify(classification), at],
  );

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
}, 60_000);

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.query("DELETE FROM public.messages WHERE direction = 'in'");
  await handle.db.query("DELETE FROM public.events");
});

describe("the client timeline", () => {
  it("shows sends, replies, payments and status changes, newest first", async () => {
    await handle.db.query(`UPDATE public.reminders SET tier = 'tier2', draft = $2 WHERE id = $1`, [
      A.reminders,
      JSON.stringify({ subject: "Invoice overdue", body: "Please pay soon." }),
    ]);
    await event("invoice", A.invoices, "invoice.sent", "2026-12-01T10:00:00Z");
    await event("reminder", A.reminders, "reminder.approved", "2026-12-03T10:00:00Z", {
      via: "telegram",
    });
    await event("reminder", A.reminders, "reminder.sent", "2026-12-03T11:00:00Z", {
      tier: "tier2",
    });
    await reply("Can I pay half now?", "2026-12-04T10:00:00Z", {
      label: "installments",
      confidence: 0.9,
    });
    await event("invoice", A.invoices, "invoice.paid", "2026-12-05T10:00:00Z", {
      amountPaidCents: 90000,
    });

    const entries = await timeline();
    expect(entries.map((entry) => [entry.kind, entry.title])).toEqual([
      ["payment", "USD 900.00 paid"],
      ["reply", "The client replied"],
      ["sent", "Firm reminder sent (Tier 2)"],
      ["status", "Approved on Telegram"],
      ["status", "Invoice sent"],
    ]);
    expect(entries[2]).toMatchObject({ subject: "Invoice overdue", body: "Please pay soon." });
    expect(entries[1]).toMatchObject({
      body: "Can I pay half now?",
      aiLabel: "installments",
    });
    expect(entries[0]?.reference).toMatch(/^FPR-/);
    expect(entries[0]?.stampId).toBe(`invoice:${entries[0]?.reference ?? ""}`);
    expect(entries.slice(1).map((entry) => entry.stampId)).toEqual([null, null, null, null]);
  });

  it("gives a captured hold a stamp, but not a part payment or a refund", async () => {
    await event("hold", A.milestone_holds, "hold.captured", "2026-12-03T10:00:00Z", {
      amountCents: 90000,
    });
    await event("invoice", A.invoices, "invoice.refunded", "2026-12-02T10:00:00Z", {
      amountPaidCents: 0,
    });
    await event("invoice", A.invoices, "invoice.partially_paid", "2026-12-01T10:00:00Z", {
      amountPaidCents: 100,
    });
    expect((await timeline()).map((entry) => entry.stampId)).toEqual([
      `hold:${A.milestone_holds}`,
      null,
      null,
    ]);
  });

  it("never shows an AI label on a reply that has none", async () => {
    await reply("Thanks!", "2026-12-04T10:00:00Z", null);
    const [entry] = await timeline();
    expect(entry).toMatchObject({ kind: "reply", aiLabel: null });
  });

  it("covers holds, retainers and maintenance for this client", async () => {
    await event("hold", A.milestone_holds, "hold.captured", "2026-12-01T10:00:00Z", {
      amountCents: 90000,
    });
    await event("retainer", A.retainers, "retainer.cancelled", "2026-12-02T10:00:00Z");
    await event("maintenance", A.maintenance_tasks, "maintenance.done", "2026-12-03T10:00:00Z");
    expect((await timeline()).map((entry) => entry.title)).toEqual([
      "Maintenance job done",
      "Retainer cancelled",
      "Hold captured: USD 900.00",
    ]);
  });

  it("leaves out what isn't evidence: drafting noise and account events", async () => {
    await event("reminder", A.reminders, "reminder.drafted", "2026-12-01T10:00:00Z");
    await event("invoice", A.invoices, "paypal.webhook", "2026-12-01T10:00:00Z");
    await event("invoice", A.invoices, "reply.received", "2026-12-01T10:00:00Z");
    await event("user", USER_A.userId, "gmail.connected", "2026-12-01T10:00:00Z");
    await event("invoice", A.invoices, "invoice.something_new", "2026-12-01T10:00:00Z");
    expect(await timeline()).toEqual([]);
  });

  it("shows nothing from another freelancer, even with their client's id", async () => {
    await event("invoice", B.invoices, "invoice.paid", "2026-12-01T10:00:00Z", {}, USER_B.userId);
    expect(await timeline(B.clients)).toEqual([]);
    expect(await timeline(A.clients)).toEqual([]);
  });

  it("keeps a client's entries off another client of the same freelancer", async () => {
    await handle.db.query(
      `INSERT INTO public.clients (id, user_id, name, email, country, time_zone)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000099', $1, 'Other', 'other@example.test', 'US', 'UTC')
       ON CONFLICT DO NOTHING`,
      [USER_A.userId],
    );
    await event("invoice", A.invoices, "invoice.sent", "2026-12-01T10:00:00Z");
    expect(await timeline("aaaaaaaa-0000-4000-8000-000000000099")).toEqual([]);
  });

  it("says what a dispute, a split and a pause were", async () => {
    await event("invoice", A.invoices, "invoice.disputed", "2026-12-01T10:00:00Z");
    await event("invoice", A.invoices, "invoice.split", "2026-12-02T10:00:00Z", { count: 2 });
    await event("invoice", A.invoices, "reminders.paused", "2026-12-03T10:00:00Z", {
      until: "2026-12-15",
    });
    expect((await timeline()).map((entry) => entry.title)).toEqual([
      "Reminders paused until 15 Dec",
      "Split into 2 installments",
      "The client opened a dispute",
    ]);
  });
});
