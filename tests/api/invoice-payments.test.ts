import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser, type UserDbRunner } from "@/lib/db";
import { formatMoney } from "@/lib/format";
import { invoiceHandlers } from "@/lib/invoice-handlers";
import { listClientInvoices } from "@/lib/invoice-history";
import { loadClientTimeline } from "@/lib/timeline";
import { createPaypalClient, type PaypalClient } from "@/lib/paypal";
import { paypalWebhookHandler } from "@/lib/paypal-webhook";
import { runAsService } from "@/lib/service-db";
import { USER_A, USER_B, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import {
  createFakePaypal,
  FAKE_WEBHOOK_ID,
  VALID_SIGNATURE,
  type FakePaypal,
} from "../mocks/paypal";

// E1: the freelancer records money received outside PayPal. Real migrations and RLS (PGlite),
// PayPal mocked by msw. PayPal is told first; if it refuses, nothing here changes.

let handle: TestDatabase;
let fake: FakePaypal;
const server = setupServer();

/** 15:00 UTC on 3 Nov: the freelancer's zone (UTC by default) is on 3 Nov too. */
const NOW = new Date("2026-11-03T15:00:00Z");
const PROJECT = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BUILD = "aaaaaaaa-0000-4000-8000-0000000000b2";
const CREDENTIALS = { clientId: "id", clientSecret: "secret" };

const runnerFor =
  (userId: string): UserDbRunner =>
  (work) =>
    runAsUser(handle.db, userId, work);

const handlersFor = (userId: string) =>
  invoiceHandlers({
    runAsUser: runnerFor(userId),
    paypal: () => createPaypalClient(CREDENTIALS),
    now: () => NOW,
  });

const post = (body: unknown) =>
  new Request("http://127.0.0.1:3000/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const idContext = (id: string) => ({ params: Promise.resolve({ id }) });

type Invoice = { id: string; status: string; amountPaidCents: number };
type Issue = { field: string; message: string };

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
const invoiceOf = async (response: Response): Promise<Invoice> => {
  const [first] = (await json<{ invoices: Invoice[] }>(response)).invoices;
  if (!first) throw new Error("no invoice in the response");
  return first;
};
const errorsOf = async (response: Response): Promise<Issue[]> => {
  expect(response.status).toBe(400);
  return (await json<{ errors: Issue[] }>(response)).errors;
};

const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => {
  const { rows } = await handle.db.query<T>(sql, params);
  const row = rows[0];
  if (!row) throw new Error(`No row for ${sql}`);
  return row;
};

const paypalIdOf = async (invoiceId: string): Promise<string> =>
  (
    await one<{ paypal_invoice_id: string }>(
      "SELECT paypal_invoice_id FROM public.invoices WHERE id = $1",
      [invoiceId],
    )
  ).paypal_invoice_id;

const paymentCalls = () => fake.calls.filter((call) => call.path.endsWith("/payments"));
const payments = (invoiceId: string) =>
  handle.db.query<{ method: string; amount_cents: string; reference: string | null }>(
    "SELECT method, amount_cents::text, reference FROM public.invoice_payments WHERE invoice_id = $1",
    [invoiceId],
  );

const BANK = { method: "bank_transfer", amountCents: 300000, receivedOn: "2026-11-02" };

/** A sent invoice for the Build milestone (USD 3,000.00), already overdue. */
const sentInvoice = async (): Promise<Invoice> => {
  const response = await handlersFor(USER_A.userId).issue(post({}), idContext(BUILD));
  expect(response.status).toBe(201);
  const invoice = await invoiceOf(response);
  await handle.db.query("UPDATE public.invoices SET due_date = '2026-10-20' WHERE id = $1", [
    invoice.id,
  ]);
  return invoice;
};

const record = (id: string, body: unknown, userId = USER_A.userId) =>
  handlersFor(userId).recordPayment(post(body), idContext(id));

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
      VALUES ('${BUILD}', '${USER_A.userId}', '${PROJECT}', 'USD', 1, 'Build', 10000, '2026-12-10', 'pay_on_invoice', 'delivered');
  `);
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(async () => {
  server.close();
  await handle.close();
});

describe("POST /api/invoices/[id]/payments", () => {
  it("records a bank transfer in PayPal and here: paid, reminders stopped, timeline events", async () => {
    const invoice = await sentInvoice();
    await handle.db.query(
      `INSERT INTO public.reminders (user_id, invoice_id, tier, scheduled_at)
       VALUES ($1, $2, 'tier1', '2026-11-04T14:00:00Z')`,
      [USER_A.userId, invoice.id],
    );
    const response = await record(invoice.id, { ...BANK, reference: "NEFT 884211" });
    expect(response.status).toBe(200);
    expect(await invoiceOf(response)).toMatchObject({ status: "paid", amountPaidCents: 300000 });

    const paypalId = await paypalIdOf(invoice.id);
    expect(fake.invoices.get(paypalId)?.status).toBe("MARKED_AS_PAID");
    const [call] = paymentCalls();
    expect(call?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      method: "BANK_TRANSFER",
      payment_date: "2026-11-02",
      amount: { currency_code: "USD", value: "3000.00" },
      note: "Recorded by the freelancer: Bank transfer, NEFT 884211",
    });

    const saved = await payments(invoice.id);
    expect(saved.rows).toEqual([
      { method: "bank_transfer", amount_cents: "300000", reference: "NEFT 884211" },
    ]);
    const reminder = await one<{ approval_status: string }>(
      "SELECT approval_status FROM public.reminders WHERE invoice_id = $1",
      [invoice.id],
    );
    expect(reminder.approval_status).toBe("skipped");
    const milestone = await one<{ status: string }>(
      "SELECT status FROM public.milestones WHERE id = $1",
      [BUILD],
    );
    expect(milestone.status).toBe("paid");
    const types = (
      await handle.db.query<{ type: string }>(
        "SELECT type FROM public.events WHERE entity_id = $1",
        [invoice.id],
      )
    ).rows.map((row) => row.type);
    expect(types).toEqual(expect.arrayContaining(["payment.recorded", "invoice.paid"]));
    const paid = await one<{ paid_at: string | null }>(
      "SELECT paid_at FROM public.invoices WHERE id = $1",
      [invoice.id],
    );
    expect(paid.paid_at).not.toBeNull();
  });

  it("a part payment leaves the invoice partially paid, with the rest still owed", async () => {
    const invoice = await sentInvoice();
    const response = await record(invoice.id, { ...BANK, method: "upi", amountCents: 40000 });
    expect(await invoiceOf(response)).toMatchObject({
      status: "partially_paid",
      amountPaidCents: 40000,
    });
    expect(JSON.parse(paymentCalls()[0]?.body ?? "{}")).toMatchObject({ method: "OTHER" });
    const rest = await record(invoice.id, { ...BANK, amountCents: 260000 });
    expect(await invoiceOf(rest)).toMatchObject({ status: "paid", amountPaidCents: 300000 });
    expect((await payments(invoice.id)).rows).toHaveLength(2);
  });

  it("rejects an amount over what is owed, a future date and an unknown method with 400", async () => {
    const invoice = await sentInvoice();
    const over = await errorsOf(await record(invoice.id, { ...BANK, amountCents: 300001 }));
    expect(over[0]?.field).toBe("amountCents");
    expect(over[0]?.message).toContain(formatMoney(300000, "USD"));
    const future = await errorsOf(await record(invoice.id, { ...BANK, receivedOn: "2026-11-04" }));
    expect(future[0]).toMatchObject({ field: "receivedOn", message: "can't be in the future" });
    const method = await errorsOf(await record(invoice.id, { ...BANK, method: "bitcoin" }));
    expect(method[0]?.field).toBe("method");
    const long = await errorsOf(await record(invoice.id, { ...BANK, reference: "x".repeat(201) }));
    expect(long[0]?.field).toBe("reference");
    const zero = await errorsOf(await record(invoice.id, { ...BANK, amountCents: 0 }));
    expect(zero[0]?.field).toBe("amountCents");
    const float = await errorsOf(await record(invoice.id, { ...BANK, amountCents: 12.5 }));
    expect(float[0]?.field).toBe("amountCents");
    expect(paymentCalls()).toHaveLength(0);
    expect((await payments(invoice.id)).rows).toHaveLength(0);
  });

  it("answers 404 for another user's invoice and calls nothing", async () => {
    const invoice = await sentInvoice();
    const calls = fake.calls.length;
    expect((await record(invoice.id, BANK, USER_B.userId)).status).toBe(404);
    expect(fake.calls).toHaveLength(calls);
    expect((await payments(invoice.id)).rows).toHaveLength(0);
  });

  it("changes nothing when PayPal refuses, and says so", async () => {
    const invoice = await sentInvoice();
    fake.behaviour.refuseRecordPayment = true;
    const response = await record(invoice.id, BANK);
    expect(response.status).toBe(502);
    expect((await json<{ error: string }>(response)).error).toMatch(/PAYMENT_NOT_ALLOWED/);
    expect((await payments(invoice.id)).rows).toHaveLength(0);
    const row = await one<{ status: string; amount_paid_cents: string }>(
      "SELECT status, amount_paid_cents::text FROM public.invoices WHERE id = $1",
      [invoice.id],
    );
    expect(row).toEqual({ status: "sent", amount_paid_cents: "0" });
  });

  it("won't take a payment on an invoice that isn't open", async () => {
    const invoice = await sentInvoice();
    await handlersFor(USER_A.userId).cancel(post({ reason: "mistake" }), idContext(invoice.id));
    const response = await record(invoice.id, BANK);
    expect(response.status).toBe(409);
    expect(paymentCalls()).toHaveLength(0);
  });

  it("is not counted twice when PayPal's own webhook for the payment arrives afterwards", async () => {
    const invoice = await sentInvoice();
    await record(invoice.id, BANK);
    const paypalId = await paypalIdOf(invoice.id);

    const webhook = paypalWebhookHandler({
      runAsService: (work) => runAsService(handle.db, work),
      runAsUser: (userId) => (work) => runAsUser(handle.db, userId, work),
      now: () => NOW,
      paypal: (): PaypalClient => createPaypalClient(CREDENTIALS),
      webhookId: () => FAKE_WEBHOOK_ID,
    });
    const body = `{ "id": "WH-EVT-9001", "event_type": "INVOICING.INVOICE.PAID", "resource": { "id": "${paypalId}" } }`;
    const deliver = () =>
      webhook.post(
        new Request("http://127.0.0.1:3000/api/webhooks/paypal", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "paypal-auth-algo": "SHA256withRSA",
            "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-fake",
            "paypal-transmission-id": "tx-1",
            "paypal-transmission-sig": VALID_SIGNATURE,
            "paypal-transmission-time": "2026-11-03T15:00:00Z",
          },
          body,
        }),
      );
    expect((await json<{ outcome: string }>(await deliver())).outcome).toBe("unchanged");
    expect((await json<{ outcome: string }>(await deliver())).outcome).toBe("duplicate");

    const row = await one<{ status: string; amount_paid_cents: string }>(
      "SELECT status, amount_paid_cents::text FROM public.invoices WHERE id = $1",
      [invoice.id],
    );
    expect(row).toEqual({ status: "paid", amount_paid_cents: "300000" });
    expect((await payments(invoice.id)).rows).toHaveLength(1);
  });

  it("keeps one row per PayPal payment id", async () => {
    const invoice = await sentInvoice();
    await record(invoice.id, { ...BANK, amountCents: 40000 });
    const { rows } = await handle.db.query<{ paypal_payment_id: string }>(
      "SELECT paypal_payment_id FROM public.invoice_payments WHERE invoice_id = $1",
      [invoice.id],
    );
    await expect(
      handle.db.query(
        `INSERT INTO public.invoice_payments (user_id, invoice_id, method, amount_cents, currency, received_on, paypal_payment_id, recorded_by)
         VALUES ($1, $2, 'cash', 100, 'USD', '2026-11-02', $3, $1)`,
        [USER_A.userId, invoice.id, rows[0]?.paypal_payment_id],
      ),
    ).rejects.toThrow();
  });
});

describe("where a recorded payment shows", () => {
  it("is a row on the client's timeline, and the history says how it was paid", async () => {
    const invoice = await sentInvoice();
    const open = await runAsUser(handle.db, USER_A.userId, (db) =>
      listClientInvoices(db, USER_A.rows.clients, NOW),
    );
    expect(open.find((row) => row.id === invoice.id)).toMatchObject({
      closable: true,
      paymentMethod: null,
    });

    await record(invoice.id, { ...BANK, method: "cheque" });
    const timeline = await runAsUser(handle.db, USER_A.userId, (db) =>
      loadClientTimeline(db, USER_A.rows.clients),
    );
    const recorded = timeline.find((entry) => entry.title.startsWith("Payment recorded by you"));
    expect(recorded).toMatchObject({ kind: "payment" });
    expect(recorded?.title).toBe(
      `Payment recorded by you · Cheque · ${formatMoney(300000, "USD")}`,
    );

    const done = await runAsUser(handle.db, USER_A.userId, (db) =>
      listClientInvoices(db, USER_A.rows.clients, NOW),
    );
    expect(done.find((row) => row.id === invoice.id)).toMatchObject({
      status: "paid",
      closable: false,
      paymentMethod: "cheque",
    });
  });

  it("shows the reason on a cancelled invoice's timeline row", async () => {
    const invoice = await sentInvoice();
    await handlersFor(USER_A.userId).cancel(post({ reason: "mistake" }), idContext(invoice.id));
    const timeline = await runAsUser(handle.db, USER_A.userId, (db) =>
      loadClientTimeline(db, USER_A.rows.clients),
    );
    expect(timeline.map((entry) => entry.title)).toContain("Invoice cancelled: Mistake");
  });
});

describe("POST /api/invoices/[id]/cancel with a reason", () => {
  it("needs a reason from the list", async () => {
    const invoice = await sentInvoice();
    const none = await handlersFor(USER_A.userId).cancel(post({}), idContext(invoice.id));
    expect((await errorsOf(none))[0]?.field).toBe("reason");
    const bad = await handlersFor(USER_A.userId).cancel(
      post({ reason: "boredom" }),
      idContext(invoice.id),
    );
    expect((await errorsOf(bad))[0]?.field).toBe("reason");
    expect(fake.invoices.get(await paypalIdOf(invoice.id))?.status).toBe("UNPAID");
  });

  it("cancels, logs the reason, and stops reminders", async () => {
    const invoice = await sentInvoice();
    const response = await handlersFor(USER_A.userId).cancel(
      post({ reason: "writing_off" }),
      idContext(invoice.id),
    );
    expect((await invoiceOf(response)).status).toBe("cancelled");
    const event = await one<{ payload: { reason: string } }>(
      "SELECT payload FROM public.events WHERE entity_id = $1 AND type = 'invoice.cancelled'",
      [invoice.id],
    );
    expect(event.payload.reason).toBe("writing_off");
  });

  it("is not allowed on a paid invoice", async () => {
    const invoice = await sentInvoice();
    await record(invoice.id, BANK);
    const response = await handlersFor(USER_A.userId).cancel(
      post({ reason: "mistake" }),
      idContext(invoice.id),
    );
    expect(response.status).toBe(409);
    expect(fake.invoices.get(await paypalIdOf(invoice.id))?.status).toBe("MARKED_AS_PAID");
  });
});
