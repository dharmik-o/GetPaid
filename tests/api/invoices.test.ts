import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser, type UserDbRunner } from "@/lib/db";
import { installmentHandlers } from "@/lib/installment-handlers";
import { invoiceHandlers } from "@/lib/invoice-handlers";
import { createPaypalClient, PAYPAL_SANDBOX_BASE } from "@/lib/paypal";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import { createFakePaypal, type FakePaypal } from "../mocks/paypal";

// The invoice flow end to end: real migrations and RLS (PGlite), PayPal mocked by msw.
// One PayPal invoice per milestone or per installment; never PayPal partial payments.

let handle: TestDatabase;
let fake: FakePaypal;
const server = setupServer();

/** 15:00 UTC is 10:00 in New York (the client's zone): still 3 Nov there. */
const NOW = new Date("2026-11-03T15:00:00Z");

const PROJECT = "aaaaaaaa-0000-4000-8000-0000000000a1";
const DEPOSIT = "aaaaaaaa-0000-4000-8000-0000000000b1";
const BUILD = "aaaaaaaa-0000-4000-8000-0000000000b2";
const LAUNCH = "aaaaaaaa-0000-4000-8000-0000000000b3";
const HOLD = "aaaaaaaa-0000-4000-8000-0000000000b4";

const CREDENTIALS = { clientId: "id", clientSecret: "secret" };

const runnerFor =
  (userId: string): UserDbRunner =>
  (work) =>
    runAsUser(handle.db, userId, work);

const handlersFor = (userId: string, paypal = () => createPaypalClient(CREDENTIALS)) =>
  invoiceHandlers({ runAsUser: runnerFor(userId), paypal, now: () => NOW });

const planHandlers = (userId = USER_A.userId) =>
  installmentHandlers({ runAsUser: runnerFor(userId), now: () => NOW });

const request = (method: string, body: unknown = {}) =>
  new Request("http://127.0.0.1:3000/api/x", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const post = (body: unknown = {}) => request("POST", body);

const idContext = (id: string) => ({ params: Promise.resolve({ id }) });

type Invoice = {
  id: string;
  milestoneId: string;
  invoiceNumber: string;
  status: string;
  amountCents: number;
  amountPaidCents: number;
  currency: string;
  dueDate: string;
  link: string | null;
  installment: { number: number; count: number } | null;
};
type Issue = { field: string; message: string };
type PaypalBody = {
  detail: { invoice_number: string; payment_term: unknown; note?: string };
  items: { description: string; unit_amount: { value: string } }[];
  configuration: unknown;
};

const issue = async (milestoneId: string, body: unknown = {}, userId = USER_A.userId) =>
  handlersFor(userId).issue(post(body), idContext(milestoneId));

const cancel = async (invoiceId: string) =>
  handlersFor(USER_A.userId).cancel(post({ reason: "mistake" }), idContext(invoiceId));

const savePlan = async (milestoneId: string, items: unknown, userId = USER_A.userId) =>
  planHandlers(userId).save(request("PUT", { items }), idContext(milestoneId));

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const invoicesOf = async (response: Response): Promise<Invoice[]> =>
  (await json<{ invoices: Invoice[] }>(response)).invoices;

const invoiceOf = async (response: Response): Promise<Invoice> => {
  const [first] = await invoicesOf(response);
  if (!first) throw new Error("no invoice in the response");
  return first;
};

const errorsOf = async (response: Response): Promise<Issue[]> => {
  expect(response.status).toBe(400);
  return (await json<{ errors: Issue[] }>(response)).errors;
};

const one = async <T extends object>(sql: string, params: unknown[]): Promise<T> => {
  const { rows } = await handle.db.query<T>(sql, params);
  const row = rows[0];
  if (!row) throw new Error(`No row for ${sql}`);
  return row;
};

const milestoneStatus = async (id: string): Promise<string> =>
  (await one<{ status: string }>("SELECT status FROM public.milestones WHERE id = $1", [id]))
    .status;

const paypalIdOf = async (invoiceId: string): Promise<string> =>
  (
    await one<{ paypal_invoice_id: string }>(
      "SELECT paypal_invoice_id FROM public.invoices WHERE id = $1",
      [invoiceId],
    )
  ).paypal_invoice_id;

const paypalBodyOf = async (invoiceId: string): Promise<PaypalBody> =>
  fake.invoices.get(await paypalIdOf(invoiceId))?.body as PaypalBody;

const planRow = (milestoneId: string) =>
  handle.db.query<{ status: string; created_from: string; count: number }>(
    "SELECT status, created_from, count FROM public.installment_plans WHERE milestone_id = $1",
    [milestoneId],
  );

/** formatMoney puts a no-break space after the currency code. */
const plain = (text: string | undefined): string => (text ?? "").replace(/\u00a0/gu, " ");

const BUILD_SPLIT = [
  { amountCents: 75000, dueDate: "2026-11-03" },
  { amountCents: 75000, dueDate: "2026-11-15" },
];

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  await handle.db.query(seedOwnerSql(USER_B));
  server.listen({ onUnhandledFrame: "error" });
}, 60_000);

