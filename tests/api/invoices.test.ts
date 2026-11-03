import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser, type UserDbRunner } from "@/lib/db";
import { invoiceHandlers } from "@/lib/invoice-handlers";
import { createPaypalClient, PAYPAL_SANDBOX_BASE } from "@/lib/paypal";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import { createFakePaypal, type FakePaypal } from "../mocks/paypal";

// The invoice flow end to end: real migrations and RLS (PGlite), PayPal mocked by msw.

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

const runnerFor =
  (userId: string): UserDbRunner =>
  (work) =>
    runAsUser(handle.db, userId, work);

const handlersFor = (userId: string, paypal = () => createPaypalClient(CREDENTIALS)) =>
  invoiceHandlers({ runAsUser: runnerFor(userId), paypal, now: () => NOW });

const CREDENTIALS = { clientId: "id", clientSecret: "secret" };

const post = (body: unknown = {}) =>
  new Request("http://127.0.0.1:3000/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const idContext = (id: string) => ({ params: Promise.resolve({ id }) });

type Invoice = {
  id: string;
  milestoneId: string;
  invoiceNumber: string;
  status: string;
  amountCents: number;
  amountPaidCents: number;
  minimumDueCents: number | null;
  currency: string;
  dueDate: string;
  link: string | null;
};
type Issue = { field: string; message: string };

const issue = async (milestoneId: string, body: unknown = {}, userId = USER_A.userId) =>
  handlersFor(userId).issue(post(body), idContext(milestoneId));

const cancel = async (invoiceId: string) =>
  handlersFor(USER_A.userId).cancel(post(), idContext(invoiceId));

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const invoiceOf = async (response: Response): Promise<Invoice> =>
  (await json<{ invoice: Invoice }>(response)).invoice;

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

const paypalBody = (id: string) =>
  fake.invoices.get(id)?.body as {
    detail: { invoice_number: string; payment_term: unknown };
    configuration: unknown;
  };

const paypalIdOf = async (invoiceId: string): Promise<string> =>
  (
    await one<{ paypal_invoice_id: string }>(
      "SELECT paypal_invoice_id FROM public.invoices WHERE id = $1",
      [invoiceId],
    )
  ).paypal_invoice_id;

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

afterEach(() => { server.resetHandlers(); });

afterAll(async () => {
  server.close();
  await handle.close();
});

describe("POST /api/milestones/[id]/invoice", () => {
  it("creates and sends a deposit invoice with partial payment and its minimum", async () => {
    const response = await issue(DEPOSIT, { minimumDueCents: 30000 });
    expect(response.status).toBe(201);
    const invoice = await invoiceOf(response);
    expect(invoice).toMatchObject({
      milestoneId: DEPOSIT,
      status: "sent",
      amountCents: 90000,
      amountPaidCents: 0,
      minimumDueCents: 30000,
      currency: "USD",
      // Net 14 (the default) from 3 Nov in the client's zone.
      dueDate: "2026-11-17",
    });
    expect(invoice.invoiceNumber).toMatch(/^FPR-\d{6}$/);

    const paypalId = await paypalIdOf(invoice.id);
    expect(invoice.link).toBe(`https://www.sandbox.paypal.com/invoice/p/#${paypalId}`);
    expect(fake.invoices.get(paypalId)?.status).toBe("UNPAID");
    const body = paypalBody(paypalId);
    expect(body.detail.invoice_number).toBe(invoice.invoiceNumber);
    expect(body.detail.payment_term).toEqual({ due_date: "2026-11-17" });
    expect(body.configuration).toEqual({
      allow_tip: false,
      partial_payment: {
        allow_partial_payment: true,
        minimum_amount_due: { currency_code: "USD", value: "300.00" },
      },
    });
    expect(await milestoneStatus(DEPOSIT)).toBe("invoiced");
    const event = await one<{ type: string }>(
      "SELECT type FROM public.events WHERE entity_id = $1",
      [invoice.id],
    );
    expect(event.type).toBe("invoice.sent");
  });

  it("sends the invoice's own PayPal-Request-Id on create", async () => {
    const invoice = await invoiceOf(await issue(DEPOSIT, { minimumDueCents: 30000 }));
    const { paypal_request_id: requestId } = await one<{ paypal_request_id: string }>(
      "SELECT paypal_request_id::text FROM public.invoices WHERE id = $1",
      [invoice.id],
    );
    const create = fake.calls.find((c) => c.path === "/v2/invoicing/invoices");
    expect(create?.requestId).toBe(requestId);
  });

  it("gives back the same invoice when asked again: one per milestone", async () => {
    const first = await invoiceOf(await issue(DEPOSIT, { minimumDueCents: 30000 }));
    const again = await issue(DEPOSIT, { minimumDueCents: 30000 });
    expect(again.status).toBe(200);
    expect((await invoiceOf(again)).id).toBe(first.id);
    expect(fake.invoices.size).toBe(1);
  });

  it("turns partial payments on with no minimum for pay-on-invoice milestones", async () => {
    const invoice = await invoiceOf(await issue(BUILD));
    expect(invoice).toMatchObject({ amountCents: 150000, minimumDueCents: null });
    expect(paypalBody(await paypalIdOf(invoice.id)).configuration).toEqual({
      allow_tip: false,
      partial_payment: { allow_partial_payment: true },
    });
  });

  it("uses the milestone's own payment terms; due on receipt is due today in the client's zone", async () => {
    await handle.db.query(
      `UPDATE public.milestones SET settings = '{"paymentTerms":{"kind":"on_receipt"}}' WHERE id = $1`,
      [BUILD],
    );
    const invoice = await invoiceOf(await issue(BUILD));
    expect(invoice.dueDate).toBe("2026-11-03");
    expect(paypalBody(await paypalIdOf(invoice.id)).detail.payment_term).toEqual({
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

  it("needs a minimum first payment for a deposit, no more than the amount", async () => {
    expect((await errorsOf(await issue(DEPOSIT)))[0]?.field).toBe("minimumDueCents");
    const tooHigh = await errorsOf(await issue(DEPOSIT, { minimumDueCents: 90001 }));
    expect(tooHigh[0]?.message).toMatch(/USD\s900\.00/);
    expect(fake.invoices.size).toBe(0);
  });

  it("refuses a minimum on a milestone that isn't a deposit", async () => {
    const errors = await errorsOf(await issue(BUILD, { minimumDueCents: 100 }));
    expect(errors[0]?.field).toBe("minimumDueCents");
  });

  it("invoices pay-on-invoice work only once it's delivered", async () => {
    const errors = await errorsOf(await issue(LAUNCH));
    expect(errors[0]?.message).toMatch(/Mark it Delivered/);
  });

  it("leaves milestone holds to the PayPal authorization flow", async () => {
    const errors = await errorsOf(await issue(HOLD));
    expect(errors[0]?.field).toBe("paymentMode");
  });

  it("rejects unknown fields", async () => {
    const errors = await errorsOf(await issue(BUILD, { amountCents: 1 }));
    expect(errors[0]?.field).toBe("amountCents");
  });

  it("answers 404 for another user's milestone or a bad id", async () => {
    expect((await issue(DEPOSIT, { minimumDueCents: 1 }, USER_B.userId)).status).toBe(404);
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
          async ({ request }) => {
            fake.store((await request.json()) as Record<string, unknown>);
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

describe("POST /api/invoices/[id]/cancel", () => {
  it("cancels in PayPal, restores the milestone, skips waiting reminders and logs it", async () => {
    const invoice = await invoiceOf(await issue(DEPOSIT, { minimumDueCents: 30000 }));
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

  it("refuses once the client has paid part of it, and changes nothing", async () => {
    const invoice = await invoiceOf(await issue(BUILD));
    const paypalId = await paypalIdOf(invoice.id);
    fake.pay(paypalId, "750.00", "PARTIALLY_PAID");
    const response = await cancel(invoice.id);
    expect(response.status).toBe(409);
    expect((await json<{ error: string }>(response)).error).toMatch(/paid/);
    expect(fake.invoices.get(paypalId)?.status).toBe("PARTIALLY_PAID");
    expect(await milestoneStatus(BUILD)).toBe("invoiced");
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
    expect((await asB.cancel(post(), idContext(invoice.id))).status).toBe(404);
    expect(fake.invoices.get(await paypalIdOf(invoice.id))?.status).toBe("UNPAID");
  });
});
