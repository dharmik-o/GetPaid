import { randomBytes } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveAiSettings } from "@/lib/ai-settings";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser } from "@/lib/db";
import { draftsHandler } from "@/lib/drafter-handler";
import { formatMoney } from "@/lib/format";
import { storedDraftSchema } from "@/lib/stored-draft";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";

// The n8n-facing drafter: real migrations and RLS (PGlite), the model mocked by msw.

let handle: TestDatabase;
const server = setupServer();
const box = createSecretBox(randomBytes(32));
const TOKEN = "d".repeat(64);
const LOCAL_URL = "http://127.0.0.1:11434/v1/chat/completions";
const PAY_LINK = "https://www.sandbox.paypal.com/invoice/p/#INV2-DRFT-TEST-0001";
/** The seeded invoice is due 8 Dec 2026; the client is in New York. */
const NOW = new Date("2026-12-22T15:00:00Z");

/** formatMoney puts a no-break space after the code. */
const usd = (cents: number) => formatMoney(cents, "USD");

const { reminders: REMINDER, invoices: INVOICE } = USER_A.rows;

const handler = (token: string | null = TOKEN) =>
  draftsHandler({
    runAsUser: (userId) => (work) => runAsUser(handle.db, userId, work),
    box: () => box,
    now: () => NOW,
    token: () => token ?? undefined,
  });

const call = (
  payload: unknown = { userId: USER_A.userId, reminderId: REMINDER },
  authorization: string | null = `Bearer ${TOKEN}`,
) =>
  handler().post(
    new Request("http://127.0.0.1:3000/api/internal/drafts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(payload),
    }),
  );

type Seen = { model: string; facts: Record<string, unknown> };

/** The mock model answers each call with the next reply; records the model and the facts. */
const model = (replies: unknown[], seen: Seen[] = []) => {
  server.use(
    http.post(LOCAL_URL, async ({ request }) => {
      const sent = (await request.json()) as {
        model: string;
        messages: { content: string }[];
      };
      const user = sent.messages[1]?.content ?? "";
      seen.push({ model: sent.model, facts: JSON.parse(user.slice(7, -8)) as Seen["facts"] });
      const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
      return HttpResponse.json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
    }),
  );
  return seen;
};

const stored = async () => {
  const { rows } = await handle.db.query<{ draft: unknown }>(
    "SELECT draft FROM public.reminders WHERE id = $1",
    [REMINDER],
  );
  return rows[0]?.draft ? storedDraftSchema.parse(rows[0].draft) : null;
};

const setReminder = (sql: string) =>
  handle.db.query(`UPDATE public.reminders SET ${sql} WHERE id = '${REMINDER}'`);
const setInvoice = (sql: string) =>
  handle.db.query(`UPDATE public.invoices SET ${sql} WHERE id = '${INVOICE}'`);

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
        taskModels: { tier3: "llama3.3:70b" },
      },
      box,
    ),
  );
  server.listen({ onUnhandledFrame: "error" });
}, 60_000);