beforeEach(async () => {
  fake = createFakePaypal();
  server.resetHandlers(...fake.handlers);
  await handle.db.query(`DELETE FROM public.projects WHERE id = '${PROJECT}'`);
  await handle.db.query(`
    INSERT INTO public.projects (id, user_id, client_id, title, total_cents, currency, deadline)
      VALUES ('${PROJECT}', '${USER_A.userId}', '${USER_A.rows.clients}', 'Website redesign', 300000, 'USD', '2026-12-31');
    INSERT INTO public.milestones (id, user_id, project_id, currency, position, name, percent_bp, deadline, payment_mode, status)
      VALUES
        ('${DEPOSIT}', '${USER_A.userId}', '${PROJECT}', 'USD', 1, 'Design', 3000, '2026-11-20', 'deposit', 'planned'),
        ('${BUILD}', '${USER_A.userId}', '${PROJECT}', 'USD', 2, 'Build', 5000, '2026-12-10', 'pay_on_invoice', 'delivered'),
        ('${LAUNCH}', '${USER_A.userId}', '${PROJECT}', 'USD', 3, 'Launch', 1000, '2026-12-20', 'pay_on_invoice', 'in_progress'),
        ('${HOLD}', '${USER_A.userId}', '${PROJECT}', 'USD', 4, 'Extras', 1000, '2026-12-31', 'hold', 'planned');
  `);
});

afterEach(() => {
  // Installments replace PayPal partial payments: no request may ever ask for them.
  for (const call of fake.calls) {
    expect(call.body).not.toMatch(/partial_payment|allow_partial_payment|minimum_amount_due/);
  }
  server.resetHandlers();
});

afterAll(async () => {
  server.close();
  await handle.close();
});

