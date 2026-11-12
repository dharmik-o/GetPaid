import { randomBytes } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveAiSettings } from "@/lib/ai-settings";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser, type Db } from "@/lib/db";
import { schedulerHandler } from "@/lib/scheduler-handler";
import { runAsService } from "@/lib/service-db";
import { storedDraftSchema } from "@/lib/stored-draft";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import { TEST_LAWS } from "../fixtures/statutes";

// The scheduler: real migrations and RLS (PGlite), the model mocked by msw, so with no answer the
// fixed template writes the draft. It plans and drafts; it never sends.

let handle: TestDatabase;
const server = setupServer();
const box = createSecretBox(randomBytes(32));
const TOKEN = "t".repeat(64);
const LOCAL_URL = "http://127.0.0.1:11434/v1/chat/completions";
const PAY_LINK = "https://www.sandbox.paypal.com/invoice/p/#INV2-SCHD-TEST-0001";
/** A Tuesday, 15:00 in New York. The seeded invoice is due 8 Dec 2026, so it's 14 days overdue. */
const NOW = new Date("2026-12-22T20:00:00Z");
let clock = NOW;
let modelCalls = 0;

const { invoices: INVOICE, reminders: SEEDED } = USER_A.rows;

const deps = () => ({
  runAsService: <T>(work: (db: Db) => Promise<T>) => runAsService(handle.db, work),
  runAsUser:
    (userId: string) =>
    <T>(work: (db: Db) => Promise<T>) =>
      runAsUser(handle.db, userId, work),
  box: () => box,
  now: () => clock,
  laws: TEST_LAWS,
  token: () => TOKEN,
  paypal: () => {
    throw new Error("These tests have no retainer to invoice.");
  },
});