beforeEach(async () => {
  await setInvoice(`status = 'sent', link = '${PAY_LINK}', amount_paid_cents = 0`);
  await setReminder(
    "draft = NULL, approval_status = 'waiting', approved_via = NULL, tier = 'tier2'",
  );
  await handle.db.query("DELETE FROM public.events WHERE type = 'reminder.drafted'");
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(async () => {
  server.close();
  await handle.close();
});

const GOOD = {
  subject: "Overdue: invoice for Website redesign",
  body: `Hi Client a,\n\nUSD 900.00 is now 14 days overdue.\n\n${PAY_LINK}\n\nFreelancer a`,
};

describe("POST /api/internal/drafts", () => {
  it("refuses a missing or wrong token, and answers 503 until the token is set", async () => {
    expect((await call(undefined, null)).status).toBe(401);
    expect((await call(undefined, "Bearer wrong")).status).toBe(401);
    const unset = await handler(null).post(
      new Request("http://127.0.0.1:3000/api/internal/drafts", { method: "POST" }),
    );
    expect(unset.status).toBe(503);
    expect(await stored()).toBeNull();
  });

  it("refuses a body that isn't a user and reminder id", async () => {
    expect((await call({ userId: USER_A.userId, reminderId: "x" })).status).toBe(400);
    expect(
      (await call({ userId: USER_A.userId, reminderId: REMINDER, tier: "tier1" })).status,
    ).toBe(400);
  });

  it("drafts from the database facts and saves the model's draft", async () => {
    const seen = model([GOOD]);
    const response = await call();
    expect(response.status).toBe(201);
    expect(seen[0]?.model).toBe("llama3.2");
    expect(seen[0]?.facts).toMatchObject({
      freelancerName: "Freelancer a",
      clientName: "Client a",
      projectTitle: "Website redesign",
      milestoneName: "Design",
      amountDue: usd(90000),
      dueDate: "8 Dec 2026",
      daysOverdue: 14,
      paymentTerms: "Net 14",
      payLink: PAY_LINK,
    });
    expect(seen[0]?.facts).not.toHaveProperty("citation");
    expect(await stored()).toMatchObject({
      ...GOOD,
      kind: "tier2",
      via: "model",
      model: "llama3.2",
      isLocal: true,
      citation: null,
      notLegalAdvice: false,
    });
    const { rows } = await handle.db.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM public.events WHERE type = 'reminder.drafted'",
    );
    expect(rows).toEqual([
      { payload: { tier: "tier2", via: "model", model: "llama3.2", citation: null } },
    ]);
  });

  it("counts days overdue in the client's time zone", async () => {
    // 04:30 UTC on 22 Dec is still 21 Dec in New York: 13 days after 8 Dec.
    const seen = model([GOOD]);
    const early = draftsHandler({
      runAsUser: (userId) => (work) => runAsUser(handle.db, userId, work),
      box: () => box,
      now: () => new Date("2026-12-22T04:30:00Z"),
      token: () => TOKEN,
    });
    await early.post(
      new Request("http://127.0.0.1:3000/api/internal/drafts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ userId: USER_A.userId, reminderId: REMINDER }),
      }),
    );
    expect(seen[0]?.facts.daysOverdue).toBe(13);
  });

  it("uses the fixed template when the model is down", async () => {
    server.use(http.post(LOCAL_URL, () => new HttpResponse(null, { status: 500 })));
    expect((await call()).status).toBe(201);
    const draft = await stored();
    expect(draft).toMatchObject({ via: "template", model: null, isLocal: null });
    expect(draft?.body).toContain(PAY_LINK);
    expect(draft?.body).toContain(usd(90000));
  });

  it("never saves a draft that invents an amount: one retry, then the template", async () => {
    const invented = { ...GOOD, body: `${GOOD.body}\nPlus a USD 75.00 late fee.` };
    const seen = model([invented]);
    await call();
    expect(seen).toHaveLength(2);
    const draft = await stored();
    expect(draft?.via).toBe("template");
    expect(draft?.body).not.toContain("75.00");
  });

  it("is safe to re-run: a second call keeps the first draft and calls no model", async () => {
    const seen = model([GOOD]);
    await call();
    const second = await call();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "exists" });
    expect(seen).toHaveLength(1);
  });

  it("leaves an approved or skipped reminder alone", async () => {
    await setReminder("approval_status = 'skipped'");
    expect((await call()).status).toBe(409);
    expect(await stored()).toBeNull();
  });

  it.each([
    ["paid", "status = 'paid', amount_paid_cents = 90000"],
    ["cancelled", "status = 'cancelled'"],
    ["not sent yet", "status = 'draft', link = NULL"],
  ])("writes no draft when the invoice is %s", async (_label, sql) => {
    const seen = model([GOOD]);
    await setInvoice(sql);
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "not_payable" });
    expect(seen).toHaveLength(0);
  });

  it("asks only for what's left on a partly paid invoice", async () => {
    const seen = model([{ ...GOOD, body: `USD 400.00 left.\n${PAY_LINK}` }]);
    await setInvoice("status = 'partially_paid', amount_paid_cents = 50000");
    await call();
    expect(seen[0]?.facts.amountDue).toBe(usd(40000));
  });

  it("can't draft another user's reminder (RLS)", async () => {
    const response = await call({ userId: USER_B.userId, reminderId: REMINDER });
    expect(response.status).toBe(404);
    expect(await stored()).toBeNull();
  });

  it("Tier 3 uses the Tier 3 model and carries the not-legal-advice note", async () => {
    await setReminder("tier = 'tier3'");
    const seen = model([{ subject: "Final notice: invoice", body: `USD 900.00.\n${PAY_LINK}` }]);
    await call();
    expect(seen[0]?.model).toBe("llama3.3:70b");
    expect(await stored()).toMatchObject({ kind: "tier3", notLegalAdvice: true });
  });
});