describe("POST /api/milestones/[id]/invoice: plain invoices", () => {
  it("creates and sends one invoice for a pay-on-invoice milestone", async () => {
    const response = await issue(BUILD);
    expect(response.status).toBe(201);
    const invoice = await invoiceOf(response);
    expect(invoice).toMatchObject({
      milestoneId: BUILD,
      status: "sent",
      amountCents: 150000,
      amountPaidCents: 0,
      currency: "USD",
      // Net 14 (the default) from 3 Nov in the client's zone.
      dueDate: "2026-11-17",
      installment: null,
    });
    expect(invoice.invoiceNumber).toMatch(/^FPR-\d{6}$/);
    const paypalId = await paypalIdOf(invoice.id);
    expect(invoice.link).toBe(`https://www.sandbox.paypal.com/invoice/p/#${paypalId}`);
    expect(fake.invoices.get(paypalId)?.status).toBe("UNPAID");
    const body = await paypalBodyOf(invoice.id);
    expect(body.detail.invoice_number).toBe(invoice.invoiceNumber);
    expect(body.detail.payment_term).toEqual({ due_date: "2026-11-17" });
    expect(body.detail.note).toBeUndefined();
    expect(body.configuration).toEqual({ allow_tip: false });
    expect(await milestoneStatus(BUILD)).toBe("invoiced");
    const event = await one<{ type: string }>(
      "SELECT type FROM public.events WHERE entity_id = $1",
      [invoice.id],
    );
    expect(event.type).toBe("invoice.sent");
  });

  it("sends the invoice's own PayPal-Request-Id on create", async () => {
    const invoice = await invoiceOf(await issue(BUILD));
    const { paypal_request_id: requestId } = await one<{ paypal_request_id: string }>(
      "SELECT paypal_request_id::text FROM public.invoices WHERE id = $1",
      [invoice.id],
    );
    const create = fake.calls.find((c) => c.path === "/v2/invoicing/invoices");
    expect(create?.requestId).toBe(requestId);
  });

  it("gives back the same invoice when asked again: one per milestone", async () => {
    const first = await invoiceOf(await issue(BUILD));
    const again = await issue(BUILD);
    expect(again.status).toBe(200);
    expect((await invoiceOf(again)).id).toBe(first.id);
    expect(fake.invoices.size).toBe(1);
  });

  it("uses the milestone's own payment terms; due on receipt is due today in the client's zone", async () => {
    await handle.db.query(
      `UPDATE public.milestones SET settings = '{"paymentTerms":{"kind":"on_receipt"}}' WHERE id = $1`,
      [BUILD],
    );
    const invoice = await invoiceOf(await issue(BUILD));
    expect(invoice.dueDate).toBe("2026-11-03");
    expect((await paypalBodyOf(invoice.id)).detail.payment_term).toEqual({
      term_type: "DUE_ON_RECEIPT",
    });
  });

  it("refuses a fixed due date that has already passed", async () => {
    await handle.db.query(
      `UPDATE public.projects SET settings = '{"paymentTerms":{"kind":"date","date":"2026-11-02"}}' WHERE id = $1`,
      [PROJECT],
    );
    const errors = await errorsOf(await issue(BUILD));
    expect(errors[0]?.field).toBe("paymentTerms");
    expect(errors[0]?.message).toMatch(/2 Nov.*passed/);
    expect(fake.invoices.size).toBe(0);
  });

  it("refuses a deposit amount or installment on a pay-on-invoice milestone", async () => {
    expect((await errorsOf(await issue(BUILD, { depositCents: 100 })))[0]?.field).toBe(
      "depositCents",
    );
    expect((await errorsOf(await issue(BUILD, { installment: 2 })))[0]?.field).toBe("installment");
  });

  it("invoices pay-on-invoice work only once it's delivered", async () => {
    const errors = await errorsOf(await issue(LAUNCH));
    expect(errors[0]?.message).toMatch(/Mark it Delivered/);
  });

  it("leaves milestone holds to the PayPal authorization flow", async () => {
    const errors = await errorsOf(await issue(HOLD));
    expect(errors[0]?.field).toBe("paymentMode");
  });

  it("rejects unknown fields, including the old minimum amount due", async () => {
    expect((await errorsOf(await issue(BUILD, { amountCents: 1 })))[0]?.field).toBe("amountCents");
    expect((await errorsOf(await issue(DEPOSIT, { minimumDueCents: 1 })))[0]?.field).toBe(
      "minimumDueCents",
    );
  });

  it("answers 404 for another user's milestone or a bad id", async () => {
    expect((await issue(DEPOSIT, { depositCents: 1 }, USER_B.userId)).status).toBe(404);
    expect((await issue("not-a-uuid")).status).toBe(404);
    expect(fake.invoices.size).toBe(0);
  });

  it("explains when PayPal isn't set up", async () => {
    const handlers = handlersFor(USER_A.userId, () => {
      throw new Error("The PayPal sandbox settings are not valid");
    });
    const response = await handlers.issue(post(), idContext(BUILD));
    expect(response.status).toBe(503);
    expect((await json<{ error: string }>(response)).error).toMatch(/PAYPAL_CLIENT_ID/);
  });

  describe("retries never duplicate", () => {
    it("resumes after a failed send, reusing the PayPal draft", async () => {
      server.use(
        http.post(
          `${PAYPAL_SANDBOX_BASE}/v2/invoicing/invoices/:id/send`,
          () => HttpResponse.json({ name: "INTERNAL_SERVER_ERROR" }, { status: 500 }),
          { once: true },
        ),
      );
      const failed = await issue(BUILD);
      expect(failed.status).toBe(502);
      expect((await json<{ error: string }>(failed)).error).toMatch(/Try again/);
      expect(await milestoneStatus(BUILD)).toBe("delivered");

      const retried = await issue(BUILD);
      expect(retried.status).toBe(201);
      expect((await invoiceOf(retried)).status).toBe("sent");
      expect(fake.invoices.size).toBe(1);
    });

    it("finds the invoice PayPal created when its answer was lost", async () => {
      server.use(
        http.post(
          `${PAYPAL_SANDBOX_BASE}/v2/invoicing/invoices`,
          async ({ request: sent }) => {
            fake.store((await sent.json()) as Record<string, unknown>);
            return HttpResponse.json({ name: "INTERNAL_SERVER_ERROR" }, { status: 500 });
          },
          { once: true },
        ),
      );
      expect((await issue(BUILD)).status).toBe(502);
      const retried = await invoiceOf(await issue(BUILD));
      expect(retried.status).toBe("sent");
      expect(fake.invoices.size).toBe(1);
      expect(await paypalIdOf(retried.id)).toBe([...fake.invoices.keys()][0]);
    });
  });
});