const run = async () => {
  const response = await schedulerHandler(deps()).post(
    new Request("http://127.0.0.1:3000/api/internal/scheduler/run", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: "{}",
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { planned: number; drafted: number };
};

type Row = {
  id: string;
  tier: string;
  approval_status: string;
  approved_via: string | null;
  scheduled_at: Date;
  sent_at: Date | null;
  draft: unknown;
};

const reminders = async (invoiceId = INVOICE) => {
  const { rows } = await handle.db.query<Row>(
    `SELECT id::text, tier, approval_status, approved_via, scheduled_at, sent_at, draft
     FROM public.reminders WHERE invoice_id = $1 ORDER BY created_at`,
    [invoiceId],
  );
  return rows;
};

const setInvoice = (sql: string, params: unknown[] = []) =>
  handle.db.query(`UPDATE public.invoices SET ${sql} WHERE id = '${INVOICE}'`, params);

const setSettings = (settings: object) =>
  handle.db.query(`UPDATE public.users SET default_settings = $1 WHERE id = $2`, [
    JSON.stringify(settings),
    USER_A.userId,
  ]);

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  await runAsUser(handle.db, USER_A.userId, (db) =>
    saveAiSettings(
      db,
      {
        main: { provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.2" },
        cloudFallback: null,
        taskModels: {},
      },
      box,
    ),
  );
  server.listen({ onUnhandledFrame: "error" });
}, 60_000);

afterEach(() => {
  server.resetHandlers();
});

afterAll(async () => {
  server.close();
  await handle.close();
});

beforeEach(async () => {
  clock = NOW;
  modelCalls = 0;
  server.use(
    http.post(LOCAL_URL, () => {
      modelCalls += 1;
      return HttpResponse.error();
    }),
  );
  await handle.db.query("DELETE FROM public.reminders WHERE id <> $1", [SEEDED]);
  await handle.db.query(`UPDATE public.reminders SET approval_status = 'skipped'
    WHERE id = '${USER_B.rows.reminders}'`);
  await handle.db.query("DELETE FROM public.reminders WHERE id = $1", [SEEDED]);
  await handle.db.query(
    `UPDATE public.invoices SET status = 'draft', link = NULL, amount_paid_cents = 0`,
  );
  await handle.db.query(`UPDATE public.users SET default_settings = '{}'`);
  await handle.db.query(`UPDATE public.retainers SET status = 'cancelled'`);
  await setInvoice("status = 'sent', link = $1, due_date = '2026-12-08'", [PAY_LINK]);
});

describe("planning", () => {
  it("plans nothing for an archived project, and plans again once it is restored", async () => {
    await handle.db.query("UPDATE public.projects SET archived_at = now() WHERE id = $1", [
      USER_A.rows.projects,
    ]);
    expect((await run()).planned).toBe(0);
    await handle.db.query("UPDATE public.projects SET archived_at = NULL WHERE id = $1", [
      USER_A.rows.projects,
    ]);
    expect((await run()).planned).toBeGreaterThan(0);
  });

  it("plans and drafts the tier the invoice has reached, and leaves it waiting", async () => {
    expect(await run()).toMatchObject({ planned: 1, drafted: 1 });
    const [reminder] = await reminders();
    expect(reminder).toMatchObject({ tier: "tier2", approval_status: "waiting", sent_at: null });
    const draft = storedDraftSchema.parse(reminder?.draft);
    expect(draft.body).toContain(PAY_LINK);
    expect(draft.kind).toBe("tier2");
  });

  it("the send time is inside the client's window", async () => {
    await run();
    expect((await reminders())[0]?.scheduled_at.toISOString()).toBe(NOW.toISOString());
  });

  it("never approves or sends a draft by default", async () => {
    await run();
    await run();
    expect(await reminders()).toEqual([
      expect.objectContaining({ approval_status: "waiting", approved_via: null, sent_at: null }),
    ]);
  });

  it("repeating the run changes nothing: one open reminder per invoice", async () => {
    await run();
    expect(await run()).toMatchObject({ planned: 0, drafted: 0 });
    expect(await reminders()).toHaveLength(1);
  });

  it("the database refuses a second open reminder even if two runs overlap", async () => {
    await run();
    await expect(
      handle.db.query(
        `INSERT INTO public.reminders (user_id, invoice_id, tier, scheduled_at)
         VALUES ($1, $2, 'tier2', now())`,
        [USER_A.userId, INVOICE],
      ),
    ).rejects.toThrow();
  });

  it.each(["draft", "paid", "cancelled", "refunded", "disputed"])(
    "plans nothing for an invoice that's %s",
    async (status) => {
      await setInvoice("status = $1", [status]);
      expect(await run()).toMatchObject({ planned: 0, drafted: 0 });
    },
  );

  it("plans for a partly paid invoice", async () => {
    await setInvoice("status = 'partially_paid', amount_paid_cents = 1000");
    expect((await run()).planned).toBe(1);
  });

  it("waits while the next reminder is more than a day away", async () => {
    await setInvoice("due_date = '2027-02-01'");
    expect(await run()).toMatchObject({ planned: 0, drafted: 0 });
  });

  it("plans a courtesy note a day ahead, for its own send time", async () => {
    // Due Friday 25 Dec; the courtesy is 2 days before, Wednesday 23 Dec at 09:00 New York.
    await setInvoice("due_date = '2026-12-25'");
    expect((await run()).planned).toBe(1);
    const [reminder] = await reminders();
    expect(reminder?.tier).toBe("courtesy");
    expect(reminder?.scheduled_at.toISOString()).toBe("2026-12-23T14:00:00.000Z");
  });
});

describe("after a reminder", () => {
  const addPast = (sql: string) =>
    handle.db.query(
      `INSERT INTO public.reminders (user_id, invoice_id, tier, scheduled_at, draft, ${sql.split("=")[0]?.trim() ?? ""}, approval_status, approved_via)
       VALUES ($1, $2, 'tier2', '2026-12-21T15:00:00Z', '{}', ${sql.split("=")[1]?.trim() ?? ""}, 'approved', 'outbox')`,
      [USER_A.userId, INVOICE],
    );

  it("waits for the interval after a send, then plans the next", async () => {
    await addPast("sent_at = '2026-12-21T15:00:00Z'");
    // Wednesday 23 Dec: the next is 18 hours away, inside the day ahead.
    clock = new Date("2026-12-23T20:00:00Z");
    expect((await run()).planned).toBe(1);
    const planned = (await reminders()).at(-1);
    // Three days after Monday 21 Dec, at the window's opening in New York.
    expect(planned?.scheduled_at.toISOString()).toBe("2026-12-24T14:00:00.000Z");
  });

  it("plans nothing while the next is over a day past the interval", async () => {
    await addPast("sent_at = '2026-12-22T15:00:00Z'");
    expect((await run()).planned).toBe(0);
  });

  it("a skipped reminder counts, so it isn't drafted again straight away", async () => {
    await handle.db.query(
      `INSERT INTO public.reminders (user_id, invoice_id, tier, scheduled_at, approval_status)
       VALUES ($1, $2, 'tier2', '2026-12-22T15:00:00Z', 'skipped')`,
      [USER_A.userId, INVOICE],
    );
    expect((await run()).planned).toBe(0);
  });
});

describe("stops", () => {
  it("a pause plans nothing", async () => {
    await setSettings({ paused: true });
    expect(await run()).toMatchObject({ planned: 0, drafted: 0 });
  });

  it("a snooze plans nothing until it's nearly over", async () => {
    await setSettings({ snoozeUntil: "2027-01-15" });
    expect(await run()).toMatchObject({ planned: 0, drafted: 0 });
  });
});

describe("auto-send Tier 1", () => {
  it("approves a Tier 1 draft only when the freelancer chose it", async () => {
    await setInvoice("due_date = '2026-12-20'");
    await setSettings({ approvalMode: "auto_send_tier1" });
    await run();
    const [reminder] = await reminders();
    expect(reminder).toMatchObject({
      tier: "tier1",
      approval_status: "approved",
      approved_via: null,
    });
    const { rows } = await handle.db.query<{ payload: { via: string } }>(
      "SELECT payload FROM public.events WHERE type = 'reminder.approved' AND entity_id = $1",
      [reminder?.id],
    );
    expect(rows[0]?.payload.via).toBe("auto_send_tier1");
  });

  it("stays waiting for Tier 1 under the default", async () => {
    await setInvoice("due_date = '2026-12-20'");
    await run();
    expect((await reminders())[0]).toMatchObject({ tier: "tier1", approval_status: "waiting" });
  });

  it.each([
    ["Tier 2", "2026-12-08", "tier2"],
    ["Tier 3", "2026-11-20", "tier3"],
  ])("%s always needs a person, even with auto-send on", async (_name, dueDate, tier) => {
    await setInvoice("due_date = $1", [dueDate]);
    await setSettings({ approvalMode: "auto_send_tier1" });
    await run();
    expect((await reminders())[0]).toMatchObject({ tier, approval_status: "waiting" });
  });
});

describe("drafting", () => {
  it("drafts a planned reminder that had no draft yet, on a later run", async () => {
    await handle.db.query(
      `INSERT INTO public.reminders (user_id, invoice_id, tier, scheduled_at)
       VALUES ($1, $2, 'tier2', '2026-12-22T20:00:00Z')`,
      [USER_A.userId, INVOICE],
    );
    expect(await run()).toMatchObject({ planned: 0, drafted: 1 });
    expect((await reminders())[0]?.draft).not.toBeNull();
  });

  it("tries the model first", async () => {
    await run();
    expect(modelCalls).toBeGreaterThan(0);
  });

  it("each draft belongs to the invoice's owner", async () => {
    await handle.db.query(
      `UPDATE public.invoices SET status = 'sent', link = $1, due_date = '2026-12-08' WHERE id = $2`,
      [PAY_LINK, USER_B.rows.invoices],
    );
    await handle.db.query("DELETE FROM public.ai_providers WHERE user_id = $1", [USER_B.userId]);
    await run();
    const { rows } = await handle.db.query<{ user_id: string; invoice_id: string }>(
      `SELECT user_id::text, invoice_id::text FROM public.reminders
       WHERE invoice_id = ANY($1::uuid[]) AND approval_status = 'waiting' ORDER BY user_id`,
      [[INVOICE, USER_B.rows.invoices]],
    );
    expect(rows).toEqual([
      { user_id: USER_A.userId, invoice_id: INVOICE },
      { user_id: USER_B.userId, invoice_id: USER_B.rows.invoices },
    ]);
  });
});

describe("who may call", () => {
  it("refuses without the token", async () => {
    const response = await schedulerHandler({ ...deps(), token: () => "other" }).post(
      new Request("http://127.0.0.1:3000/api/internal/scheduler/run", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(response.status).toBe(401);
    expect(await reminders()).toEqual([]);
  });
});