describe("deposits: installment 1 at kickoff, the rest on delivery", () => {
  it("a deposit of the whole amount is one plain invoice, with no plan", async () => {
    const invoice = await invoiceOf(await issue(DEPOSIT, { depositCents: 90000 }));
    expect(invoice).toMatchObject({ amountCents: 90000, installment: null, status: "sent" });
    expect((await planRow(DEPOSIT)).rows).toEqual([]);
    expect(await milestoneStatus(DEPOSIT)).toBe("invoiced");
  });

  it("a smaller deposit makes a 2-installment plan and invoices installment 1 now", async () => {
    const response = await issue(DEPOSIT, { depositCents: 30000 });
    expect(response.status).toBe(201);
    const invoices = await invoicesOf(response);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      amountCents: 30000,
      installment: { number: 1, count: 2 },
      dueDate: "2026-11-17",
    });
    expect((await planRow(DEPOSIT)).rows).toEqual([
      { status: "active", created_from: "deposit", count: 2 },
    ]);
    const body = await paypalBodyOf(invoices[0]?.id ?? "");
    expect(body.items[0]?.description).toBe("Installment 1 of 2 for Website redesign: Design");
    expect(body.items[0]?.unit_amount.value).toBe("300.00");
    const note = plain(body.detail.note);
    expect(note).toContain(
      "Milestone total USD 900.00 · Paid so far USD 0.00 · This installment USD 300.00 · Remaining after this USD 600.00",
    );
    expect(note).toContain("Installment 2 of 2: due when the work is delivered");
    expect(await milestoneStatus(DEPOSIT)).toBe("invoiced");
  });

  it("asking again returns installment 1; installment 2 is invoiced on request", async () => {
    const first = await invoiceOf(await issue(DEPOSIT, { depositCents: 30000 }));
    const again = await issue(DEPOSIT, { depositCents: 30000 });
    expect(again.status).toBe(200);
    expect((await invoiceOf(again)).id).toBe(first.id);

    await handle.db.query(
      "UPDATE public.invoices SET status = 'paid', amount_paid_cents = 30000 WHERE id = $1",
      [first.id],
    );
    const rest = await invoiceOf(await issue(DEPOSIT, { installment: 2 }));
    expect(rest).toMatchObject({ amountCents: 60000, installment: { number: 2, count: 2 } });
    const note = plain((await paypalBodyOf(rest.id)).detail.note);
    expect(note).toContain("Paid so far USD 300.00 · This installment USD 600.00");
    expect(note).toContain("Installment 1 of 2: due 17 Nov 2026 (paid)");
    expect(fake.invoices.size).toBe(2);
  });

  it("needs installment 1 before installment 2, and a plan before either", async () => {
    expect((await errorsOf(await issue(DEPOSIT, { installment: 2 })))[0]?.field).toBe(
      "installment",
    );
  });

  it("needs a deposit amount, no more than the milestone amount", async () => {
    expect((await errorsOf(await issue(DEPOSIT)))[0]?.field).toBe("depositCents");
    const tooHigh = await errorsOf(await issue(DEPOSIT, { depositCents: 90001 }));
    expect(plain(tooHigh[0]?.message)).toMatch(/USD 900\.00/);
    expect(fake.invoices.size).toBe(0);
  });
});

describe("installments set up on a pay-on-invoice milestone", () => {
  it("saves a plan and invoices every installment together, each with its own due date", async () => {
    const saved = await savePlan(BUILD, BUILD_SPLIT);
    expect(saved.status).toBe(200);
    const response = await issue(BUILD);
    expect(response.status).toBe(201);
    const invoices = await invoicesOf(response);
    expect(invoices.map((i) => [i.installment, i.amountCents, i.dueDate])).toEqual([
      [{ number: 1, count: 2 }, 75000, "2026-11-03"],
      [{ number: 2, count: 2 }, 75000, "2026-11-15"],
    ]);
    const [first, second] = invoices;
    // Due today is PayPal's due-on-receipt; a later date is sent as the date.
    expect((await paypalBodyOf(first?.id ?? "")).detail.payment_term).toEqual({
      term_type: "DUE_ON_RECEIPT",
    });
    const secondBody = await paypalBodyOf(second?.id ?? "");
    expect(secondBody.detail.payment_term).toEqual({ due_date: "2026-11-15" });
    expect(plain(secondBody.detail.note)).toContain("Installment 1 of 2: due 3 Nov 2026");
    expect(await milestoneStatus(BUILD)).toBe("invoiced");
  });

  it("a retry creates no duplicates", async () => {
    await savePlan(BUILD, BUILD_SPLIT);
    const first = await invoicesOf(await issue(BUILD));
    const again = await issue(BUILD);
    expect(again.status).toBe(200);
    expect((await invoicesOf(again)).map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(fake.invoices.size).toBe(2);
  });

  it("refuses a plan that doesn't add up to the milestone exactly", async () => {
    const errors = await errorsOf(
      await savePlan(BUILD, [
        { amountCents: 75000, dueDate: "2026-11-03" },
        { amountCents: 74999, dueDate: "2026-11-15" },
      ]),
    );
    expect(errors[0]?.field).toBe("items");
  });

  it("refuses more than 12 installments, a past date, or a missing date", async () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => ({
      amountCents: i < 12 ? 11538 : 150000 - 11538 * 12,
      dueDate: "2026-11-20",
    }));
    expect((await errorsOf(await savePlan(BUILD, thirteen)))[0]?.message).toMatch(/2 to 12/);
    const past = await errorsOf(
      await savePlan(BUILD, [
        { amountCents: 75000, dueDate: "2026-11-02" },
        { amountCents: 75000, dueDate: null },
      ]),
    );
    expect(past.map((e) => e.field)).toEqual(["items.0.dueDate", "items.1.dueDate"]);
  });

  it("is only for pay-on-invoice milestones", async () => {
    const errors = await errorsOf(
      await savePlan(DEPOSIT, [
        { amountCents: 45000, dueDate: "2026-11-10" },
        { amountCents: 45000, dueDate: "2026-11-20" },
      ]),
    );
    expect(errors[0]?.field).toBe("paymentMode");
  });

  it("can be changed or removed until it's invoiced, then not", async () => {
    await savePlan(BUILD, BUILD_SPLIT);
    const changed = await savePlan(BUILD, [
      { amountCents: 50000, dueDate: "2026-11-10" },
      { amountCents: 50000, dueDate: "2026-11-20" },
      { amountCents: 50000, dueDate: "2026-11-30" },
    ]);
    expect(changed.status).toBe(200);
    expect((await planRow(BUILD)).rows).toEqual([
      { status: "active", created_from: "setup", count: 3 },
    ]);
    const removed = await planHandlers().remove(request("DELETE"), idContext(BUILD));
    expect(removed.status).toBe(200);
    expect((await planRow(BUILD)).rows).toEqual([]);

    await savePlan(BUILD, BUILD_SPLIT);
    await issue(BUILD);
    expect((await savePlan(BUILD, BUILD_SPLIT)).status).toBe(409);
    expect((await planHandlers().remove(request("DELETE"), idContext(BUILD))).status).toBe(409);
  });

  it("refuses to invoice an installment whose date has passed since the plan was saved", async () => {
    await savePlan(BUILD, BUILD_SPLIT);
    const later = invoiceHandlers({
      runAsUser: runnerFor(USER_A.userId),
      paypal: () => createPaypalClient(CREDENTIALS),
      now: () => new Date("2026-11-05T15:00:00Z"),
    });
    const errors = await errorsOf(await later.issue(post(), idContext(BUILD)));
    expect(errors[0]?.field).toBe("items.0.dueDate");
    expect(fake.invoices.size).toBe(0);
  });

  it("refuses a plan that no longer matches a changed milestone amount", async () => {
    await savePlan(BUILD, BUILD_SPLIT);
    await handle.db.query("UPDATE public.milestones SET percent_bp = 4000 WHERE id = $1", [BUILD]);
    await handle.db.query("UPDATE public.milestones SET percent_bp = 2000 WHERE id = $1", [LAUNCH]);
    const errors = await errorsOf(await issue(BUILD));
    expect(errors[0]?.field).toBe("items");
    expect(plain(errors[0]?.message)).toMatch(/USD 1,200\.00/);
  });

  it("answers 404 for another user's milestone", async () => {
    expect((await savePlan(BUILD, BUILD_SPLIT, USER_B.userId)).status).toBe(404);
  });
});

describe("POST /api/invoices/[id]/cancel", () => {
  it("cancels in PayPal, restores the milestone, skips waiting reminders and logs it", async () => {
    const invoice = await invoiceOf(await issue(DEPOSIT, { depositCents: 90000 }));
    await handle.db.query(
      `INSERT INTO public.reminders (user_id, invoice_id, tier, scheduled_at)
       VALUES ($1, $2, 'courtesy', '2026-11-15T14:00:00Z')`,
      [USER_A.userId, invoice.id],
    );
    const response = await cancel(invoice.id);
    expect(response.status).toBe(200);
    expect((await invoiceOf(response)).status).toBe("cancelled");
    expect(fake.invoices.get(await paypalIdOf(invoice.id))?.status).toBe("CANCELLED");
    expect(await milestoneStatus(DEPOSIT)).toBe("planned");
    const reminder = await one<{ approval_status: string }>(
      "SELECT approval_status FROM public.reminders WHERE invoice_id = $1",
      [invoice.id],
    );
    expect(reminder.approval_status).toBe("skipped");
    const { types } = await one<{ types: string[] }>(
      "SELECT array_agg(type ORDER BY created_at, type) AS types FROM public.events WHERE entity_id = $1",
      [invoice.id],
    );
    expect(types).toContain("invoice.cancelled");
  });

  it("lets the milestone be invoiced again, with a new number", async () => {
    const first = await invoiceOf(await issue(BUILD));
    await cancel(first.id);
    const second = await invoiceOf(await issue(BUILD));
    expect(second.id).not.toBe(first.id);
    expect(second.invoiceNumber).not.toBe(first.invoiceNumber);
    expect(second.status).toBe("sent");
  });

  it("deletes a PayPal draft that was never sent", async () => {
    server.use(
      http.post(
        `${PAYPAL_SANDBOX_BASE}/v2/invoicing/invoices/:id/send`,
        () => HttpResponse.json({ name: "INTERNAL_SERVER_ERROR" }, { status: 500 }),
        { once: true },
      ),
    );
    await issue(BUILD);
    const { id } = await one<{ id: string }>(
      "SELECT id::text FROM public.invoices WHERE milestone_id = $1",
      [BUILD],
    );
    expect((await cancel(id)).status).toBe(200);
    expect(fake.invoices.size).toBe(0);
    expect(await milestoneStatus(BUILD)).toBe("delivered");
  });

  it("refuses once the client has paid, and changes nothing", async () => {
    const invoice = await invoiceOf(await issue(BUILD));
    const paypalId = await paypalIdOf(invoice.id);
    fake.pay(paypalId, "1500.00", "PAID");
    const response = await cancel(invoice.id);
    expect(response.status).toBe(409);
    expect((await json<{ error: string }>(response)).error).toMatch(/paid/);
    expect(fake.invoices.get(paypalId)?.status).toBe("PAID");
    expect(await milestoneStatus(BUILD)).toBe("invoiced");
  });

  it("cancels an installment plan as a whole, and the milestone goes back", async () => {
    await savePlan(BUILD, BUILD_SPLIT);
    const invoices = await invoicesOf(await issue(BUILD));
    const response = await cancel(invoices[1]?.id ?? "");
    expect(response.status).toBe(200);
    expect((await invoicesOf(response)).map((i) => i.status)).toEqual(["cancelled", "cancelled"]);
    for (const invoice of invoices) {
      expect(fake.invoices.get(await paypalIdOf(invoice.id))?.status).toBe("CANCELLED");
    }
    expect((await planRow(BUILD)).rows[0]?.status).toBe("cancelled");
    expect(await milestoneStatus(BUILD)).toBe("delivered");
  });

  it("never cancels an installment plan with a paid installment", async () => {
    await savePlan(BUILD, BUILD_SPLIT);
    const [first, second] = await invoicesOf(await issue(BUILD));
    await handle.db.query(
      "UPDATE public.invoices SET status = 'paid', amount_paid_cents = 75000 WHERE id = $1",
      [first?.id],
    );
    const response = await cancel(second?.id ?? "");
    expect(response.status).toBe(409);
    expect((await json<{ error: string }>(response)).error).toMatch(/Installment 1 .* paid/);
    expect(fake.invoices.get(await paypalIdOf(second?.id ?? ""))?.status).toBe("UNPAID");
    expect((await planRow(BUILD)).rows[0]?.status).toBe("active");
  });

  it("is safe to repeat", async () => {
    const invoice = await invoiceOf(await issue(BUILD));
    await cancel(invoice.id);
    const again = await cancel(invoice.id);
    expect(again.status).toBe(200);
    expect((await invoiceOf(again)).status).toBe("cancelled");
  });

  it("answers 404 for another user's invoice", async () => {
    const invoice = await invoiceOf(await issue(BUILD));
    const asB = handlersFor(USER_B.userId);
    expect((await asB.cancel(post({ reason: "mistake" }), idContext(invoice.id))).status).toBe(404);
    expect(fake.invoices.get(await paypalIdOf(invoice.id))?.status).toBe("UNPAID");
  });
});
